import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/**
 * Cài đặt > Kết nối & AI > Webhook ra: danh sách, tạo (secret hiện MỘT lần), kiểm form, lỗi BE nguyên văn,
 * thiếu khoá máy chủ → banner + khoá nút, gửi thử, xoá có xác nhận, nhật ký gửi (Tải thêm, gửi lại chỉ cho lỗi/đã dừng).
 */
const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDelete = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    patch: (...a: unknown[]) => mockPatch(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

import { WebhookOutPanel } from "@/app/(dashboard)/settings/_components/integrations/webhook-out-panel"

const INITIAL = useAuthStore.getState()
const EVENTS = [
  { type: "contact.created", resource: "contact", label: "Tạo khách hàng" },
  { type: "contact.updated", resource: "contact", label: "Sửa khách hàng" },
  { type: "deal.won", resource: "deal", label: "Deal chốt thành công" },
]
const ep = (over: Record<string, unknown> = {}) => ({
  id: 1, name: "Zapier", url: "https://hooks.example.com/z", events: ["contact.created"], is_active: true, disabled_reason: null,
  created_by: 5, created_at: "2026-10-04T01:00:00.000Z", updated_at: "2026-10-04T01:00:00.000Z",
  last_success_at: null, last_failure_at: null, consecutive_failures: 0, secret_set: true, ...over,
})
const delivery = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, endpoint_id: 1, event_id: "9", event_type: "contact.created", status, attempts: 2, next_attempt_at: "2026-10-04T02:00:00.000Z",
  last_status_code: 500, last_error: "http_500", created_at: "2026-10-04T01:00:00.000Z", delivered_at: null, ...over,
})

function setup(opts: { endpoints?: unknown[]; deliveries?: Record<string, unknown> } = {}) {
  mockGet.mockImplementation(async (url: string, cfg?: { params?: Record<string, string> }) => {
    if (url.endsWith("/events")) return { data: EVENTS }
    if (url.endsWith("/endpoints")) return { data: { data: opts.endpoints ?? [ep()] } }
    if (url.endsWith("/deliveries")) {
      if (cfg?.params?.cursor === "c1") return { data: { data: [delivery("d3", "dead")], meta: { next_cursor: null } } }
      return { data: opts.deliveries ?? { data: [delivery("d1", "failed"), delivery("d2", "success", { last_error: null, last_status_code: 200 })], meta: { next_cursor: "c1" } } }
    }
    throw new Error(`unexpected GET ${url}`)
  })
}
function renderPanel(keyReady = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><WebhookOutPanel keyReady={keyReady} /></QueryClientProvider>)
}
const grant = (...perms: string[]) => useAuthStore.setState({ permissions: Object.fromEntries(perms.map((p) => [p, true])) as never })

beforeEach(() => {
  mockGet.mockReset(); mockPost.mockReset(); mockPatch.mockReset(); mockDelete.mockReset()
  toast.success.mockReset(); toast.error.mockReset()
  grant("integrations.webhooks")
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("<WebhookOutPanel>", () => {
  it("liệt kê endpoint: tên, URL, sự kiện, trạng thái; KHÔNG hiện secret", async () => {
    setup()
    renderPanel()
    await screen.findAllByText("Zapier")
    expect(screen.getByText("https://hooks.example.com/z")).toBeTruthy()
    expect(screen.getAllByText("contact.created").length).toBeGreaterThan(0)
    expect(screen.getByText("Đang bật")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/whsec_|secret_enc/)
  })

  it("rỗng → trạng thái rỗng; lỗi tải → báo lỗi (không nhầm là rỗng)", async () => {
    setup({ endpoints: [] })
    const { unmount } = renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có endpoint nào/)).toBeTruthy())
    unmount()
    mockGet.mockReset()
    mockGet.mockRejectedValue(new Error("boom"))
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Không tải được danh sách webhook/)).toBeTruthy())
    expect(screen.queryByText(/Chưa có endpoint nào/)).toBeNull()
  })

  it("tạo endpoint: chọn nhóm sự kiện bằng checkbox nhóm → POST đúng payload → secret hiện MỘT lần có nút sao chép", async () => {
    setup({ endpoints: [] })
    mockPost.mockResolvedValue({ data: { ...ep({ id: 7, name: "Mới" }), secret: "whsec_TEST_ONLY" } })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có endpoint nào/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Thêm endpoint/ }))
    const dlg = within(await screen.findByRole("dialog"))
    fireEvent.change(dlg.getByLabelText("Tên"), { target: { value: "  Mới  " } })
    fireEvent.change(dlg.getByLabelText(/Địa chỉ nhận/), { target: { value: "https://hooks.example.com/new" } })
    fireEvent.click(dlg.getByLabelText("Chọn cả nhóm Khách hàng"))
    fireEvent.click(dlg.getByRole("button", { name: "Tạo endpoint" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost.mock.calls[0][0]).toBe("/integrations/webhooks/endpoints")
    expect(mockPost.mock.calls[0][1]).toEqual({ name: "Mới", url: "https://hooks.example.com/new", events: ["contact.created", "contact.updated"] })

    const reveal = await screen.findByText("whsec_TEST_ONLY")
    expect(reveal).toBeTruthy()
    expect(screen.getByRole("button", { name: /Sao chép Secret/ })).toBeTruthy()
    expect(screen.getByText(/chỉ hiện một lần/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Đã lưu, đóng" }))
    await waitFor(() => expect(screen.queryByText("whsec_TEST_ONLY")).toBeNull())
  })

  it("kiểm form: http://, thiếu sự kiện, tên rỗng → báo lỗi, KHÔNG gọi API", async () => {
    setup({ endpoints: [] })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có endpoint nào/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Thêm endpoint/ }))
    const dlg = within(await screen.findByRole("dialog"))
    fireEvent.change(dlg.getByLabelText(/Địa chỉ nhận/), { target: { value: "http://insecure.example.com" } })
    fireEvent.click(dlg.getByRole("button", { name: "Tạo endpoint" }))
    await waitFor(() => expect(dlg.getByText("Nhập tên endpoint")).toBeTruthy())
    expect(dlg.getByText(/phải bắt đầu bằng https/)).toBeTruthy()
    expect(dlg.getByText("Chọn ít nhất 1 sự kiện")).toBeTruthy()
    expect(mockPost).not.toHaveBeenCalled()
  })

  it("lỗi BE (URL bị chặn SSRF) hiện NGUYÊN VĂN, dialog giữ nguyên để sửa", async () => {
    setup({ endpoints: [] })
    mockPost.mockRejectedValue({ response: { data: { message: "Không phân giải được tên miền hoặc địa chỉ không phải IP công cộng" } } })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có endpoint nào/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Thêm endpoint/ }))
    const dlg = within(await screen.findByRole("dialog"))
    fireEvent.change(dlg.getByLabelText("Tên"), { target: { value: "X" } })
    fireEvent.change(dlg.getByLabelText(/Địa chỉ nhận/), { target: { value: "https://169.254.169.254/x" } })
    fireEvent.click(dlg.getByLabelText("Chọn cả nhóm Deal"))
    fireEvent.click(dlg.getByRole("button", { name: "Tạo endpoint" }))
    await waitFor(() => expect(dlg.getByRole("alert").textContent).toMatch(/không phải IP công cộng/))
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("máy chủ thiếu INTEGRATIONS_SECRET_KEY → banner nêu tên biến, nút Thêm endpoint + Gửi thử bị khoá", async () => {
    setup()
    renderPanel(false)
    await screen.findAllByText("Zapier")
    expect(screen.getAllByText(/INTEGRATIONS_SECRET_KEY/).length).toBeGreaterThan(0)
    expect((screen.getByRole("button", { name: /Thêm endpoint/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: /Gửi thử/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("gửi thử: POST /:id/test, báo kết quả", async () => {
    setup()
    mockPost.mockResolvedValue({ data: { delivery_id: "x", ok: true, status_code: 200, error: null, duration_ms: 42 } })
    renderPanel()
    await screen.findAllByText("Zapier")
    fireEvent.click(screen.getByRole("button", { name: /Gửi thử/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/integrations/webhooks/endpoints/1/test"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("HTTP 200")))
  })

  it("bật/tắt gọi PATCH is_active; xoá cần xác nhận rồi DELETE", async () => {
    setup()
    mockPatch.mockResolvedValue({ data: ep({ is_active: false }) })
    mockDelete.mockResolvedValue({ data: { deleted: true } })
    renderPanel()
    await screen.findAllByText("Zapier")
    fireEvent.click(screen.getByRole("switch", { name: /Bật\/tắt endpoint Zapier/ }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/integrations/webhooks/endpoints/1", { is_active: false }))

    fireEvent.click(screen.getByRole("button", { name: /Thao tác khác cho Zapier/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Xoá/ }))
    expect(mockDelete).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Xoá endpoint" }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("/integrations/webhooks/endpoints/1"))
  })

  it("endpoint tự tắt: hiện lý do bằng tiếng Việt", async () => {
    setup({ endpoints: [ep({ is_active: false, disabled_reason: "consecutive_failures", consecutive_failures: 20 })] })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Tự tắt vì lỗi liên tiếp 20 lần/)).toBeTruthy())
  })

  it("nhật ký gửi: 'Tải thêm' lấy trang kế bằng cursor; Gửi lại CHỈ cho lỗi/đã dừng; lỗi hiện tiếng Việt, không lộ nội dung gửi", async () => {
    setup()
    mockPost.mockResolvedValue({ data: { id: "d1", status: "pending" } })
    renderPanel()
    await waitFor(() => expect(screen.getAllByText("Lỗi — sẽ thử lại").length).toBeGreaterThan(0))
    const retryButtons = screen.getAllByRole("button", { name: /Gửi lại/ })
    expect(retryButtons.length).toBeGreaterThan(0) // d1 (failed) có; d2 (success) không
    expect(screen.getAllByText(/Bên nhận trả HTTP 500/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "Tải thêm" }))
    await waitFor(() => expect(screen.getAllByText("Đã dừng").length).toBeGreaterThan(0))
    const calls = mockGet.mock.calls.filter((c) => String(c[0]).endsWith("/deliveries"))
    expect(calls[calls.length - 1][1].params.cursor).toBe("c1")
    expect(screen.queryByRole("button", { name: "Tải thêm" })).toBeNull()

    fireEvent.click(retryButtons[0])
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/integrations/webhooks/deliveries/d1/retry"))
    expect(document.body.textContent).not.toMatch(/"phone"|"data":/) // nhật ký không hiển thị nội dung gửi đi
  })

  it("có hướng dẫn kiểm chữ ký cho bên nhận (Node + Python, at-least-once)", async () => {
    setup()
    renderPanel()
    await screen.findAllByText("Zapier")
    expect(screen.getByText(/Hướng dẫn cho bên nhận/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/createHmac/)
    expect(document.body.textContent).toMatch(/hmac\.compare_digest/)
    expect(document.body.textContent).toMatch(/ít nhất một lần/)
  })
})
