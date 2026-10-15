import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/**
 * màn đồng ý OAuth: hiện client + HOST redirect + scope tiếng Việt; chỉ gửi quyết định kèm consent_token;
 * lỗi client/redirect (400) hiện trên trang KHÔNG điều hướng; lỗi tham số (ok:false) báo về client; 403/404 rõ nguyên nhân;
 * chỉ điều hướng tới https/loopback.
 */
const mockPost = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { post: (...a: unknown[]) => mockPost(...a) } }))
const search = vi.hoisted(() => ({ value: new URLSearchParams() }))
vi.mock("next/navigation", () => ({ useSearchParams: () => search.value, useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/hooks/use-app-shell", () => ({ useAppDocumentTheme: () => undefined }))

import { AuthorizeContent } from "@/app/oauth/authorize/_components/authorize-content"

const INITIAL = useAuthStore.getState()
const assign = vi.fn()
const replace = vi.fn()
const PARAMS = {
  response_type: "code", client_id: "trn_c_abc", redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", scope: "crm.read",
  state: "st1", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://crm.example.com/api/v1/mcp",
}
const okCtx = (client: Record<string, unknown> = {}) => ({
  ok: true,
  client: { name: "ChatGPT", logo_uri: null, client_uri: null, kind: "dcr", redirect_uri: PARAMS.redirect_uri, redirect_host: "chatgpt.com", loopback: false, known_as: "ChatGPT (OpenAI)", ...client },
  scopes: [{ scope: "crm.read", label: "Đọc dữ liệu CRM", description: "Xem khách hàng trong phạm vi quyền. Số điện thoại luôn bị che.", available: true }],
  consent_token: "tok.sig", expires_in: 600,
})
function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><AuthorizeContent /></QueryClientProvider>)
}

beforeEach(() => {
  mockPost.mockReset(); assign.mockReset(); replace.mockReset()
  search.value = new URLSearchParams({ ...PARAMS, evil: "1" })
  Object.defineProperty(window, "location", { value: { assign, replace, href: "https://crm.example.com/oauth/authorize" }, writable: true })
  useAuthStore.setState({ user: { id: 1, email: "an@example.com", full_name: "An", avatar_url: null, manager_id: null } } as never)
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("<AuthorizeContent>", () => {
  it("hiện client, host redirect, scope tiếng Việt, tài khoản; gửi context CHỈ với 8 tham số chuẩn", async () => {
    mockPost.mockResolvedValue({ data: okCtx() })
    renderIt()
    await screen.findByText("ChatGPT")
    expect(screen.getByTestId("redirect-host").textContent).toBe("chatgpt.com")
    expect(screen.getByText("Đã nhận diện: ChatGPT (OpenAI)")).toBeTruthy()
    expect(screen.getByText("Đọc dữ liệu CRM")).toBeTruthy()
    expect(screen.getByText(/Số điện thoại luôn bị che/)).toBeTruthy()
    expect(screen.getByText("an@example.com")).toBeTruthy()
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockPost.mock.calls[0][0]).toBe("/oauth/authorize/context")
    expect(mockPost.mock.calls[0][1]).toEqual({ params: PARAMS }) // tham số lạ `evil` bị bỏ
  })

  it("Cho phép → POST decision kèm consent_token → điều hướng tới redirect_to (https)", async () => {
    mockPost.mockResolvedValueOnce({ data: okCtx() })
    mockPost.mockResolvedValueOnce({ data: { redirect_to: "https://chatgpt.com/connector_platform_oauth_redirect?code=abc&state=st1&iss=x" } })
    renderIt()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("button", { name: /Cho phép/ }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://chatgpt.com/connector_platform_oauth_redirect?code=abc&state=st1&iss=x"))
    expect(mockPost.mock.calls[1]).toEqual(["/oauth/authorize/decision", { params: PARAMS, approve: true, consent_token: "tok.sig" }])
  })

  it("Từ chối → approve:false; redirect_to nguy hiểm (javascript:/http ngoài) KHÔNG được điều hướng", async () => {
    mockPost.mockResolvedValueOnce({ data: okCtx() })
    mockPost.mockResolvedValueOnce({ data: { redirect_to: "javascript:alert(1)" } })
    renderIt()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("button", { name: "Từ chối" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2))
    expect(mockPost.mock.calls[1][1]).toMatchObject({ approve: false })
    expect(assign).not.toHaveBeenCalled()
  })

  it("crm.write là quyền TUỲ CHỌN mặc định TICK SẴN: để nguyên ⇒ cả hai; bỏ tick ⇒ chỉ crm.read", async () => {
    const withWrite = () => {
      const c = okCtx()
      c.scopes.push({ scope: "crm.write", label: "Cho phép AI thay đổi dữ liệu (trong phạm vi quyền của bạn)", description: "AI ghi dữ liệu trực tiếp theo quyền của bạn.", available: true, optional: true } as never)
      return c
    }
    mockPost.mockResolvedValueOnce({ data: withWrite() })
    mockPost.mockResolvedValueOnce({ data: { redirect_to: "https://chatgpt.com/cb?code=a" } })
    const first = renderIt()
    await screen.findByText("ChatGPT")
    const box = screen.getByRole("checkbox") as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /Cho phép/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2))
    expect(mockPost.mock.calls[1][1]).toMatchObject({ approve: true, granted_scopes: ["crm.read", "crm.write"] })
    first.unmount()

    mockPost.mockReset(); assign.mockReset()
    mockPost.mockResolvedValueOnce({ data: withWrite() })
    mockPost.mockResolvedValueOnce({ data: { redirect_to: "https://chatgpt.com/cb?code=b" } })
    renderIt()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("checkbox"))
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: /Cho phép/ }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2))
    expect(mockPost.mock.calls[1][1]).toMatchObject({ approve: true, granted_scopes: ["crm.read"] })
  })

  it("Từ chối KHÔNG gửi granted_scopes", async () => {
    const c = okCtx()
    c.scopes.push({ scope: "crm.write", label: "Đề xuất", description: "x", available: true, optional: true } as never)
    mockPost.mockResolvedValueOnce({ data: c })
    mockPost.mockResolvedValueOnce({ data: { redirect_to: "https://chatgpt.com/cb?error=access_denied" } })
    renderIt()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("button", { name: "Từ chối" }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2))
    expect(mockPost.mock.calls[1][1]).not.toHaveProperty("granted_scopes")
  })

  it("client chưa nhận diện ⇒ cảnh báo; redirect loopback ⇒ cảnh báo localhost; scope chưa khả dụng có nhãn", async () => {
    const c = okCtx({ known_as: null, loopback: true, redirect_host: "localhost:3118", name: "Công cụ lạ" })
    c.scopes.push({ scope: "crm.write", label: "Ghi dữ liệu CRM", description: "Chưa khả dụng.", available: false })
    mockPost.mockResolvedValue({ data: c })
    renderIt()
    await screen.findByText("Công cụ lạ")
    expect(screen.getByText("Chưa được nhận diện")).toBeTruthy()
    expect(screen.getByText(/chưa nhận diện ứng dụng này/)).toBeTruthy()
    expect(screen.getByText(/CHÍNH máy tính của bạn/)).toBeTruthy()
    expect(screen.getByText("Chưa khả dụng")).toBeTruthy()
  })

  it("lỗi client/redirect_uri (400) hiện nguyên văn trên trang, KHÔNG điều hướng, KHÔNG có nút Cho phép", async () => {
    mockPost.mockRejectedValue({ response: { status: 400, data: { error: "invalid_request", error_description: "redirect_uri không khớp với địa chỉ client đã đăng ký" } } })
    renderIt()
    await screen.findByText(/redirect_uri không khớp/)
    expect(screen.queryByRole("button", { name: /Cho phép/ })).toBeNull()
    expect(assign).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("403 thiếu quyền / 404 chưa bật ⇒ thông báo rõ nguyên nhân", async () => {
    mockPost.mockRejectedValue({ response: { status: 403, data: { message: "Bạn không có quyền" } } })
    const { unmount } = renderIt()
    await screen.findByText(/integrations\.ai_connect/)
    unmount()
    mockPost.mockReset()
    mockPost.mockRejectedValue({ response: { status: 404, data: {} } })
    renderIt()
    await screen.findByText(/chưa được bật/)
  })

  it("ok:false (PKCE/scope/resource sai) ⇒ báo lỗi về client qua redirect an toàn; redirect lạ bị bỏ", async () => {
    mockPost.mockResolvedValue({ data: { ok: false, redirect_to: "https://chatgpt.com/cb?error=invalid_request&state=st1&iss=x" } })
    renderIt()
    await waitFor(() => expect(replace).toHaveBeenCalledWith("https://chatgpt.com/cb?error=invalid_request&state=st1&iss=x"))
    mockPost.mockReset(); replace.mockReset()
    mockPost.mockResolvedValue({ data: { ok: false, redirect_to: "javascript:alert(1)" } })
    renderIt()
    await screen.findAllByText(/không hợp lệ/)
    expect(replace).not.toHaveBeenCalled()
  })

  it("lỗi khi gửi quyết định (consent_token hết hạn) ⇒ hiện lỗi, KHÔNG điều hướng", async () => {
    mockPost.mockResolvedValueOnce({ data: okCtx() })
    mockPost.mockRejectedValueOnce({ response: { status: 400, data: { error: "invalid_request", error_description: "Phiên đồng ý không hợp lệ hoặc đã hết hạn — hãy tải lại trang" } } })
    renderIt()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("button", { name: /Cho phép/ }))
    await screen.findByText(/hãy tải lại trang/)
    expect(assign).not.toHaveBeenCalled()
  })
})
