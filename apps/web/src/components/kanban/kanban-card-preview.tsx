"use client"

/**
 * Thẻ card trong cột Kanban (badge kiểu Trello).
 * - `KanbanCardContent`: phần hiển thị thuần — dùng cả trong cột lẫn bản "nhấc
 *   lên" khi kéo (`DragOverlay` ở `KanbanBoardView`).
 * - `KanbanCardPreview`: thẻ kéo được (`useDraggable` của `@dnd-kit/core`). Vị trí
 *   thả KHÔNG tính ở đây — `hooks/use-board-drag.ts` theo con trỏ và cột chèn ô
 *   giữ chỗ đúng chỗ (xem `KanbanColumnView`).
 */
import { useDraggable } from "@dnd-kit/core"
import { CalendarClock, CheckSquare, MessageSquare, Paperclip } from "lucide-react"
import type { KanbanCard, KanbanLabelDef } from "@/types/kanban"
import { formatDate } from "@/lib/format"
import { kanbanPriorityLabel } from "@/lib/kanban-display"
import { ShellAvatar } from "@/components/app-shell/avatar"
import { RecordCode } from "@/components/custom-objects/record-code"

/** Chấm ưu tiên — màu token (đủ tương phản ở cả nền tối). */
const PRIORITY_DOT: Record<string, string> = {
  low: "var(--color-app-faint)",
  normal: "var(--color-app-blue)",
  high: "var(--color-app-amber)",
  urgent: "var(--color-app-tag-red-ink)",
}

interface KanbanCardContentProps {
  card: KanbanCard
  labelDefs: KanbanLabelDef[]
  /** Tên người phụ trách đã tra (theo `assignee_ids`); chưa tra được thì `#id`. */
  assigneeNames?: string[]
}

export function KanbanCardContent({ card, labelDefs, assigneeNames }: KanbanCardContentProps) {
  return (
    <>
      {card.labels.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {card.labels.slice(0, 6).map((id) => {
            const def = labelDefs.find((l) => l.id === id)
            if (!def) return null
            return (
              <span
                key={id}
                title={def.name}
                className="h-1.5 w-7 rounded-full"
                style={{ backgroundColor: def.color }}
              />
            )
          })}
        </div>
      )}

      <div className="flex items-start gap-1.5">
        <RecordCode code={card.code} />
        <p className="line-clamp-2 min-w-0 font-medium leading-snug text-foreground">{card.title}</p>
      </div>

      {card.contact && (
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {card.contact.full_name ?? "Khách hàng"} · {card.contact.phone}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
        {card.priority && (
          <span className="inline-flex items-center gap-1" title={`Ưu tiên: ${kanbanPriorityLabel(card.priority) ?? card.priority}`}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: PRIORITY_DOT[card.priority] ?? "var(--color-app-faint)" }} />
            <span className="sr-only">Ưu tiên {kanbanPriorityLabel(card.priority) ?? card.priority}</span>
          </span>
        )}
        {card.due_at && (
          <span
            className={`inline-flex items-center gap-1 rounded px-1 ${
              card.is_overdue
                ? "bg-[var(--color-app-tag-red-bg)] font-medium text-[var(--color-app-tag-red-ink)]"
                : card.due_completed_at != null
                  ? "bg-[var(--color-app-tag-green-bg)] text-[var(--color-app-tag-green-ink)]"
                  : ""
            }`}
          >
            <CalendarClock className="size-3.5" />
            {formatDate(card.due_at)}
          </span>
        )}
        {card.checklist_total > 0 && (
          <span
            className={`inline-flex items-center gap-1 rounded px-1 ${
              card.checklist_done === card.checklist_total ? "bg-[var(--color-app-tag-green-bg)] text-[var(--color-app-tag-green-ink)]" : ""
            }`}
          >
            <CheckSquare className="size-3.5" />
            {card.checklist_done}/{card.checklist_total}
          </span>
        )}
        {card.comment_count > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" />
            {card.comment_count}
          </span>
        )}
        {card.attachment_count > 0 && (
          <span className="inline-flex items-center gap-1">
            <Paperclip className="size-3.5" />
            {card.attachment_count}
          </span>
        )}
        {card.assignee_ids.length > 0 && (() => {
          const names = assigneeNames?.length ? assigneeNames : card.assignee_ids.map((id) => `#${id}`)
          return (
            <span className="ml-auto inline-flex min-w-0 max-w-[60%] items-center gap-1.5" title={names.join(", ")}>
              <ShellAvatar name={names[0]} size="xs" className="!rounded-full" />
              <span className="truncate">{names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`}</span>
            </span>
          )
        })()}
      </div>
    </>
  )
}

/** Khung thẻ — cùng một class cho thẻ trong cột và bản nhấc lên khi kéo. */
export const KANBAN_CARD_FRAME =
  "rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-sm shadow-[var(--shadow-card)]"

interface KanbanCardPreviewProps extends KanbanCardContentProps {
  /** Chiều cao ô giữ chỗ khi CHÍNH thẻ này đang được kéo (đo lúc nhấc lên). */
  placeholderHeight?: number
  onOpen: (cardId: number) => void
}

export function KanbanCardPreview({ card, labelDefs, assigneeNames, placeholderHeight, onOpen }: KanbanCardPreviewProps) {
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
        className="shrink-0 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5"
      />
    )
  }

  return (
    <div
      ref={setNodeRef}
      onClick={() => onOpen(card.id)}
      className={`group cursor-pointer touch-manipulation transition-colors hover:border-[var(--input)] ${KANBAN_CARD_FRAME}`}
      {...listeners}
      {...attributes}
    >
      <KanbanCardContent card={card} labelDefs={labelDefs} assigneeNames={assigneeNames} />
    </div>
  )
}
