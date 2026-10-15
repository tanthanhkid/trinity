import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AiAction } from "@/lib/ai-actions"

/**
 * màn "Hoạt động AI": lịch sử CỦA MÌNH; mục Chờ duyệt + Duyệt/Từ chối CHỈ khi bật "Yêu cầu duyệt thay đổi do AI" (mặc định tắt);
 * lỗi BE hiện NGUYÊN VĂN lý do; nội dung do AI soạn chỉ hiển thị dạng text (XSS); `?id=` mở thẳng một mục; tính năng tắt (404) ⇒ thông báo.
 */
const mockGet = vi.fn()
const mockPost = vi.fn()
const cfg = vi.hoisted(() => ({ requireApproval: true, pending: 0 }))
// `/settings` và `/pending-count` do màn gọi thêm: trả theo `cfg`; mọi URL khác (danh sách, `/:id`) đi vào `mockGet`.
vi.mock("@/lib/api-client", () => ({
  default: {
    get: (url: string, ...a: unknown[]) => {
      if (url.endsWith("/settings")) return Promise.resolve({ data: { require_approval: cfg.requireApproval } })
      if (url.endsWith("/pending-count")) return Promise.resolve({ data: { pending: cfg.pending } })
      return mockGet(url, ...a)
    },
    post: (...a: unknown[]) => mockPost(...a),
  },
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
const search = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock("next/navigation", () => ({ useSearchParams: () => search.value, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))

import { AiActionsScreen } from "@/app/(dashboard)/ai-actions/_components/ai-actions-screen"

const act = (id: number, over: Partial<AiAction> = {}): AiAction => ({
  id, tool: "create_contact", tool_label: "Tạo khách hàng", client_name: "ChatGPT",
  summary: `Tạo khách hàng "An ${id}" (SĐT ***321), nguồn: Facebook`,
  details: [{ label: "Họ tên", value: `An ${id}` }, { label: "SĐT (đã che)", value: "***321" }],
  status: "pending", result: null, error: null,
  created_at: "2026-10-04T01:00:00.000Z", decided_at: null, expires_at: "2026-10-05T01:00:00.000Z", ...over,
})
const page = (data: AiAction[], next: number | null = null) => ({ data: { data, next_cursor: next } })

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><AiActionsScreen /></QueryClientProvider>)
}

beforeEach(() => {
  mockGet.mockReset(); mockPost.mockReset(); toast.success.mockReset(); toast.error.mockReset()
  search.value = new URLSearchParams()
  cfg.requireApproval = true; cfg.pending = 0
})
afterEach(() => { vi.clearAllMocks() })

describe("<AiActionsScreen>", () => {
  it("liệt kê đề xuất chờ duyệt (chỉ gọi status=pending), hiện tên ứng dụng + nút Xem & duyệt; rỗng ⇒ EmptyState", async () => {
    mockGet.mockResolvedValue(page([act(1), act(2)]))
    renderIt()
    expect(await screen.findAllByTestId("ai-action-card")).toHaveLength(2)
    expect(mockGet).toHaveBeenCalledWith("/integrations/ai-actions", { params: { limit: 20, status: "pending" } })
    expect(screen.getAllByRole("button", { name: "Xem & duyệt" })).toHaveLength(2)
    expect(screen.getAllByText("ChatGPT").length).toBeGreaterThan(0)
  })

  it("cài đặt duyệt TẮT (mặc định) ⇒ lịch sử không lọc status, KHÔNG có tab Chờ duyệt, thao tác AI ghi thẳng hiện 'Đã thực hiện' + liên kết kết quả", async () => {
    cfg.requireApproval = false
    mockGet.mockResolvedValue(page([act(30, { status: "executed", result: { contact_id: 77 } })]))
    renderIt()
    await screen.findAllByTestId("ai-action-card")
    expect(mockGet).toHaveBeenCalledWith("/integrations/ai-actions", { params: { limit: 20 } })
    expect(screen.queryByRole("button", { name: "Chờ duyệt" })).toBeNull()
    expect(screen.getByText("Đã thực hiện")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Xem chi tiết" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("link", { name: "Mở khách hàng" }).getAttribute("href")).toBe("/contacts/77")
    expect(within(dialog).queryByRole("button", { name: /Duyệt và thực hiện/ })).toBeNull()
  })

  it("cài đặt TẮT nhưng còn đề xuất cũ đang chờ ⇒ vẫn hiện tab Chờ duyệt để xử lý nốt", async () => {
    cfg.requireApproval = false; cfg.pending = 2
    mockGet.mockResolvedValue(page([act(31)]))
    renderIt()
    await screen.findAllByTestId("ai-action-card")
    expect(screen.getByRole("button", { name: "Chờ duyệt" })).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith("/integrations/ai-actions", { params: { limit: 20, status: "pending" } })
  })

  it("không có đề xuất ⇒ thông báo rõ; tab Tất cả không lọc status", async () => {
    mockGet.mockResolvedValue(page([]))
    renderIt()
    await screen.findByText(/Không có thay đổi nào đang chờ bạn duyệt/)
    fireEvent.click(screen.getByRole("button", { name: "Tất cả" }))
    await screen.findByText(/Chưa có hoạt động nào của AI/)
    expect(mockGet).toHaveBeenLastCalledWith("/integrations/ai-actions", { params: { limit: 20 } })
  })

  it("mở chi tiết ⇒ tham số dạng dễ đọc; Duyệt ⇒ POST /:id/approve, toast thành công; chỉ MỘT nút đặc (Duyệt)", async () => {
    mockGet.mockResolvedValue(page([act(7)]))
    mockPost.mockResolvedValue({ data: act(7, { status: "approved", result: { contact_id: 55 } }) })
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: "Xem & duyệt" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Họ tên")).toBeTruthy()
    expect(within(dialog).getByText("***321")).toBeTruthy()
    expect(within(dialog).getByText(/Chưa có gì được thực hiện cho tới khi bạn bấm Duyệt/)).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: /Từ chối/ })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: /Duyệt và thực hiện/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/integrations/ai-actions/7/approve"))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("Từ chối ⇒ POST /:id/reject và đóng", async () => {
    mockGet.mockResolvedValue(page([act(8)]))
    mockPost.mockResolvedValue({ data: act(8, { status: "rejected" }) })
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: "Xem & duyệt" }))
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Từ chối/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/integrations/ai-actions/8/reject"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("duyệt lỗi (mất quyền / đã xử lý) ⇒ hiện NGUYÊN VĂN lý do của BE trong dialog, vẫn mở", async () => {
    mockGet.mockResolvedValue(page([act(9)]))
    mockPost.mockRejectedValue({ response: { status: 403, data: { message: "Bạn không còn quyền thực hiện thao tác này (cần quyền contacts.create)" } } })
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: "Xem & duyệt" }))
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Duyệt và thực hiện/ }))
    expect((await screen.findByRole("alert")).textContent).toContain("cần quyền contacts.create")
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("XSS: nội dung do AI soạn (summary/chi tiết/tên ứng dụng) chỉ là TEXT — không tạo phần tử HTML", async () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    mockGet.mockResolvedValue(page([act(3, { summary: evil, client_name: evil, details: [{ label: "Ghi chú", value: evil }] })]))
    const { container } = renderIt()
    fireEvent.click(await screen.findByRole("button", { name: "Xem & duyệt" }))
    await screen.findByRole("dialog")
    expect(document.querySelector("img[src='x']")).toBeNull()
    expect(document.querySelector("script")).toBeNull()
    expect(container.innerHTML).not.toContain("<img src=")
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThan(0)
  })

  it("đề xuất đã duyệt có liên kết tới khách vừa tạo; thất bại hiện lý do", async () => {
    mockGet.mockResolvedValue(page([
      act(10, { status: "approved", result: { contact_id: 55 } }),
      act(11, { status: "failed", error: "SĐT ***321 đã tồn tại" }),
    ]))
    renderIt()
    await screen.findAllByTestId("ai-action-card")
    expect(screen.getByText("SĐT ***321 đã tồn tại")).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "Xem chi tiết" })[0])
    const dialog = await screen.findByRole("dialog")
    const link = within(dialog).getByRole("link", { name: "Mở khách hàng" })
    expect(link.getAttribute("href")).toBe("/contacts/55")
    expect(within(dialog).queryByRole("button", { name: /Duyệt và thực hiện/ })).toBeNull()
  })

  it("?id= mở thẳng đề xuất (kể cả khi không ở trang đầu) qua GET /:id; id không phải của mình ⇒ báo không tìm thấy", async () => {
    search.value = new URLSearchParams({ id: "42" })
    mockGet.mockImplementation(async (url: string) => (url.endsWith("/42") ? { data: act(42) } : page([])))
    renderIt()
    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(mockGet).toHaveBeenCalledWith("/integrations/ai-actions/42")
  })

  it("?id= của người khác (404) ⇒ báo không tìm thấy, không có dialog", async () => {
    search.value = new URLSearchParams({ id: "43" })
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith("/43")) throw { response: { status: 404, data: { message: "Không tìm thấy đề xuất" } } }
      return page([])
    })
    renderIt()
    await screen.findByText(/Không tìm thấy mục #43/)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("tính năng chưa bật (BE 404) ⇒ thông báo, không phải lỗi chung", async () => {
    mockGet.mockRejectedValue({ response: { status: 404, data: {} } })
    renderIt()
    await screen.findByText(/Kết nối AI chưa được bật/)
  })

  it("có trang sau ⇒ nút Xem thêm gọi fetchNextPage với cursor", async () => {
    mockGet.mockResolvedValueOnce(page([act(20)], 20)).mockResolvedValueOnce(page([act(19)], null))
    renderIt()
    fireEvent.click(await screen.findByRole("button", { name: /Xem thêm/ }))
    await waitFor(() => expect(mockGet).toHaveBeenLastCalledWith("/integrations/ai-actions", { params: { limit: 20, status: "pending", cursor: 20 } }))
    await waitFor(() => expect(screen.getAllByTestId("ai-action-card")).toHaveLength(2))
  })
})
