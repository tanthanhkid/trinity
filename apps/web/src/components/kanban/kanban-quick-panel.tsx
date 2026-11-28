"use client"

/**
 * Ngăn chi tiết «Ánh xanh» của card Kanban (cohoi-desktop / cohoi-mobile2): sửa NGAY tại chỗ —
 * tiêu đề, giai đoạn (= chuyển cột), hạn nhanh, ưu tiên, người phụ trách, mô tả — mỗi thay đổi lưu liền
 * và có toast Hoàn tác 5 giây. Phần còn lại của card (nhãn, khách hàng, trường tuỳ biến, checklist,
 * đính kèm, hoạt động/bình luận, xoá) ở hộp thoại đầy đủ `KanbanCardDialog` — nút «Mở đầy đủ».
 *
 * - `variant="desktop"`: ngăn bên phải 440px, đầu là khối nhấn xanh (mã, tiêu đề, khách).
 * - `variant="mobile"`: trang toàn màn hình (quay lại · khối nhấn · các mục cỡ lớn · thanh dính «Đánh dấu đã xong»).
 */
import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Maximize2, X } from "lucide-react"
import { toast } from "sonner"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { Button } from "@/components/ui/button"
import { HeroCard } from "@/components/ui/hero-card"
import { PersonAvatar } from "@/components/ui/avatar"
import { AX_INPUT_CLASS } from "@/components/ui/input"
import { stageToneVars } from "@/components/ui/stage-chip"
import { showUndoToast } from "@/components/ui/undo-toast"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { Skeleton } from "@/components/ui/skeleton"
import { getApiErrorMessage } from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { usePermissions } from "@/lib/rbac"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import { useKanbanCard, useMoveKanbanCard, useUpdateKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"
import {
  dueIsoFromPreset,
  KANBAN_DUE_PRESETS,
  matchDuePreset,
  stageToneForColumn,
  vnFullDue,
  type DuePresetKey,
} from "@/lib/kanban-ax"
import { KANBAN_PRIORITY_LABELS } from "@/lib/kanban-display"
import { KANBAN_PRIORITIES, type KanbanCard, type KanbanPriority, type UpdateKanbanCardPayload } from "@/types/kanban"

/** Số người gợi ý tối đa trong hàng chip (người đã giao luôn hiện); thêm người khác → «Mở đầy đủ». */
const MAX_ASSIGNEE_CHIPS = 8

interface KanbanQuickPanelProps {
  cardId: number
  variant: "desktop" | "mobile"
  onClose: () => void
  /** Mở hộp thoại đầy đủ (checklist, bình luận, nhãn, trường tuỳ biến, xoá…). */
  onOpenFull: (cardId: number) => void
}

/** Hạn tự chọn ở hộp đầy đủ không khớp mốc nhanh nào — các chip nhanh đều tắt. */
type DueChoice = DuePresetKey | null

export function KanbanQuickPanel({ cardId, variant, onClose, onOpenFull }: KanbanQuickPanelProps) {
  const { can } = usePermissions()
  const { data: card, isLoading, isError } = useKanbanCard(cardId)
  const { data: board } = useKanbanBoardDetail(card?.board_id ?? null)
  const { data: roster = [] } = useKanbanUserRoster()
  const updateCard = useUpdateKanbanCard()
  const moveCard = useMoveKanbanCard()
  const canLinkContact = can("contacts.view")
  const mobile = variant === "mobile"

  // Mở thẻ đã xoá / ngoài quyền (404): báo rõ rồi đóng ngăn, không để khung xương quay mãi.
  useEffect(() => {
    if (isError) {
      toast.error("Không mở được công việc này — có thể đã bị xoá hoặc bạn không có quyền xem.")
      onClose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError])

  const columns = useMemo(() => (board?.columns ?? []).filter((c) => !c.is_archived), [board])
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  // Nạp lại ô nhập khi đổi thẻ hoặc máy chủ trả bản mới của đúng các trường này (chỉnh state lúc render, không cần effect).
  const syncKey = card ? `${card.id}|${card.title}|${card.description ?? ""}` : null
  const [synced, setSynced] = useState<string | null>(null)
  if (card && syncKey !== synced) {
    setSynced(syncKey)
    setTitle(card.title)
    setDescription(card.description ?? "")
  }

  if (isLoading || !card) {
    return (
      <PanelFrame variant={variant}>
        <div className="space-y-3 p-5">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PanelFrame>
    )
  }

  /** Lưu NGAY + toast Hoàn tác (đặt lại đúng các trường vừa đổi). */
  const save = (payload: UpdateKanbanCardPayload, message: string, undo: UpdateKanbanCardPayload) => {
    updateCard.mutate(
      { id: card.id, payload },
      {
        onSuccess: () =>
          showUndoToast(message, {
            onUndo: () =>
              updateCard.mutate(
                { id: card.id, payload: undo },
                { onError: (err) => toast.error(getApiErrorMessage(err, "Không hoàn tác được")) },
              ),
          }),
        onError: (err) => toast.error(getApiErrorMessage(err, "Không lưu được thay đổi")),
      },
    )
  }

  const moveTo = (columnId: number) => {
    if (columnId === card.column_id) return
    const from = card.column_id
    const name = columns.find((c) => c.id === columnId)?.name
    moveCard
      .mutateAsync({ id: card.id, payload: { column_id: columnId } })
      .then((res) => {
        if (res.wip_warning) toast.warning(res.wip_warning)
        showUndoToast(`Đã chuyển sang “${name ?? "cột mới"}”`, {
          onUndo: () =>
            moveCard.mutate(
              { id: card.id, payload: { column_id: from } },
              { onError: (err) => toast.error(getApiErrorMessage(err, "Không hoàn tác được")) },
            ),
        })
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không chuyển được card")))
  }

  const pickDue = (key: DuePresetKey) => {
    const next = dueIsoFromPreset(key)
    if (next === card.due_at) return
    save(
      { due_at: next, ...(next ? {} : { due_completed_at: null }) },
      next ? `Đã đặt hạn ${vnFullDue(next).slice(0, 5)}` : "Đã bỏ hạn",
      { due_at: card.due_at, due_completed_at: card.due_completed_at },
    )
  }

  const doneColumn = columns.find((c) => c.is_done) ?? null
  const dueDone = card.due_completed_at != null
  const inDoneColumn = doneColumn != null && card.column_id === doneColumn.id
  const isDone = dueDone || inDoneColumn
  /** Không hạn và board không có cột «xong» ⇒ nút «Đánh dấu đã xong» không có việc gì để làm — tắt thay vì bấm không phản hồi. */
  const canMarkDone = card.due_at != null || doneColumn != null
  /** Đánh dấu xong: có hạn ⇒ tích hoàn thành hạn; không hạn ⇒ chuyển sang cột «xong» của board (nếu có). */
  const toggleDone = () => {
    if (card.due_at) {
      save(
        { due_completed_at: dueDone ? null : new Date().toISOString() },
        dueDone ? "Mở lại thẻ" : "Đánh dấu đã xong",
        { due_completed_at: card.due_completed_at },
      )
    } else if (doneColumn && !inDoneColumn) {
      moveTo(doneColumn.id)
    }
  }

  const pickPriority = (p: KanbanPriority) => {
    const next = card.priority === p ? null : p
    save({ priority: next }, next ? `Ưu tiên: ${KANBAN_PRIORITY_LABELS[next]}` : "Đã bỏ mức ưu tiên", { priority: card.priority })
  }

  const rosterById = new Map(roster.map((u) => [u.id, u.full_name]))
  const assigneeIds = card.assignee_ids
  const peopleIds = [...assigneeIds, ...roster.map((u) => u.id).filter((id) => !assigneeIds.includes(id))].slice(
    0,
    Math.max(MAX_ASSIGNEE_CHIPS, assigneeIds.length),
  )
  const togglePerson = (id: number) => {
    const on = assigneeIds.includes(id)
    const next = on ? assigneeIds.filter((x) => x !== id) : [...assigneeIds, id]
    const who = rosterById.get(id) ?? `#${id}`
    save({ assignee_ids: next }, on ? `Bỏ ${who} khỏi thẻ` : `Giao cho ${who}`, { assignee_ids: assigneeIds })
  }

  const dueChoice: DueChoice = matchDuePreset(card.due_at)
  const contactName = card.contact?.full_name ?? null

  const header = (
    <HeaderBlock
      card={card}
      title={title}
      setTitle={setTitle}
      onSaveTitle={() => {
        const v = title.trim()
        if (!v) return setTitle(card.title)
        if (v !== card.title) save({ title: v }, "Đã lưu tiêu đề", { title: card.title })
      }}
      contactName={contactName}
      canLinkContact={canLinkContact}
      mobile={mobile}
      onClose={onClose}
    />
  )

  const fields = (
    <div className={cn("flex flex-col", mobile ? "gap-5" : "gap-[18px]")}>
      <Section id="qp-stage" label="Giai đoạn" mobile={mobile}>
        <div
          role="radiogroup"
          aria-labelledby="qp-stage"
          className={mobile ? "grid grid-cols-2 gap-2" : "grid gap-1"}
          style={mobile ? undefined : { gridTemplateColumns: `repeat(${Math.min(Math.max(columns.length, 1), 4)}, minmax(0, 1fr))` }}
        >
          {columns.map((col, i) => {
            const checked = col.id === card.column_id
            const v = stageToneVars(col.color ? "neutral" : stageToneForColumn(i, col.is_done))
            return (
              <button
                key={col.id}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => moveTo(col.id)}
                style={checked ? { backgroundColor: v.bg, color: v.ink, boxShadow: `inset 0 0 0 1px ${col.color ?? v.dot}` } : undefined}
                className={cn(
                  "cursor-pointer rounded-ax-field font-semibold transition-colors duration-150 outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
                  mobile ? "h-12 text-base" : "h-11 text-[13px]",
                  !checked && "bg-ax-sunken text-ax-ink-2 hover:bg-ax-hover",
                )}
              >
                <span className="block truncate px-1">{col.name}</span>
              </button>
            )
          })}
        </div>
      </Section>

      <Section label="Hạn xử lý" mobile={mobile}>
        <div className="flex flex-wrap items-center gap-1.5">
          {KANBAN_DUE_PRESETS.map((d) => (
            <Chip
              key={d.key}
              pressed={dueChoice === d.key || (d.key === "none" && !card.due_at)}
              mobile={mobile}
              onClick={() => pickDue(d.key)}
            >
              {d.label}
            </Chip>
          ))}
        </div>
        {card.due_at && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span
              className={cn(
                "text-sm font-semibold tabular-nums",
                card.is_overdue && !dueDone ? "text-[var(--ax-danger)]" : dueDone ? "text-[var(--ax-success)]" : "text-ax-ink",
              )}
            >
              {mobile ? "Hạn " : ""}
              {vnFullDue(card.due_at)}
            </span>
            {!mobile && (
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ax-ink">
                <input
                  type="checkbox"
                  checked={dueDone}
                  onChange={toggleDone}
                  className="size-5 cursor-pointer accent-[var(--ax-primary)]"
                />
                Đã xong
              </label>
            )}
          </div>
        )}
      </Section>

      <Section id="qp-prio" label="Mức ưu tiên" mobile={mobile}>
        <div role="radiogroup" aria-labelledby="qp-prio" className="flex flex-wrap gap-1.5">
          {KANBAN_PRIORITIES.map((p) => (
            <Chip key={p} role="radio" pressed={card.priority === p} mobile={mobile} onClick={() => pickPriority(p)}>
              {KANBAN_PRIORITY_LABELS[p]}
            </Chip>
          ))}
        </div>
      </Section>

      <Section label="Người phụ trách" mobile={mobile}>
        {peopleIds.length === 0 ? (
          <p className="text-sm text-ax-ink-2">Chưa giao cho ai.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {peopleIds.map((id) => {
              const name = rosterById.get(id) ?? `#${id}`
              return (
                <Chip key={id} pressed={assigneeIds.includes(id)} mobile={mobile} onClick={() => togglePerson(id)} lead>
                  <PersonAvatar kind="staff" name={name} size={mobile ? "default" : "sm"} />
                  <span className="max-w-32 truncate">{name}</span>
                </Chip>
              )
            })}
          </div>
        )}
      </Section>

      <div>
        <label htmlFor={`qp-desc-${variant}`} className={cn("mb-1.5 block text-ax-ink-3", mobile ? "text-[13px] !text-ax-ink-2" : "ax-text-label")}>
          Mô tả
        </label>
        <textarea
          id={`qp-desc-${variant}`}
          rows={4}
          value={description}
          placeholder="Ghi yêu cầu của khách, việc cần làm…"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            const v = description.trim()
            if (v !== (card.description ?? "").trim()) {
              save({ description: v || null }, "Đã lưu mô tả", { description: card.description })
            }
          }}
          className={cn(AX_INPUT_CLASS, "h-auto w-full resize-y leading-6", mobile ? "px-3.5 py-3 text-base" : "px-3 py-2.5 text-[15px]")}
        />
      </div>

      <Button variant="ax-secondary" size="ax" className="w-full" onClick={() => onOpenFull(card.id)}>
        <Maximize2 className="size-4" aria-hidden /> Mở đầy đủ — checklist, bình luận, nhãn…
      </Button>
    </div>
  )

  if (mobile) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col ax-page" role="dialog" aria-label="Chi tiết thẻ">
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-ax-line bg-ax-surface px-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Quay lại danh sách"
            className="flex size-11 cursor-pointer items-center justify-center rounded-ax-field text-ax-primary hover:bg-ax-hover"
          >
            <ArrowLeft className="size-[22px]" aria-hidden />
          </button>
          {card.code && <span className="rounded-md bg-ax-sunken px-2 py-[3px] text-[13px] font-semibold text-ax-ink-2">{card.code}</span>}
        </div>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-32">
          {header}
          {fields}
        </div>
        <StickyActionBar layout="mobile" className="fixed inset-x-0 bottom-0 z-40">
          <Button
            variant={isDone ? "ax-secondary" : "ax-primary"}
            size="ax-lg"
            className="w-full text-[17px] font-bold"
            disabled={(isDone && !dueDone) || (!isDone && !canMarkDone)}
            title={!isDone && !canMarkDone ? "Đặt hạn hoặc thêm cột «xong» cho board để đánh dấu đã xong" : undefined}
            onClick={toggleDone}
          >
            {isDone ? (dueDone ? "Đã xong · bấm để mở lại" : "Đã xong") : "Đánh dấu đã xong"}
          </Button>
        </StickyActionBar>
      </div>
    )
  }

  return (
    <PanelFrame variant="desktop">
      {header}
      <div className="max-h-[calc(100vh-230px)] overflow-auto px-5 pt-[18px] pb-5">{fields}</div>
    </PanelFrame>
  )
}

function PanelFrame({ variant, children }: { variant: "desktop" | "mobile"; children: React.ReactNode }) {
  if (variant === "mobile") {
    return <div className="fixed inset-0 z-40 overflow-y-auto ax-page">{children}</div>
  }
  return (
    <aside
      aria-label="Chi tiết thẻ"
      className="sticky top-4 flex w-[440px] max-w-full shrink-0 flex-col overflow-hidden rounded-ax-sheet border border-ax-line bg-ax-surface shadow-ax-float"
    >
      {children}
    </aside>
  )
}

function Section({ id, label, mobile, children }: { id?: string; label: string; mobile: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div id={id} className={cn("mb-1.5", mobile ? "mb-2 text-[13px] text-ax-ink-2" : "ax-text-label text-ax-ink-3")}>
        {label}
      </div>
      {children}
    </div>
  )
}

/** Chip chọn (hạn, ưu tiên, người): bo 999, cao 40 (desktop) / 44 (điện thoại); đang chọn = gradient nhạt + viền xanh. */
function Chip({
  pressed,
  mobile,
  lead,
  role,
  onClick,
  children,
}: {
  pressed: boolean
  mobile: boolean
  lead?: boolean
  role?: "radio"
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role={role}
      {...(role === "radio" ? { "aria-checked": pressed } : { "aria-pressed": pressed })}
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-2 rounded-[var(--ax-radius-chip)] border transition-colors duration-150 outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
        mobile ? "h-11 text-[15px] font-semibold" : "h-10 text-sm",
        lead ? (mobile ? "pr-4 pl-1.5" : "pr-3.5 pl-1.5") : mobile ? "px-4" : "px-3.5",
        pressed
          ? "border-ax-primary bg-ax-primary-soft text-ax-primary-ink"
          : "border-ax-line bg-ax-surface text-ax-ink-2 hover:border-ax-primary hover:text-ax-primary-ink",
      )}
    >
      {children}
    </button>
  )
}

function HeaderBlock({
  card,
  title,
  setTitle,
  onSaveTitle,
  contactName,
  canLinkContact,
  mobile,
  onClose,
}: {
  card: KanbanCard
  title: string
  setTitle: (v: string) => void
  onSaveTitle: () => void
  contactName: string | null
  canLinkContact: boolean
  mobile: boolean
  onClose: () => void
}) {
  const contactLine = card.contact_id == null ? null : !canLinkContact || card.contact?.masked ? (
    <span className="font-semibold text-white">{contactName ?? "Khách hàng"}</span>
  ) : (
    <Link href={`/contacts/${card.contact_id}`} className="font-semibold text-white underline underline-offset-[3px] hover:text-[#dce8f3]">
      {contactName ?? "Khách hàng"}
    </Link>
  )
  const titleInput = (
    <>
      <label htmlFor={`qp-title-${mobile ? "m" : "d"}`} className="sr-only">
        Tiêu đề
      </label>
      <input
        id={`qp-title-${mobile ? "m" : "d"}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={onSaveTitle}
        className={cn(
          "w-full text-white outline-none placeholder:text-white/75 focus-visible:border-white focus-visible:shadow-[0_0_0_3px_rgba(255,255,255,.28)]",
          mobile
            ? "min-h-7 truncate rounded-md border-0 bg-transparent p-0 text-[17px] font-bold tracking-[-0.011em]"
            : "h-[46px] rounded-ax-field border border-white/[.28] bg-[rgba(13,32,54,.30)] px-3 text-lg font-semibold tracking-[-0.011em] hover:border-white/60",
        )}
      />
    </>
  )
  if (mobile) {
    return (
      <HeroCard className="p-[18px]">
        {titleInput}
        {contactLine && <div className="mt-2 text-[15px] text-[var(--ax-on-hero-ink-2)]">Khách: {contactLine}</div>}
      </HeroCard>
    )
  }
  return (
    <HeroCard className="flex flex-col gap-2.5 rounded-none border-0 border-b border-b-[#214a70] p-0 py-3 pr-3 pl-5 pb-[18px] shadow-[inset_0_1px_0_rgba(255,255,255,.18)]">
      <div className="flex items-center justify-between">
        {card.code ? (
          <span className="rounded-md bg-[rgba(13,32,54,.34)] px-2 py-[3px] text-xs font-semibold tracking-[.02em] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.16)]">
            {card.code}
          </span>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng chi tiết"
          className="flex size-10 cursor-pointer items-center justify-center rounded-ax-field text-white outline-none hover:bg-[rgba(13,32,54,.46)] focus-visible:shadow-[0_0_0_2px_#fff]"
        >
          <X className="size-[18px]" aria-hidden />
        </button>
      </div>
      <div className="pr-2">
        {titleInput}
        {contactLine && <div className="mt-2.5 text-[13px] text-[var(--ax-on-hero-ink-2)]">Khách: {contactLine}</div>}
      </div>
    </HeroCard>
  )
}
