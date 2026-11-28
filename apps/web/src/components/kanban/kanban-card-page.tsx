"use client"

/**
 * Trang chi tiết MỘT việc (thẻ Kanban) — «Ánh xanh» congviec-desktop / congviec-mobile(+2).
 *
 * Một bộ điều khiển (`useCardController`: dữ liệu, quyền, ghi + toast Hoàn tác) dùng cho HAI bố cục khác nhau:
 *  - desktop ≥1024px: khối nhấn (tên việc + giai đoạn) · Mô tả · Việc con · Ghi chú và lịch sử | cột thuộc tính 360px;
 *  - điện thoại: khối nhấn gọn · hàng giai đoạn cuộn ngang · danh sách Hạn/Người làm/Ưu tiên (Hạn, Người làm mở khay đáy)
 *    · Việc con · Mô tả · Ghi chú · thanh «Hoàn thành việc» dính đáy.
 * Dữ liệu, quyền, API giống hộp thoại chi tiết ở `/kanban` (KanbanCardDialog) — chỉ đổi giao diện.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { ChevronLeft, ChevronRight, Check, X } from "lucide-react"
import { toast } from "sonner"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { MentionEditor } from "@/components/refs/mention-editor"
import { MentionText } from "@/components/refs/mention-text"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  BottomSheet,
  BottomSheetClose,
  BottomSheetContent,
} from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { buttonVariants } from "@/components/ui/button-variants"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { HeroCard } from "@/components/ui/hero-card"
import { Skeleton } from "@/components/ui/skeleton"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { showUndoToast } from "@/components/ui/undo-toast"
import { Input } from "@/components/ui/input"
import { getApiErrorMessage } from "@/lib/api-client"
import { formatDateTimeVn } from "@/lib/format"
import { cn } from "@/lib/utils"
import { isoToVnLocal, vnLocalToIso } from "@/lib/vn-datetime"
import { useAuth } from "@/hooks/use-auth"
import { usePermissions } from "@/lib/rbac"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import {
  useDeleteKanbanCardWithUndo,
  useKanbanCard,
  useMoveKanbanCard,
  useUpdateKanbanCard,
} from "@/hooks/kanban/use-kanban-cards"
import {
  useCreateKanbanChecklistItem,
  useDeleteKanbanChecklistItem,
  useKanbanChecklist,
  useUpdateKanbanChecklistItem,
} from "@/hooks/kanban/use-kanban-checklist"
import { useAddKanbanComment, useKanbanCardActivities } from "@/hooks/kanban/use-kanban-card-activities"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"
import { KANBAN_PRIORITIES, type KanbanCard, type KanbanColumn, type KanbanPriority } from "@/types/kanban"
import { KanbanAttachmentPanel } from "./kanban-attachment-panel"
import { KanbanAttributeField } from "./kanban-attribute-field"
import { KanbanContactPicker } from "./kanban-contact-picker"
import { KanbanMultiUserPicker } from "./kanban-multi-user-picker"
import { describeActivity } from "./kanban-activity-describe"

const MarkdownWithMentions = dynamic(
  () => import("@/components/refs/markdown-with-mentions").then((m) => m.MarkdownWithMentions),
  { ssr: false, loading: () => null },
)

const PRIORITY_LABELS: Record<KanbanPriority, string> = { low: "Thấp", normal: "Bình thường", high: "Cao", urgent: "Khẩn cấp" }
const COMMENT_MAX = 5000
const DEFAULT_DUE_TIME = "17:00"
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"]

// ───────────────────────── ngày ─────────────────────────

const two = (n: number) => String(n).padStart(2, "0")
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const dayKey = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
const dm = (d: Date) => `${two(d.getDate())}/${two(d.getMonth() + 1)}`
const fullDate = (d: Date) => `${WEEKDAYS[d.getDay()]} ${dm(d)}/${d.getFullYear()}`
const addDays = (n: number) => {
  const d = startOfDay(new Date())
  d.setDate(d.getDate() + n)
  return d
}
/** `YYYY-MM-DDTHH:mm` (giờ VN) → Date ngày/giờ local để hiển thị. */
function parseLocal(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null
}
function parseVnDate(text: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim())
  if (!m) return null
  const d = new Date(+m[3], +m[2] - 1, +m[1])
  return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? d : null
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0 || !parts[0]) return "?"
  const last = parts[parts.length - 1]
  return (parts.length > 1 ? parts[0][0] + last[0] : last.slice(0, 2)).toUpperCase()
}

// ───────────────────────── bộ điều khiển ─────────────────────────

function useCardController(cardId: number) {
  const router = useRouter()
  const { user } = useAuth()
  const { can, isAdmin } = usePermissions()
  const cardQ = useKanbanCard(cardId)
  const card = cardQ.data
  const { data: board } = useKanbanBoardDetail(card?.board_id ?? null)
  const updateCard = useUpdateKanbanCard()
  const moveCard = useMoveKanbanCard()
  const deleteCard = useDeleteKanbanCardWithUndo()
  const rosterData = useKanbanUserRoster().data
  const roster = useMemo(() => rosterData ?? [], [rosterData])
  const checklistQ = useKanbanChecklist(cardId)
  const createItem = useCreateKanbanChecklistItem(cardId)
  const updateItem = useUpdateKanbanChecklistItem(cardId)
  const deleteItem = useDeleteKanbanChecklistItem(cardId)
  const activitiesQ = useKanbanCardActivities(cardId)
  const addComment = useAddKanbanComment(cardId)

  const columns = useMemo(() => (board?.columns ?? []).filter((c) => !c.is_archived).sort((a, b) => a.position - b.position), [board])
  const labelDefs = useMemo(() => board?.label_defs ?? [], [board])
  const nameById = useMemo(() => new Map(roster.map((u) => [u.id, u.full_name])), [roster])
  const currentColumn = columns.find((c) => c.id === card?.column_id) ?? null
  const isDone = currentColumn?.is_done ?? false

  const patch = (payload: Record<string, unknown>, onOk?: () => void) => {
    updateCard.mutate(
      { id: cardId, payload },
      { onSuccess: onOk, onError: (err) => toast.error(getApiErrorMessage(err, "Không lưu được thay đổi")) },
    )
  }
  /** Lưu NGAY (lạc quan) rồi cho Hoàn tác: `undo` là payload đưa các trường về giá trị cũ. */
  const commit = (payload: Record<string, unknown>, undo: Record<string, unknown>, label: string) => {
    patch(payload, () => showUndoToast(label, { onUndo: () => patch(undo) }))
  }

  const pickColumn = (col: KanbanColumn) => {
    if (!card || col.id === card.column_id) return
    const prev = card.column_id
    moveCard.mutate(
      { id: cardId, payload: { column_id: col.id } },
      {
        onSuccess: (r) => {
          if (r.wip_warning) toast.warning(r.wip_warning)
          showUndoToast(`Đã chuyển sang ${col.name}`, { onUndo: () => moveCard.mutate({ id: cardId, payload: { column_id: prev } }) })
        },
        onError: (err) => toast.error(getApiErrorMessage(err, "Không chuyển được giai đoạn")),
      },
    )
  }
  /** Hoàn thành ⇄ mở lại: sang cột «xong» đầu tiên / cột đầu tiên không phải «xong». */
  const toggleFinish = () => {
    const target = isDone ? columns.find((c) => !c.is_done) : columns.find((c) => c.is_done)
    if (!target) {
      toast.error("Bảng này chưa có cột hoàn thành — thêm cột ở Cài đặt bảng.")
      return
    }
    pickColumn(target)
  }

  const canDelete = card ? isAdmin || (user?.id != null && user.id === card.created_by) : false
  const remove = () => {
    deleteCard(cardId, card?.title)
    router.push("/kanban")
  }

  return {
    cardQ, card, board, columns, labelDefs, nameById, roster, currentColumn, isDone,
    checklist: checklistQ.data ?? [], createItem, updateItem, deleteItem,
    activities: activitiesQ.data ?? [], activitiesLoading: activitiesQ.isLoading, addComment,
    patch, commit, pickColumn, toggleFinish, canDelete, remove,
    canLinkContact: can("contacts.view"),
    canManage: can("kanban.manage"),
  }
}
type Ctl = ReturnType<typeof useCardController> & { card: KanbanCard }

// ───────────────────────── khối dùng chung ─────────────────────────

const SECTION = "rounded-ax-card border border-ax-line ax-grad-card p-4 shadow-ax-card lg:p-6"
const GROUP = "ax-text-group"

function dueInfo(card: KanbanCard, isDone: boolean) {
  const local = isoToVnLocal(card.due_at)
  const due = local ? parseLocal(local) : null
  if (!due) return { has: false as const, text: "Chưa đặt hạn", sub: "Việc này chưa có hạn.", tone: "muted" as const, overdue: false, dateKey: "" }
  const time = local.slice(11, 16)
  const diff = Math.round((startOfDay(due).getTime() - startOfDay(new Date()).getTime()) / 86400000)
  const finished = isDone || card.due_completed_at != null
  let sub = `Còn ${diff} ngày.`
  let tone: "muted" | "danger" | "warn" | "ok" = "muted"
  const overdue = diff < 0 && !finished
  if (finished) { sub = "Đã xử lý."; tone = "ok" }
  else if (overdue) { sub = `Quá hạn ${-diff} ngày. Chọn hạn mới hoặc đánh dấu đã xử lý.`; tone = "danger" }
  else if (diff === 0) { sub = "Đến hạn hôm nay."; tone = "warn" }
  return { has: true as const, text: `${fullDate(due)} · ${time}`, shortText: `${WEEKDAYS[due.getDay()]} ${dm(due)} · ${time}`, sub, tone, overdue, dateKey: dayKey(due), time }
}
const TONE_TEXT = { muted: "text-ax-ink-2", danger: "text-ax-danger font-semibold", warn: "text-ax-warn font-semibold", ok: "text-ax-success" } as const

function setDue(c: Ctl, date: Date) {
  const time = c.card.due_at ? isoToVnLocal(c.card.due_at).slice(11, 16) : DEFAULT_DUE_TIME
  const iso = vnLocalToIso(`${dayKey(date)}T${time}`)
  c.commit({ due_at: iso, due_completed_at: null }, { due_at: c.card.due_at, due_completed_at: c.card.due_completed_at }, `Đã đổi hạn sang ${dm(date)}`)
}
function clearDue(c: Ctl) {
  c.commit({ due_at: null, due_completed_at: null }, { due_at: c.card.due_at, due_completed_at: c.card.due_completed_at }, "Đã bỏ hạn")
}
function toggleDueDone(c: Ctl) {
  const was = c.card.due_completed_at
  c.commit({ due_completed_at: was ? null : new Date().toISOString() }, { due_completed_at: was }, was ? "Đã mở lại hạn" : "Đã đánh dấu xử lý đúng hạn")
}
function toggleAssignee(c: Ctl, id: number) {
  const cur = c.card.assignee_ids
  const on = cur.includes(id)
  const next = on ? cur.filter((x) => x !== id) : [...cur, id]
  const name = c.nameById.get(id) ?? "người này"
  c.commit({ assignee_ids: next }, { assignee_ids: cur }, on ? `Đã bỏ ${name} khỏi việc` : `Đã giao thêm cho ${name}`)
}
function setPriority(c: Ctl, p: KanbanPriority) {
  const cur = c.card.priority
  c.commit({ priority: cur === p ? null : p }, { priority: cur }, cur === p ? "Đã bỏ mức ưu tiên" : `Đã đặt ưu tiên ${PRIORITY_LABELS[p].toLowerCase()}`)
}
function toggleLabel(c: Ctl, id: string) {
  const cur = c.card.labels
  const next = cur.includes(id) ? cur.filter((l) => l !== id) : [...cur, id]
  c.commit({ labels: next }, { labels: cur }, "Đã đổi nhãn")
}

const CHIP = (on: boolean, danger = false) =>
  cn(
    "inline-flex cursor-pointer items-center justify-center rounded-ax-field border-[1.5px] text-sm font-semibold transition-colors outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
    on
      ? danger
        ? "border-ax-danger bg-ax-danger-soft text-[var(--ax-danger-ink)]"
        : "border-ax-primary bg-ax-primary-soft text-ax-primary-ink"
      : "border-ax-line bg-ax-surface text-ax-ink-2 hover:bg-ax-hover",
  )

function TickBox({ on, size = 22 }: { on: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn("flex shrink-0 items-center justify-center rounded-[7px] border-2", on ? "border-ax-success bg-ax-success" : "border-ax-field-border bg-ax-surface")}
    >
      <Check className={cn("size-3.5 text-white", on ? "opacity-100" : "opacity-0")} strokeWidth={3.4} />
    </span>
  )
}

/** Giai đoạn = cột của bảng; một nhóm nút chọn 1 (aria-pressed). Chấm theo màu cột. */
function StageButtons({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  return (
    <div
      role="group"
      aria-label="Trạng thái"
      className={cn(
        mobile
          ? "flex gap-2 overflow-x-auto px-4 pb-3.5"
          : "grid gap-1.5 p-3 ax-grad-soft [grid-template-columns:repeat(auto-fit,minmax(112px,1fr))]",
      )}
    >
      {c.columns.map((col) => {
        const on = col.id === c.card.column_id
        return (
          <button
            key={col.id}
            type="button"
            aria-pressed={on}
            onClick={() => c.pickColumn(col)}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 border font-semibold transition-colors outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
              mobile ? "h-12 rounded-full px-[18px] text-base" : "h-12 rounded-ax-field px-3 text-[15px]",
              on ? "border-ax-primary/40 bg-ax-primary-soft text-ax-primary-ink" : "border-ax-line bg-ax-surface text-ax-ink-2 hover:bg-ax-hover",
            )}
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: col.color || "var(--ax-ink-3)" }} />
            <span className="truncate">{col.name}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Tên việc: bấm để sửa tại chỗ (Enter lưu, Esc bỏ). Trên khối nhấn nên chữ trắng. */
function TitleEditor({ c, className, inputClass }: { c: Ctl; className: string; inputClass: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const done = c.isDone
  const finish = (save: boolean) => {
    const v = draft.trim()
    setEditing(false)
    if (save && v && v !== c.card.title) c.commit({ title: v }, { title: c.card.title }, "Đã đổi tên việc")
  }
  if (editing) {
    return (
      <>
        <label htmlFor="cv-title" className="sr-only">Tên việc</label>
        <input
          id="cv-title"
          autoFocus
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false) }}
          onBlur={() => finish(true)}
          className={cn("w-full rounded-ax-field border border-white/30 bg-[rgba(13,32,54,.30)] px-3 font-semibold tracking-tight text-white outline-none focus:border-white focus:shadow-[0_0_0_3px_rgba(255,255,255,.28)]", inputClass)}
        />
      </>
    )
  }
  return (
    <button
      type="button"
      aria-label={`Sửa tên việc: ${c.card.title}`}
      onClick={() => { setDraft(c.card.title); setEditing(true) }}
      className="block min-h-11 w-full cursor-text text-left outline-none focus-visible:shadow-[0_0_0_2px_rgba(255,255,255,.6)]"
    >
      <h1 className={cn(className, done && "line-through")}>{c.card.title}</h1>
    </button>
  )
}

function DescriptionBlock({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const desc = c.card.description ?? ""
  const start = () => { setDraft(desc); setEditing(true) }
  const save = () => {
    setEditing(false)
    if (draft !== desc) c.commit({ description: draft.trim() || null }, { description: c.card.description }, "Đã lưu mô tả")
  }
  const view = (
    <button
      type="button"
      onClick={start}
      className={cn(
        "-m-2 block w-[calc(100%+16px)] cursor-text rounded-ax-field p-2 text-left leading-relaxed outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]",
        mobile ? "text-base" : "text-[15px]",
        desc.trim() ? "text-ax-ink" : "text-ax-ink-2",
      )}
    >
      {desc.trim() ? (
        <div className="[&_a]:text-ax-primary [&_a]:underline [&_code]:rounded [&_code]:bg-ax-sunken [&_code]:px-1 [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
          <MarkdownWithMentions text={desc} />
        </div>
      ) : (
        "Chưa có mô tả. Bấm để thêm bối cảnh cho người nhận việc."
      )}
    </button>
  )
  const edit = (
    <div>
      <MentionEditor
        value={draft}
        onChange={(v) => setDraft(v ?? "")}
        rows={4}
        maxLength={10000}
        placeholder="Hỗ trợ Markdown — **đậm**, *nghiêng*, danh sách. Gõ @ để gắn thẻ khách hàng, công việc, bản ghi khác (vd @KH001)"
      />
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="ax-primary" size="ax-lg" className="px-5" onClick={save}>Lưu</Button>
        <Button type="button" variant="ax-secondary" size="ax-lg" onClick={() => setEditing(false)}>Huỷ</Button>
      </div>
    </div>
  )
  return editing ? edit : view
}

function ChecklistBlock({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const [draft, setDraft] = useState("")
  const items = c.checklist
  const done = items.filter((i) => i.is_done).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0
  const add = () => {
    const text = draft.trim()
    if (!text || c.createItem.isPending) return
    c.createItem.mutate({ text }, {
      onSuccess: () => { setDraft(""); showUndoToast("Đã thêm việc con") },
      onError: (err) => toast.error(getApiErrorMessage(err, "Không thêm được việc con")),
    })
  }
  const toggle = (id: number, is_done: boolean) =>
    c.updateItem.mutate({ id, payload: { is_done: !is_done } }, { onError: (err) => toast.error(getApiErrorMessage(err, "Không cập nhật được việc con")) })
  const remove = (id: number, text: string) =>
    c.deleteItem.mutate(id, {
      onSuccess: () => showUndoToast("Đã xoá việc con", { onUndo: () => c.createItem.mutate({ text }) }),
      onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được việc con")),
    })

  const addInput = (
    <>
      <label htmlFor={mobile ? "m-add" : "cv-add"} className="sr-only">Thêm việc con</label>
      <Input
        id={mobile ? "m-add" : "cv-add"}
        variant="ax"
        value={draft}
        maxLength={500}
        placeholder={mobile ? "Thêm việc con" : "Thêm việc con, Enter để lưu"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add() } }}
        className={mobile ? "border-0 px-1 shadow-none" : "mt-2"}
      />
    </>
  )

  if (mobile) {
    return (
      <>
        <h2 className={cn(GROUP, "mx-8 mt-5 mb-2")}>Việc con · <span className="tabular-nums">{done}/{items.length}</span></h2>
        <div className="mx-4 overflow-hidden rounded-[14px] bg-ax-surface">
          {items.map((it, i) => (
            <div key={it.id} className={cn("flex min-h-14 items-center", i > 0 && "border-t border-ax-divider")}>
              <button type="button" role="checkbox" aria-checked={it.is_done} onClick={() => toggle(it.id, it.is_done)} className="flex min-h-14 flex-1 cursor-pointer items-center gap-3.5 px-4 text-left outline-none focus-visible:shadow-[inset_var(--ax-focus-ring)]">
                <TickBox on={it.is_done} size={26} />
                <span className={cn("flex-1 text-base", it.is_done ? "text-ax-ink-2 line-through" : "text-ax-ink")}>{it.text}</span>
              </button>
              <button type="button" aria-label={`Xoá việc con ${it.text}`} onClick={() => remove(it.id, it.text)} className="flex size-12 shrink-0 cursor-pointer items-center justify-center text-ax-ink-3">
                <X className="size-4" />
              </button>
            </div>
          ))}
          <div className={cn("px-3 py-2", items.length > 0 && "border-t border-ax-divider")}>{addInput}</div>
        </div>
      </>
    )
  }
  return (
    <section aria-labelledby="ck" className={SECTION}>
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 id="ck" className={GROUP}>Việc con</h2>
        <span className="text-sm font-semibold tabular-nums text-ax-ink-2">{done}/{items.length} xong</span>
      </div>
      <div aria-hidden className="mb-2 h-1.5 overflow-hidden rounded-[3px] bg-ax-line"><div className="h-full rounded-[3px] bg-ax-success" style={{ width: `${pct}%` }} /></div>
      <ul>
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-1 rounded-[10px] hover:bg-ax-hover">
            <button type="button" role="checkbox" aria-checked={it.is_done} aria-label={it.text} onClick={() => toggle(it.id, it.is_done)} className="flex size-11 shrink-0 cursor-pointer items-center justify-center outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
              <TickBox on={it.is_done} />
            </button>
            <span className={cn("flex-1 text-[15px]", it.is_done ? "text-ax-ink-2 line-through" : "text-ax-ink")}>{it.text}</span>
            <button type="button" aria-label={`Xoá việc con ${it.text}`} onClick={() => remove(it.id, it.text)} className="flex size-11 shrink-0 cursor-pointer items-center justify-center text-ax-ink-3 hover:text-ax-ink">
              <X className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {addInput}
    </section>
  )
}

function CommentComposer({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const [draft, setDraft] = useState("")
  const submit = () => {
    const content = draft.trim()
    if (!content || c.addComment.isPending) return
    c.addComment.mutate(content, {
      onSuccess: () => setDraft(""),
      onError: (err) => toast.error(getApiErrorMessage(err, "Không gửi được bình luận")),
    })
  }
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <MentionEditor
          value={draft}
          onChange={(v) => setDraft(v ?? "")}
          onSubmit={submit}
          placeholder={mobile ? "Viết ghi chú… gõ @ để gắn thẻ" : "Viết ghi chú cho cả nhóm… gõ @ để gắn thẻ (Ctrl/⌘ + Enter để gửi)"}
          rows={2}
          maxLength={COMMENT_MAX}
        />
      </div>
      <Button type="button" variant="ax-primary" size="ax-lg" className={mobile ? "w-[72px]" : "px-[18px]"} onClick={submit} disabled={c.addComment.isPending || !draft.trim()}>
        Gửi
      </Button>
    </div>
  )
}

function ActivityBlock({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const columnName = (id: unknown) => c.columns.find((x) => x.id === id)?.name ?? "đã xoá"
  const list = mobile ? c.activities.filter((a) => a.action === "comment") : c.activities
  if (mobile) {
    return (
      <>
        <h2 className={cn(GROUP, "mx-8 mt-5 mb-2")}>Ghi chú</h2>
        <div className="mx-4 flex flex-col gap-3 rounded-[14px] bg-ax-surface px-4 py-3">
          {c.activitiesLoading ? <p className="text-sm text-ax-ink-2">Đang tải ghi chú…</p> : null}
          {list.map((a) => (
            <div key={a.id}>
              <div className="text-[13px] text-ax-ink-2"><b className="text-ax-ink">{a.actor_name ?? "Hệ thống"}</b> · {formatDateTimeVn(a.created_at)}</div>
              <div className="mt-0.5 text-base leading-normal whitespace-pre-wrap break-words"><MentionText text={describeActivity(a, columnName)} /></div>
            </div>
          ))}
          <CommentComposer c={c} mobile />
        </div>
      </>
    )
  }
  return (
    <section aria-labelledby="gc" className={SECTION}>
      <h2 id="gc" className={cn(GROUP, "mb-2.5")}>Ghi chú và lịch sử</h2>
      <div className="mb-3.5"><CommentComposer c={c} /></div>
      {c.activitiesLoading ? (
        <p className="text-sm text-ax-ink-2">Đang tải lịch sử…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-ax-ink-2">Chưa có hoạt động nào.</p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {list.map((a) => {
            const isComment = a.action === "comment"
            const who = a.actor_name ?? "Hệ thống"
            return (
              <li key={a.id} className="flex gap-3">
                <Avatar kind="staff"><AvatarFallback>{initials(who)}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1">
                  {isComment ? (
                    <>
                      <div className="text-sm"><b>{who}</b> <span className="text-ax-ink-2">đã ghi chú</span></div>
                      <div className="mt-1.5 rounded-[10px] bg-ax-bg px-3 py-2 text-[15px] leading-normal whitespace-pre-wrap break-words"><MentionText text={describeActivity(a, columnName)} /></div>
                    </>
                  ) : (
                    <div className="text-sm"><b>{who}</b> <span className="text-ax-ink-2">{describeActivity(a, columnName)}</span></div>
                  )}
                  <div className="text-xs tabular-nums text-ax-ink-2">{formatDateTimeVn(a.created_at)}</div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** Trường tuỳ biến của bảng — giữ nguyên chức năng của hộp thoại cũ (gom 600ms rồi PATCH, gửi đúng key đổi). */
function CustomFields({ c }: { c: Ctl }) {
  const defs = c.board?.field_defs ?? []
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const timer = useRef<number | null>(null)
  const pending = useRef<Record<string, unknown>>({})
  const patchRef = useRef(c.patch)
  useEffect(() => { patchRef.current = c.patch })
  const flush = () => {
    timer.current = null
    const p = pending.current
    pending.current = {}
    if (Object.keys(p).length > 0) patchRef.current({ attributes: p })
  }
  useEffect(() => () => { if (timer.current !== null) { window.clearTimeout(timer.current); flush() } }, [])
  if (defs.length === 0) return null
  const change = (def: { key: string; type: string }, value: unknown) => {
    setDraft((d) => ({ ...d, [def.key]: value }))
    pending.current = { ...pending.current, [def.key]: value }
    if (timer.current !== null) window.clearTimeout(timer.current)
    if (["text", "url", "number", "money"].includes(def.type)) timer.current = window.setTimeout(flush, 600)
    else flush()
  }
  return (
    <section aria-labelledby="tt" className={SECTION}>
      <h2 id="tt" className={cn(GROUP, "mb-3")}>Trường tuỳ biến</h2>
      <div className="flex flex-col gap-3">
        {defs.map((def) => (
          <div key={def.id}>
            <label className="mb-1 block text-sm text-ax-ink-2">{def.label}{def.required && <span className="text-ax-danger"> *</span>}</label>
            <KanbanAttributeField def={def} value={def.key in draft ? draft[def.key] : c.card.attributes[def.key]} onChange={(v) => change(def, v)} />
          </div>
        ))}
      </div>
    </section>
  )
}

function PeopleList({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const ids = c.card.assignee_ids
  // Roster rỗng (thiếu quyền users.view) ⇒ giữ bộ chọn cũ để vẫn gán được người.
  if (c.roster.length === 0) {
    return <KanbanMultiUserPicker value={ids} onChange={(assignee_ids) => c.patch({ assignee_ids })} />
  }
  const sorted = [...c.roster].sort((a, b) => Number(ids.includes(b.id)) - Number(ids.includes(a.id)) || a.full_name.localeCompare(b.full_name, "vi"))
  return (
    <div className="flex flex-col gap-1">
      {sorted.map((u) => {
        const on = ids.includes(u.id)
        return (
          <button
            key={u.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => toggleAssignee(c, u.id)}
            className={cn("flex cursor-pointer items-center gap-3 rounded-ax-field px-2 text-left outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]", mobile ? "min-h-14 gap-3.5 px-3.5" : "min-h-12")}
          >
            <Avatar kind="staff" size={mobile ? "lg" : "default"}>
              <AvatarFallback className={on ? "!bg-none !bg-ax-primary !text-white" : undefined}>{initials(u.full_name)}</AvatarFallback>
            </Avatar>
            <span className={cn("flex-1", mobile ? "text-[17px]" : "text-[15px]", on ? "font-semibold" : "font-normal")}>{u.full_name}</span>
            {mobile ? <Check className={cn("size-[22px] text-ax-primary", on ? "opacity-100" : "opacity-0")} strokeWidth={3} aria-hidden /> : on ? <span className="text-[13px] font-semibold text-ax-success">Đang làm</span> : null}
          </button>
        )
      })}
    </div>
  )
}

function DuePicker({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const info = dueInfo(c.card, c.isDone)
  const [text, setText] = useState("")
  const [err, setErr] = useState(false)
  const presets: [string, Date][] = [["Hôm nay", addDays(0)], ["Ngày mai", addDays(1)], [WEEKDAYS[addDays(2).getDay()], addDays(2)], ["Tuần sau", addDays(7)]]
  const submit = () => {
    const d = parseVnDate(text)
    if (!d) { setErr(true); return }
    setErr(false); setText(""); setDue(c, d)
  }
  return (
    <>
      <div role="group" aria-label="Chọn hạn" className={mobile ? "flex flex-col gap-0.5" : "mt-3 flex flex-wrap gap-1.5"}>
        {presets.map(([label, d]) => {
          const on = info.has && info.dateKey === dayKey(d)
          return mobile ? (
            <button key={label} type="button" aria-pressed={on} onClick={() => setDue(c, d)} className={cn("flex min-h-14 cursor-pointer items-center justify-between rounded-[10px] px-3.5 text-[17px]", on ? "bg-ax-primary-soft font-semibold text-ax-primary-ink" : "text-ax-ink hover:bg-ax-hover")}>
              <span>{label}</span><span className="text-[15px] font-normal tabular-nums text-ax-ink-2">{dm(d)}</span>
            </button>
          ) : (
            <button key={label} type="button" aria-pressed={on} onClick={() => setDue(c, d)} className={cn(CHIP(on), "h-10 px-3 text-sm")}>{label} {dm(d)}</button>
          )
        })}
        {info.has ? (
          mobile ? (
            <button type="button" onClick={() => clearDue(c)} className="flex min-h-14 cursor-pointer items-center rounded-[10px] px-3.5 text-[17px] font-semibold text-ax-danger hover:bg-ax-danger-soft">Bỏ hạn</button>
          ) : (
            <button type="button" onClick={() => clearDue(c)} className={cn(CHIP(false), "h-10 px-3 !text-ax-danger")}>Bỏ hạn</button>
          )
        ) : null}
      </div>
      <div className="mt-2.5">
        <label htmlFor={mobile ? "m-date" : "cv-date"} className={cn("text-ax-ink-2", mobile ? "text-sm" : "text-[13px]")}>Hoặc nhập ngày (dd/mm/yyyy)</label>
        <Input
          id={mobile ? "m-date" : "cv-date"}
          variant="ax"
          inputMode="numeric"
          className="mt-1"
          placeholder="05/12/2026"
          value={text}
          aria-invalid={err || undefined}
          onChange={(e) => { setText(e.target.value); setErr(false) }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
          onBlur={() => { if (text.trim()) submit() }}
        />
        {err ? <div role="alert" className="mt-1 text-[13px] text-ax-danger">Ngày chưa đúng. Nhập theo dạng 05/12/2026.</div> : null}
      </div>
    </>
  )
}

function PrioritiesAndLabels({ c }: { c: Ctl }) {
  return (
    <section className="rounded-ax-card border border-ax-line ax-grad-card p-4 shadow-ax-card">
      <div className={GROUP} id="hp">Ưu tiên</div>
      <div role="group" aria-labelledby="hp" className="mt-2 grid grid-cols-2 gap-1.5">
        {KANBAN_PRIORITIES.map((p) => (
          <button key={p} type="button" aria-pressed={c.card.priority === p} onClick={() => setPriority(c, p)} className={cn(CHIP(c.card.priority === p, p === "high" || p === "urgent"), "h-11 text-[15px]")}>
            {PRIORITY_LABELS[p]}
          </button>
        ))}
      </div>
      <div className={cn(GROUP, "mt-4")} id="hl">Nhãn</div>
      {c.labelDefs.length === 0 ? (
        <p className="mt-2 text-sm text-ax-ink-2">Bảng này chưa có nhãn.</p>
      ) : (
        <div role="group" aria-labelledby="hl" className="mt-2 flex flex-wrap gap-1.5">
          {c.labelDefs.map((l) => {
            const on = c.card.labels.includes(l.id)
            return (
              <button key={l.id} type="button" aria-pressed={on} onClick={() => toggleLabel(c, l.id)} className={cn(CHIP(on), "h-10 gap-2 rounded-full px-3.5")}>
                <span aria-hidden className="size-2 rounded-full" style={{ background: l.color }} />{l.name}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ContactBlock({ c, mobile }: { c: Ctl; mobile?: boolean }) {
  const contact = c.card.contact
  if (!c.canLinkContact) {
    return <p className="text-sm text-ax-ink-2">Vai trò của bạn không xem được thông tin khách hàng.</p>
  }
  return (
    <div className={cn("flex flex-col gap-3", mobile && "p-4")}>
      {contact ? (
        <div className="flex items-center gap-3">
          <Avatar kind="customer" size="lg"><AvatarFallback>{initials(contact.full_name ?? "?")}</AvatarFallback></Avatar>
          <div className="min-w-0 flex-1">
            <div className={GROUP}>Khách hàng</div>
            <div className="mt-0.5 truncate text-[15px] font-semibold tracking-tight">{contact.full_name ?? contact.phone}</div>
            {contact.phone ? <div className="text-xs tabular-nums text-ax-ink-2">SĐT: {contact.phone}</div> : null}
          </div>
          <Link href={`/contacts/${contact.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-ax-primary hover:text-ax-primary-hover">Mở hồ sơ</Link>
        </div>
      ) : (
        <div className={GROUP}>Khách hàng</div>
      )}
      <KanbanContactPicker value={c.card.contact_id} valueLabel={contact?.full_name} onChange={(contactId) => c.patch({ contact_id: contactId })} />
      {c.card.contact_id != null && !contact ? <p className="text-xs text-ax-ink-2">— (không xem được thông tin khách hàng này)</p> : null}
    </div>
  )
}

// ───────────────────────── desktop ─────────────────────────

function DesktopView({ c }: { c: Ctl }) {
  const info = dueInfo(c.card, c.isDone)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const creator = c.nameById.get(c.card.created_by)
  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <nav aria-label="Đường dẫn" className="flex items-center gap-2 text-[13px] text-ax-ink-2">
        <Link href="/kanban" className="text-ax-ink-2 no-underline hover:text-ax-ink">Công việc</Link>
        <span aria-hidden>/</span>
        <span>{c.board?.name ?? "…"}</span>
        <span aria-hidden>/</span>
        <span className="text-ax-ink">{c.card.code ?? `#${c.card.id}`}</span>
      </nav>
      <div className="flex flex-wrap items-start gap-5">
        <main className="flex min-w-0 flex-[1_1_620px] flex-col gap-4">
          <div className="overflow-hidden rounded-[var(--ax-radius-sheet)] border border-[var(--ax-hero-border)] bg-ax-surface shadow-[var(--ax-shadow-hero)]">
            <HeroCard className="rounded-none border-0 px-6 pt-[22px] pb-5 shadow-none">
              <TitleEditor c={c} className="m-0 text-[28px] leading-tight font-bold tracking-tight text-white" inputClass="h-[52px] text-[22px]" />
              <div className="mt-1 text-[13px] text-[var(--ax-on-hero-ink-2)]">
                {c.card.code ?? `#${c.card.id}`}{creator ? ` · tạo bởi ${creator}` : ""} · {formatDateTimeVn(c.card.created_at)}
              </div>
            </HeroCard>
            <StageButtons c={c} />
          </div>
          <section aria-labelledby="mt" className={SECTION}>
            <h2 id="mt" className={cn(GROUP, "mb-2")}>Mô tả</h2>
            <DescriptionBlock c={c} />
          </section>
          <ChecklistBlock c={c} />
          <ActivityBlock c={c} />
          <CustomFields c={c} />
          <section aria-labelledby="dk" className={SECTION}>
            <h2 id="dk" className={cn(GROUP, "mb-2")}>Đính kèm</h2>
            <KanbanAttachmentPanel cardId={c.card.id} />
          </section>
        </main>

        <aside aria-label="Thuộc tính" className="sticky top-4 flex max-w-full flex-[0_0_360px] flex-col gap-3">
          <section className={cn("rounded-ax-card border bg-gradient-to-br from-[#F6F9FC] to-white p-4 shadow-ax-card", info.overdue ? "border-ax-danger/40" : "border-ax-line")}>
            <div className={GROUP} id="hd">Hạn xử lý</div>
            <div className={cn("mt-1.5 mb-1 text-xl font-semibold tracking-tight", info.overdue ? "text-ax-danger" : "text-ax-ink")}>{info.text}</div>
            <div className={cn("min-h-5 text-[13px]", TONE_TEXT[info.tone])}>{info.sub}</div>
            <DuePicker c={c} />
            {info.has ? (
              <button type="button" role="checkbox" aria-checked={c.card.due_completed_at != null} onClick={() => toggleDueDone(c)} className="mt-2 flex h-12 cursor-pointer items-center gap-2.5 text-[15px] outline-none focus-visible:shadow-[var(--ax-focus-ring)]">
                <TickBox on={c.card.due_completed_at != null} />Đã xử lý đúng hạn
              </button>
            ) : null}
          </section>
          <section className="rounded-ax-card border border-ax-line ax-grad-card p-4 shadow-ax-card">
            <div className={GROUP} id="hw">Người làm</div>
            <div role="group" aria-labelledby="hw" className="mt-2"><PeopleList c={c} /></div>
          </section>
          <PrioritiesAndLabels c={c} />
          <section className="rounded-ax-card border border-ax-line ax-grad-card p-4 shadow-ax-card"><ContactBlock c={c} /></section>
          {c.canDelete ? (
            <div className="flex justify-end px-1">
              <button type="button" onClick={() => setConfirmDelete(true)} className="h-10 cursor-pointer px-1 text-sm font-semibold text-ax-danger hover:underline">Xoá việc này</button>
            </div>
          ) : null}
        </aside>
      </div>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Xoá việc này" description="Việc biến khỏi bảng ngay; bấm Hoàn tác trên thông báo trong 5 giây để lấy lại." confirmLabel="Xoá việc" onConfirm={c.remove} />
    </div>
  )
}

// ───────────────────────── điện thoại ─────────────────────────

function MobileView({ c }: { c: Ctl }) {
  const info = dueInfo(c.card, c.isDone)
  const [sheet, setSheet] = useState<"due" | "who" | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const who = c.card.assignee_ids.map((id) => c.nameById.get(id) ?? `#${id}`)
  const rowCls = "flex min-h-[60px] w-full cursor-pointer items-center gap-3 bg-ax-surface pr-3.5 pl-4 text-left outline-none focus-visible:shadow-[inset_var(--ax-focus-ring)]"
  return (
    <div className="-mx-4 -mt-2 flex flex-col pb-2">
      <div className="flex items-center justify-between px-2 pt-2">
        <Link href="/kanban" aria-label="Quay lại Công việc" className="flex h-12 items-center gap-0.5 px-2.5 text-base font-semibold tracking-tight text-ax-primary-ink">
          <ChevronLeft className="size-5" strokeWidth={2.4} aria-hidden />Công việc
        </Link>
        <span className="pr-3.5 text-[13px] tabular-nums text-ax-ink-2">{c.card.code ?? `#${c.card.id}`}</span>
      </div>
      <HeroCard className="mx-3 mt-1 mb-3.5 p-[18px]">
        <TitleEditor c={c} className="m-0 text-[23px] leading-tight font-bold tracking-tight text-white" inputClass="h-12 text-lg" />
        {c.card.contact?.full_name ? <div className="mt-2 text-sm text-[var(--ax-on-hero-ink-2)]">Khách: {c.card.contact.full_name}</div> : null}
      </HeroCard>

      <StageButtons c={c} mobile />

      <div className="mx-4 overflow-hidden rounded-[14px] bg-ax-surface">
        <button type="button" onClick={() => setSheet("due")} className={rowCls}>
          <span className="w-[84px] shrink-0 text-[15px] text-ax-ink-2">Hạn</span>
          <span className="min-w-0 flex-1">
            <span className={cn("block text-base font-semibold tracking-tight", info.overdue ? "text-ax-danger" : "text-ax-ink")}>{info.has ? info.shortText : "Chưa đặt hạn"}</span>
            <span className={cn("mt-px block text-[13px]", TONE_TEXT[info.tone])}>{info.sub}</span>
          </span>
          <ChevronRight className="size-4 text-ax-ink-3" aria-hidden />
        </button>
        <button type="button" onClick={() => setSheet("who")} className={cn(rowCls, "border-t border-ax-divider")}>
          <span className="w-[84px] shrink-0 text-[15px] text-ax-ink-2">Người làm</span>
          <span className={cn("min-w-0 flex-1 text-base font-medium", who.length ? "text-ax-ink" : "text-ax-warn")}>{who.length ? who.join(", ") : "Chưa giao ai"}</span>
          <ChevronRight className="size-4 text-ax-ink-3" aria-hidden />
        </button>
        <div className="flex flex-col gap-2 border-t border-ax-divider px-4 py-2.5">
          <span className="text-[15px] text-ax-ink-2" id="m-prio">Ưu tiên</span>
          <div role="group" aria-labelledby="m-prio" className="grid grid-cols-2 gap-1.5">
            {KANBAN_PRIORITIES.map((p) => (
              <button key={p} type="button" aria-pressed={c.card.priority === p} onClick={() => setPriority(c, p)} className={cn(CHIP(c.card.priority === p, p === "high" || p === "urgent"), "h-11 rounded-[10px] text-sm")}>{PRIORITY_LABELS[p]}</button>
            ))}
          </div>
        </div>
        {c.labelDefs.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-ax-divider px-4 py-2.5">
            <span className="text-[15px] text-ax-ink-2" id="m-lab">Nhãn</span>
            <div role="group" aria-labelledby="m-lab" className="flex flex-wrap gap-1.5">
              {c.labelDefs.map((l) => {
                const on = c.card.labels.includes(l.id)
                return (
                  <button key={l.id} type="button" aria-pressed={on} onClick={() => toggleLabel(c, l.id)} className={cn(CHIP(on), "h-11 gap-2 rounded-full px-3.5")}>
                    <span aria-hidden className="size-2 rounded-full" style={{ background: l.color }} />{l.name}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>

      <ChecklistBlock c={c} mobile />

      <h2 className={cn(GROUP, "mx-8 mt-5 mb-2")}>Mô tả</h2>
      <div className="mx-4 rounded-[14px] bg-ax-surface px-4 py-3.5"><DescriptionBlock c={c} mobile /></div>

      <ActivityBlock c={c} mobile />

      <h2 className={cn(GROUP, "mx-8 mt-5 mb-2")}>Khách hàng</h2>
      <div className="mx-4 rounded-[14px] bg-ax-surface"><ContactBlock c={c} mobile /></div>

      {(c.board?.field_defs.length ?? 0) > 0 ? <div className="mx-4 mt-5"><CustomFields c={c} /></div> : null}
      <h2 className={cn(GROUP, "mx-8 mt-5 mb-2")}>Đính kèm</h2>
      <div className="mx-4 rounded-[14px] bg-ax-surface p-4"><KanbanAttachmentPanel cardId={c.card.id} /></div>

      {c.canDelete ? (
        <button type="button" onClick={() => setConfirmDelete(true)} className="mx-4 mt-5 h-12 cursor-pointer text-left text-[15px] font-semibold text-ax-danger">Xoá việc này</button>
      ) : null}

      <StickyActionBar layout="mobile">
        <Button
          type="button"
          size="ax-lg"
          variant={c.isDone ? "ax-secondary" : "ax-primary"}
          className={cn("h-14 text-[17px] font-bold", !c.isDone && "!bg-ax-success !bg-none")}
          onClick={c.toggleFinish}
        >
          {c.isDone ? "Mở lại việc" : "Hoàn thành việc"}
        </Button>
      </StickyActionBar>

      <BottomSheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <BottomSheetContent title={sheet === "who" ? "Người làm" : "Hạn xử lý"} className="gap-3">
          {sheet === "due" ? (
            <>
              <DuePicker c={c} mobile />
              {info.has ? (
                <button type="button" role="checkbox" aria-checked={c.card.due_completed_at != null} onClick={() => toggleDueDone(c)} className="flex h-12 cursor-pointer items-center gap-2.5 text-[15px]">
                  <TickBox on={c.card.due_completed_at != null} />Đã xử lý đúng hạn
                </button>
              ) : null}
            </>
          ) : null}
          {sheet === "who" ? <PeopleList c={c} mobile /> : null}
          <BottomSheetClose className={cn(buttonVariants({ variant: "ax-primary", size: "ax-lg" }), "w-full")}>Xong</BottomSheetClose>
        </BottomSheetContent>
      </BottomSheet>
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Xoá việc này" description="Việc biến khỏi bảng ngay; bấm Hoàn tác trên thông báo trong 5 giây để lấy lại." confirmLabel="Xoá việc" onConfirm={c.remove} />
    </div>
  )
}

// ───────────────────────── trang ─────────────────────────

function useIsDesktop(): boolean | null {
  const [v, setV] = useState<boolean | null>(null)
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)")
    const on = () => setV(mql.matches)
    on()
    mql.addEventListener("change", on)
    return () => mql.removeEventListener("change", on)
  }, [])
  return v
}

export function KanbanCardPage({ cardId }: { cardId: number | null }) {
  if (cardId == null) return <NotFound />
  return <CardScreen cardId={cardId} />
}

function NotFound() {
  return (
    <EmptyState
      variant="ax"
      title="Không mở được công việc này"
      message="Việc có thể đã bị xoá hoặc bạn không có quyền xem."
      action={<Link href="/kanban" className={buttonVariants({ variant: "ax-primary", size: "ax" })}>Về Công việc</Link>}
    />
  )
}

function CardScreen({ cardId }: { cardId: number }) {
  const c = useCardController(cardId)
  const isDesktop = useIsDesktop()
  const err = c.cardQ.error as { response?: { status?: number } } | null
  if (c.cardQ.isError) {
    const gone = err?.response?.status === 404 || err?.response?.status === 403
    return gone ? <NotFound /> : <ErrorState title="Không tải được công việc" error={c.cardQ.error} onRetry={() => void c.cardQ.refetch()} retrying={c.cardQ.isFetching} />
  }
  if (!c.card || isDesktop === null) {
    return (
      <div className="mx-auto flex max-w-[1440px] flex-col gap-3" aria-busy>
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    )
  }
  const ctl = c as Ctl
  return isDesktop ? <DesktopView c={ctl} /> : <MobileView c={ctl} />
}
