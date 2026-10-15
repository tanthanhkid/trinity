import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"

// RBAC quyền + phạm vi: nút hiện khi có `contacts.view` VÀ `kanban.manage` (POST /kanban/cards đòi kanban.manage).
let canViewContacts = true
let canManageKanban = true
vi.mock("@/lib/rbac", () => ({
  usePermissions: () => ({ can: (p: string) => (p === "contacts.view" && canViewContacts) || (p === "kanban.manage" && canManageKanban) }),
}))
vi.mock("@/hooks/kanban/use-kanban-cards", () => ({
  useKanbanCardsByContact: () => ({ data: { pages: [{ cards: [] }] }, isLoading: false }),
}))
vi.mock("@/components/kanban/kanban-card-list", () => ({ KanbanCardList: () => <div /> }))
vi.mock("@/components/kanban/kanban-card-dialog", () => ({ KanbanCardDialog: () => null }))
vi.mock("@/components/kanban/contact-create-task-dialog", () => ({
  ContactCreateTaskDialog: ({ open, contactId }: { open: boolean; contactId: number }) =>
    open ? <div>dialog-{contactId}</div> : null,
}))

import { ContactKanbanTab } from "@/components/kanban/contact-kanban-tab"

describe("ContactKanbanTab — nút Tạo công việc", () => {
  beforeEach(() => {
    canViewContacts = true
    canManageKanban = true
  })
  it("hiện nút Tạo công việc cho người có quyền xem Danh bạ", () => {
    render(<ContactKanbanTab contactId={7} />)
    expect(screen.getByRole("button", { name: /Tạo công việc/ })).toBeTruthy()
  })
  it("ẩn nút khi có contacts.view nhưng thiếu kanban.manage (tránh 403)", () => {
    canManageKanban = false
    render(<ContactKanbanTab contactId={7} />)
    expect(screen.queryByRole("button", { name: /Tạo công việc/ })).toBeNull()
  })
  it("ẩn nút khi KHÔNG có quyền contacts.view (không được gắn khách hàng vào card)", () => {
    canViewContacts = false
    render(<ContactKanbanTab contactId={7} />)
    expect(screen.queryByRole("button", { name: /Tạo công việc/ })).toBeNull()
  })
})
