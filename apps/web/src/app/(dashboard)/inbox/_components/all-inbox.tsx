"use client"

import { useMemo, useState, type ReactNode } from "react"
import { Inbox, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { isChannelOff } from "@/lib/channel-off"
import {
  ConversationItem, InboxEmpty, InboxFrame, InboxListToolbar, SideSection, awaitingReply, inboxTimeLabel, type InboxChannel,
} from "@/components/inbox/inbox-ui"
import { useMarkReadZaloOa, useZaloOaThreads } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/use-zalo-oa"
import { inConsultWindow, threadTitle, type ZaloOaThread } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-types"
import { ZaloCustomerSide, ZaloThreadView } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-inbox"
import { messengerReplyLabel, useFacebookConversations, type FacebookConversation } from "@/app/(dashboard)/settings/_components/integrations/use-facebook"
import { FacebookCustomerSide, FacebookThread, facebookCustomerName } from "@/app/(dashboard)/settings/_components/integrations/facebook-inbox"
import { ErrorState } from "@/components/ui/error-state"

/** Một dòng của danh sách gộp — giữ bản ghi gốc để mở đúng màn hội thoại của kênh đó. */
export type MergedConversation =
  | { key: string; channel: "zalo"; at: string | null; name: string; source: ZaloOaThread }
  | { key: string; channel: "facebook"; at: string | null; name: string; source: FacebookConversation }

/**
 * Gộp hội thoại Zalo OA + Messenger ở PHÍA CLIENT, mới nhất lên đầu (theo `last_message_at`).
 * Lọc Messenger theo chữ tìm ngay trên client (API Messenger không có ô tìm); Zalo đã lọc ở BE theo `q`.
 */
export function mergeConversations(
  zalo: readonly ZaloOaThread[],
  facebook: readonly FacebookConversation[],
  q = "",
): MergedConversation[] {
  const needle = q.trim().toLocaleLowerCase("vi")
  const fb = needle
    ? facebook.filter((c) => `${facebookCustomerName(c)} ${c.last_message_preview ?? ""}`.toLocaleLowerCase("vi").includes(needle))
    : facebook
  const rows: MergedConversation[] = [
    ...zalo.map((t) => ({ key: `zalo-${t.id}`, channel: "zalo" as const, at: t.last_message_at, name: threadTitle(t), source: t })),
    ...fb.map((c) => ({ key: `facebook-${c.id}`, channel: "facebook" as const, at: c.last_message_at, name: facebookCustomerName(c), source: c })),
  ]
  const ts = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0)
  return rows.sort((a, b) => ts(b.at) - ts(a.at))
}

/** Tin cuối là của khách (chưa ai trả lời): tin vào ghi cả hai mốc, tin ra chỉ đẩy `last_message_at`. */
export { awaitingReply }

/**
 * Tab "Tất cả" của Hộp thư: một danh sách gộp hai kênh, mở hội thoại bằng ĐÚNG màn của kênh đó
 * (Zalo: cửa sổ 48 giờ + ZNS; Messenger: 24 giờ). Không có API mới — chỉ hai hook sẵn có.
 */
export function AllInbox({ listTop, className }: { listTop?: ReactNode; className?: string }) {
  const [q, setQ] = useState("")
  const [onlyAwaiting, setOnlyAwaiting] = useState(false)
  const [selected, setSelected] = useState<{ channel: InboxChannel; id: number } | null>(null)
  const zalo = useZaloOaThreads(q, true)
  const fb = useFacebookConversations(true)
  const markRead = useMarkReadZaloOa()
  const zaloRows = useMemo(() => zalo.data?.pages.flatMap((p) => p.data) ?? [], [zalo.data])
  const all = useMemo(() => mergeConversations(zaloRows, fb.data ?? [], q), [zaloRows, fb.data, q])
  const awaitingCount = useMemo(() => all.filter((r) => awaitingReply(r.source)).length, [all])
  const rows = useMemo(() => (onlyAwaiting ? all.filter((r) => awaitingReply(r.source)) : all), [all, onlyAwaiting])
  const current = selected ? rows.find((r) => r.channel === selected.channel && r.source.id === selected.id) ?? null : null
  const loading = zalo.isLoading || fb.isLoading
  // Kênh tắt (BE trả 403) ⇒ coi như kênh đó không có hội thoại, KHÔNG hiện chữ đỏ; chỉ lỗi thật mới báo.
  const zaloErr = zalo.isError && !isChannelOff(zalo.error)
  const fbErr = fb.isError && !isChannelOff(fb.error)

  const pick = (r: MergedConversation) => {
    setSelected({ channel: r.channel, id: r.source.id })
    if (r.channel === "zalo" && r.source.unread_count > 0) markRead.mutate(r.source.id)
  }

  const list = (
    <>
      <InboxListToolbar q={q} onQ={setQ} awaiting={{ on: onlyAwaiting, count: awaitingCount, onChange: setOnlyAwaiting }} />
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin" /></div>}
        {zaloErr && <ErrorState compact className="px-2 py-2" title="Không tải được hội thoại Zalo OA" error={zalo.error} onRetry={() => void zalo.refetch()} retrying={zalo.isFetching} />}
        {fbErr && <ErrorState compact className="px-2 py-2" title="Không tải được hội thoại Messenger" error={fb.error} onRetry={() => void fb.refetch()} retrying={fb.isFetching} />}
        {!loading && rows.length === 0 && !zaloErr && !fbErr && (
          <InboxEmpty icon={<Inbox aria-hidden />}>
            {onlyAwaiting ? "Không còn hội thoại nào chờ trả lời." : q ? "Không có hội thoại nào khớp." : "Chưa có hội thoại nào. Khi khách nhắn vào Zalo OA hoặc Fanpage đã kết nối, hội thoại sẽ hiện ở đây."}
          </InboxEmpty>
        )}
        <ul className="space-y-0.5">
          {rows.map((r) => {
            const open = r.channel === "zalo" ? inConsultWindow(r.source.last_inbound_at) : r.source.can_reply
            const dotLabel =
              r.channel === "zalo"
                ? open ? "Còn trong 48 giờ trả lời" : "Quá 48 giờ — chỉ gửi được ZNS"
                : messengerReplyLabel(r.source)
            return (
              <li key={r.key}>
                <ConversationItem
                  name={r.name}
                  preview={r.source.last_message_preview ?? "—"}
                  time={inboxTimeLabel(r.at)}
                  unread={r.source.unread_count}
                  active={current?.key === r.key}
                  channel={r.channel}
                  avatarUrl={r.channel === "zalo" ? r.source.avatar_url : null}
                  dot={{ tone: open ? "open" : "closed", label: dotLabel }}
                  onClick={() => pick(r)}
                />
              </li>
            )
          })}
        </ul>
        {zalo.hasNextPage && (
          <Button variant="outline" className="mt-2 w-full text-sm" disabled={zalo.isFetchingNextPage} onClick={() => zalo.fetchNextPage()}>
            Tải thêm hội thoại Zalo
          </Button>
        )}
      </div>
    </>
  )

  const back = () => setSelected(null)
  return (
    <InboxFrame
      threadOpen={current !== null}
      listTop={listTop}
      className={className}
      list={list}
      thread={
        current === null ? (
          <InboxEmpty icon={<Inbox aria-hidden />} title="Chưa mở hội thoại">Chọn một hội thoại bên trái để xem tin và trả lời khách.</InboxEmpty>
        ) : current.channel === "zalo" ? (
          <ZaloThreadView key={current.key} thread={current.source} onBack={back} />
        ) : (
          <FacebookThread key={current.key} id={current.source.id} onBack={back} />
        )
      }
      side={
        current === null ? (
          <SideSection title="Khách hàng"><p className="text-sm text-muted-foreground">Chọn một hội thoại để xem thông tin khách.</p></SideSection>
        ) : current.channel === "zalo" ? (
          <ZaloCustomerSide thread={current.source} />
        ) : (
          <FacebookCustomerSide c={current.source} />
        )
      }
    />
  )
}
