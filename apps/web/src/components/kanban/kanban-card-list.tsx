"use client"

/**
 * Danh sách card dạng BẢNG (toggle Board ↔ List). Nhận sẵn kết
 * quả `useInfiniteQuery` từ caller (board list hoặc contact tab) để dùng
 * chung UI, khác nguồn dữ liệu.
 */
import { Loader2 } from "lucide-react"
import { DotTag } from "@/components/app-shell/dot-tag"
import { ShellAvatar } from "@/components/app-shell/avatar"
import { Button } from "@/components/ui/button"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate } from "@/lib/format"
import { kanbanPriorityLabel, kanbanPriorityTone } from "@/lib/kanban-display"
import { useKanbanCardLookups, type KanbanCardLookups } from "@/hooks/kanban/use-kanban-card-lookups"
import type { KanbanCard } from "@/types/kanban"

interface KanbanCardListProps {
  cards: KanbanCard[]
  isLoading: boolean
  hasNextPage?: boolean
  isFetchingNextPage?: boolean
  onFetchNextPage?: () => void
  onOpenCard: (cardId: number) => void
  /** Cột "Board" (tên bảng) — dùng khi list gom card của nhiều board. */
  showBoardColumn?: boolean
  /** Cột "Trạng thái" (tên cột Kanban chứa card). */
  showStatusColumn?: boolean
}

export function KanbanCardList({
  cards,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onFetchNextPage,
  onOpenCard,
  showBoardColumn = false,
  showStatusColumn = false,
}: KanbanCardListProps) {
  const lookups = useKanbanCardLookups(cards, showBoardColumn || showStatusColumn || cards.length > 0)
  // Nhãn: tạo công việc từ khách không có chọn nhãn → chỉ hiện cột khi có dữ liệu.
  const hasLabels = cards.some((c) => c.labels.length > 0)
  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Đang tải…</p>
  }
  if (cards.length === 0) {
    return <p className="px-4 py-12 text-center text-sm text-muted-foreground">Không có card nào.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <ShellResponsiveList
        table={
      <Table>
        <TableHeader className="bg-transparent">
          <TableRow className="border-[var(--border)] hover:bg-transparent">
            <TableHead className={TH}>Tiêu đề</TableHead>
            {showBoardColumn && <TableHead className={TH}>Board</TableHead>}
            {showStatusColumn && <TableHead className={TH}>Trạng thái</TableHead>}
            <TableHead className={TH}>Khách hàng</TableHead>
            <TableHead className={TH}>Người phụ trách</TableHead>
            <TableHead className={TH}>Hạn xử lý</TableHead>
            <TableHead className={TH}>Ưu tiên</TableHead>
            {hasLabels && <TableHead className={TH}>Nhãn</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {cards.map((card) => (
            <CardRow
              key={card.id}
              card={card}
              lookups={lookups}
              showBoardColumn={showBoardColumn}
              showStatusColumn={showStatusColumn}
              hasLabels={hasLabels}
              onOpenCard={onOpenCard}
            />
          ))}
        </TableBody>
      </Table>
        }
        cards={
          <div className="space-y-3 p-3">
            {cards.map((card) => (
              <CardMobileItem
                key={card.id}
                card={card}
                lookups={lookups}
                showBoardColumn={showBoardColumn}
                showStatusColumn={showStatusColumn}
                onOpenCard={onOpenCard}
              />
            ))}
          </div>
        }
      />
      {hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="mb-3 self-center text-sm max-sm:h-11"
          disabled={isFetchingNextPage}
          onClick={onFetchNextPage}
        >
          {isFetchingNextPage ? <Loader2 className="size-3.5 animate-spin" /> : "Tải thêm"}
        </Button>
      )}
    </div>
  )
}

/** Ô tiêu đề cột — như bảng Khách hàng: chữ 14px, xám, không in hoa. */
const TH = "h-auto px-3 py-2.5 text-sm font-medium text-muted-foreground whitespace-nowrap first:pl-4"
/** Ô dữ liệu: cao như dòng bảng Khách hàng. */
const TD = "px-3 py-2.5 text-sm first:pl-4"

/** Nhãn lưu theo id: hiện tên + chấm màu từ label_defs của board, chưa tra được thì ẩn id thô sau dấu "…". */
function LabelBadge({ card, labelId, lookups }: { card: KanbanCard; labelId: string; lookups: KanbanCardLookups }) {
  const def = lookups.label?.(card.board_id, labelId) ?? null
  if (!def) return <DotTag tone="slate">…</DotTag>
  return <DotTag outline dotColor={def.color}>{def.name}</DotTag>
}

/** Người phụ trách: avatar chữ cái + tên đầu, "+n" nếu nhiều người. */
function Assignees({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex min-w-0 items-center gap-2" title={names.join(", ")}>
      <ShellAvatar name={names[0]} size="sm" className="!rounded-full text-sm" />
      <span className="truncate">{names[0]}</span>
      {names.length > 1 && <span className="shrink-0 text-muted-foreground">+{names.length - 1}</span>}
    </span>
  )
}

function CardRow({
  card, lookups, showBoardColumn, showStatusColumn, hasLabels, onOpenCard,
}: {
  card: KanbanCard
  lookups: KanbanCardLookups
  showBoardColumn: boolean
  showStatusColumn: boolean
  hasLabels: boolean
  onOpenCard: (cardId: number) => void
}) {
  const names = lookups.assigneeNames(card)
  const column = lookups.column(card.board_id, card.column_id)
  const priority = kanbanPriorityLabel(card.priority)
  return (
    <TableRow className="cursor-pointer border-[var(--border)] hover:bg-[var(--muted)]" onClick={() => onOpenCard(card.id)}>
      <TableCell className={`${TD} max-w-[22rem] whitespace-normal font-medium`}>{card.title}</TableCell>
      {showBoardColumn && (
        <TableCell className={TD}>
          <DotTag tone="violet">{lookups.boardName(card.board_id)}</DotTag>
        </TableCell>
      )}
      {showStatusColumn && (
        <TableCell className={TD}>
          {column ? (
            <DotTag tone={column.isDone ? "green" : "teal"}>{column.name}</DotTag>
          ) : (
            "—"
          )}
        </TableCell>
      )}
      <TableCell className={TD}>
        {card.contact ? (
          <span className="block min-w-0">
            <span className="block truncate">{card.contact.full_name ?? "Khách hàng"}</span>
            <span className="block tabular-nums text-muted-foreground">{card.contact.phone}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className={TD}>
        <Assignees names={names} />
      </TableCell>
      <TableCell className={`${TD} tabular-nums ${card.is_overdue ? "font-medium text-[var(--color-app-tag-red-ink)]" : ""}`}>
        {card.due_at ? formatDate(card.due_at) : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className={TD}>
        {priority ? (
          <DotTag tone={kanbanPriorityTone(card.priority)}>{priority}</DotTag>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      {hasLabels && (
        <TableCell className={TD}>
          <div className="flex flex-wrap gap-1">
            {card.labels.map((l) => (
              <LabelBadge key={l} card={card} labelId={l} lookups={lookups} />
            ))}
          </div>
        </TableCell>
      )}
    </TableRow>
  )
}

/** Điện thoại (<640px): mỗi card 1 thẻ, chạm = mở chi tiết. */
function CardMobileItem({
  card, lookups, showBoardColumn, showStatusColumn, onOpenCard,
}: {
  card: KanbanCard
  lookups: KanbanCardLookups
  showBoardColumn: boolean
  showStatusColumn: boolean
  onOpenCard: (cardId: number) => void
}) {
  const names = lookups.assigneeNames(card)
  const column = lookups.column(card.board_id, card.column_id)
  const priority = kanbanPriorityLabel(card.priority)
  return (
    <ShellListCard onClick={() => onOpenCard(card.id)}>
      <p className="font-medium">{card.title}</p>
      {showBoardColumn && (
        <ShellListCardRow
          label="Board"
          value={<DotTag tone="violet">{lookups.boardName(card.board_id)}</DotTag>}
        />
      )}
      {showStatusColumn && column && (
        <ShellListCardRow
          label="Trạng thái"
          value={<DotTag tone={column.isDone ? "green" : "teal"}>{column.name}</DotTag>}
        />
      )}
      {card.contact && (
        <ShellListCardRow
          label="Khách hàng"
          value={`${card.contact.full_name ?? ""} · ${card.contact.phone}`}
        />
      )}
      {names.length > 0 && (
        <ShellListCardRow
          label="Phụ trách"
          value={
            <>
              {names[0]}
              {names.length > 1 && <span className="text-muted-foreground"> +{names.length - 1}</span>}
            </>
          }
        />
      )}
      {card.due_at && (
        <ShellListCardRow
          label="Hạn xử lý"
          className={card.is_overdue ? "text-[var(--color-app-tag-red-ink)]" : ""}
          value={formatDate(card.due_at)}
        />
      )}
      {priority && (
        <ShellListCardRow
          label="Ưu tiên"
          value={<DotTag tone={kanbanPriorityTone(card.priority)}>{priority}</DotTag>}
        />
      )}
      {card.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {card.labels.map((l) => (
            <LabelBadge key={l} card={card} labelId={l} lookups={lookups} />
          ))}
        </div>
      )}
    </ShellListCard>
  )
}
