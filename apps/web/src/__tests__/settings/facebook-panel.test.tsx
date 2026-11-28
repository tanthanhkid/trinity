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
const mockToastCustom = vi.fn()
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), custom: (...a: unknown[]) => mockToastCustom(...a), dismiss: vi.fn() } }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }))

import { FacebookPanel } from "@/app/(dashboard)/settings/_components/integrations/facebook-panel"
import { facebookResultMessage } from "@/app/(dashboard)/settings/_components/integrations/use-facebook"
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

function setup(opts: { status?: unknown; pages?: unknown[]; conversations?: unknown[]; canReply?: boolean; replyMode?: string } = {}) {
  mockGet.mockImplementation(async (url: string) => {
    if (url === "/facebook/status") return { data: opts.status ?? STATUS }
    if (url === "/facebook/pages") return { data: { data: opts.pages ?? [PAGE] } }
    if (url === "/facebook/conversations") return { data: { data: opts.conversations ?? [conv({ can_reply: opts.canReply ?? true })] } }
    if (url === "/facebook/conversations/7/messages") {
      return { data: { conversation: conv({ can_reply: opts.canReply ?? true, reply_mode: opts.replyMode }), messages: [
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
  it("đã cấu hình đủ ⇒ ẩn khối hướng dẫn (URL webhook, quyền); Page đã kết nối với trạng thái token", async () => {
    setup()
    renderPanel()
    await waitFor(() => expect(screen.getByText("Trinity Software")).toBeTruthy())
    expect(screen.queryByText("https://crm.example.vn/api/v1/facebook/webhook")).toBeNull()
    expect(document.body.textContent).not.toMatch(/Valid OAuth Redirect URI|pages_messaging/)
    expect(screen.getByText(/Token còn hiệu lực/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/token_enc|access_token/)
  })

  it("ghi rõ phần đăng bài của Page: đã nối / đã gỡ / chưa nối", async () => {
    setup({ pages: [{ ...PAGE, posting: "on" }, { ...PAGE, id: 2, page_id: "222", name: "Hai", posting: "removed" }, { ...PAGE, id: 3, page_id: "333", name: "Ba" }] })
    renderPanel()
    await waitFor(() => expect(screen.getByText("Trinity Software")).toBeTruthy())
    const seen: string[] = []
    for (const name of ["Trinity Software", "Hai", "Ba"]) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(name) }))
      seen.push(screen.getByTestId("fb-page-posting").textContent ?? "")
    }
    expect(seen).toEqual(["Đăng bài: đã nối", "Đăng bài: đã gỡ", "Đăng bài: chưa nối"])
  })

  it("Page đã ngắt (tắt, token rỗng) ⇒ ghi 'kết nối lại để bật', không có nút kiểm tra/ngắt", async () => {
    setup({ pages: [{ ...PAGE, is_active: false, disconnected: true }] })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("fb-page-disconnected")).toHaveTextContent("Đã ngắt — kết nối lại để bật"))
    expect(screen.queryByRole("button", { name: /Kiểm tra token/ })).toBeNull()
  })

  it("khách thường thấy máy chủ chưa sẵn sàng ⇒ câu dễ hiểu, không lộ tên biến, nút Kết nối bị khoá", async () => {
    setup({ status: { ...STATUS, configured: false, app_secret_set: false, verify_token_set: false } })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("fb-not-ready")).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/FACEBOOK_APP_SECRET|Callback URL|https?:\/\//i)
    expect((screen.getByRole("button", { name: /Thêm Fanpage/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("quản trị: thiếu cấu hình máy chủ ⇒ liệt kê biến còn thiếu và khoá nút Kết nối; Login for Business ghi chú thay cho danh sách quyền", async () => {
    useAuthStore.setState({ isAdmin: true })
    setup({ status: { ...STATUS, configured: false, app_secret_set: false, verify_token_set: false, login_for_business: true } })
    renderPanel()
    await waitFor(() => expect(screen.getByText("FACEBOOK_APP_SECRET")).toBeTruthy())
    expect(screen.getByText("FACEBOOK_WEBHOOK_VERIFY_TOKEN")).toBeTruthy()
    expect(document.body.textContent).toMatch(/Login for Business/)
    expect((screen.getByRole("button", { name: /Thêm Fanpage/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("Page token chết ⇒ cảnh báo cần kết nối lại", async () => {
    setup({ pages: [{ ...PAGE, token_status: "invalid" }] })
    renderPanel()
    await waitFor(() => expect(screen.getByText("Đang không nhận được tin của khách")).toBeTruthy())
    expect(screen.getByRole("button", { name: "Kết nối lại Fanpage" })).toBeTruthy()
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
    expect(screen.getByText("Đang tắt nhận tin")).toBeTruthy()
    expect(screen.getByText("Bạn đang tắt nhận tin cho Page này.")).toBeTruthy()
  })

  it("hộp thư: 24h–7 ngày ⇒ vẫn trả lời được, ghi rõ chỉ nhân viên trong 7 ngày", async () => {
    setup({ canReply: true, replyMode: "human_agent" })
    renderInbox()
    fireEvent.click(await screen.findByRole("button", { name: /Khách A/ }))
    await waitFor(() => expect(screen.getAllByText("Trả lời trong 7 ngày (nhân viên)").length).toBeGreaterThan(0))
    expect(screen.getByLabelText("Nội dung trả lời")).toBeTruthy()
  })

  it("hộp thư: quá 7 ngày ⇒ không có ô trả lời, hiện lý do", async () => {
    setup({ canReply: false, replyMode: "closed" })
    renderInbox()
    fireEvent.click(await screen.findByRole("button", { name: /Khách A/ }))
    await waitFor(() => expect(screen.getByText(/quá 7 ngày kể từ/)).toBeTruthy())
    expect(screen.queryByLabelText("Nội dung trả lời")).toBeNull()
  })
})

describe("<FacebookPanel> Ánh xanh — desktop", () => {
  it("sửa cách nhận khách ⇒ hiện thanh lưu; Lưu gửi một PATCH các trường đổi rồi cho Hoàn tác", async () => {
    setup({ pages: [{ ...PAGE, default_assignee_id: 5 }] })
    mockGet.mockImplementation(async (url: string) => {
      if (url === "/facebook/status") return { data: STATUS }
      if (url === "/facebook/pages") return { data: { data: [{ ...PAGE }] } }
      if (url === "/settings/options") return { data: { data: [{ id: 3, label: "Facebook" }, { id: 4, label: "Fanpage" }] } }
      if (url === "/contacts/assignable-sales") return { data: [{ id: 5, full_name: "Tôi", email: "a@x" }, { id: 6, full_name: "Lan Anh", email: "b@x" }] }
      throw new Error(`unexpected GET ${url}`)
    })
    mockPatch.mockResolvedValue({ data: PAGE })
    useAuthStore.setState({ permissions: { "integrations.webhooks": true, "contacts.transfer": true } as never })
    renderPanel()
    expect(await screen.findByRole("heading", { name: "Tình trạng kết nối" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Lưu cấu hình" })).toBeNull()
    fireEvent.click(await screen.findByRole("radio", { name: /Lan Anh/ }))
    fireEvent.click(await screen.findByRole("radio", { name: "Fanpage" }))
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/facebook/pages/1", { default_assignee_id: 6, contact_source_id: 4 }))
    await waitFor(() => expect(mockToastCustom).toHaveBeenCalled())
  })

  it("Bỏ thay đổi ⇒ trả bản nháp về giá trị đang chạy, không gọi API", async () => {
    setup()
    renderPanel()
    const sw = await screen.findByRole("switch")
    fireEvent.click(sw)
    expect(sw.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(screen.getByRole("button", { name: "Bỏ thay đổi" }))
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true")
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it("Page đã ngắt: hero có Kết nối lại, công tắc khoá, không có nút Ngắt kết nối", async () => {
    setup({ pages: [{ ...PAGE, is_active: false, disconnected: true }] })
    renderPanel()
    expect(await screen.findByText("Page đã ngắt kết nối")).toBeTruthy()
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole("button", { name: "Ngắt kết nối Page" })).toBeNull()
    expect(screen.getByRole("button", { name: "Kết nối lại Fanpage" })).toBeTruthy()
  })

  it("Ngắt kết nối: hỏi xác nhận trong thẻ rồi gọi DELETE", async () => {
    setup()
    mockDelete.mockResolvedValue({})
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Ngắt kết nối Page" }))
    expect(screen.getByRole("alertdialog")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Ngắt kết nối" }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("/facebook/pages/1"))
  })
})

describe("<FacebookPanel> Ánh xanh — điện thoại", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
  })
  afterEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); vi.unstubAllGlobals() })

  it("bố cục riêng: công tắc lưu ngay (không thanh Lưu) + Hoàn tác", async () => {
    setup()
    mockPatch.mockResolvedValue({ data: PAGE })
    renderPanel()
    fireEvent.click(await screen.findByRole("switch"))
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/facebook/pages/1", { is_active: false }))
    expect(screen.queryByRole("button", { name: "Lưu cấu hình" })).toBeNull()
    await waitFor(() => expect(mockToastCustom).toHaveBeenCalled())
  })

  it("Page token chết: Kết nối lại mở hướng dẫn ba bước, nút Mở Facebook gọi connect-url", async () => {
    setup({ pages: [{ ...PAGE, token_status: "expired" }] })
    mockPost.mockResolvedValue({ data: { url: "https://www.facebook.com/v25.0/dialog/oauth?x=1" } })
    vi.stubGlobal("location", { href: "" })
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Kết nối lại Fanpage" }))
    expect(screen.getByRole("heading", { name: "Nối lại Fanpage" })).toBeTruthy()
    expect(screen.getByText("Cho phép đủ quyền")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Mở Facebook để nối lại" }))
    await waitFor(() => expect(mockPost.mock.calls.some((c) => c[0] === "/facebook/connect-url")).toBe(true))
  })

  const GUIDE = { page_id: "111", page_name: "Trinity Software", recipient: null, steps: [], permissions: [], manage_url: null, text: "Chào anh/chị, nhờ nối lại Fanpage", sent: false }
  async function openGuide() {
    setup({ pages: [{ ...PAGE, token_status: "expired" }] })
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Kết nối lại Fanpage" }))
    return screen.getByRole("button", { name: "Gửi hướng dẫn cho quản trị viên Page" })
  }

  it("Gửi hướng dẫn cho quản trị viên Page: máy chủ chỉ soạn, văn bản đi qua bảng chia sẻ của điện thoại", async () => {
    mockPost.mockResolvedValue({ data: GUIDE })
    const share = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { share, clipboard: { writeText: vi.fn() } })
    fireEvent.click(await openGuide())
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: "Nối lại Fanpage Trinity Software", text: GUIDE.text }))
    expect(mockPost).toHaveBeenCalledWith("/facebook/pages/1/admin-guide", {})
  })

  it("Gửi hướng dẫn: không có bảng chia sẻ ⇒ chép vào bộ nhớ tạm; đóng bảng chia sẻ ⇒ không chép", async () => {
    mockPost.mockResolvedValue({ data: GUIDE })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    fireEvent.click(await openGuide())
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(GUIDE.text))
    const cancelled = vi.fn().mockRejectedValue(new DOMException("x", "AbortError"))
    const writeText2 = vi.fn()
    vi.stubGlobal("navigator", { share: cancelled, clipboard: { writeText: writeText2 } })
    fireEvent.click(screen.getByRole("button", { name: "Gửi hướng dẫn cho quản trị viên Page" }))
    await waitFor(() => expect(cancelled).toHaveBeenCalled())
    expect(writeText2).not.toHaveBeenCalled()
  })
})

describe("facebookResultMessage", () => {
  it("câu tiếng Việt cho huỷ, thiếu quyền admin Page, token hết hạn, không có Page, lỗi chung", () => {
    expect(facebookResultMessage("cancelled", null)).toMatchObject({ kind: "info", text: expect.stringMatching(/huỷ/) })
    expect(facebookResultMessage("error", "permission")?.text).toMatch(/quản trị Page/)
    expect(facebookResultMessage("error", "token")?.text).toMatch(/hết hạn/)
    expect(facebookResultMessage("error", "no_page")?.text).toMatch(/Page nào/)
    expect(facebookResultMessage("error", null)?.kind).toBe("error")
    expect(facebookResultMessage("connected", null)).toBeNull()
  })
})
