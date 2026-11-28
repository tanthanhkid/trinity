"use client"

import { useState } from "react"
import { Inbox, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { formatDateTimeVn, formatPhone } from "@/lib/format"
import { CustomerProfile, ProfileSheet, reminderText, useLinkedContact } from "@/components/inbox/customer-profile"
import { usePermissions } from "@/lib/rbac"
import {
  Composer, ConversationItem, HeroChip, InboxEmpty, InboxFrame, InboxListToolbar, awaitingReply, MessageThread, SideSection, StatusPill, ThreadHeader,
  inboxTimeLabel, type InboxMessage,
} from "@/components/inbox/inbox-ui"
import { apiErrorMessage } from "../webhook-types"
import { useMarkReadZaloOa, useReplyZaloOa, useZaloOaMessages, useZaloOaThreads } from "./use-zalo-oa"
import { inConsultWindow, threadTitle, type ZaloOaMessage, type ZaloOaThread } from "./zalo-oa-types"
import { isChannelOff } from "@/lib/channel-off"
import { ErrorState } from "@/components/ui/error-state"

const messageText = (m: ZaloOaMessage) => m.text ?? (m.kind === "zns" ? "[Tin ZNS]" : "[Tệp đính kèm]")

/** Cột phải của một hội thoại Zalo OA (dùng chung với màn Hộp thư `/inbox`): hồ sơ khách sửa tại chỗ + thông tin hội thoại. */
export function ZaloCustomerSide({ thread }: { thread: ZaloOaThread }) {
  const open = inConsultWindow(thread.last_inbound_at)
  return (
    <>
      <CustomerProfile
        contactId={thread.contact_id}
        fallbackName={threadTitle(thread)}
        fallbackPhone={thread.phone}
        avatarUrl={thread.avatar_url}
        channelLabel="Zalo OA"
      />
      <SideSection
        title="Hội thoại Zalo OA"
        rows={[
          { label: "Tin khách gần nhất", value: thread.last_inbound_at ? formatDateTimeVn(thread.last_inbound_at) : "—" },
          { label: "Trả lời", value: open ? "Còn trong 48 giờ" : "Quá 48 giờ — dùng ZNS" },
        ]}
      />
    </>
  )
}

/** Luồng tin + ô trả lời của một hội thoại Zalo OA (dùng chung với màn Hộp thư `/inbox`). */
export function ZaloThreadView({ thread, onBack }: { thread: ZaloOaThread; onBack: () => void }) {
  const messages = useZaloOaMessages(thread.id)
  const reply = useReplyZaloOa(thread.id)
  const [text, setText] = useState("")
  const [sheet, setSheet] = useState(false)
  const { can } = usePermissions()
  const contact = useLinkedContact(thread.contact_id, can("contacts.view"))
  const c = contact.data && typeof contact.data === "object" ? contact.data : null
  const open = inConsultWindow(thread.last_inbound_at)
  const name = threadTitle(thread)
  const phone = c?.phone || thread.phone
  const stageLabel = c?.stage_option?.label ?? null
  // BE trả mới nhất trước ⇒ đảo lại cũ → mới.
  const items: InboxMessage[] = [...(messages.data ?? [])].reverse().map((m) => ({
    id: m.id,
    direction: m.direction,
    text: messageText(m),
    at: m.created_at,
    who: m.direction === "in" ? name : m.kind === "zns" ? "ZNS" : undefined,
    failed: m.status === "failed" ? (m.error ?? "") : null,
  }))

  const send = () => {
    const t = text.trim()
    if (!t) return
    reply.mutate(t, { onSuccess: () => setText(""), onError: (e) => toast.error(apiErrorMessage(e, "Gửi tin thất bại")) })
  }

  const sub = ["Zalo OA", thread.phone ? formatPhone(thread.phone) : "Chưa có SĐT", thread.contact_id ? `Khách #${thread.contact_id}` : "Chưa ghép khách"].join(" · ")

  return (
    <>
      <ThreadHeader
        name={name}
        sub={sub}
        channel="zalo"
        avatarUrl={thread.avatar_url}
        onBack={onBack}
        aside={<StatusPill tone={open ? "ok" : "warn"}>{open ? "Trả lời được" : "Quá 48 giờ"}</StatusPill>}
        onOpenProfile={() => setSheet(true)}
        chips={
          <>
            <HeroChip tone={phone ? "solid" : "dashed"} onClick={() => setSheet(true)}>{phone ? formatPhone(phone) : "Chưa có số điện thoại"}</HeroChip>
            {stageLabel ? <HeroChip onClick={() => setSheet(true)}>{stageLabel}</HeroChip> : null}
            {c ? <HeroChip tone="glass" onClick={() => setSheet(true)}>{reminderText(c)}</HeroChip> : null}
          </>
        }
      />
      <ProfileSheet open={sheet} onOpenChange={setSheet}>
        <CustomerProfile contactId={thread.contact_id} fallbackName={name} fallbackPhone={thread.phone} avatarUrl={thread.avatar_url} channelLabel="Zalo OA" variant="sheet" />
      </ProfileSheet>
      <MessageThread messages={items} loading={messages.isLoading} error={messages.isError} />
      <Composer
        value={text}
        onChange={setText}
        onSend={send}
        pending={reply.isPending}
        disabled={!open}
        placeholder="Nhập câu trả lời..."
        notice={
          !open ? (
            <p className="mb-2 text-sm text-[var(--ax-warn)]">
              Đã quá 48 giờ kể từ tin gần nhất của khách — Zalo không cho gửi tin tư vấn. Hãy dùng ZNS.
            </p>
          ) : null
        }
      />
    </>
  )
}

/**
 * Hộp thư Zalo OA theo bố cục 3 cột của giao diện mới: danh sách hội thoại · luồng tin · thông tin khách.
 * Điện thoại: danh sách rồi vào từng hội thoại. Dữ liệu/gửi tin y nguyên hook cũ (`use-zalo-oa`).
 */
export function ZaloOaInbox({ listTop, className, initialOpenId }: { listTop?: React.ReactNode; className?: string; initialOpenId?: number | null } = {}) {
  const [q, setQ] = useState("")
  const [onlyAwaiting, setOnlyAwaiting] = useState(false)
  // Mở sẵn hội thoại từ thông báo / Tương tác (?hoi_thoai=).
  const [selectedId, setSelectedId] = useState<number | null>(initialOpenId ?? null)
  const threads = useZaloOaThreads(q, true)
  const markRead = useMarkReadZaloOa()
  // Kênh tắt (403) = trạng thái trống, không phải lỗi.
  const zaloOff = threads.isError && isChannelOff(threads.error)
  const all = threads.data?.pages.flatMap((p) => p.data) ?? []
  const awaitingCount = all.filter(awaitingReply).length
  const rows = onlyAwaiting ? all.filter(awaitingReply) : all
  const selected = rows.find((t) => t.id === selectedId) ?? null

  const pick = (t: ZaloOaThread) => {
    setSelectedId(t.id)
    if (t.unread_count > 0) markRead.mutate(t.id)
  }

  const list = (
    <>
      <InboxListToolbar q={q} onQ={setQ} awaiting={{ on: onlyAwaiting, count: awaitingCount, onChange: setOnlyAwaiting }} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.isLoading && <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin" /></div>}
        {threads.isError && !zaloOff && <ErrorState compact className="px-2 py-4" title="Không tải được danh sách hội thoại" error={threads.error} onRetry={() => void threads.refetch()} retrying={threads.isFetching} />}
        {!threads.isLoading && (zaloOff || (!threads.isError && rows.length === 0)) && (
          <InboxEmpty icon={<Inbox aria-hidden />}>
            {zaloOff
              ? "Kênh Zalo OA chưa bật cho tổ chức. Khi quản trị bật Zalo OA và kết nối, hội thoại sẽ hiện ở đây."
              : onlyAwaiting ? "Không còn hội thoại nào chờ trả lời." : q ? "Không có hội thoại nào khớp." : "Chưa có hội thoại nào. Khi khách nhắn vào Zalo OA đã kết nối, hội thoại sẽ hiện ở đây."}
          </InboxEmpty>
        )}
        <ul>
          {rows.map((t) => {
            const open = inConsultWindow(t.last_inbound_at)
            return (
              <li key={t.id}>
                <ConversationItem
                  name={threadTitle(t)}
                  preview={t.last_message_preview ?? "—"}
                  time={inboxTimeLabel(t.last_message_at)}
                  unread={t.unread_count}
                  active={t.id === selectedId}
                  channel="zalo"
                  avatarUrl={t.avatar_url}
                  dot={{ tone: open ? "open" : "closed", label: open ? "Còn trong 48 giờ trả lời" : "Quá 48 giờ — chỉ gửi được ZNS" }}
                  onClick={() => pick(t)}
                />
              </li>
            )
          })}
        </ul>
        {threads.hasNextPage && (
          <Button variant="ax-secondary" size="ax" className="m-3 w-[calc(100%-1.5rem)]" disabled={threads.isFetchingNextPage} onClick={() => threads.fetchNextPage()}>
            Tải thêm
          </Button>
        )}
      </div>
    </>
  )

  return (
    <InboxFrame
      threadOpen={selected !== null}
      listTop={listTop}
      className={className}
      list={list}
      thread={
        selected ? (
          <ZaloThreadView key={selected.id} thread={selected} onBack={() => setSelectedId(null)} />
        ) : (
          <InboxEmpty icon={<Inbox aria-hidden />} title="Chưa mở hội thoại">Chọn một hội thoại bên trái để xem tin và trả lời khách.</InboxEmpty>
        )
      }
      side={selected ? <ZaloCustomerSide thread={selected} /> : <SideSection title="Khách hàng"><p className="text-sm text-muted-foreground">Chọn một hội thoại để xem thông tin khách.</p></SideSection>}
    />
  )
}
