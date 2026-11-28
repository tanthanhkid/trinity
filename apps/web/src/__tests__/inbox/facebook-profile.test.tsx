import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

/**
 * Hồ sơ khách của hội thoại Messenger sửa được như Zalo OA (vòng 2 Ánh xanh, câu 7): cùng `CustomerProfile`, cùng API
 * GET/PATCH /contacts/:id, đúng quyền `contacts.view` / `contacts.update`. Kèm đầu hội thoại điện thoại (hopthu-mobile):
 * chip SĐT / giai đoạn / hẹn, dòng «Messenger · Phụ trách …», hội thoại mở ra chiếm toàn màn dưới 1024px.
 */
const mockGet = vi.fn()
const mockPatch = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    post: (...a: unknown[]) => mockPost(...a),
  },
}))
const undoToast = vi.hoisted(() => vi.fn())
vi.mock("@/components/ui/undo-toast", () => ({ showUndoToast: undoToast }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const perms = vi.hoisted(() => ({ view: true, update: true }))
vi.mock("@/lib/rbac", () => ({
  usePermissions: () => ({
    can: (k: string) => (k === "contacts.view" && perms.view) || (k === "contacts.update" && perms.update),
    isAdmin: false,
  }),
}))
vi.mock("@/hooks/use-settings-options", () => ({
  useSettingsOptions: (group: string) => ({
    data: group === "contact_stage" ? [{ id: 1, value: "new", label: "Mới" }, { id: 2, value: "follow_up_2", label: "Đang tư vấn" }] : [],
  }),
}))

import { FacebookCustomerSide, FacebookThread } from "@/app/(dashboard)/settings/_components/integrations/facebook-inbox"
import { InboxFrame } from "@/components/inbox/inbox-ui"

const conv = (over: Record<string, unknown> = {}) => ({
  id: 7, page_id: "111", page_name: "Trinity Software", psid: "999888", customer_name: "Khách A", contact_id: 42,
  last_inbound_at: "2026-11-28T01:00:00.000Z", last_message_at: "2026-11-28T01:00:00.000Z", last_message_preview: "Giá?",
  unread_count: 0, can_reply: true, reply_mode: "standard", ...over,
})
const CONTACT = {
  id: 42, phone: null, full_name: "Khách A", stage_id: 1, contact_status_id: null, stage_option: { id: 1, value: "new", label: "Mới" },
  reminder_at: null, assigned_user: { full_name: "Linh" }, created_at: "2026-11-27T13:40:00Z",
}

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  perms.view = true
  perms.update = true
  mockGet.mockReset(); mockPatch.mockReset(); mockPost.mockReset(); undoToast.mockReset()
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/contacts/42") return { data: CONTACT }
    if (url === "/facebook/conversations/7/messages") {
      return { data: { conversation: conv(), messages: [{ id: "1", direction: "in", text: "Giá?", sent_at: "2026-11-28T01:00:00.000Z", sent_by_user_id: null }] } }
    }
    throw new Error(`unexpected GET ${url}`)
  })
  mockPatch.mockResolvedValue({ data: {} })
})

describe("FacebookCustomerSide — hồ sơ khách Messenger sửa tại chỗ", () => {
  it("có quyền sửa: đổi giai đoạn ⇒ PATCH /contacts/:id của khách đã ghép + toast Hoàn tác; vẫn giữ thông tin hội thoại", async () => {
    wrap(<FacebookCustomerSide c={conv() as never} />)
    const chip = await screen.findByRole("button", { name: "Đang tư vấn" })
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(chip)
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/contacts/42", { stage_id: 2 }))
    await waitFor(() => expect(undoToast).toHaveBeenCalled())
    expect(screen.getByText("Hội thoại Messenger")).toBeTruthy()
    expect(screen.getByText("Trinity Software")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Hồ sơ đầy đủ" }).getAttribute("href")).toBe("/contacts/42")
  })

  it("chỉ có quyền xem: chip giai đoạn khoá, không có nút hẹn nhắc", async () => {
    perms.update = false
    wrap(<FacebookCustomerSide c={conv() as never} />)
    const chip = await screen.findByRole("button", { name: "Đang tư vấn" })
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Sáng mai 09:00" })).toBeNull()
  })

  it("không có quyền xem khách: không gọi /contacts, chỉ hiện thông tin từ hội thoại", async () => {
    perms.view = false
    perms.update = false
    wrap(<FacebookCustomerSide c={conv() as never} />)
    expect(screen.getByText(/bạn chưa có quyền xem hồ sơ khách/)).toBeTruthy()
    expect(mockGet).not.toHaveBeenCalledWith("/contacts/42")
  })

  it("hội thoại chưa ghép khách (contact_id null): chỉ xem, báo chưa ghép", () => {
    wrap(<FacebookCustomerSide c={conv({ contact_id: null }) as never} />)
    expect(screen.getByText("Chưa ghép với khách nào trong CRM.")).toBeTruthy()
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe("FacebookThread — đầu hội thoại điện thoại (hopthu-mobile)", () => {
  it("chip «Thêm số điện thoại» (thiếu SĐT) + giai đoạn + hẹn; dòng phụ «Messenger · Phụ trách …»; chip mở khay Hồ sơ khách", async () => {
    wrap(<FacebookThread id={7} onBack={() => {}} />)
    const phoneChip = await screen.findByRole("button", { name: "Thêm số điện thoại" })
    expect(await screen.findByRole("button", { name: "Mới" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Chưa đặt hẹn" })).toBeTruthy()
    expect(screen.getByText("Messenger · Phụ trách Linh")).toBeTruthy()
    expect(screen.getByPlaceholderText("Soạn trả lời")).toBeTruthy()
    fireEvent.click(phoneChip)
    expect(await screen.findByRole("dialog", { name: "Hồ sơ khách" })).toBeTruthy()
  })
})

describe("InboxFrame — hội thoại toàn màn dưới 1024px", () => {
  it("mở hội thoại ⇒ cột hội thoại thành lớp fixed toàn màn (chỉ max-lg), danh sách ẩn; đóng ⇒ không fixed", () => {
    const { rerender } = render(<InboxFrame threadOpen list={<p>ds</p>} thread={<p>chat</p>} />)
    const cls = screen.getByTestId("inbox-thread").className
    expect(cls).toContain("max-lg:fixed")
    expect(cls).toContain("max-lg:inset-0")
    expect(cls).not.toMatch(/(^|\s)fixed(\s|$)/)
    expect(screen.getByLabelText("Danh sách hội thoại").className).toContain("hidden")
    rerender(<InboxFrame threadOpen={false} list={<p>ds</p>} thread={<p>chat</p>} />)
    expect(screen.getByTestId("inbox-thread").className).not.toContain("max-lg:fixed")
  })
})
