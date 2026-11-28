"use client"

/**
 * Bố cục ĐIỆN THOẠI của bảng Công việc («Ánh xanh», cohoi-mobile): thanh tab giai đoạn (pill 44px, chấm màu +
 * số thẻ) và danh sách thẻ của MỘT giai đoạn — không phải bảng cột kéo-thả của desktop. Mỗi thẻ có nút
 * «sang <giai đoạn kế>» 64px bên phải (chuyển một bấm, có Hoàn tác). Bấm thẻ ⇒ mở trang chi tiết.
 */
import { useState } from "react"
import { ChevronRight, Inbox } from "lucide-react"
import { toast } from "sonner"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { LoadingBlock } from "@/components/ui/loading-block"
import { Button } from "@/components/ui/button"
import { stageToneVars } from "@/components/ui/stage-chip"
import { showUndoToast } from "@/components/ui/undo-toast"
import { getApiErrorMessage } from "@/lib/api-client"
import { stageToneForColumn } from "@/lib/kanban-ax"
import { cn } from "@/lib/utils"
import { useKanbanBoardDetail } from "@/hooks/kanban/use-kanban-boards"
import { useKanbanCardsByColumn, useMoveKanbanCard } from "@/hooks/kanban/use-kanban-cards"
import { formatNumber } from "@/lib/format"
import { KanbanCardMeta } from "./kanban-card-preview"
import type { KanbanCard, KanbanColumn, QueryKanbanCardsParams } from "@/types/kanban"

type Filters = Omit<QueryKanbanCardsParams, "board_id" | "column_id" | "cursor">

interface KanbanMobileBoardProps {
  boardId: number
  filters: Filters
  onOpenCard: (cardId: number) => void
}

export function KanbanMobileBoard({ boardId, filters, onOpenCard }: KanbanMobileBoardProps) {
  const { data: board, isLoading, isError, error, refetch, isFetching } = useKanbanBoardDetail(boardId)
  const [tab, setTab] = useState<number | null>(null)
  const columns = (board?.columns ?? []).filter((c) => !c.is_archived)

  if (isError && !board) return <ErrorState title="Không tải được board" error={error} onRetry={() => void refetch()} retrying={isFetching} />
  if (isLoading || !board) return <LoadingBlock count={3} label="Đang tải board…" />
  if (columns.length === 0) return <p className="p-6 text-[15px] text-ax-ink-2">Board chưa có cột nào — vào “Cấu hình board” để thêm cột.</p>

  // Chưa chọn / cột đang chọn không còn (đổi board) ⇒ cột đầu.
  const index = Math.max(0, columns.findIndex((c) => c.id === tab))
  const current = columns[index]
  const next = columns[index + 1] ?? null

  return (
    <>
      <div role="tablist" aria-label="Giai đoạn" className="-mx-4 flex gap-2 overflow-x-auto px-4 pt-1 pb-3 [scrollbar-width:none]">
        {columns.map((col, i) => (
          <StageTab key={col.id} boardId={boardId} filters={filters} column={col} index={i} selected={col.id === current.id} onPick={() => setTab(col.id)} />
        ))}
      </div>
      <StageList
        key={current.id}
        boardId={boardId}
        filters={filters}
        column={current}
        next={next}
        onOpenCard={onOpenCard}
      />
    </>
  )
}

function StageTab({
  boardId,
  filters,
  column,
  index,
  selected,
  onPick,
}: {
  boardId: number
  filters: Filters
  column: KanbanColumn
  index: number
  selected: boolean
  onPick: () => void
}) {
  const { data, hasNextPage } = useKanbanCardsByColumn(boardId, column.id, filters)
  const n = data?.pages.flatMap((p) => p.cards).length
  const v = stageToneVars(column.color ? "neutral" : stageToneForColumn(index, column.is_done))
  const dot = column.color ?? v.dot
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onPick}
      style={selected ? { backgroundColor: v.bg, color: v.ink, borderColor: dot } : undefined}
      className={cn(
        "inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-[var(--ax-radius-chip)] border px-4 text-[15px] font-semibold whitespace-nowrap outline-none transition-colors duration-150 focus-visible:shadow-[var(--ax-focus-ring)]",
        !selected && "border-ax-line bg-ax-surface text-ax-ink-2",
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: dot }} />
      {column.name}
      <span className="tabular-nums opacity-85">{n == null ? "" : `${formatNumber(n)}${hasNextPage ? "+" : ""}`}</span>
    </button>
  )
}

function StageList({
  boardId,
  filters,
  column,
  next,
  onOpenCard,
}: {
  boardId: number
  filters: Filters
  column: KanbanColumn
  next: KanbanColumn | null
  onOpenCard: (cardId: number) => void
}) {
  const { data, isLoading, isError, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useKanbanCardsByColumn(
    boardId,
    column.id,
    filters,
  )
  const moveCard = useMoveKanbanCard()
  const cards = data?.pages.flatMap((p) => p.cards) ?? []

  const moveNext = (card: KanbanCard) => {
    if (!next) return
    moveCard
      .mutateAsync({ id: card.id, payload: { column_id: next.id } })
      .then((res) => {
        if (res.wip_warning) toast.warning(res.wip_warning)
        showUndoToast(`Đã chuyển sang “${next.name}”`, {
          onUndo: () => moveCard.mutate({ id: card.id, payload: { column_id: column.id } }),
        })
      })
      .catch((err) => toast.error(getApiErrorMessage(err, "Không chuyển được card")))
  }

  if (isLoading) return <LoadingBlock variant="cards" count={3} />
  if (isError && cards.length === 0) return <ErrorState compact title="Không tải được card" error={error} onRetry={() => void refetch()} retrying={isFetching} />
  if (cards.length === 0) {
    return <EmptyState variant="ax" icon={Inbox} title="Cột này đang trống" message="Thẻ chuyển sang đây sẽ hiện ở đây." />
  }
  return (
    <div role="tabpanel" aria-label={column.name} className="flex flex-col gap-2.5 pb-24">
      {cards.map((card) => (
        <div key={card.id} className="flex items-stretch rounded-ax-card border border-ax-divider bg-ax-surface shadow-[var(--ax-shadow-card)]">
          <button
            type="button"
            onClick={() => onOpenCard(card.id)}
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 rounded-l-ax-card py-3.5 pr-2 pl-4 text-left outline-none focus-visible:shadow-[var(--ax-focus-ring)]"
          >
            <span className={cn("text-base font-semibold leading-[1.35] text-ax-ink", card.due_completed_at != null && "line-through")}>{card.title}</span>
            {card.contact && <span className="truncate text-sm text-ax-ink-2">{card.contact.full_name ?? "Khách hàng"}</span>}
            <KanbanCardMeta card={card} className="text-[13px]" />
          </button>
          {next && (
            <button
              type="button"
              onClick={() => moveNext(card)}
              aria-label={`Chuyển “${card.title}” sang ${next.name}`}
              className="flex w-16 shrink-0 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-r-ax-card border-l border-ax-divider text-xs font-semibold text-ax-primary outline-none hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]"
            >
              <ChevronRight className="size-5" strokeWidth={2.2} aria-hidden />
              <span className="max-w-14 truncate">{next.name.split(" ").pop()}</span>
            </button>
          )}
        </div>
      ))}
      {hasNextPage && (
        <Button variant="ax-ghost" size="ax" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
          Tải thêm
        </Button>
      )}
    </div>
  )
}
