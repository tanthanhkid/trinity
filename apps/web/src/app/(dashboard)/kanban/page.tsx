"use client"

/**
 * Trang Kanban «Ánh xanh» (cohoi) — board switcher + toggle Board/List + tìm + link "Cấu hình board"
 * (RBAC quyền+phạm vi — `kanban.boards`).
 * - Desktop (≥1024px): bảng cột kéo-thả + ngăn chi tiết bên phải (sửa tại chỗ).
 * - Điện thoại: khối nhấn + tab giai đoạn + danh sách thẻ; bấm thẻ ⇒ trang chi tiết toàn màn hình.
 * Hộp thoại đầy đủ (`KanbanCardDialog`) mở từ nút «Mở đầy đủ» ở ngăn/trang chi tiết.
 */
import { Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { HoverLink as Link } from "@/components/app-shell/hover-link"
import { LayoutGrid, Plus, Search, Settings2, Table2 } from "lucide-react"
import { buttonVariants } from "@/components/ui/button-variants"
import { Button } from "@/components/ui/button"
import { HeroCard, HeroCardLabel } from "@/components/ui/hero-card"
import { Input } from "@/components/ui/input"
import { PermissionGate, usePermissions } from "@/lib/rbac"
import { useKanbanBoards } from "@/hooks/kanban/use-kanban-boards"
import { useKanbanCardsByBoard } from "@/hooks/kanban/use-kanban-cards"
import { KanbanBoardView } from "@/components/kanban/kanban-board-view"
import { KanbanCardList } from "@/components/kanban/kanban-card-list"
import { KanbanAddCardDialog } from "@/components/kanban/kanban-add-card-dialog"
import { KanbanCardDialog } from "@/components/kanban/kanban-card-dialog"
import { KanbanQuickPanel } from "@/components/kanban/kanban-quick-panel"
import { KanbanMobileBoard } from "@/components/kanban/kanban-mobile-board"
import { useIsDesktop } from "@/hooks/use-media-query"
import { InlineSelect } from "@/components/ui/inline-select"
import { LoadingBlock } from "@/components/ui/loading-block"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { cn } from "@/lib/utils"

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
  const isDesktop = useIsDesktop()
  const canConfigure = can("kanban.boards")
  const canCreateCard = can("kanban.manage")
  const { data: boards = [], isLoading: boardsLoading, isError: boardsError, error: boardsErr, refetch: refetchBoards, isFetching: boardsFetching } = useKanbanBoards({ overview: true })
  const [boardId, setBoardId] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("board")
  const [addCardOpen, setAddCardOpen] = useState(false)
  const [search, setSearch] = useState("")
  /** Thẻ đang mở ở ngăn chi tiết (desktop) / trang chi tiết (điện thoại). */
  const [openCardId, setOpenCardId] = useState<number | null>(cardParam)
  /** Thẻ đang mở ở hộp thoại đầy đủ (checklist, bình luận, nhãn, trường tuỳ biến, xoá). */
  const [fullCardId, setFullCardId] = useState<number | null>(null)

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

  const listQuery = useKanbanCardsByBoard(boardId ?? 0, filters, viewMode === "list" && isDesktop)
  const listCards = listQuery.data?.pages.flatMap((p) => p.cards) ?? []

  const currentBoard = boards.find((b) => b.id === boardId) ?? null
  const cardCountText = currentBoard ? `${currentBoard.card_count.toLocaleString("vi-VN")} thẻ` : null
  const boardOptions = boards.map((b) => ({ value: b.id, label: `${b.name} (${b.card_count})` }))
  const viewBtn = (mode: ViewMode) =>
    cn(
      "inline-flex h-9 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-ax-field px-3 text-sm font-semibold transition-colors duration-150",
      "focus-visible:outline-none focus-visible:shadow-[var(--ax-focus-ring)]",
      viewMode === mode ? "bg-ax-primary-soft text-ax-primary-ink" : "text-ax-ink-2 hover:bg-ax-hover",
    )

  const settingsLink = canConfigure && (
    <Link
      href="/kanban/settings"
      aria-label="Cấu hình board"
      className={cn(buttonVariants({ variant: "ax-secondary", size: "ax" }), "max-lg:size-11 max-lg:px-0")}
    >
      <Settings2 className="size-4" aria-hidden /> <span className="max-lg:hidden">Cấu hình board</span>
    </Link>
  )

  const searchBox = (
    <div className="relative w-60 max-lg:w-full">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ax-ink-3" aria-hidden />
      <Input
        variant="ax"
        placeholder="Tìm theo tiêu đề…"
        aria-label="Tìm theo tiêu đề"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="pl-9"
      />
    </div>
  )

  const closeDetail = () => setOpenCardId(null)
  const detail =
    openCardId != null ? (
      <KanbanQuickPanel
        key={openCardId}
        cardId={openCardId}
        variant={isDesktop ? "desktop" : "mobile"}
        onClose={closeDetail}
        onOpenFull={setFullCardId}
      />
    ) : null

  const state = boardsLoading ? (
    <div className="ax-card p-4"><LoadingBlock count={3} label="Đang tải danh sách board…" /></div>
  ) : boardsError && boards.length === 0 ? (
    <ErrorState title="Không tải được danh sách board" error={boardsErr} onRetry={() => void refetchBoards()} retrying={boardsFetching} />
  ) : boards.length === 0 ? (
    <EmptyState
      variant="ax"
      title="Chưa có board nào"
      message={canConfigure ? "Tạo board đầu tiên để theo dõi công việc, cơ hội bán theo từng bước." : "Chưa có board nào hiển thị với vai trò của bạn — nhờ quản trị viên cấp quyền xem board."}
      action={canConfigure ? <Link href="/kanban/settings" className={buttonVariants({ variant: "ax-secondary", size: "ax" })}>Tạo board</Link> : undefined}
    />
  ) : null

  const dialogs = (
    <>
      {boardId != null && <KanbanAddCardDialog boardId={boardId} open={addCardOpen} onOpenChange={setAddCardOpen} />}
      <KanbanCardDialog
        cardId={fullCardId}
        onClose={() => setFullCardId(null)}
        onDeleted={(id) => setOpenCardId((cur) => (cur === id ? null : cur))}
      />
    </>
  )

  if (!isDesktop) {
    return (
      <div className="flex flex-col gap-3">
        <HeroCard className="flex items-end justify-between gap-3 p-[18px]">
          <div className="min-w-0">
            <HeroCardLabel className="truncate text-[13px]">{currentBoard ? `Bảng ${currentBoard.name}` : "Bảng"}</HeroCardLabel>
            <h1 className="mt-0.5 text-[28px] leading-[1.1] font-bold tracking-[-0.02em] text-white">Công việc</h1>
          </div>
          {cardCountText && <span className="shrink-0 text-sm tabular-nums text-[var(--ax-on-hero-ink-2)]">{cardCountText}</span>}
        </HeroCard>

        {state ?? (
          <>
            <div className="flex items-center gap-2">
              {boards.length > 1 && (
                <InlineSelect<number>
                  className="w-auto min-w-0 flex-1 [&>button]:h-11"
                  ariaLabel="Chọn board"
                  options={boardOptions}
                  value={boardId}
                  onChange={(v) => v != null && setBoardId(v)}
                />
              )}
              {settingsLink}
            </div>
            {searchBox}
            {boardId != null && <KanbanMobileBoard boardId={boardId} filters={filters} onOpenCard={setOpenCardId} />}
            {canCreateCard && (
              <Button
                variant="ax-primary"
                aria-label="Thêm thẻ"
                disabled={boardId == null}
                onClick={() => setAddCardOpen(true)}
                className="fixed right-5 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-30 size-14 rounded-2xl p-0"
              >
                <Plus className="size-6" strokeWidth={2.4} aria-hidden />
              </Button>
            )}
          </>
        )}
        {dialogs}
        {detail}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      {/* Thanh trên: tiêu đề + số thẻ của board đang xem · chọn board · tìm · Kanban/Bảng · Cấu hình board · Thêm thẻ */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex min-w-0 items-baseline gap-2 text-[22px] leading-tight font-bold tracking-[-0.02em] text-ax-ink">
          Công việc
          {cardCountText && <span className="text-[15px] font-normal tabular-nums text-ax-ink-2">{cardCountText}</span>}
        </h1>
        {boards.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <InlineSelect<number>
              className="w-60 [&>button]:h-10 [&>button]:text-sm"
              ariaLabel="Chọn board"
              options={boardOptions}
              value={boardId}
              onChange={(v) => v != null && setBoardId(v)}
            />
            {searchBox}
            <div className="flex items-center gap-1 rounded-ax-card bg-ax-surface p-0.5 shadow-[var(--ax-shadow-secondary)]" role="group" aria-label="Kiểu xem">
              <button type="button" onClick={() => setViewMode("board")} aria-pressed={viewMode === "board"} className={viewBtn("board")}>
                <LayoutGrid className="size-4" aria-hidden /> Kanban
              </button>
              <button type="button" onClick={() => setViewMode("list")} aria-pressed={viewMode === "list"} className={viewBtn("list")}>
                <Table2 className="size-4" aria-hidden /> Bảng
              </button>
            </div>
            {settingsLink}
            {canCreateCard && (
              <Button variant="ax-primary" size="ax" disabled={boardId == null} onClick={() => setAddCardOpen(true)}>
                <Plus className="size-4" aria-hidden /> Thêm thẻ
              </Button>
            )}
          </div>
        )}
      </div>

      {state ?? (
        <section aria-label="Công việc của board" className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1 basis-[640px]">
            {boardId != null &&
              (viewMode === "board" ? (
                <KanbanBoardView boardId={boardId} filters={filters} onOpenCard={setOpenCardId} selectedCardId={openCardId} />
              ) : (
                <div className="ax-card overflow-hidden">
                  <KanbanCardList
                    cards={listCards}
                    isLoading={listQuery.isLoading}
                    error={listQuery.isError ? listQuery.error : undefined}
                    onRetry={() => void listQuery.refetch()}
                    hasNextPage={listQuery.hasNextPage}
                    isFetchingNextPage={listQuery.isFetchingNextPage}
                    onFetchNextPage={() => listQuery.fetchNextPage()}
                    onOpenCard={setOpenCardId}
                  />
                </div>
              ))}
          </div>
          {detail ??
            (viewMode === "board" && (
              <aside className="ax-grad-empty w-[440px] max-w-full shrink-0 rounded-ax-sheet border border-dashed border-ax-line px-7 py-10 text-center text-sm leading-relaxed text-ax-ink-2">
                Bấm một thẻ để xem và sửa tại đây. Đổi giai đoạn, hạn, người phụ trách chỉ một bấm.
              </aside>
            ))}
        </section>
      )}
      {dialogs}
    </div>
  )
}
