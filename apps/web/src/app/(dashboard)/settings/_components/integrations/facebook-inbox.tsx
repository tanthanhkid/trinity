"use client"

import { useState } from "react"
import { Loader2, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { formatDateTimeVn } from "@/lib/format"
import {
  Composer, ConversationItem, InboxEmpty, InboxFrame, InboxListToolbar, awaitingReply, MessageThread, SideSection, StatusPill, ThreadHeader,
  inboxTimeLabel, type InboxMessage,
} from "@/components/inbox/inbox-ui"
import { messengerReplyLabel, useFacebookConversations, useFacebookMessages, useFacebookReply, type FacebookConversation } from "./use-facebook"
import { apiErrorMessage } from "./webhook-types"
import { isChannelOff } from "@/lib/channel-off"
import { ErrorState } from "@/components/ui/error-state"

/** Tên hiển thị của khách Messenger (chưa có tên ⇒ 6 số cuối PSID). */
export const facebookCustomerName = (c: FacebookConversation) => c.customer_name || `Khách ${c.psid.slice(-6)}`

/** Luồng tin + ô trả lời của một hội thoại Messenger (dùng chung với màn Hộp thư `/inbox`). */
export function FacebookThread({ id, onBack }: { id: number; onBack: () => void }) {
  const q = useFacebookMessages(id)
  const reply = useFacebookReply(id)
  const [text, setText] = useState("")
  const conv = q.data?.conversation
  const name = conv ? facebookCustomerName(conv) : "Đang tải..."
  const items: InboxMessage[] = (q.data?.messages ?? []).map((m) => ({
    id: m.id,
    direction: m.direction,
    text: m.text ?? "",
    at: m.sent_at,
    who: m.direction === "in" ? name : undefined,
  }))

  function send() {
    const t = text.trim()
    if (!t) return
    reply.mutate(t, { onSuccess: () => setText(""), onError: (e) => toast.error(apiErrorMessage(e, "Không gửi được tin nhắn")) })
  }

  return (
    <>
      <ThreadHeader
        name={name}
        sub={conv ? (conv.page_name ? `Messenger · ${conv.page_name}` : "Messenger") : ""}
        channel="facebook"
        onBack={onBack}
        aside={conv ? <StatusPill tone={conv.can_reply && conv.reply_mode !== "human_agent" ? "ok" : "warn"}>{conv.can_reply ? (conv.reply_mode === "human_agent" ? "Trả lời trong 7 ngày (nhân viên)" : "Trả lời được") : "Quá 7 ngày"}</StatusPill> : null}
      />
      <MessageThread messages={items} loading={q.isLoading} error={q.isError} />
      {conv && !conv.can_reply ? (
        <div className="border-t border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <p className="text-sm text-[var(--color-app-tag-amber-ink)]">
            Đã quá 7 ngày kể từ tin nhắn gần nhất của khách — Messenger không cho gửi tin chủ động. Có thể trả lời khi khách nhắn lại (hoặc trả lời trong Inbox của Fanpage).
          </p>
        </div>
      ) : (
        <>
        {conv?.reply_mode === "human_agent" && (
          <p className="border-t border-[var(--border)] bg-[var(--card)] px-4 pt-2 text-xs text-[var(--color-app-tag-amber-ink)]">
            Khách nhắn đã quá 24 giờ: chỉ nhân viên trả lời trực tiếp, trong 7 ngày kể từ tin cuối của khách.
          </p>
        )}
        <Composer
          value={text}
          onChange={setText}
          onSend={send}
          pending={reply.isPending}
          placeholder="Nhập tin nhắn..."
          ariaLabel="Nội dung trả lời"
          maxLength={2000}
        />
        </>
      )}
    </>
  )
}

/** Cột phải của một hội thoại Messenger. */
export function FacebookCustomerSide({ c }: { c: FacebookConversation }) {
  return (
    <>
      <SideSection
        title="Khách hàng"
        rows={[
          { label: "Tên", value: facebookCustomerName(c) },
          { label: "Fanpage", value: c.page_name },
        ]}
      />
      <SideSection
        title="Hội thoại Messenger"
        rows={[
          { label: "Tin khách gần nhất", value: c.last_inbound_at ? formatDateTimeVn(c.last_inbound_at) : "—" },
          { label: "Trả lời", value: messengerReplyLabel(c) },
        ]}
      />
    </>
  )
}

/**
 * Hộp thư Messenger theo bố cục 3 cột của giao diện mới. Trả lời chỉ trong 24h (BE báo `can_reply`).
 * Quyền xem/trả lời = `integrations.webhooks` (cổng ở mục Fanpage Facebook). Dữ liệu y nguyên hook cũ (`use-facebook`).
 */
export function FacebookInbox({ listTop, className, initialOpenId }: { listTop?: React.ReactNode; className?: string; initialOpenId?: number | null } = {}) {
  const list = useFacebookConversations(true)
  // Kênh tắt (403) = trạng thái trống, không phải lỗi.
  const fbOff = list.isError && isChannelOff(list.error)
  // Mở sẵn hội thoại từ thông báo / Tương tác (?hoi_thoai=).
  const [openId, setOpenId] = useState<number | null>(initialOpenId ?? null)
  const [q, setQ] = useState("")
  const [onlyAwaiting, setOnlyAwaiting] = useState(false)
  const needle = q.trim().toLocaleLowerCase("vi")
  const all = (list.data ?? []).filter((c) => !needle || `${facebookCustomerName(c)} ${c.last_message_preview ?? ""}`.toLocaleLowerCase("vi").includes(needle))
  const awaitingCount = all.filter(awaitingReply).length
  const rows = onlyAwaiting ? all.filter(awaitingReply) : all
  const selected = rows.find((c) => c.id === openId) ?? null

  return (
    <InboxFrame
      threadOpen={openId !== null}
      listTop={listTop}
      className={className}
      list={
        <>
        <InboxListToolbar q={q} onQ={setQ} awaiting={{ on: onlyAwaiting, count: awaitingCount, onChange: setOnlyAwaiting }} />
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.isLoading && <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
          {list.isError && !fbOff && <ErrorState compact className="px-2 py-4" title="Không tải được hộp thư" error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
          {(fbOff || (list.isSuccess && rows.length === 0)) && (
            <InboxEmpty icon={<MessageCircle aria-hidden />}>
              {fbOff
                ? "Kênh Fanpage Facebook chưa bật cho tổ chức. Khi quản trị bật và kết nối Fanpage, hội thoại sẽ hiện ở đây."
                : onlyAwaiting && (list.data?.length ?? 0) > 0
                  ? "Không còn hội thoại nào chờ trả lời."
                  : needle && (list.data?.length ?? 0) > 0
                    ? "Không có hội thoại nào khớp."
                    : "Chưa có tin nhắn nào. Khi khách nhắn tin vào Fanpage đã kết nối, hội thoại sẽ hiện ở đây."}
            </InboxEmpty>
          )}
          <ul className="space-y-0.5">
            {rows.map((c) => (
              <li key={c.id}>
                <ConversationItem
                  name={facebookCustomerName(c)}
                  preview={c.last_message_preview ?? "—"}
                  time={inboxTimeLabel(c.last_message_at)}
                  unread={c.unread_count}
                  active={openId === c.id}
                  channel="facebook"
                  dot={{ tone: c.can_reply ? "open" : "closed", label: messengerReplyLabel(c) }}
                  onClick={() => setOpenId(c.id)}
                />
              </li>
            ))}
          </ul>
        </div>
        </>
      }
      thread={
        openId !== null ? (
          <FacebookThread key={openId} id={openId} onBack={() => setOpenId(null)} />
        ) : (
          <InboxEmpty icon={<MessageCircle aria-hidden />} title="Chưa mở hội thoại">Chọn một hội thoại bên trái để xem tin và trả lời khách.</InboxEmpty>
        )
      }
      side={selected ? <FacebookCustomerSide c={selected} /> : undefined}
    />
  )
}
