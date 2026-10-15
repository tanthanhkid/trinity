import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/** Cài đặt > Kết nối & AI > Zalo OA (kết nối, ZNS) + Hộp thư Zalo OA (trả lời trong cửa sổ 48h). */
const mockGet = vi.fn()
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a), delete: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ZaloOaPanel } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-panel"
import { ZaloOaInbox } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-inbox"
import { inConsultWindow } from "@/app/(dashboard)/settings/_components/integrations/zalo-oa/zalo-oa-types"

const INITIAL = useAuthStore.getState()
const status = (over: Record<string, unknown> = {}) => ({
  configured: true, webhook_secret_configured: true, secret_key_configured: true, connected: false, oa_id: null, status: "disconnected",
  access_expires_at: null, refresh_expires_at: null, last_error: null, redirect_uri: "https://crm.example/api/v1/zalo-oa/oauth/callback",
  webhook_path: "/api/v1/zalo-oa/webhook", ...over,
})
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const grant = (...p: string[]) => useAuthStore.setState({ permissions: Object.fromEntries(p.map((x) => [x, true])) as never })

beforeEach(() => { mockGet.mockReset(); mockPost.mockReset() })
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("inConsultWindow", () => {
  it("48h tính từ tin gần nhất của khách", () => {
    const now = Date.parse("2026-10-07T12:00:00Z")
    expect(inConsultWindow("2026-10-05T13:00:00Z", now)).toBe(true)
    expect(inConsultWindow("2026-10-05T11:00:00Z", now)).toBe(false)
    expect(inConsultWindow(null, now)).toBe(false)
  })
})

describe("<ZaloOaPanel>", () => {
  it("thiếu env: liệt kê biến còn thiếu và khoá nút kết nối", async () => {
    grant("integrations.webhooks")
    mockGet.mockResolvedValue({ data: status({ configured: false, webhook_secret_configured: false }) })
    wrap(<ZaloOaPanel />)
    expect(await screen.findByText("ZALO_OA_APP_ID")).toBeTruthy()
    expect(screen.getByText("ZALO_WEBHOOK_SECRET")).toBeTruthy()
    expect((screen.getByRole("button", { name: /Kết nối Zalo OA/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("không có quyền integrations.webhooks: chỉ xem trạng thái, không có nút kết nối/ngắt", async () => {
    grant("contacts.update")
    mockGet.mockResolvedValue({ data: status({ connected: true, status: "active", oa_id: "OA1" }) })
    wrap(<ZaloOaPanel />)
    expect(await screen.findByText("Đã kết nối")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Ngắt kết nối/ })).toBeNull()
    expect(screen.queryByText("Gửi thử ZNS")).toBeNull()
  })

  it("đã kết nối + đủ quyền: hiện form ZNS và gửi đúng payload", async () => {
    grant("integrations.webhooks")
    mockGet.mockResolvedValue({ data: status({ connected: true, status: "active", oa_id: "OA1" }) })
    mockPost.mockResolvedValue({ data: { message_id: "z1" } })
    wrap(<ZaloOaPanel />)
    fireEvent.change(await screen.findByPlaceholderText(/Số điện thoại/), { target: { value: "0912345678" } })
    fireEvent.change(screen.getByPlaceholderText(/template_id/), { target: { value: "123456" } })
    fireEvent.click(screen.getByRole("button", { name: "Gửi ZNS" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/zalo-oa/zns", { phone: "0912345678", template_id: "123456", template_data: { customer_name: "Khách" } }))
  })
})

describe("<ZaloOaInbox>", () => {
  const thread = (over: Record<string, unknown> = {}) => ({
    id: 1, zalo_user_id: "U1", display_name: "Chị Lan", avatar_url: null, phone: "0912345678", contact_id: 5, last_message_preview: "Cho mình hỏi giá",
    last_message_at: new Date().toISOString(), last_inbound_at: new Date().toISOString(), unread_count: 2, ...over,
  })
  const msgs = [{ id: "2", direction: "out", kind: "text", text: "Dạ vâng", status: "sent", error: null, created_at: new Date().toISOString() }, { id: "1", direction: "in", kind: "text", text: "Cho mình hỏi giá", status: "received", error: null, created_at: new Date().toISOString() }]
  const setup = (t: ReturnType<typeof thread>) => mockGet.mockImplementation(async (url: string) => {
    if (url === "/zalo-oa/threads") return { data: { data: [t], meta: { next_cursor: null } } }
    return { data: { data: msgs } }
  })

  it("danh sách hội thoại → mở → hiện tin theo thứ tự cũ→mới, đánh dấu đã đọc, trả lời gọi API", async () => {
    setup(thread())
    mockPost.mockResolvedValue({ data: {} })
    wrap(<ZaloOaInbox />)
    fireEvent.click(await screen.findByText("Chị Lan"))
    expect(await screen.findByText("Dạ vâng")).toBeTruthy()
    expect(mockPost).toHaveBeenCalledWith("/zalo-oa/threads/1/read")
    fireEvent.change(screen.getByPlaceholderText("Nhập câu trả lời..."), { target: { value: "Giá 100k ạ" } })
    fireEvent.click(screen.getByRole("button", { name: "Gửi" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/zalo-oa/threads/1/messages", { text: "Giá 100k ạ" }))
  })

  it("quá 48h: khoá ô nhập và nhắc dùng ZNS", async () => {
    setup(thread({ last_inbound_at: new Date(Date.now() - 49 * 3600_000).toISOString() }))
    wrap(<ZaloOaInbox />)
    fireEvent.click(await screen.findByText("Chị Lan"))
    expect(await screen.findByText(/quá 48 giờ/)).toBeTruthy()
    expect((screen.getByPlaceholderText("Nhập câu trả lời...") as HTMLTextAreaElement).disabled).toBe(true)
  })
})
