import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/** Cài đặt > Kết nối & AI > Fanpage Facebook: cấu hình thiếu, danh sách Page (không lộ token), hộp thư + cửa sổ 24h. */
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }))

import { FacebookPanel } from "@/app/(dashboard)/settings/_components/integrations/facebook-panel"
import { FacebookInbox } from "@/app/(dashboard)/settings/_components/integrations/facebook-inbox"

const INITIAL = useAuthStore.getState()
const STATUS = {
  configured: true, app_id_set: true, app_secret_set: true, base_url_set: true, verify_token_set: true, secret_key_configured: true,
  graph_version: "v25.0", webhook_url: "https://crm.example.vn/api/v1/facebook/webhook", oauth_redirect_uri: "https://crm.example.vn/api/v1/facebook/oauth/callback",
  scopes: ["pages_messaging", "leads_retrieval"],
}
const PAGE = {
  id: 1, page_id: "111", name: "Trinity Software", token_status: "active", token_checked_at: "2026-10-07T01:00:00.000Z", token_expires_at: null,
  data_access_expires_at: null, subscribed: true, default_assignee_id: 5, contact_source_id: 3, is_active: true, created_at: "2026-10-07T01:00:00.000Z", posting: null, disconnected: false,
}
const conv = (over: Record<string, unknown> = {}) => ({
  id: 7, page_id: "111", page_name: "Trinity Software", psid: "999888", customer_name: "Khách A", last_inbound_at: "2026-10-07T01:00:00.000Z",
  last_message_at: "2026-10-07T01:00:00.000Z", last_message_preview: "Giá gói A?", unread_count: 2, can_reply: true, ...over,
})

function setup(opts: { status?: unknown; pages?: unknown[]; conversations?: unknown[]; canReply?: boolean } = {}) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/facebook/status") return { data: opts.status ?? STATUS }
    if (url === "/facebook/pages") return { data: { data: opts.pages ?? [PAGE] } }
    if (url === "/facebook/conversations") return { data: { data: opts.conversations ?? [conv({ can_reply: opts.canReply ?? true })] } }
    if (url === "/facebook/conversations/7/messages") {
      return { data: { conversation: conv({ can_reply: opts.canReply ?? true }), messages: [
        { id: "1", direction: "in", text: "Giá gói A?", sent_at: "2026-10-07T01:00:00.000Z", sent_by_user_id: null },
        { id: "2", direction: "out", text: "Dạ 5 triệu ạ", sent_at: "2026-10-07T01:05:00.000Z", sent_by_user_id: 5 },
      ] } }
    }
    if (url === "/settings/options") return { data: { data: [{ id: 3, label: "Facebook" }] } }
    if (url === "/contacts/assignable-sales") return { data: [{ id: 5, full_name: "Tôi", email: "a@x" }] }
    throw new Error(`unexpected GET ${url}`)
  })
}
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><FacebookPanel /></QueryClientProvider>)
}

/** Hộp thư Messenger nằm ở menu Hộp thư (/inbox); Cài đặt chỉ còn link sang đó. */
function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><FacebookInbox /></QueryClientProvider>)
}

beforeEach(() => {
  mockGet.mockReset(); mockPost.mockReset(); mockPatch.mockReset(); mockDelete.mockReset()
  useAuthStore.setState({ permissions: { "integrations.webhooks": true } as never, user: { id: 5, email: "me@x", full_name: "Tôi", avatar_url: null, manager_id: null } })
})
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("<FacebookPanel>", () => {
  it("hiện URL webhook + redirect để dán vào Meta; Page đã kết nối với trạng thái token", async () => {
    setup()
    renderPanel()
    await waitFor(() => expect(screen.getByText("Trinity Software")).toBeTruthy())
    expect(screen.getByText("https://crm.example.vn/api/v1/facebook/webhook")).toBeTruthy()
    expect(screen.getByText(/Token còn hiệu lực/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/token_enc|access_token/)
  })

  it("ghi rõ phần đăng bài của Page: đã nối / đã gỡ / chưa nối", async () => {
    setup({ pages: [{ ...PAGE, posting: "on" }, { ...PAGE, id: 2, page_id: "222", name: "Hai", posting: "removed" }, { ...PAGE, id: 3, page_id: "333", name: "Ba" }] })
    renderPanel()
    await waitFor(() => expect(screen.getByText("Trinity Software")).toBeTruthy())
    expect(screen.getAllByTestId("fb-page-posting").map((e) => e.textContent)).toEqual(["Đăng bài: đã nối", "Đăng bài: đã gỡ", "Đăng bài: chưa nối"])
  })

  it("Page đã ngắt (tắt, token rỗng) ⇒ ghi 'kết nối lại để bật', không có nút kiểm tra/ngắt", async () => {
    setup({ pages: [{ ...PAGE, is_active: false, disconnected: true }] })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("fb-page-disconnected")).toHaveTextContent("Đã ngắt — kết nối lại để bật"))
    expect(screen.queryByRole("button", { name: /Kiểm tra token/ })).toBeNull()
  })

  it("thiếu cấu hình máy chủ ⇒ liệt kê biến còn thiếu và khoá nút Kết nối", async () => {
    setup({ status: { ...STATUS, configured: false, app_secret_set: false, verify_token_set: false } })
    renderPanel()
    await waitFor(() => expect(screen.getByText("FACEBOOK_APP_SECRET")).toBeTruthy())
    expect(screen.getByText("FACEBOOK_WEBHOOK_VERIFY_TOKEN")).toBeTruthy()
    expect((screen.getByRole("button", { name: /Kết nối Fanpage/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("Page token chết ⇒ cảnh báo cần kết nối lại", async () => {
    setup({ pages: [{ ...PAGE, token_status: "invalid" }] })
    renderPanel()
    await waitFor(() => expect(screen.getByText(/cần kết nối lại/)).toBeTruthy())
  })

  it("bấm Kết nối: xin URL đăng nhập từ BE", async () => {
    setup({ pages: [] })
    mockPost.mockResolvedValue({ data: { url: "https://www.facebook.com/v25.0/dialog/oauth?x=1" } })
    const loc = { href: "" }
    vi.stubGlobal("location", loc)
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Chưa kết nối Fanpage nào/)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Kết nối Fanpage/ }))
    await waitFor(() => expect(loc.href).toContain("facebook.com/v25.0/dialog/oauth"))
    expect(mockPost.mock.calls[0][0]).toBe("/facebook/connect-url")
    vi.unstubAllGlobals()
  })

  it("hộp thư: mở hội thoại, gửi trả lời trong 24h", async () => {
    setup()
    mockPost.mockResolvedValue({ data: { id: "3" } })
    renderInbox()
    fireEvent.click(await screen.findByRole("button", { name: /Khách A/ }))
    await waitFor(() => expect(screen.getByText("Dạ 5 triệu ạ")).toBeTruthy())
    fireEvent.change(screen.getByLabelText("Nội dung trả lời"), { target: { value: "Dạ vâng" } })
    fireEvent.click(screen.getByRole("button", { name: "Gửi" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith("/facebook/conversations/7/messages", { text: "Dạ vâng" }))
  })

  it("Cài đặt Fanpage: Hộp thư là link sang menu Hộp thư", () => {
    setup()
    renderPanel()
    expect(screen.getByRole("link", { name: "Hộp thư" }).getAttribute("href")).toBe("/inbox")
  })

  it("Fanpage đã tắt ⇒ hiện 'Đã tắt', không hiện như đang kết nối", async () => {
    setup({ pages: [{ ...PAGE, is_active: false }] })
    renderPanel()
    expect(await screen.findByTestId("fb-page-off")).toBeTruthy()
    expect(screen.queryByText(/còn hiệu lực/)).toBeNull()
  })

  it("hộp thư: quá 24h ⇒ không có ô trả lời, hiện lý do", async () => {
    setup({ canReply: false })
    renderInbox()
    fireEvent.click(await screen.findByRole("button", { name: /Khách A/ }))
    await waitFor(() => expect(screen.getByText(/quá 24 giờ/)).toBeTruthy())
    expect(screen.queryByLabelText("Nội dung trả lời")).toBeNull()
  })
})
