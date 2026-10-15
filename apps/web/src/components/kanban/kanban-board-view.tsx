"use client"

/**
 * View "Kanban" của 1 board (kéo-thả mượt kiểu Trello)
 * — cột kéo-thả ngang, mỗi cột tự tải card riêng (phân trang). Mobile: cuộn
 * ngang (`overflow-x-auto`).
 *
 * Kéo-thả CHỈ dùng `@dnd-kit/core` đã có sẵn (KHÔNG thêm `@dnd-kit/sortable`)
 * — thứ tự chèn card tính THỦ CÔNG từ `prevCardId`/`nextCardId` do
 * `KanbanColumnView` truyền xuống mỗi `KanbanCardPreview` (xem file đó), và
 * thứ tự cột tính từ vị trí X so với cột đích lúc thả. `DragOverlay` cho hiệu
 * ứng "nhấc lên nghiêng nhẹ" — bản gốc tại chỗ tạm ẩn thành placeholder viền
 * đứt (xem `kanban-card-preview.tsx`).
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
import { toast } from "sonner"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import { useMoveKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { useReorderKanbanColumns } from "@/hooks/kanban/use-kanban-columns"
import { KanbanColumnView } from "./kanban-column-view"
import { KanbanCardDialog } from "./kanban-card-dialog"
import type { KanbanCard, QueryKanbanCardsParams } from "@/types/kanban"

interface KanbanBoardViewProps {
  boardId: number
  filters: Omit<QueryKanbanCardsParams, "board_id" | "column_id" | "cursor">
}

/** So tâm 2 hình chữ nhật theo 1 trục — dùng để quyết "thả TRƯỚC hay SAU đích". */
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
  const { data: board, isLoading } = useKanbanBoardDetail(boardId)
  const moveCard = useMoveKanbanCard()
  const reorderColumns = useReorderKanbanColumns(boardId)
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null)
  const [activeColumnId, setActiveColumnId] = useState<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const canReorderColumns = can("kanban.boards")

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    if (id.startsWith("card-")) {
      setActiveCard((event.active.data.current as { card: KanbanCard } | undefined)?.card ?? null)
    } else if (id.startsWith("col-")) {
      setActiveColumnId(Number(id.replace("col-", "")))
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCard(null)
    setActiveColumnId(null)
    const { active, over } = event
    if (!over || !board) return
    const activeId = String(active.id)

    if (activeId.startsWith("col-")) {
      handleColumnDragEnd(activeId, event)
      return
    }

    const cardId = Number(activeId.replace("card-", ""))
    if (!cardId) return
    const overId = String(over.id)

    if (overId.startsWith("card-drop-")) {
      const overData = over.data.current as
        | { card: KanbanCard; prevCardId?: number; nextCardId?: number }
        | undefined
      if (!overData) return
      const before = isBeforeOnAxis(active.rect.current.translated, over.rect, "y")
      const payload = before
        ? { column_id: overData.card.column_id, before_card_id: overData.prevCardId, after_card_id: overData.card.id }
        : { column_id: overData.card.column_id, before_card_id: overData.card.id, after_card_id: overData.nextCardId }
      submitMove(cardId, payload)
      return
    }

    if (overId.startsWith("column-")) {
      const columnId = Number(overId.replace("column-", ""))
      if (!columnId) return
      submitMove(cardId, { column_id: columnId })
    }
  }

  const submitMove = (
    cardId: number,
    payload: { column_id: number; before_card_id?: number; after_card_id?: number },
  ) => {
    moveCard.mutate(
      { id: cardId, payload },
      {
        onSuccess: (result) => {
          if (result.wip_warning) toast.warning(result.wip_warning)
        },
        onError: (err) => toast.error(getApiErrorMessage(err, "Không chuyển được card")),
      },
    )
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

  if (isLoading || !board) {
    return <p className="p-6 text-sm text-muted-foreground">Đang tải board…</p>
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
          setActiveCard(null)
          setActiveColumnId(null)
        }}
      >
        <div className="flex gap-3 overflow-x-auto pb-3 max-sm:snap-x max-sm:snap-mandatory max-sm:scroll-px-4">
          {board.columns.map((column) => (
            <KanbanColumnView
              key={column.id}
              boardId={boardId}
              column={column}
              labelDefs={board.label_defs}
              filters={filters}
              canReorder={canReorderColumns}
              isBeingDragged={activeColumnId === column.id}
              onOpenCard={setOpenCardId}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
          {activeCard ? (
            <div className="w-64 rotate-2 scale-105 rounded-lg border border-primary/40 bg-card p-2.5 text-sm shadow-xl">
              <p className="line-clamp-2 font-medium">{activeCard.title}</p>
            </div>
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
