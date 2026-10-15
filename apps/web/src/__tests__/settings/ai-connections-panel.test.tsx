import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/**
 * Cài đặt > Kết nối & AI > Kết nối AI: hướng dẫn + URL (sao chép), danh sách ứng dụng đã cấp quyền, thu hồi có xác nhận,
 * ai_admin xem của mọi người; thiếu base URL → nói rõ nguyên nhân và KHÔNG gọi API danh sách.
 */
const mockGet = vi.fn()
const mockDelete = vi.fn()
const mockPatch = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a), delete: (...a: unknown[]) => mockDelete(...a), patch: (...a: unknown[]) => mockPatch(...a) } }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

import { AiConnectionsPanel } from "@/app/(dashboard)/settings/_components/integrations/ai-connections-panel"

const INITIAL = useAuthStore.getState()
const MCP = "https://crm.example.com/api/v1/mcp"
const conn = (id: string, over: Record<string, unknown> = {}) => ({
  id, client_id: "trn_c_1", client_name: "ChatGPT", client_kind: "dcr", user: { id: 5, full_name: "An", email: "an@example.com" },
  scopes: ["crm.read"], connected_at: "2026-10-04T01:00:00.000Z", last_used_at: null, refresh_expires_at: "2026-11-03T01:00:00.000Z", ...over,
})
const grant = (...perms: string[]) => useAuthStore.setState({ permissions: Object.fromEntries(perms.map((p) => [p, true])) as never })
function renderPanel(props: { mcpUrl: string | null; baseUrlConfigured?: boolean } = { mcpUrl: MCP }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><AiConnectionsPanel mcpUrl={props.mcpUrl} baseUrlConfigured={props.baseUrlConfigured ?? true} /></QueryClientProvider>)
}

beforeEach(() => {
  mockGet.mockReset(); mockDelete.mockReset(); mockPatch.mockReset(); toast.success.mockReset(); toast.error.mockReset()
  grant("integrations.ai_connect")
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("<AiConnectionsPanel>", () => {
  it("ai_admin thấy công tắc 'Yêu cầu duyệt thay đổi do AI' (mặc định TẮT); bật ⇒ PATCH require_approval=true; người thường không thấy", async () => {
    mockGet.mockImplementation(async (url: string) => (url.endsWith("/settings") ? { data: { require_approval: false } } : { data: { data: [] } }))
    mockPatch.mockResolvedValue({ data: { require_approval: true } })
    grant("integrations.ai_connect", "integrations.ai_admin")
    renderPanel()
    const sw = await screen.findByRole("switch")
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"))
    expect(screen.getByText(/Đang TẮT \(mặc định\)/)).toBeTruthy()
    fireEvent.click(sw)
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("/integrations/ai-actions/settings", { require_approval: true }))
  })

  it("người không có ai_admin không thấy công tắc duyệt", async () => {
    mockGet.mockResolvedValue({ data: { data: [] } })
    renderPanel()
    await screen.findByText(/chưa kết nối ứng dụng AI nào/)
    expect(screen.queryByRole("switch")).toBeNull()
  })

  it("hiện URL MCP + nút sao chép + hướng dẫn ChatGPT & Claude", async () => {
    mockGet.mockResolvedValue({ data: { data: [] } })
    renderPanel()
    expect(screen.getByTestId("mcp-url").textContent).toBe(MCP)
    fireEvent.click(screen.getByRole("button", { name: /Sao chép URL MCP/ }))
    await waitFor(() => expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(MCP))
    expect(screen.getByText(/Cách nối với ChatGPT/)).toBeTruthy()
    expect(screen.getByText(/Cách nối với Claude/)).toBeTruthy()
    await screen.findByText(/chưa kết nối ứng dụng AI nào/)
  })

  it("danh sách của mình: tên, quyền 'Chỉ đọc', lần dùng cuối; KHÔNG hiện người dùng; ai_connect không thấy nút 'Mọi người'", async () => {
    mockGet.mockResolvedValue({ data: { data: [conn("f1", { last_used_at: "2026-10-04T03:00:00.000Z" })] } })
    renderPanel()
    await screen.findByText("ChatGPT")
    expect(screen.getByText("Chỉ đọc")).toBeTruthy()
    expect(screen.queryByText(/an@example.com/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Mọi người" })).toBeNull()
    expect(mockGet).toHaveBeenCalledWith("/integrations/ai-connections", { params: undefined })
  })

  it("thu hồi: có xác nhận → DELETE đúng id → báo thành công; huỷ thì không gọi", async () => {
    mockGet.mockResolvedValue({ data: { data: [conn("fam-1")] } })
    mockDelete.mockResolvedValue({})
    renderPanel()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("button", { name: "Thu hồi ChatGPT" }))
    const dlg = within(await screen.findByRole("dialog"))
    expect(dlg.getByText(/mất quyền truy cập NGAY/)).toBeTruthy()
    fireEvent.click(dlg.getByRole("button", { name: "Huỷ" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(mockDelete).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Thu hồi ChatGPT" }))
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Thu hồi quyền" }))
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("/integrations/ai-connections/fam-1"))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("lỗi thu hồi hiện thông điệp THẬT của BE", async () => {
    mockGet.mockResolvedValue({ data: { data: [conn("fam-1")] } })
    mockDelete.mockRejectedValue({ response: { data: { message: "Không tìm thấy kết nối" } } })
    renderPanel()
    await screen.findByText("ChatGPT")
    fireEvent.click(screen.getByRole("button", { name: "Thu hồi ChatGPT" }))
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Thu hồi quyền" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Không tìm thấy kết nối"))
  })

  it("ai_admin: nút 'Mọi người' gọi scope=all và hiện chủ sở hữu từng kết nối", async () => {
    grant("integrations.ai_admin")
    mockGet.mockImplementation(async (_u: string, cfg?: { params?: { scope?: string } }) =>
      cfg?.params?.scope === "all" ? { data: { data: [conn("a"), conn("b", { user: { id: 9, full_name: "Bình", email: "binh@example.com" }, client_name: "Claude" })] } } : { data: { data: [] } },
    )
    renderPanel()
    await screen.findByText(/chưa kết nối ứng dụng AI nào/)
    fireEvent.click(screen.getByRole("button", { name: "Mọi người" }))
    await screen.findByText(/binh@example.com/)
    expect(mockGet).toHaveBeenCalledWith("/integrations/ai-connections", { params: { scope: "all" } })
    expect(screen.getByText(/an@example.com/)).toBeTruthy()
  })

  it("lỗi tải ⇒ báo lỗi (không nhầm là rỗng)", async () => {
    mockGet.mockRejectedValue(new Error("boom"))
    renderPanel()
    await screen.findByText(/Không tải được danh sách kết nối/)
    expect(screen.queryByText(/chưa kết nối ứng dụng AI nào/)).toBeNull()
  })

  it("thiếu INTEGRATIONS_PUBLIC_BASE_URL ⇒ nói rõ cần đặt gì, không hiện URL, KHÔNG gọi API danh sách", () => {
    renderPanel({ mcpUrl: null, baseUrlConfigured: false })
    expect(screen.getByText(/INTEGRATIONS_PUBLIC_BASE_URL/)).toBeTruthy()
    expect(screen.queryByTestId("mcp-url")).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
  })
})
