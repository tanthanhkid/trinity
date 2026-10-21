"use client"

/**
 * View "Kanban" của 1 board (kéo-thả mượt kiểu Trello)
 * — cột kéo-thả ngang, mỗi cột tự tải card riêng (phân trang). Mobile: cuộn
 * ngang (`overflow-x-auto`).
 *
 * Kéo-thả dùng `@dnd-kit/core` (nhấc + `DragOverlay`) và `useBoardDrag` (theo
 * con trỏ → cột + vị trí chèn). Phong cách chuyển động theo Arc Library
 * (`lib/motion-tokens.ts`): thẻ nhấc lên nghiêng nhẹ, ô giữ chỗ viền đứt chạy theo
 * con trỏ, các thẻ khác trượt nhường chỗ, thả xuống thì trượt vào đúng ô giữ chỗ
 * (không bay về chỗ cũ rồi mới nhảy sang).
 *
 * Sau khi thả, thẻ được giữ ở vị trí mới (`settling`) tới khi máy chủ trả lời —
 * cache của React Query báo tới component chậm một nhịp, nếu bỏ giữ ngay thì thẻ
 * chớp về cột cũ. Thứ tự cột vẫn tính từ vị trí X so với cột đích lúc thả.
 */
import { useState } from "react"
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { GripVertical } from "lucide-react"
import { motion, MotionConfig } from "motion/react"
import { toast } from "sonner"
import { getApiErrorMessage } from "@/lib/api-client"
import { toastWithUndo } from "@/lib/undo"
import { ErrorState } from "@/components/ui/error-state"
import { usePermissions } from "@/lib/rbac"
import { neighboursAt } from "@/lib/board-drag-target"
import { CSS_EASE_ENTER, motionTokens } from "@/lib/motion-tokens"
import { useBoardDrag } from "@/hooks/use-board-drag"
import { useKanbanUserRoster } from "@/hooks/kanban/use-kanban-user-roster"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import { useMoveKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { useReorderKanbanColumns } from "@/hooks/kanban/use-kanban-columns"
import { KanbanColumnView } from "./kanban-column-view"
import { KANBAN_CARD_FRAME, KanbanCardContent } from "./kanban-card-preview"
import { KanbanCardDialog } from "./kanban-card-dialog"
import type { KanbanCard, QueryKanbanCardsParams } from "@/types/kanban"
import { LoadingBlock } from "@/components/ui/loading-block"

interface KanbanBoardViewProps {
  boardId: number
  filters: Omit<QueryKanbanCardsParams, "board_id" | "column_id" | "cursor">
}

/** So tâm 2 hình chữ nhật theo 1 trục — dùng để quyết "thả cột TRƯỚC hay SAU cột đích". */
function isBeforeOnAxis(
  activeRect: { top: number; left: number; width: number; height: number } | null,
  overRect: { top: number; left: number; width: number; height: number } | null,
  axis: "x" | "y",
): boolean {
  if (!activeRect || !overRect) return true
  const activeCenter = axis === "y" ? activeRect.top + activeRect.height / 2 : activeRect.left + activeRect.width / 2
  const overCenter = axis === "y" ? overRect.top + overRect.height / 2 : overRect.left + overRect.width / 2
  return activeCenter < overCenter
}

export function KanbanBoardView({ boardId, filters }: KanbanBoardViewProps) {
  const { can } = usePermissions()
  const { data: board, isLoading, isError, error, refetch, isFetching } = useKanbanBoardDetail(boardId)
  const moveCard = useMoveKanbanCard()
  const reorderColumns = useReorderKanbanColumns(boardId)
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null)
  const [activeColumnId, setActiveColumnId] = useState<number | null>(null)
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null)
  const [settling, setSettling] = useState<{ card: KanbanCard; index: number; height: number } | null>(null)
  const { rootRef: boardRef, target: dropTarget, start: startDrag, stop: stopDrag } = useBoardDrag()
  const { data: roster = [] } = useKanbanUserRoster()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const canReorderColumns = can("kanban.boards")

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    if (id.startsWith("card-")) {
      const card = (event.active.data.current as { card: KanbanCard } | undefined)?.card ?? null
      if (!card) return
      setActiveSize(startDrag(String(card.id), String(card.column_id)))
      setActiveCard(card)
    } else if (id.startsWith("col-")) {
      setActiveColumnId(Number(id.replace("col-", "")))
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const card = activeCard
    setActiveCard(null)
    setActiveColumnId(null)
    const activeId = String(event.active.id)
    if (activeId.startsWith("col-")) {
      if (board && event.over) handleColumnDragEnd(activeId, event)
      return
    }

    const result = stopDrag()
    if (!card || !result || result.unchanged) return
    const columnId = Number(result.target.column)
    if (!columnId) return
    const { prev, next } = neighboursAt(result.snapshot, result.target.index)
    setSettling({ card: { ...card, column_id: columnId }, index: result.target.index, height: activeSize?.height ?? 92 })
    // Chỗ cũ để "Hoàn tác": cột cũ + hai thẻ hàng xóm cũ (bản chụp đã bỏ thẻ đang kéo).
    const back = result.origin && result.originSnapshot ? neighboursAt(result.originSnapshot, result.origin.index) : null
    const undo = result.origin
      ? {
          column_id: Number(result.origin.column),
          before_card_id: back?.prev ? Number(back.prev) : undefined,
          after_card_id: back?.next ? Number(back.next) : undefined,
        }
      : null
    const toColumn = board?.columns.find((c) => c.id === columnId)?.name
    submitMove(
      card.id,
      {
        column_id: columnId,
        before_card_id: prev ? Number(prev) : undefined,
        after_card_id: next ? Number(next) : undefined,
      },
      // Chỉ đổi thứ tự trong cùng cột thì không cần toast — đổi cột (= đổi trạng thái) mới có Hoàn tác.
      undo && undo.column_id !== columnId ? { message: `Đã chuyển “${card.title}”${toColumn ? ` sang ${toColumn}` : ""}`, payload: undo } : null,
    )
  }

  const submitMove = (
    cardId: number,
    payload: { column_id: number; before_card_id?: number; after_card_id?: number },
    undo: { message: string; payload: { column_id: number; before_card_id?: number; after_card_id?: number } } | null = null,
  ) => {
    // `mutateAsync` (không dùng callback của `mutate`): kéo liền hai card thì callback của `mutate` chỉ chạy cho lần
    // cuối — lần đầu sẽ mất toast Hoàn tác. Promise của từng lần gọi luôn trả về đúng lần đó.
    moveCard
      .mutateAsync({ id: cardId, payload })
      .then((result) => {
        if (result.wip_warning) toast.warning(result.wip_warning)
        if (undo) toastWithUndo({ message: undo.message, onUndo: () => submitMove(cardId, undo.payload) })
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không chuyển được card")))
      .finally(() => setSettling(null))
  }

  const handleColumnDragEnd = (activeId: string, event: DragEndEvent) => {
    if (!board) return
    const { over, active } = event
    if (!over) return
    const draggedId = Number(activeId.replace("col-", ""))
    const overId = String(over.id)
    if (!overId.startsWith("column-")) return
    const targetId = Number(overId.replace("column-", ""))
    if (!draggedId || !targetId || draggedId === targetId) return

    const ids = board.columns.map((c) => c.id)
    const fromIdx = ids.indexOf(draggedId)
    if (fromIdx === -1) return
    ids.splice(fromIdx, 1)
    let targetIdx = ids.indexOf(targetId)
    if (targetIdx === -1) return
    const before = isBeforeOnAxis(active.rect.current.translated, over.rect, "x")
    if (!before) targetIdx += 1
    ids.splice(targetIdx, 0, draggedId)

    reorderColumns.mutate(ids, {
      onError: (err) => toast.error(getApiErrorMessage(err, "Không sắp xếp lại được cột")),
    })
  }

  // Lỗi mà chưa có dữ liệu ⇒ nói rõ + Thử lại, không để khung xương quay mãi.
  if (isError && !board) {
    return <ErrorState title="Không tải được board" error={error} onRetry={() => void refetch()} retrying={isFetching} />
  }

  if (isLoading || !board) {
    return (
      <div className="flex gap-3 overflow-hidden pb-3" role="status" aria-busy="true">
        <span className="sr-only">Đang tải board…</span>
        {[0, 1, 2].map((i) => (
          <div key={i} aria-hidden className="flex w-72 shrink-0 flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] p-2 max-sm:w-[85vw]">
            <div className="h-6 px-1 py-1"><div className="skeleton-calm h-3.5 w-24 rounded-md bg-muted" /></div>
            <LoadingBlock variant="cards" count={3 - i} />
          </div>
        ))}
      </div>
    )
  }

  if (board.columns.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Board chưa có cột nào — vào “Cấu hình board” để thêm cột.
      </p>
    )
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          stopDrag()
          setActiveCard(null)
          setActiveColumnId(null)
        }}
      >
        <MotionConfig reducedMotion="user">
        <div ref={boardRef} className="flex gap-3 overflow-x-auto pb-3 max-sm:snap-x max-sm:snap-mandatory max-sm:scroll-px-4">
          {board.columns.map((column) => (
            <KanbanColumnView
              key={column.id}
              boardId={boardId}
              column={column}
              labelDefs={board.label_defs}
              filters={filters}
              canReorder={canReorderColumns}
              isBeingDragged={activeColumnId === column.id}
              hiddenCardId={activeCard?.id ?? settling?.card.id ?? null}
              drop={
                activeCard && dropTarget?.column === String(column.id)
                  ? { card: activeCard, index: dropTarget.index, height: activeSize?.height ?? 92 }
                  : !activeCard && settling?.card.column_id === column.id
                    ? settling
                    : null
              }
              onOpenCard={setOpenCardId}
            />
          ))}
        </div>
        </MotionConfig>

        <DragOverlay dropAnimation={{ duration: 260, easing: CSS_EASE_ENTER }}>
          {activeCard ? (
            <MotionConfig reducedMotion="user">
              <motion.div
                initial={{ rotate: 0, scale: 1 }}
                animate={{ rotate: 2.5, scale: 1.03 }}
                transition={motionTokens.spring.snappy}
                style={{ width: activeSize?.width }}
                className={`cursor-grabbing !shadow-xl ${KANBAN_CARD_FRAME}`}
              >
                <KanbanCardContent
                  card={activeCard}
                  labelDefs={board.label_defs}
                  assigneeNames={activeCard.assignee_ids.map((uid) => roster.find((u) => u.id === uid)?.full_name ?? `#${uid}`)}
                />
              </motion.div>
            </MotionConfig>
          ) : activeColumnId != null ? (
            <div className="flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-semibold shadow-xl">
              <GripVertical className="size-3.5 text-muted-foreground" />
              {board.columns.find((c) => c.id === activeColumnId)?.name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <KanbanCardDialog cardId={openCardId} onClose={() => setOpenCardId(null)} />
    </>
  )
}
