import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { KanbanCard } from "@/types/kanban"

const move = vi.fn()
const update = vi.fn()

const card: KanbanCard = {
  id: 14, code: "CV014", board_id: 3, column_id: 1, position: 1, title: "Gọi lại anh Bảo", description: "Chốt sofa",
  contact_id: null, assignee_id: 5, assignee_ids: [5], created_by: 1, due_at: null, due_completed_at: null,
  priority: "high", labels: ["l1"], attributes: {}, completed_at: null, created_at: "2026-11-26T02:15:00Z",
  updated_at: "", contact: null, is_overdue: false, checklist_total: 2, checklist_done: 1, comment_count: 0, attachment_count: 0,
}
const columns = [
  { id: 1, board_id: 3, name: "Cần làm", color: "#5B6170", position: 1, wip_limit: null, is_done: false, is_archived: false, created_at: "", updated_at: "" },
  { id: 2, board_id: 3, name: "Xong", color: "#2F7A4F", position: 2, wip_limit: null, is_done: true, is_archived: false, created_at: "", updated_at: "" },
]

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("next/dynamic", () => ({ default: () => () => null }))
vi.mock("@/components/app-shell/hover-link", () => ({ HoverLink: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }))
vi.mock("@/components/refs/mention-editor", () => ({ MentionEditor: () => <textarea aria-label="editor" /> }))
vi.mock("@/components/refs/mention-text", () => ({ MentionText: ({ text }: { text: string }) => <span>{text}</span> }))
vi.mock("@/components/kanban/kanban-attachment-panel", () => ({ KanbanAttachmentPanel: () => null }))
vi.mock("@/components/kanban/kanban-contact-picker", () => ({ KanbanContactPicker: () => null }))
vi.mock("@/components/kanban/kanban-multi-user-picker", () => ({ KanbanMultiUserPicker: () => null }))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: 1 } }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => true, isAdmin: false }) }))
vi.mock("@/hooks/kanban/use-kanban-boards", () => ({
  useKanbanBoardDetail: () => ({ data: { id: 3, name: "Bảng Bán hàng", columns, field_defs: [], label_defs: [{ id: "l1", name: "Báo giá", color: "#3A75A6" }] } }),
}))
vi.mock("@/hooks/kanban/use-kanban-cards", () => ({
  useKanbanCard: () => ({ data: card, isError: false }),
  useUpdateKanbanCard: () => ({ mutate: update }),
  useMoveKanbanCard: () => ({ mutate: move }),
  useDeleteKanbanCardWithUndo: () => vi.fn(),
}))
vi.mock("@/hooks/kanban/use-kanban-checklist", () => ({
  useKanbanChecklist: () => ({ data: [{ id: 1, text: "Xác nhận màu", is_done: true }, { id: 2, text: "Gọi anh Bảo", is_done: false }] }),
  useCreateKanbanChecklistItem: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateKanbanChecklistItem: () => ({ mutate: vi.fn() }),
  useDeleteKanbanChecklistItem: () => ({ mutate: vi.fn() }),
}))
vi.mock("@/hooks/kanban/use-kanban-card-activities", () => ({
  useKanbanCardActivities: () => ({ data: [], isLoading: false }),
  useAddKanbanComment: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/kanban/use-kanban-user-roster", () => ({
  useKanbanUserRoster: () => ({ data: [{ id: 5, full_name: "Minh Trần" }, { id: 6, full_name: "Linh Phạm" }] }),
}))

import { KanbanCardPage } from "@/components/kanban/kanban-card-page"

const renderPage = (cardId: number | null) =>
  render(<QueryClientProvider client={new QueryClient()}><KanbanCardPage cardId={cardId} /></QueryClientProvider>)

function setDesktop(on: boolean) {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("1024"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
}

describe("KanbanCardPage", () => {
  beforeEach(() => { move.mockClear(); update.mockClear() })

  it("desktop: tên việc, cột thuộc tính, đổi giai đoạn gọi move", () => {
    setDesktop(true)
    renderPage(14)
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Gọi lại anh Bảo")
    expect(screen.getByRole("complementary", { name: "Thuộc tính" })).toBeTruthy()
    expect(screen.getByText("1/2 xong")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Xong/ }))
    expect(move).toHaveBeenCalledWith({ id: 14, payload: { column_id: 2 } }, expect.anything())
  })

  it("điện thoại: có nút Hoàn thành việc dính đáy, bấm chuyển sang cột xong", () => {
    setDesktop(false)
    renderPage(14)
    expect(screen.queryByRole("complementary", { name: "Thuộc tính" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Hoàn thành việc" }))
    expect(move).toHaveBeenCalledWith({ id: 14, payload: { column_id: 2 } }, expect.anything())
  })

  it("id sai hiện trạng thái trống, không crash", () => {
    setDesktop(true)
    renderPage(null)
    expect(screen.getByText("Không mở được công việc này")).toBeTruthy()
  })
})
