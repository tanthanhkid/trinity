/** Ngăn chi tiết «Ánh xanh»: sửa tại chỗ (giai đoạn, hạn nhanh, ưu tiên, người phụ trách) lưu ngay + Hoàn tác. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { KanbanCard } from "@/types/kanban"

const card: KanbanCard = {
  id: 7, code: "CV007", board_id: 1, column_id: 10, position: 1, title: "Gọi lại chốt đơn", description: "Mô tả cũ", contact_id: 5,
  assignee_id: 1, assignee_ids: [1], created_by: 1, due_at: null, due_completed_at: null, priority: "normal", labels: [],
  attributes: {}, completed_at: null, created_at: "", updated_at: "", contact: { id: 5, full_name: "Lê Minh Tuấn", phone: "0900", masked: false },
  is_overdue: false, checklist_total: 0, checklist_done: 0, comment_count: 0, attachment_count: 0,
}
const update = vi.fn((_v: unknown, o?: { onSuccess?: () => void }) => o?.onSuccess?.())
const move = vi.fn((_v: unknown) => Promise.resolve({ wip_warning: null }))
const undoToasts = vi.hoisted(() => ({ list: [] as { message: string; onUndo: () => void }[] }))

vi.mock("@/components/ui/undo-toast", () => ({
  showUndoToast: (message: string, o: { onUndo: () => void }) => undoToasts.list.push({ message, onUndo: o.onUndo }),
}))
vi.mock("@/components/app-shell/hover-link", () => ({ HoverLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => true }) }))
vi.mock("@/hooks/kanban/use-kanban-boards", () => ({
  useKanbanBoardDetail: () => ({
    data: {
      id: 1,
      columns: [
        { id: 10, name: "Cần làm", color: null, is_done: false, is_archived: false },
        { id: 20, name: "Đang làm", color: null, is_done: false, is_archived: false },
        { id: 30, name: "Xong", color: null, is_done: true, is_archived: false },
      ],
    },
  }),
}))
vi.mock("@/hooks/kanban/use-kanban-cards", () => ({
  useKanbanCard: () => ({ data: card, isLoading: false, isError: false }),
  useUpdateKanbanCard: () => ({ mutate: update }),
  useMoveKanbanCard: () => ({ mutateAsync: move, mutate: vi.fn() }),
}))
vi.mock("@/hooks/kanban/use-kanban-user-roster", () => ({
  useKanbanUserRoster: () => ({ data: [{ id: 1, full_name: "Linh" }, { id: 2, full_name: "Hạnh" }] }),
}))

import { KanbanQuickPanel } from "@/components/kanban/kanban-quick-panel"

beforeEach(() => {
  update.mockClear()
  move.mockClear()
  undoToasts.list = []
})

describe("KanbanQuickPanel (desktop)", () => {
  const open = (onOpenFull = vi.fn(), onClose = vi.fn()) => {
    render(<KanbanQuickPanel cardId={7} variant="desktop" onClose={onClose} onOpenFull={onOpenFull} />)
    return { onOpenFull, onClose }
  }

  it("hiện mã, tiêu đề, link khách sang hồ sơ; giai đoạn hiện tại được chọn", () => {
    open()
    expect(screen.getByText("CV007")).toBeTruthy()
    expect((screen.getByLabelText("Tiêu đề") as HTMLInputElement).value).toBe("Gọi lại chốt đơn")
    expect(screen.getByRole("link", { name: "Lê Minh Tuấn" }).getAttribute("href")).toBe("/contacts/5")
    expect(screen.getByRole("radio", { name: "Cần làm" }).getAttribute("aria-checked")).toBe("true")
  })

  it("chọn giai đoạn ⇒ chuyển cột + Hoàn tác về cột cũ", async () => {
    open()
    fireEvent.click(screen.getByRole("radio", { name: "Đang làm" }))
    expect(move).toHaveBeenCalledWith({ id: 7, payload: { column_id: 20 } })
    await waitFor(() => expect(undoToasts.list).toHaveLength(1))
    expect(undoToasts.list[0].message).toContain("Đang làm")
  })

  it("hạn nhanh «Bỏ hạn» khi chưa có hạn ⇒ không gọi; «Ngày mai» ⇒ lưu hạn + toast Hoàn tác trả hạn cũ", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Bỏ hạn" }))
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Ngày mai" }))
    expect(update).toHaveBeenCalledTimes(1)
    const sent = update.mock.calls[0][0] as { id: number; payload: { due_at: string } }
    expect(sent.id).toBe(7)
    expect(sent.payload.due_at).toMatch(/Z$/)
    expect(undoToasts.list).toHaveLength(1)
    undoToasts.list[0].onUndo()
    expect(update).toHaveBeenLastCalledWith({ id: 7, payload: { due_at: null, due_completed_at: null } }, expect.anything())
  })

  it("ưu tiên: chọn mức khác ⇒ lưu; bấm lại mức đang chọn ⇒ bỏ ưu tiên", () => {
    open()
    fireEvent.click(screen.getByRole("radio", { name: "Khẩn cấp" }))
    expect(update).toHaveBeenLastCalledWith({ id: 7, payload: { priority: "urgent" } }, expect.anything())
    fireEvent.click(screen.getByRole("radio", { name: "Bình thường" }))
    expect(update).toHaveBeenLastCalledWith({ id: 7, payload: { priority: null } }, expect.anything())
  })

  it("người phụ trách: thêm Hạnh giữ nguyên Linh; bỏ Linh còn rỗng vẫn cho phép", () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: /Hạnh/ }))
    expect(update).toHaveBeenLastCalledWith({ id: 7, payload: { assignee_ids: [1, 2] } }, expect.anything())
    fireEvent.click(screen.getByRole("button", { name: /Linh/ }))
    expect(update).toHaveBeenLastCalledWith({ id: 7, payload: { assignee_ids: [] } }, expect.anything())
  })

  it("sửa tiêu đề rồi rời ô ⇒ lưu; để trống ⇒ trả về tiêu đề cũ, không lưu", () => {
    open()
    const input = screen.getByLabelText("Tiêu đề") as HTMLInputElement
    fireEvent.change(input, { target: { value: "Tiêu đề mới" } })
    fireEvent.blur(input)
    expect(update).toHaveBeenLastCalledWith({ id: 7, payload: { title: "Tiêu đề mới" } }, expect.anything())
    update.mockClear()
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.blur(input)
    expect(update).not.toHaveBeenCalled()
    expect(input.value).toBe("Gọi lại chốt đơn")
  })

  it("«Mở đầy đủ» và «Đóng chi tiết» gọi đúng callback", () => {
    const { onOpenFull, onClose } = open()
    fireEvent.click(screen.getByRole("button", { name: /Mở đầy đủ/ }))
    expect(onOpenFull).toHaveBeenCalledWith(7)
    fireEvent.click(screen.getByRole("button", { name: "Đóng chi tiết" }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe("KanbanQuickPanel (điện thoại)", () => {
  it("trang toàn màn hình: quay lại + nút dính «Đánh dấu đã xong» (không có hạn ⇒ chuyển sang cột xong)", () => {
    const onClose = vi.fn()
    render(<KanbanQuickPanel cardId={7} variant="mobile" onClose={onClose} onOpenFull={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Quay lại danh sách" }))
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Đánh dấu đã xong" }))
    expect(move).toHaveBeenCalledWith({ id: 7, payload: { column_id: 30 } })
  })
})
