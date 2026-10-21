"use client"

import { useState } from "react"
import Link from "next/link"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, EyeOff, MessageSquare, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { BrandLogo } from "@/components/ui/connection-row"
import { ReplyBox } from "@/app/(dashboard)/settings/_components/integrations/facebook-comments"
import apiClient from "@/lib/api-client"
import { formatDateTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatNumber } from "@/lib/format"

/** Khớp `GET /interactions` (services/crm/src/interactions/interactions.service.ts). */
export interface Interaction {
  key: string
  channel: "facebook" | "zalo"
  type: "comment" | "message"
  page_id: string | null
  channel_name: string
  at: string
  customer_name: string | null
  contact_id: number | null
  text: string | null
  post_url: string | null
  rule_name: string | null
  auto_result: string | null
  hidden: boolean
  status: "unanswered" | "auto" | "staff" | "answered"
  ref: { comment_id?: string; conversation_id?: number; thread_id?: number }
}
interface Stats { messages_today: number; comments_today: number; auto_handled_today: number; unanswered_7d: number }
interface Thread {
  comments: { id: string; message: string | null; at: string; status: string; hidden: boolean; can_private_reply: boolean; actions: Record<string, unknown> }[]
  conversation: { id: number; customer_name: string | null } | null
  messages: { id: string; direction: "in" | "out"; text: string | null; at: string }[]
}

export interface InteractionFilter { type: "" | "comment" | "message"; channel: "" | "facebook" | "zalo"; unanswered: boolean; rule: "" | "1" | "0"; from: string; to: string; q: string }
export const EMPTY_FILTER: InteractionFilter = { type: "", channel: "", unanswered: false, rule: "", from: "", to: "", q: "" }

export function filterParams(f: InteractionFilter): Record<string, string> {
  const p: Record<string, string> = {}
  if (f.type) p.type = f.type
  if (f.channel) p.channel = f.channel
  if (f.unanswered) p.status = "unanswered"
  if (f.rule) p.has_rule = f.rule
  if (f.from) p.from = `${f.from}T00:00:00+07:00`
  if (f.to) p.to = `${f.to}T23:59:59+07:00`
  if (f.q.trim()) p.q = f.q.trim()
  return p
}

const STATUS: Record<Interaction["status"], { label: string; cls: string }> = {
  unanswered: { label: "Chưa trả lời", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  auto: { label: "Luật đã trả lời", cls: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200" },
  staff: { label: "Nhân viên đã trả lời", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  answered: { label: "Đã trả lời", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
}
const nf = formatNumber
const brandOf = (i: Pick<Interaction, "channel" | "type">) => (i.channel === "zalo" ? "zalo" : i.type === "comment" ? "facebook" : "messenger") as "zalo" | "facebook" | "messenger"

/** "Tương tác": dòng thời gian gộp bình luận Fanpage + tin Messenger + Zalo OA, có số hôm nay, lọc, và khung chi tiết để trả lời tại chỗ. */
export function InteractionsView({ tabs, onOpenConversation }: { tabs?: React.ReactNode; onOpenConversation: (i: Interaction) => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState<InteractionFilter>(EMPTY_FILTER)
  const [open, setOpen] = useState<Interaction | null>(null)
  const stats = useQuery<Stats>({ queryKey: ["interactions", "stats"], queryFn: async () => (await apiClient.get<Stats>("/interactions/stats")).data, staleTime: 30_000, refetchInterval: 60_000 })
  const list = useQuery<{ data: Interaction[]; next_before: string | null }>({
    queryKey: ["interactions", "list", f],
    queryFn: async () => (await apiClient.get("/interactions", { params: { ...filterParams(f), limit: 60 } })).data,
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
  const set = (patch: Partial<InteractionFilter>) => setF((x) => ({ ...x, ...patch }))
  const rows = list.data?.data ?? []
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["interactions"] }) }

  return (
    <div className="space-y-4" data-testid="interactions">
      {tabs}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="interaction-stats">
        {[
          ["Tin nhắn hôm nay", stats.data?.messages_today],
          ["Bình luận hôm nay", stats.data?.comments_today],
          ["Chưa trả lời (7 ngày)", stats.data?.unanswered_7d],
          ["Luật tự xử lý hôm nay", stats.data?.auto_handled_today],
        ].map(([label, v]) => (
          <div key={label as string} className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-[22px] font-semibold tabular-nums">{v === undefined ? "—" : nf(v as number)}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Lọc tương tác">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Tìm tên khách hoặc nội dung" className="pl-8 max-sm:h-11" aria-label="Tìm" />
        </div>
        <Seg value={f.type} onChange={(v) => set({ type: v as InteractionFilter["type"] })} options={[["", "Tất cả"], ["comment", "Bình luận"], ["message", "Tin nhắn"]]} label="Loại" />
        <Seg value={f.channel} onChange={(v) => set({ channel: v as InteractionFilter["channel"] })} options={[["", "Mọi kênh"], ["facebook", "Facebook"], ["zalo", "Zalo"]]} label="Kênh" />
        <Seg value={f.rule} onChange={(v) => set({ rule: v as InteractionFilter["rule"] })} options={[["", "Mọi bình luận"], ["1", "Có luật chạy"], ["0", "Không luật"]]} label="Luật" />
        <label className="inline-flex items-center gap-1.5 text-sm max-sm:min-h-11">
          <input type="checkbox" checked={f.unanswered} onChange={(e) => set({ unanswered: e.target.checked })} className="size-4" />Chưa trả lời
        </label>
        <label className="inline-flex items-center gap-1 text-sm text-muted-foreground">Từ<Input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} className="h-9 w-[150px] max-sm:h-11" aria-label="Từ ngày" /></label>
        <label className="inline-flex items-center gap-1 text-sm text-muted-foreground">đến<Input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} className="h-9 w-[150px] max-sm:h-11" aria-label="Đến ngày" /></label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <ul className={cn("divide-y rounded-xl border bg-card", open && "max-lg:hidden")} data-testid="interaction-list">
          {list.isLoading && Array.from({ length: 5 }).map((_, k) => <li key={k} className="p-3"><Skeleton className="h-12 rounded-lg" /></li>)}
          {!list.isLoading && rows.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">Chưa có tương tác nào khớp bộ lọc.</li>}
          {rows.map((i) => (
            <li key={i.key}>
              <button type="button" onClick={() => setOpen(i)} className={cn("flex w-full gap-3 px-4 py-3 text-left hover:bg-muted/60", open?.key === i.key && "bg-accent")} data-testid="interaction-row">
                <BrandLogo brand={brandOf(i)} size={32} className="mt-0.5 rounded-lg" />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                    <span className="font-medium">{i.customer_name || "Khách"}</span>
                    <span className="text-xs text-muted-foreground">{i.type === "comment" ? "bình luận" : "tin nhắn"} · {i.channel_name} · {formatDateTimeVn(i.at)}</span>
                  </span>
                  <span className="line-clamp-2 block text-sm text-muted-foreground">{i.text || "[không có chữ]"}</span>
                  {i.auto_result && <span className="block text-xs text-violet-700 dark:text-violet-300">{i.auto_result}</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS[i.status].cls)}>{STATUS[i.status].label}</span>
                  {i.hidden && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><EyeOff className="size-3" aria-hidden />đã ẩn</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {open ? (
          <InteractionDetail key={open.key} i={open} onClose={() => setOpen(null)} onOpenConversation={onOpenConversation} onReplied={refresh} />
        ) : (
          <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground max-lg:hidden">Bấm một tương tác để xem chi tiết và trả lời tại chỗ.</div>
        )}
      </div>
    </div>
  )
}

function Seg({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: [string, string][]; label: string }) {
  return (
    <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={cn("rounded-md px-2.5 py-1 text-sm max-sm:min-h-10", value === v ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>{l}</button>
      ))}
    </div>
  )
}

function InteractionDetail({ i, onClose, onOpenConversation, onReplied }: { i: Interaction; onClose: () => void; onOpenConversation: (i: Interaction) => void; onReplied: () => void }) {
  const thread = useQuery<Thread>({
    queryKey: ["interactions", "thread", i.ref.comment_id],
    queryFn: async () => (await apiClient.get<Thread>(`/interactions/comments/${i.ref.comment_id}/thread`)).data,
    enabled: i.type === "comment" && !!i.ref.comment_id,
  })
  return (
    <aside className="space-y-3 rounded-xl border bg-card p-4" data-testid="interaction-detail">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{i.customer_name || "Khách"}</p>
          <p className="text-xs text-muted-foreground">{i.channel_name} · {i.type === "comment" ? "bình luận" : "tin nhắn"}</p>
        </div>
        <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground max-sm:min-h-11">Đóng</button>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {i.contact_id && <Link href={`/contacts/${i.contact_id}`} className="text-primary underline">Mở khách hàng</Link>}
        {i.post_url && <a href={i.post_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">Xem bài<ExternalLink className="size-3" aria-hidden /></a>}
      </div>
      {i.type === "comment" ? (
        thread.isLoading ? <Skeleton className="h-24 rounded-lg" /> : (
          <div className="space-y-3">
            {(thread.data?.comments ?? []).map((c) => (
              <div key={c.id} className="space-y-2 rounded-lg bg-muted/50 p-3">
                <p className="text-sm">{c.message || "[không có chữ]"}</p>
                <p className="text-xs text-muted-foreground">{formatDateTimeVn(c.at)}{c.hidden ? " · đã ẩn vì có số điện thoại" : ""}</p>
                {c.id === i.ref.comment_id && i.auto_result && <p className="text-xs text-violet-700 dark:text-violet-300">{i.auto_result}</p>}
                <ReplyBox c={{ id: c.id, can_private_reply: c.can_private_reply }} onSent={onReplied} />
              </div>
            ))}
            {thread.data?.conversation && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tin nhắn riêng</p>
                <ul className="space-y-1.5">
                  {thread.data.messages.map((m) => (
                    <li key={m.id} className={cn("max-w-[85%] rounded-lg px-3 py-1.5 text-sm", m.direction === "in" ? "bg-muted" : "ml-auto bg-primary/10")}>{m.text || "[tệp]"}</li>
                  ))}
                </ul>
                <button type="button" onClick={() => onOpenConversation({ ...i, type: "message", ref: { conversation_id: thread.data!.conversation!.id } })} className="inline-flex items-center gap-1 text-sm text-primary underline max-sm:min-h-11">
                  <MessageSquare className="size-4" aria-hidden />Nhắn tiếp trong Hộp thư
                </button>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <p className="rounded-lg bg-muted/50 p-3 text-sm">{i.text || "[không có chữ]"}</p>
          <button type="button" onClick={() => onOpenConversation(i)} className="inline-flex items-center gap-1 text-sm font-medium text-primary underline max-sm:min-h-11" data-testid="open-conversation">
            <MessageSquare className="size-4" aria-hidden />Mở hội thoại để trả lời
          </button>
        </div>
      )}
    </aside>
  )
}
