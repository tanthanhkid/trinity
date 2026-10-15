"use client"

import { useEffect, useState } from "react"
import { Ban, CalendarClock, Loader2, Megaphone, Pencil, Plus, Send, Trash2, Users } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { OptionSelect } from "./option-select"
import {
  useBroadcastMutations,
  useBroadcastRecipients,
  useBroadcasts,
  useChatLinks,
  type Broadcast,
  type BroadcastAudience,
  type BroadcastPreview,
  type BroadcastRecipientStatus,
  type BroadcastStatus,
  type FacebookPageView,
} from "./use-facebook"
import { apiErrorMessage, type SimpleOption } from "./webhook-types"

export const BROADCAST_STATUS: Record<BroadcastStatus, string> = { draft: "Nháp", scheduled: "Chờ gửi", sending: "Đang gửi", done: "Đã xong", cancelled: "Đã huỷ" }
const RECIPIENT_STATUS: Record<BroadcastRecipientStatus, string> = { queued: "Chờ gửi", sending: "Đang gửi", sent: "Đã gửi", failed: "Lỗi", skipped: "Bỏ qua" }
const MAX_TEXT = 2000
/** Hẹn tối đa 7 ngày — khớp máy chủ. */
const MAX_AHEAD_MS = 7 * 86_400_000

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Lỗi giờ hẹn (null = hợp lệ). */
export function broadcastScheduleError(value: string, now = Date.now()): string | null {
  if (!value) return "Chọn ngày giờ gửi."
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return "Ngày giờ không hợp lệ."
  if (t <= now + 60_000) return "Giờ hẹn phải sau bây giờ ít nhất 1 phút."
  if (t - now > MAX_AHEAD_MS) return "Chỉ hẹn trước tối đa 7 ngày."
  return null
}

const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

function PickList({ label, options, value, onChange, empty }: { label: string; options: SimpleOption[]; value: number[]; onChange: (v: number[]) => void; empty: string }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm max-sm:min-h-11">
              <Checkbox checked={value.includes(o.id)} onCheckedChange={() => onChange(toggle(value, o.id))} aria-label={`${label}: ${o.label}`} />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

function PreviewLine({ p, loading }: { p: BroadcastPreview | null; loading: boolean }) {
  if (loading && !p) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang đếm người nhận...</p>
  if (!p) return null
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="broadcast-preview" aria-live="polite">
      <p>
        <b>{p.eligible.toLocaleString("vi-VN")}</b> khách sẽ nhận tin nếu gửi bây giờ
        {p.sample.length > 0 && <span className="text-muted-foreground"> (vd {p.sample.join(", ")})</span>}.
      </p>
      {p.outside_window > 0 && (
        <p className="text-xs text-muted-foreground">
          {p.outside_window.toLocaleString("vi-VN")} khách khớp bộ lọc nhưng đã quá 24 giờ chưa nhắn Fanpage — Facebook không cho gửi tin cho họ.
        </p>
      )}
    </div>
  )
}

function BroadcastDialog({
  open,
  onOpenChange,
  pages,
  sources,
  broadcast,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  pages: FacebookPageView[]
  sources: SimpleOption[]
  broadcast: Broadcast | null
}) {
  const m = useBroadcastMutations()
  const links = useChatLinks(open)
  const [pageId, setPageId] = useState(broadcast?.page_id ?? pages[0]?.page_id ?? "")
  const [name, setName] = useState(broadcast?.name ?? "")
  const [text, setText] = useState(broadcast?.text ?? "")
  const [sourceIds, setSourceIds] = useState<number[]>(broadcast?.audience.source_ids ?? [])
  const [linkIds, setLinkIds] = useState<number[]>(broadcast?.audience.chat_link_ids ?? [])
  const [scheduleOn, setScheduleOn] = useState(false)
  const [scheduleAt, setScheduleAt] = useState("")
  const [preview, setPreview] = useState<BroadcastPreview | null>(null)
  const [confirm, setConfirm] = useState(false)
  const pageLinks = (links.data ?? []).filter((l) => l.page_id === pageId)
  const audience: BroadcastAudience = { source_ids: sourceIds, chat_link_ids: linkIds }
  const audienceKey = JSON.stringify([pageId, sourceIds, linkIds])

  useEffect(() => {
    if (!open || !pageId) return
    const t = setTimeout(() => m.preview.mutate({ page_id: pageId, audience }, { onSuccess: setPreview, onError: () => setPreview(null) }), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, audienceKey])

  const problem = !name.trim() ? "Đặt tên cho lượt gửi." : !text.trim() ? "Nhập nội dung tin." : text.length > MAX_TEXT ? `Nội dung tối đa ${MAX_TEXT} ký tự.` : null
  const schedErr = scheduleOn ? broadcastScheduleError(scheduleAt) : null
  const pending = m.create.isPending || m.update.isPending || m.send.isPending
  const input = { name: name.trim(), page_id: pageId, text: text.trim(), audience }

  async function saveDraft(): Promise<Broadcast | null> {
    if (problem) {
      toast.error(problem)
      return null
    }
    try {
      return broadcast ? await m.update.mutateAsync({ id: broadcast.id, ...input }) : await m.create.mutateAsync(input)
    } catch (e) {
      toast.error(apiErrorMessage(e, "Không lưu được"))
      return null
    }
  }

  async function send() {
    const b = await saveDraft()
    if (!b) return
    try {
      await m.send.mutateAsync({ id: b.id, scheduled_at: scheduleOn ? new Date(scheduleAt).toISOString() : null })
      toast.success(scheduleOn ? "Đã hẹn giờ gửi" : "Đang gửi — xem tiến độ trong danh sách")
      setConfirm(false)
      onOpenChange(false)
    } catch (e) {
      toast.error(apiErrorMessage(e, "Không gửi được"))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{broadcast ? "Sửa lượt gửi" : "Soạn tin gửi hàng loạt"}</DialogTitle>
          <DialogDescription>Một tin gửi riêng cho từng khách qua Messenger. Facebook chỉ cho Fanpage nhắn khách trong 24 giờ kể từ tin cuối của khách, nên chỉ khách vừa nhắn trong 24 giờ qua mới nhận được.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!broadcast && pages.length > 1 && (
            <OptionSelect label="Fanpage" value={pageId} onChange={(v) => { setPageId(v); setLinkIds([]) }} options={pages.map((p) => ({ value: p.page_id, label: p.name }))} className="h-9 w-[220px] max-sm:h-11 max-sm:w-full" />
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bc-name">Tên lượt gửi</Label>
            <Input id="bc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Báo lịch khai giảng tháng 11" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bc-text">Nội dung</Label>
            <Textarea id="bc-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Chào {ten}, lớp mới khai giảng ngày..." />
            <p className="flex justify-between text-xs text-muted-foreground">
              <span>{"{ten}"} thay bằng tên khách.</span>
              <span className={cn(text.length > MAX_TEXT && "text-destructive")}>{text.length}/{MAX_TEXT}</span>
            </p>
          </div>
          <PickList label="Chỉ khách thuộc nguồn" options={sources} value={sourceIds} onChange={setSourceIds} empty="Chưa có nguồn khách nào." />
          <PickList label="Chỉ khách vào chat qua link / QR" options={pageLinks.map((l) => ({ id: l.id, label: l.name }))} value={linkIds} onChange={setLinkIds} empty="Fanpage này chưa có link / QR nào." />
          <p className="text-xs text-muted-foreground">Không chọn gì = mọi khách còn trong 24 giờ của Fanpage.</p>
          <PreviewLine p={preview} loading={m.preview.isPending} />
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={scheduleOn}
                onCheckedChange={(v) => {
                  setScheduleOn(v === true)
                  if (v === true && !scheduleAt) setScheduleAt(toLocalInput(new Date(Date.now() + 60 * 60_000)))
                }}
                aria-label="Hẹn giờ gửi"
              />
              Hẹn giờ gửi
            </label>
            {scheduleOn && (
              <div className="space-y-1">
                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  min={toLocalInput(new Date(Date.now() + 2 * 60_000))}
                  max={toLocalInput(new Date(Date.now() + MAX_AHEAD_MS))}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  aria-label="Ngày giờ gửi"
                  className="w-auto"
                />
                {schedErr ? (
                  <p className="text-xs text-destructive">{schedErr}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Danh sách người nhận chốt lúc tới giờ: khách nhắn Fanpage trong 24 giờ trước giờ gửi.</p>
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button variant="outline" disabled={pending} onClick={async () => { if (await saveDraft()) { toast.success("Đã lưu nháp"); onOpenChange(false) } }}>Lưu nháp</Button>
          <Button disabled={pending || !!problem || !!schedErr || !pageId} onClick={() => setConfirm(true)}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : scheduleOn ? <CalendarClock className="size-4" /> : <Send className="size-4" />}
            {scheduleOn ? "Hẹn gửi" : "Gửi ngay"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="default"
        title={scheduleOn ? "Hẹn gửi tin hàng loạt?" : "Gửi tin hàng loạt?"}
        description={
          scheduleOn ? (
            <>Tin sẽ gửi lúc <b>{new Date(scheduleAt).toLocaleString("vi-VN")}</b> cho khách nhắn Fanpage trong 24 giờ trước đó. Huỷ được trước giờ gửi.</>
          ) : (
            <>Gửi ngay cho <b>{preview?.eligible ?? 0}</b> khách. Tin đã gửi không thu hồi được.</>
          )
        }
        confirmLabel={scheduleOn ? "Hẹn gửi" : "Gửi"}
        pending={pending}
        onConfirm={send}
      />
    </Dialog>
  )
}

function RecipientsList({ id }: { id: number }) {
  const r = useBroadcastRecipients(id, true)
  if (r.isLoading) return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Đang tải" />
  if (r.isError) return <p className="text-sm text-destructive">Không tải được người nhận.</p>
  if (!r.data?.length) return <p className="text-sm text-muted-foreground">Chưa có người nhận — danh sách chốt lúc bắt đầu gửi.</p>
  return (
    <ul className="max-h-64 divide-y overflow-y-auto text-sm" data-testid="broadcast-recipients">
      {r.data.map((x) => (
        <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
          <span className="font-medium">{x.customer_name ?? `Hội thoại #${x.conversation_id}`}</span>
          <Badge variant={x.status === "sent" ? "success" : x.status === "failed" ? "destructive" : "secondary"}>{RECIPIENT_STATUS[x.status] ?? x.status}</Badge>
          {x.note && <span className="text-xs text-muted-foreground">{x.note}</span>}
        </li>
      ))}
    </ul>
  )
}

function BroadcastCard({ b, pages, sources, highlight }: { b: Broadcast; pages: FacebookPageView[]; sources: SimpleOption[]; highlight: boolean }) {
  const m = useBroadcastMutations()
  const [edit, setEdit] = useState(false)
  const [del, setDel] = useState(false)
  const [stop, setStop] = useState(false)
  const [showList, setShowList] = useState(highlight)
  const live = b.status === "scheduled" || b.status === "sending"
  const when = b.scheduled_at ? new Date(b.scheduled_at).toLocaleString("vi-VN") : null
  return (
    <Card id={`broadcast-${b.id}`} className={cn(highlight && "ring-2 ring-primary")} data-testid="broadcast-card">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{b.name}</p>
          <Badge variant={b.status === "done" ? "success" : b.status === "sending" || b.status === "scheduled" ? "soft" : "secondary"}>{BROADCAST_STATUS[b.status]}</Badge>
          {b.source === "mcp" && <Badge variant="outline">Tạo qua trợ lý AI</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          Fanpage {b.page_name ?? b.page_id}
          {when && <> · {b.status === "scheduled" ? "gửi lúc" : "bắt đầu"} {when}</>}
        </p>
        <p className="line-clamp-2 whitespace-pre-line text-sm">{b.text}</p>
        {b.status !== "draft" && b.status !== "scheduled" && (
          <p className="text-sm">
            Đã gửi <b>{b.sent}</b>/{b.total}
            {b.failed > 0 && <> · <span className="text-destructive">{b.failed} lỗi</span></>}
            {b.skipped > 0 && <> · {b.skipped} bỏ qua (quá 24 giờ)</>}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {b.status === "draft" && <Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil className="size-4" /> Sửa & gửi</Button>}
          {b.status !== "draft" && b.status !== "scheduled" && (
            <Button size="sm" variant="outline" aria-expanded={showList} onClick={() => setShowList((x) => !x)}><Users className="size-4" /> Người nhận</Button>
          )}
          {live && <Button size="sm" variant="outline" onClick={() => setStop(true)}><Ban className="size-4" /> Huỷ gửi</Button>}
          {!live && (
            <Button size="sm" variant="ghost" className="ml-auto text-red-600" onClick={() => setDel(true)} aria-label={`Xoá lượt gửi ${b.name}`}><Trash2 className="size-4" /></Button>
          )}
        </div>
        {showList && <RecipientsList id={b.id} />}
      </CardContent>
      {edit && <BroadcastDialog open={edit} onOpenChange={setEdit} pages={pages} sources={sources} broadcast={b} />}
      <ConfirmDialog
        open={stop}
        onOpenChange={setStop}
        title="Huỷ lượt gửi?"
        description={<>Khách chưa nhận tin của <b>{b.name}</b> sẽ không nhận nữa. Tin đã gửi giữ nguyên.</>}
        confirmLabel="Huỷ gửi"
        cancelLabel="Đóng"
        pending={m.cancel.isPending}
        onConfirm={() => m.cancel.mutate(b.id, { onSuccess: () => { toast.success("Đã huỷ lượt gửi"); setStop(false) }, onError: (e) => toast.error(apiErrorMessage(e, "Không huỷ được")) })}
      />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Xoá lượt gửi?"
        description={<>Lượt <b>{b.name}</b> và danh sách người nhận sẽ bị xoá. Tin đã gửi vẫn nằm trong hộp thư và lịch sử khách.</>}
        confirmLabel="Xoá lượt gửi"
        pending={m.remove.isPending}
        onConfirm={() => m.remove.mutate(b.id, { onSuccess: () => { toast.success("Đã xoá lượt gửi"); setDel(false) }, onError: (e) => toast.error(apiErrorMessage(e, "Không xoá được")) })}
      />
    </Card>
  )
}

/** Cài đặt › Fanpage › Gửi hàng loạt: một tin cho nhiều khách qua Messenger, chỉ khách còn trong cửa sổ 24 giờ. */
export function FacebookBroadcasts({ pages, sources, highlight }: { pages: FacebookPageView[]; sources: SimpleOption[]; highlight?: number }) {
  const list = useBroadcasts(true)
  const [open, setOpen] = useState(false)
  const active = pages.filter((p) => p.is_active)
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Gửi một tin cho nhiều khách cùng lúc qua Messenger (báo lịch, khuyến mãi, nhắc hẹn). Theo luật của Facebook, Fanpage chỉ được nhắn khách trong 24 giờ kể từ tin cuối của khách — khách cũ hơn sẽ không nhận được, Trinity tự bỏ qua họ.
      </p>
      <Button onClick={() => setOpen(true)} disabled={!active.length} className="max-sm:h-11"><Plus className="size-4" /> Soạn tin gửi hàng loạt</Button>
      {!active.length && <p className="text-xs text-muted-foreground">Cần kết nối một Fanpage trước (mục Fanpage).</p>}
      {list.isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Đang tải" />}
      {list.isError && <p className="text-sm text-destructive">Không tải được danh sách lượt gửi.</p>}
      {list.isSuccess && list.data.length === 0 && <EmptyState icon={Megaphone} message="Chưa có lượt gửi hàng loạt nào." />}
      <div className="grid gap-3 xl:grid-cols-2">
        {list.data?.map((b) => <BroadcastCard key={b.id} b={b} pages={active} sources={sources} highlight={b.id === highlight} />)}
      </div>
      {open && <BroadcastDialog open={open} onOpenChange={setOpen} pages={active} sources={sources} broadcast={null} />}
    </div>
  )
}
