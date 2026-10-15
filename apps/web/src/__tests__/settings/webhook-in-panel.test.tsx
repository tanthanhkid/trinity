import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/**
 * Cài đặt > Kết nối & AI > Webhook vào: danh sách nguồn (chỉ hiện tiền tố token), tạo (URL + token + signing secret
 * hiện MỘT lần, kèm curl), người nhận lấy từ ĐÚNG nguồn BE ràng buộc, quyền contacts.create / contacts.transfer,
 * tạo lại token cần xác nhận, lỗi BE nguyên văn.
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { WebhookInPanel } from "@/app/(dashboard)/settings/_components/integrations/webhook-in-panel"

const INITIAL = useAuthStore.getState()
const TOKEN = `whk_${"A".repeat(43)}`
const src = (over: Record<string, unknown> = {}) => ({
  id: 1, name: "Landing FB", token_prefix: "whk_AAAAAAAA", signed: false, default_assignee_id: 11, contact_source_id: 3, project_id: null,
  is_active: true, created_by: 5, created_at: "2026-10-04T01:00:00.000Z", updated_at: "2026-10-04T01:00:00.000Z", last_received_at: null, ...over,
})

function setup(sources: unknown[] = [src()]) {
  mockGet.mockImplementation(async (url: string) => {
    if (url.endsWith("/inbound-sources")) return { data: { data: sources } }
    if (url === "/settings/options") return { data: { data: [{ id: 3, label: "Facebook Ads" }, { id: 4, label: "Zalo OA" }] } }
    if (url === "/contacts/assignable-sales") return { data: [{ id: 11, full_name: "Sale Mười Một", email: "a@x" }, { id: 12, full_name: "Sale Mười Hai", email: "b@x" }] }
    throw new Error(`unexpected GET ${url}`)
  })
}
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><WebhookInPanel keyReady /></QueryClientProvider>)
}
const grant = (...perms: string[]) => useAuthStore.setState({
  permissions: Object.fromEntries(perms.map((p) => [p, true])) as never,
  user: { id: 5, email: "me@x", full_name: "Tôi", avatar_url: null, manager_id: null },
})
/** Base UI chỉ chọn mục sau khi con trỏ "đi vào" mục đó (jsdom không tự làm) — mô phỏng rê chuột rồi bấm. */
async function pick(name: string) {
  const opt = await screen.findByRole("option", { name })
  fireEvent.pointerEnter(opt); fireEvent.pointerMove(opt); fireEvent.mouseMove(opt)
  fireEvent.click(opt)
}
const getCalls = (suffix: string) => mockGet.mock.calls.filter((c) => String(c[0]).endsWith(suffix))

beforeEach(() => {
  mockGet.mockReset(); mockPost.mockReset(); mockPatch.mockReset(); mockDelete.mockReset()
  grant("integrations.webhooks", "contacts.create", "contacts.transfer")
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("<WebhookInPanel>", () => {
  it("liệt kê nguồn: tên, sale nhận, nguồn khách, tiền tố token — KHÔNG có token đầy đủ", async () => {
    setup([src({ last_received_at: "2026-10-04T03:00:00.000Z" })])
    renderPanel()
    await waitFor(() => expect(screen.getByText("Landing FB")).toBeTruthy())
    await waitFor(() => expect(screen.getByText("Sale Mười Một")).toBeTruthy())
    expect(screen.getByText("Facebook Ads")).toBeTruthy()
    expect(screen.getByText(/whk_AAAAAAAA•+/)).toBeTruthy()
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(screen.queryByText("Chưa nhận")).toBeNull() // có last_received_at
  })

  it("rỗng → trạng thái rỗng; lỗi tải → báo lỗi", async () => {
    setup([])
    const { unmount } = renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có nguồn nào/)).toBeTruthy())
    unmount()
    mockGet.mockReset(); mockGet.mockRejectedValue(new Error("x"))
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Không tải được danh sách nguồn/)).toBeTruthy())
  })

  it("tạo nguồn: chọn sale + nguồn khách + bắt buộc chữ ký → POST đúng; URL + token + signing secret + curl hiện MỘT lần", async () => {
    setup([])
    mockPost.mockResolvedValue({
      data: { ...src({ id: 9, name: "Mới", signed: true }), token: TOKEN, path: `/api/v1/hooks/in/${TOKEN}`, signing_secret: "whsec_SIGN" },
    })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có nguồn nào/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Thêm nguồn/ }))
    const dlg = within(await screen.findByRole("dialog"))
    fireEvent.change(dlg.getByLabelText("Tên nguồn"), { target: { value: " Mới " } })
    fireEvent.click(dlg.getByRole("combobox", { name: "Sale nhận khách" }))
    await pick("Sale Mười Hai")
    fireEvent.click(dlg.getByRole("combobox", { name: "Nguồn khách" }))
    await pick("Zalo OA")
    fireEvent.click(dlg.getByRole("checkbox"))
    fireEvent.click(dlg.getByRole("button", { name: "Tạo nguồn" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1))
    expect(mockPost.mock.calls[0][0]).toBe("/integrations/webhooks/inbound-sources")
    expect(mockPost.mock.calls[0][1]).toEqual({ name: "Mới", default_assignee_id: 12, contact_source_id: 4, signed: true })

    expect((await screen.findByText(new RegExp(`/api/v1/hooks/in/${TOKEN}$`))).textContent).toContain(TOKEN)
    expect(screen.getByText("whsec_SIGN")).toBeTruthy()
    expect(document.body.textContent).toMatch(/curl -X POST/)
    expect(document.body.textContent).toMatch(/X-Trinity-Signature/)
    fireEvent.click(screen.getByRole("button", { name: "Đã lưu, đóng" }))
    await waitFor(() => expect(screen.queryByText("whsec_SIGN")).toBeNull())
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it("danh sách người nhận lấy từ /contacts/assignable-sales (phạm vi contacts.transfer — đúng nguồn BE ràng buộc)", async () => {
    setup([])
    renderPanel()
    await waitFor(() => expect(getCalls("/contacts/assignable-sales").length).toBe(1))
    expect(getCalls("/users").length).toBe(0)
  })

  it("thiếu contacts.transfer: KHÔNG gọi roster, người nhận chỉ có CHÍNH MÌNH (BE chỉ cho phép vậy)", async () => {
    grant("integrations.webhooks", "contacts.create")
    setup([])
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có nguồn nào/)).toBeTruthy())
    expect(getCalls("/contacts/assignable-sales").length).toBe(0)
    fireEvent.click(screen.getByRole("button", { name: /Thêm nguồn/ }))
    const dlg = within(await screen.findByRole("dialog"))
    fireEvent.click(dlg.getByRole("combobox", { name: "Sale nhận khách" }))
    expect(await screen.findByRole("option", { name: "Tôi" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "Sale Mười Hai" })).toBeNull()
  })

  it("thiếu contacts.create: không có nút Thêm nguồn, sửa/tạo lại token bị khoá, có ghi chú giải thích", async () => {
    grant("integrations.webhooks")
    setup()
    renderPanel()
    await waitFor(() => expect(screen.getByText("Landing FB")).toBeTruthy())
    expect(screen.queryByRole("button", { name: /Thêm nguồn/ })).toBeNull()
    expect(screen.getByText(/tạo\/sửa nguồn cần thêm quyền/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Thao tác khác cho Landing FB/ }))
    expect(((await screen.findByRole("menuitem", { name: /Tạo lại token/ })) as HTMLElement).getAttribute("aria-disabled")).toBe("true")
  })

  it("form: thiếu tên/người nhận/nguồn → báo lỗi, KHÔNG gọi API; lỗi BE hiện nguyên văn", async () => {
    setup([])
    mockPost.mockRejectedValue({ response: { data: { message: "Không có quyền gán khách cho người này (cần contacts.transfer phủ người nhận)" } } })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa có nguồn nào/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Thêm nguồn/ }))
    const dlg = within(await screen.findByRole("dialog"))
    fireEvent.click(dlg.getByRole("button", { name: "Tạo nguồn" }))
    await waitFor(() => expect(dlg.getByText("Nhập tên nguồn")).toBeTruthy())
    expect(dlg.getByText("Chọn sale nhận khách", { selector: "p" })).toBeTruthy()
    expect(mockPost).not.toHaveBeenCalled()

    fireEvent.change(dlg.getByLabelText("Tên nguồn"), { target: { value: "X" } })
    fireEvent.click(dlg.getByRole("combobox", { name: "Sale nhận khách" }))
    fireEvent.click(await screen.findByRole("option", { name: "Sale Mười Một" }))
    fireEvent.click(dlg.getByRole("combobox", { name: "Nguồn khách" }))
    fireEvent.click(await screen.findByRole("option", { name: "Facebook Ads" }))
    fireEvent.click(dlg.getByRole("button", { name: "Tạo nguồn" }))
    await waitFor(() => expect(dlg.getByRole("alert").textContent).toMatch(/cần contacts\.transfer/))
  })

  it("tạo lại token: có xác nhận → POST rotate-token → hiện token mới MỘT lần", async () => {
    setup()
    mockPost.mockResolvedValue({ data: { ...src(), token: `whk_${"B".repeat(43)}`, path: `/api/v1/hooks/in/whk_${"B".repeat(43)}` } })
    renderPanel()
    await waitFor(() => expect(screen.getByText("Landing FB")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Thao tác khác cho Landing FB/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Tạo lại token/ }))
    expect(mockPost).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Tạo lại token" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/integrations/webhooks/inbound-sources/1/rotate-token"))
    expect(await screen.findByText(new RegExp(`whk_${"B".repeat(43)}$`))).toBeTruthy()
  })

  it("bật/tắt nguồn gọi PATCH is_active; sửa nguồn đang có chữ ký KHÔNG gửi lại signed khi không đổi (tránh sinh secret mới)", async () => {
    setup([src({ signed: true })])
    mockPatch.mockResolvedValue({ data: src({ signed: true }) })
    renderPanel()
    await waitFor(() => expect(screen.getByText("Landing FB")).toBeTruthy())
    fireEvent.click(screen.getByRole("switch", { name: /Bật\/tắt nguồn Landing FB/ }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/integrations/webhooks/inbound-sources/1", { is_active: false }))

    fireEvent.click(screen.getByRole("button", { name: /Thao tác khác cho Landing FB/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /Sửa/ }))
    const dlg = within(await screen.findByRole("dialog"))
    await waitFor(() => expect((dlg.getByLabelText("Tên nguồn") as HTMLInputElement).value).toBe("Landing FB"))
    fireEvent.change(dlg.getByLabelText("Tên nguồn"), { target: { value: "Đổi tên" } })
    fireEvent.click(dlg.getByRole("button", { name: "Lưu thay đổi" }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2))
    expect(mockPatch.mock.calls[1][1]).toEqual({ name: "Đổi tên", default_assignee_id: 11, contact_source_id: 3 })
  })

  it("'Cách gọi (curl)' dùng chỗ giữ token (không bịa token), có ghi chú mã trả về", async () => {
    setup()
    renderPanel()
    await waitFor(() => expect(screen.getByText("Landing FB")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Cách gọi \(curl\)/ }))
    const dlg = within(await screen.findByRole("dialog"))
    expect(dlg.getByText(/<TOKEN/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/duplicate/)
    expect(document.body.textContent).toMatch(/429/)
  })
})
