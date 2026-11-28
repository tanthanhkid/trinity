"use client"

/**
 * 1 cột Kanban — droppable qua `@dnd-kit/core` (để kéo đổi thứ tự CỘT) + cursor
 * phân trang với nút "Tải thêm" tường minh (thiếu UI trigger là phân trang vô dụng).
 *
 * Kéo thẻ: cột đánh dấu DOM theo `lib/board-drag-target.ts`; khi cột là đích thả,
 * nó chèn ô giữ chỗ vào `drop.index` và các thẻ khác trượt nhường chỗ (Motion
 * `layout`, nhịp `motionTokens.spring.smooth`).
 */
import { useDraggable, useDroppable } from "@dnd-kit/core"
import { GripVertical, Loader2, Plus } from "lucide-react"
import { motion } from "motion/react"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ErrorState } from "@/components/ui/error-state"
import { useKanbanCardsByColumn } from "@/hooks/kanban/use-kanban-cards"
import { useCreateKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"
import { motionTokens } from "@/lib/motion-tokens"
import { formatNumber } from "@/lib/format"
import { KanbanCardPreview } from "./kanban-card-preview"
import type { KanbanCard, KanbanColumn, KanbanLabelDef, QueryKanbanCardsParams } from "@/types/kanban"
import { LoadingBlock } from "@/components/ui/loading-block"

interface KanbanColumnViewProps {
  boardId: number
  column: KanbanColumn
  labelDefs: KanbanLabelDef[]
  filters: Omit<QueryKanbanCardsParams, "board_id" | "column_id" | "cursor">
  /** Kéo cột đổi thứ tự — CHỈ super_admin (+ kế thừa), mirror quyền cấu hình
   * board/cột hiện có. */
  canReorder: boolean
  /** Cột NÀY đang được kéo (từ `KanbanBoardView`) — ẩn nội dung, chỉ còn
   * placeholder viền đứt, mirror hiệu ứng card. */
  isBeingDragged: boolean
  /** Thẻ đang kéo/vừa thả — ẩn khỏi vị trí cũ ở MỌI cột. */
  hiddenCardId?: number | null
  /** Chỉ có ở cột đích: chèn thẻ đang kéo (ô giữ chỗ) hoặc vừa thả vào vị trí `index`. */
  drop?: { card: KanbanCard; index: number; height: number } | null
  onOpenCard: (cardId: number) => void
  /** Thẻ đang mở ở ngăn chi tiết (viền xanh). */
  selectedCardId?: number | null
  /** Cột kế bên phải (chuyển thẻ bằng một bấm); không có ⇒ cột cuối, ẩn nút. */
  nextColumn?: KanbanColumn | null
  onMoveNext?: (card: KanbanCard, to: KanbanColumn) => void
}

export function KanbanColumnView({
  boardId,
  column,
  labelDefs,
  filters,
  canReorder,
  isBeingDragged,
  hiddenCardId,
  drop,
  onOpenCard,
  selectedCardId,
  nextColumn,
  onMoveNext,
}: KanbanColumnViewProps) {
  const { setNodeRef, isOver: isOverAny, active } = useDroppable({ id: `column-${column.id}`, data: { column } })
  // Viền "đang trỏ vào" chỉ cho lúc kéo CỘT — kéo thẻ đã có ô giữ chỗ chỉ đích.
  const isOver = isOverAny && String(active?.id ?? "").startsWith("col-")
  const {
    attributes: dragAttributes,
    listeners: dragListeners,
    setNodeRef: setDragHandleRef,
  } = useDraggable({ id: `col-${column.id}`, data: { column }, disabled: !canReorder })
  const { data, isLoading, isError, error, refetch, isFetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useKanbanCardsByColumn(boardId, column.id, filters)
  const createCard = useCreateKanbanCard()
  // Tên người phụ trách (cùng cache với bảng danh sách) — thẻ hiện avatar + tên thay vì `#id`.
  const { data: roster = [] } = useKanbanUserRoster()
  const userNames = useMemo(() => new Map(roster.map((u) => [u.id, u.full_name])), [roster])
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState("")
  // Escape huỷ nhập: blur xảy ra ngay sau đó không được tạo card.
  const skipBlurSubmit = useRef(false)

  if (isBeingDragged) {
    return (
      <div className="flex min-h-[360px] min-w-0 rounded-ax-sheet border-2 border-dashed border-ax-primary/40 bg-ax-primary-soft" />
    )
  }

  const allCards = data?.pages.flatMap((p) => p.cards) ?? []
  const cards = hiddenCardId != null ? allCards.filter((c) => c.id !== hiddenCardId) : allCards
  const total = data?.pages[0] ? allCards.length : 0
  // Trang đầu chỉ tải 30 thẻ: còn trang sau thì tổng THỰC lớn hơn số đã tải, nên hiện "N+" và tính vượt WIP theo đó.
  const hasMoreCards = Boolean(hasNextPage)
  const wipExceeded =
    column.wip_limit != null && (hasMoreCards ? total >= column.wip_limit : total > column.wip_limit)

  const submitNewCard = () => {
    // Enter rồi blur (hoặc Enter liên tiếp) khi lần tạo trước chưa xong → tạo trùng card.
    if (createCard.isPending) return
    const t = title.trim()
    if (!t) {
      setAdding(false)
      return
    }
    createCard.mutate(
      { column_id: column.id, title: t },
      { onSuccess: () => setTitle("") },
    )
  }

  return (
    <div
      ref={setNodeRef}
      data-board-column={column.id}
      aria-label={column.name}
      className={`flex min-h-[360px] min-w-0 flex-col gap-2 rounded-ax-sheet bg-ax-sunken p-2.5 shadow-ax-inset transition-shadow ${
        isOver ? "ring-2 ring-[var(--ax-primary)]" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
        <div ref={setDragHandleRef} className="relative after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] pointer-coarse:sm:after:-inset-y-3 flex min-w-0 items-center gap-1.5 max-sm:min-h-11" {...dragAttributes} {...dragListeners}>
          {canReorder && <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />}
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: column.color || "var(--ax-ink-3)" }} />
          <h3 className="truncate text-sm font-bold tracking-[-0.011em] text-ax-ink">{column.name}</h3>
        </div>
        {/* Số đếm: "12", "12+" (còn trang sau), "12/15" (có giới hạn WIP; vượt ⇒ đỏ). */}
        <span
          title={column.wip_limit != null ? `Giới hạn ${formatNumber(column.wip_limit)} card` : undefined}
          aria-label={`${formatNumber(total)}${hasMoreCards ? " trở lên" : ""} thẻ${column.wip_limit != null ? `, giới hạn ${formatNumber(column.wip_limit)}` : ""}`}
          className={`shrink-0 text-sm tabular-nums ${wipExceeded ? "font-semibold text-[var(--ax-danger)]" : "font-medium text-ax-ink-2"}`}
        >
          {formatNumber(total)}
          {hasMoreCards ? "+" : ""}
          {column.wip_limit != null ? `/${formatNumber(column.wip_limit)}` : ""}
        </span>
      </div>

      <div data-board-list className="flex flex-1 flex-col gap-2 overflow-y-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
        {isLoading ? (
          <LoadingBlock variant="cards" count={3} />
        ) : isError && cards.length === 0 ? (
          <ErrorState compact className="p-2" title="Không tải được card" error={error} onRetry={() => void refetch()} retrying={isFetching} />
        ) : cards.length === 0 && !drop ? (
          <p className="p-2 text-center text-sm text-ax-ink-2">Chưa có thẻ</p>
        ) : (
          withDrop(
            cards.map((card) => (
              <motion.div key={card.id} layout="position" transition={motionTokens.spring.smooth} data-board-item={card.id}>
                <KanbanCardPreview
                  card={card}
                  labelDefs={labelDefs}
                  assigneeNames={card.assignee_ids.map((uid) => userNames.get(uid) ?? `#${uid}`)}
                  selected={card.id === selectedCardId}
                  nextColumnName={nextColumn?.name}
                  onMoveNext={nextColumn && onMoveNext ? (c) => onMoveNext(c, nextColumn) : undefined}
                  onOpen={onOpenCard}
                />
              </motion.div>
            )),
            drop &&
              <motion.div key={drop.card.id} layout="position" transition={motionTokens.spring.smooth}>
                <KanbanCardPreview
                  card={drop.card}
                  labelDefs={labelDefs}
                  assigneeNames={drop.card.assignee_ids.map((uid) => userNames.get(uid) ?? `#${uid}`)}
                  placeholderHeight={drop.height}
                  onOpen={onOpenCard}
                />
              </motion.div>,
            drop?.index ?? 0,
          )
        )}

        {hasNextPage && (
          <Button
            variant="ax-ghost"
            size="ax"
            className="text-sm"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {isFetchingNextPage ? <Loader2 className="size-3 animate-spin" /> : "Tải thêm"}
          </Button>
        )}
      </div>

      <div>
        {adding ? (
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={title}
              variant="ax"
              placeholder="Tiêu đề thẻ…"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitNewCard()
                if (e.key === "Escape") {
                  skipBlurSubmit.current = true
                  setAdding(false)
                  setTitle("")
                }
              }}
              onBlur={() => {
                if (skipBlurSubmit.current) {
                  skipBlurSubmit.current = false
                  return
                }
                submitNewCard()
              }}
            />
          </div>
        ) : (
          <Button variant="ax-ghost" size="ax" className="w-full justify-start text-sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden /> Thêm thẻ
          </Button>
        )}
      </div>
    </div>
  )
}

/** Chèn `node` vào `items` tại `index` (null thì giữ nguyên). */
function withDrop(items: ReactNode[], node: ReactNode | null | undefined, index: number): ReactNode[] {
  if (!node) return items
  const out = items.slice()
  out.splice(Math.min(index, out.length), 0, node)
  return out
}
