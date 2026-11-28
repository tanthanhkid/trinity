"use client"

/**
 * Thẻ card trong cột Kanban — «Ánh xanh» (cohoi-desktop): tiêu đề 14/600, tên khách, hạn + ưu tiên,
 * hàng dưới là avatar người phụ trách (tròn) và nút «chuyển sang cột kế» 40×40.
 * - `KanbanCardContent`: phần hiển thị thuần — dùng cả trong cột lẫn bản "nhấc
 *   lên" khi kéo (`DragOverlay` ở `KanbanBoardView`).
 * - `KanbanCardPreview`: thẻ kéo được (`useDraggable` của `@dnd-kit/core`). Vị trí
 *   thả KHÔNG tính ở đây — `hooks/use-board-drag.ts` theo con trỏ và cột chèn ô
 *   giữ chỗ đúng chỗ (xem `KanbanColumnView`).
 */
import { useDraggable } from "@dnd-kit/core"
import { CheckSquare, ChevronRight, MessageSquare, Paperclip } from "lucide-react"
import type { KanbanCard, KanbanLabelDef, KanbanPriority } from "@/types/kanban"
import { DUE_TONE_CLASS, dueMeta, KANBAN_PRIORITY_DOT } from "@/lib/kanban-ax"
import { cn } from "@/lib/utils"
import { PersonAvatar } from "@/components/ui/avatar"
import { kanbanPriorityLabel } from "@/lib/kanban-display"

interface KanbanCardContentProps {
  card: KanbanCard
  labelDefs: KanbanLabelDef[]
  /** Tên người phụ trách đã tra (theo `assignee_ids`); chưa tra được thì `#id`. */
  assigneeNames?: string[]
  /** Chuyển thẻ sang cột kế (không truyền ⇒ ẩn nút, vd cột cuối hoặc bản đang kéo). */
  onMoveNext?: (card: KanbanCard) => void
  /** Tên cột kế — chỉ để đặt nhãn cho nút chuyển. */
  nextColumnName?: string
}

/** Chữ hạn + chấm ưu tiên (dùng chung desktop và điện thoại). */
export function KanbanCardMeta({ card, className }: { card: KanbanCard; className?: string }) {
  const due = dueMeta(card)
  // Mức lạ (dữ liệu cũ/nhập ngoài) thì ẩn chấm ưu tiên, không in mã tiếng Anh ra màn.
  const prio = kanbanPriorityLabel(card.priority) ? (card.priority as KanbanPriority) : null
  return (
    <span className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] tabular-nums", className)}>
      <span className={DUE_TONE_CLASS[due.tone]}>{due.text}</span>
      {prio && (
        <span className="flex items-center gap-[5px] text-ax-ink-2">
          <span aria-hidden className="size-2 rounded-full" style={{ background: KANBAN_PRIORITY_DOT[prio] ?? "var(--ax-ink-3)" }} />
          {kanbanPriorityLabel(prio)}
        </span>
      )}
    </span>
  )
}

export function KanbanCardContent({ card, labelDefs, assigneeNames, onMoveNext, nextColumnName }: KanbanCardContentProps) {
  const names = card.assignee_ids.length > 0 ? (assigneeNames?.length ? assigneeNames : card.assignee_ids.map((id) => `#${id}`)) : []
  const done = card.due_completed_at != null
  return (
    <div className="flex flex-col gap-2">
      {card.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.labels.slice(0, 6).map((id) => {
            const def = labelDefs.find((l) => l.id === id)
            if (!def) return null
            return <span key={id} title={def.name} className="h-1.5 w-7 rounded-full" style={{ backgroundColor: def.color }} />
          })}
        </div>
      )}
      <p className={cn("line-clamp-2 min-w-0 text-sm font-semibold leading-[1.35] text-ax-ink", done && "line-through")}>{card.title}</p>
      {card.contact && <p className="truncate text-[13px] text-ax-ink-2">{card.contact.full_name ?? "Khách hàng"}</p>}
      <KanbanCardMeta card={card} />
      {(card.checklist_total > 0 || card.comment_count > 0 || card.attachment_count > 0) && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ax-ink-2">
          {card.checklist_total > 0 && (
            <span className={cn("inline-flex items-center gap-1", card.checklist_done === card.checklist_total && "text-[var(--ax-success)]")}>
              <CheckSquare className="size-3.5" aria-hidden />
              {card.checklist_done}/{card.checklist_total}
              <span className="sr-only"> việc nhỏ</span>
            </span>
          )}
          {card.comment_count > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3.5" aria-hidden />
              {card.comment_count}
              <span className="sr-only"> bình luận</span>
            </span>
          )}
          {card.attachment_count > 0 && (
            <span className="inline-flex items-center gap-1">
              <Paperclip className="size-3.5" aria-hidden />
              {card.attachment_count}
              <span className="sr-only"> đính kèm</span>
            </span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {names.length > 0 ? (
          <span className="inline-flex min-w-0 items-center gap-1.5" title={names.join(", ")} aria-label={`Phụ trách ${names.join(", ")}`}>
            <PersonAvatar kind="staff" name={names[0]} size="default" />
            {names.length > 1 && <span className="text-[12px] font-semibold text-ax-ink-2">+{names.length - 1}</span>}
          </span>
        ) : (
          <span />
        )}
        {onMoveNext && (
          <button
            type="button"
            aria-label={`Chuyển “${card.title}” sang ${nextColumnName ? `“${nextColumnName}”` : "cột kế"}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onMoveNext(card)
            }}
            className="flex size-10 cursor-pointer items-center justify-center rounded-ax-field border border-ax-line bg-ax-surface text-ax-ink-2 outline-none transition-colors duration-150 hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}

/** Khung thẻ — cùng một class cho thẻ trong cột và bản nhấc lên khi kéo. */
export const KANBAN_CARD_FRAME =
  "rounded-ax-card border border-ax-divider bg-ax-surface p-3 text-sm shadow-[var(--ax-shadow-card)]"

interface KanbanCardPreviewProps extends KanbanCardContentProps {
  /** Chiều cao ô giữ chỗ khi CHÍNH thẻ này đang được kéo (đo lúc nhấc lên). */
  placeholderHeight?: number
  /** Thẻ đang mở ở ngăn chi tiết bên phải: viền xanh + vòng 3px. */
  selected?: boolean
  onOpen: (cardId: number) => void
}

export function KanbanCardPreview({ card, labelDefs, assigneeNames, placeholderHeight, selected, onMoveNext, nextColumnName, onOpen }: KanbanCardPreviewProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `card-${card.id}`,
    data: { card },
  })

  // Đang kéo thẻ này: chỉ còn ô giữ chỗ viền đứt ở vị trí sẽ thả (cột đặt nó
  // đúng chỗ), bản thật hiện qua `<DragOverlay>`.
  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        style={{ height: placeholderHeight ?? 92 }}
        className="shrink-0 rounded-ax-card border-2 border-dashed border-ax-primary/40 bg-ax-primary-soft"
      />
    )
  }

  return (
    <div
      ref={setNodeRef}
      onClick={() => onOpen(card.id)}
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group cursor-pointer touch-manipulation transition-[border-color,box-shadow] duration-150 hover:border-ax-ink-3",
        KANBAN_CARD_FRAME,
        selected && "border-ax-primary shadow-[0_0_0_3px_rgba(58,117,166,.16)] hover:border-ax-primary",
      )}
      {...listeners}
      {...attributes}
    >
      <KanbanCardContent card={card} labelDefs={labelDefs} assigneeNames={assigneeNames} onMoveNext={onMoveNext} nextColumnName={nextColumnName} />
    </div>
  )
}
