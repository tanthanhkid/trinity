"use client"

/**
 * Trang Kanban — board switcher + toggle Board/List + filters +
 * link "Cấu hình board" (RBAC quyền+phạm vi — `kanban.boards`).
 */
import { Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { LayoutGrid, Plus, Search, Settings2, Table2 } from "lucide-react"
import { buttonVariants } from "@/components/ui/button-variants"
import { Button } from "@/components/ui/button"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { Input } from "@/components/ui/input"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { useKanbanBoards } from "@/hooks/kanban/use-kanban-boards"
import { useKanbanCardsByBoard } from "@/hooks/kanban/use-kanban-cards"
import { KanbanBoardView } from "@/components/kanban/kanban-board-view"
import { KanbanCardList } from "@/components/kanban/kanban-card-list"
import { KanbanAddCardDialog } from "@/components/kanban/kanban-add-card-dialog"
import { KanbanCardDialog } from "@/components/kanban/kanban-card-dialog"
import { InlineSelect } from "@/components/ui/inline-select"
import { cn } from "@/lib/utils"
import { BOX } from "@/app/(dashboard)/dashboard/_components/home-box"

type ViewMode = "board" | "list"

/** `/kanban?card=<id>` (deep link từ Tổng quan) mở thẳng card đó. */
function parseCardParam(raw: string | null): number | null {
  const id = raw ? Number(raw) : NaN
  return Number.isInteger(id) && id > 0 ? id : null
}

export default function KanbanPage() {
  return (
    <PermissionGate permission="kanban.view">
      <Suspense fallback={null}>
        <KanbanScreen />
      </Suspense>
    </PermissionGate>
  )
}

function KanbanScreen() {
  const cardParam = parseCardParam(useSearchParams().get("card"))
  const { can } = usePermissions()
  const canConfigure = can("kanban.boards")
  const canCreateCard = can("kanban.manage")
  const { data: boards = [], isLoading: boardsLoading } = useKanbanBoards()
  const [boardId, setBoardId] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("board")
  const [addCardOpen, setAddCardOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [openCardId, setOpenCardId] = useState<number | null>(cardParam)

  // Link /kanban?card=ID khi đã đứng ở /kanban: route không remount nên phải đồng bộ lại từ query
  // (chỉnh state ngay lúc render theo giá trị query trước đó — không cần effect).
  const [seenCardParam, setSeenCardParam] = useState(cardParam)
  if (cardParam !== seenCardParam) {
    setSeenCardParam(cardParam)
    if (cardParam != null) setOpenCardId(cardParam)
  }

  useEffect(() => {
    if (boardId == null && boards.length > 0) setBoardId(boards[0].id)
  }, [boardId, boards])

  const filters = useMemo(() => (search.trim() ? { search: search.trim() } : {}), [search])

  const listQuery = useKanbanCardsByBoard(boardId ?? 0, filters)
  const listCards = listQuery.data?.pages.flatMap((p) => p.cards) ?? []

  const currentBoard = boards.find((b) => b.id === boardId) ?? null
  const viewBtn = (mode: ViewMode) =>
    cn(
      "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-medium transition max-sm:h-11",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
      viewMode === mode ? "bg-[var(--muted)] text-foreground" : "text-muted-foreground hover:bg-[var(--muted)] hover:text-foreground",
    )

  return (
    <div className="space-y-4">
      {/* Thanh trên gọn như màn Khách hàng: tiêu đề + số card của board đang xem · Cấu hình board / Thêm card */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex min-w-0 items-baseline gap-2 text-[22px] font-semibold leading-tight tracking-tight text-foreground">
          Công việc
          {currentBoard && (
            <span className="text-[15px] font-normal tabular-nums text-muted-foreground">
              {currentBoard.card_count.toLocaleString("vi-VN")} card
            </span>
          )}
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canConfigure && (
            <Link
              href="/kanban/settings"
              aria-label="Cấu hình board"
              className={`${buttonVariants({ variant: "outline" })} h-9 gap-1.5 text-sm max-sm:min-h-11 max-sm:min-w-11 max-sm:px-0`}
            >
              <Settings2 className="size-4" /> <span className="max-sm:hidden">Cấu hình board</span>
            </Link>
          )}
          {canCreateCard && (
            <Button className={cn("h-9 gap-1.5 text-sm", MOBILE_FAB_CLASS)} disabled={boardId == null} onClick={() => setAddCardOpen(true)}>
              <Plus className="size-4" /> Thêm card
            </Button>
          )}
        </div>
      </div>

      {boardsLoading ? (
        <p className="text-sm text-muted-foreground">Đang tải danh sách board…</p>
      ) : boards.length === 0 ? (
        <div className={cn(BOX, "px-4 py-10 text-center text-sm text-muted-foreground")}>
          Chưa có board nào hiển thị với vai trò của bạn.
          {canConfigure && " Vào \"Cấu hình board\" để tạo board đầu tiên."}
        </div>
      ) : (
        <section aria-label="Công việc của board" className={cn(BOX, "overflow-hidden")}>
          {/* Hàng công cụ: chọn board · tìm · Kanban/Bảng */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5 sm:px-4">
            <InlineSelect<number>
              size="sm"
              className="w-60 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 [&>button]:h-9 [&>button]:text-sm max-sm:[&>button]:h-11"
              ariaLabel="Chọn board"
              options={boards.map((b) => ({ value: b.id, label: `${b.name} (${b.card_count})` }))}
              value={boardId}
              onChange={(v) => v != null && setBoardId(v)}
            />

            <div className="relative w-60 max-sm:order-first max-sm:w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Tìm theo tiêu đề…"
                aria-label="Tìm theo tiêu đề"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 pl-9 text-sm max-sm:h-11"
              />
            </div>

            <div className="ml-auto flex items-center gap-1" role="group" aria-label="Kiểu xem">
              <button type="button" onClick={() => setViewMode("board")} aria-pressed={viewMode === "board"} className={viewBtn("board")}>
                <LayoutGrid className="size-4" /> Kanban
              </button>
              <button type="button" onClick={() => setViewMode("list")} aria-pressed={viewMode === "list"} className={viewBtn("list")}>
                <Table2 className="size-4" /> Bảng
              </button>
            </div>
          </div>

          {boardId != null &&
            (viewMode === "board" ? (
              <div className="p-3 sm:p-4">
                <KanbanBoardView boardId={boardId} filters={filters} />
              </div>
            ) : (
              <KanbanCardList
                cards={listCards}
                isLoading={listQuery.isLoading}
                hasNextPage={listQuery.hasNextPage}
                isFetchingNextPage={listQuery.isFetchingNextPage}
                onFetchNextPage={() => listQuery.fetchNextPage()}
                onOpenCard={setOpenCardId}
              />
            ))}
        </section>
      )}

      {boardId != null && (
        <KanbanAddCardDialog boardId={boardId} open={addCardOpen} onOpenChange={setAddCardOpen} />
      )}
      <KanbanCardDialog cardId={openCardId} onClose={() => setOpenCardId(null)} />
    </div>
  )
}
