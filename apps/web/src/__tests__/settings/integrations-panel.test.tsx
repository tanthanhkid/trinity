import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useAuthStore } from "@/store/auth"

/**
 * Cài đặt > Kết nối & AI: mục hiện theo QUYỀN, chạy theo CỜ máy chủ; nhật ký tích hợp phân trang cursor
 * (phải có nút kích `fetchNextPage`) và chỉ gọi API khi đủ quyền + cờ bật.
 */
const mockGet = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => mockGet(...a) } }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { SettingsIntegrations } from "@/app/(dashboard)/settings/_components/settings-integrations"

const INITIAL = useAuthStore.getState()
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, created_at: "2026-10-04T01:00:00.000Z", channel: "mcp", client_id: "claude", user_id: 7, action: `tool_${id}`,
  resource: "contact", resource_id: "12", status: "ok", http_status: null, duration_ms: 35, error: null, metadata: {}, ...over,
})

function setStatus(webhooks: boolean, mcp: boolean) {
  mockGet.mockImplementation(async (url: string, cfg?: { params?: Record<string, string> }) => {
    if (url === "/integrations/status") return { data: { webhooks_enabled: webhooks, mcp_enabled: mcp, secret_key_configured: true } }
    if (url === "/integrations/webhooks/endpoints") return { data: { data: [] } }
    if (url === "/integrations/webhooks/events") return { data: [] }
    if (url === "/integrations/webhooks/deliveries") return { data: { data: [], meta: { next_cursor: null } } }
    if (url === "/integrations/webhooks/inbound-sources") return { data: { data: [] } }
    if (url === "/settings/options") return { data: { data: [] } }
    if (url === "/integrations/audit-logs") {
      if (cfg?.params?.cursor === "c1") return { data: { data: [row("2")], meta: { next_cursor: null } } }
      return { data: { data: [row("1", { status: "denied", error: "Thiếu quyền contacts.view" })], meta: { next_cursor: "c1" } } }
    }
    throw new Error(`unexpected ${String(url)}`)
  })
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SettingsIntegrations /></QueryClientProvider>)
}
const grant = (...perms: string[]) =>
  useAuthStore.setState({ permissions: Object.fromEntries(perms.map((p) => [p, true])) as never })
const openAudit = () => fireEvent.click(screen.getByRole("button", { name: "Nhật ký tích hợp" }))
const auditCalls = () => mockGet.mock.calls.filter((c) => c[0] === "/integrations/audit-logs")

beforeEach(() => {
  mockGet.mockReset()
})
afterEach(() => {
  useAuthStore.setState(INITIAL, true)
})

describe("<SettingsIntegrations> — quyền", () => {
  it("không có quyền nào → thông báo, KHÔNG gọi API", () => {
    grant()
    renderPanel()
    expect(screen.getByText(/chưa có quyền/)).toBeTruthy()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("chỉ webhooks → thấy Webhook ra/vào; KHÔNG thấy Kết nối AI, KHÔNG thấy Nhật ký", async () => {
    grant("integrations.webhooks")
    setStatus(true, false)
    renderPanel()
    expect(screen.getByRole("button", { name: "Webhook ra" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Webhook vào" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Trợ lý AI" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Nhật ký tích hợp" })).toBeNull()
    // "Webhook ra" là màn thật (không còn "sắp ra mắt"); chưa có endpoint → trạng thái rỗng.
    fireEvent.click(screen.getByRole("button", { name: "Webhook ra" }))
    await waitFor(() => expect(screen.getByText(/Chưa có endpoint nào/)).toBeTruthy())
    expect(screen.queryByText(/sắp ra mắt/)).toBeNull()
    expect(auditCalls()).toHaveLength(0)
  })

  it("chỉ ai_connect → thấy đúng 'Kết nối AI' (người dùng thường tự nối tài khoản)", () => {
    grant("integrations.ai_connect")
    setStatus(false, true)
    renderPanel()
    expect(screen.getByRole("button", { name: "Trợ lý AI" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Webhook ra" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Nhật ký tích hợp" })).toBeNull()
  })
})

describe("<SettingsIntegrations> — Tổng quan", () => {
  it("mặc định mở Tổng quan: mỗi kênh một dòng, bấm nút mở thẳng mục đó", async () => {
    grant("integrations.webhooks")
    setStatus(true, false)
    renderPanel()
    expect(screen.getByRole("button", { name: "Tất cả kết nối" }).getAttribute("aria-current")).toBe("page")
    const out = screen.getByTestId("conn-webhook-out")
    await waitFor(() => expect(out.textContent).toContain("Chưa có"))
    expect(screen.getByTestId("conn-facebook")).toBeTruthy()
    expect(screen.queryByTestId("conn-ai")).toBeNull()
    expect(screen.getByText("SePay")).toBeTruthy()
    fireEvent.click(within(out).getByRole("button", { name: "Thêm" }))
    await waitFor(() => expect(screen.getByText(/Chưa có endpoint nào/)).toBeTruthy())
    expect(screen.getByRole("button", { name: "Webhook ra" }).getAttribute("aria-current")).toBe("page")
  })
})

describe("<SettingsIntegrations> — cờ máy chủ", () => {
  it("cờ tắt → banner nêu đúng tên cờ cần bật, KHÔNG gọi nhật ký", async () => {
    grant("integrations.ai_admin")
    setStatus(false, false)
    renderPanel()
    openAudit()
    await waitFor(() => expect(screen.getByText(/chưa được bật trên máy chủ/)).toBeTruthy())
    expect(screen.getByText(/INTEGRATIONS_WEBHOOKS_ENABLED hoặc INTEGRATIONS_MCP_ENABLED/)).toBeTruthy()
    expect(auditCalls()).toHaveLength(0)
  })

  it("API status lỗi → báo lỗi, KHÔNG nhầm thành 'kênh tắt'", async () => {
    grant("integrations.ai_admin")
    mockGet.mockRejectedValue(new Error("network"))
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Không đọc được trạng thái/)).toBeTruthy())
    expect(screen.queryByText(/chưa được bật trên máy chủ/)).toBeNull()
  })
})

describe("<SettingsIntegrations> — Nhật ký tích hợp", () => {
  it("ai_admin + cờ bật → tải nhật ký; 'Tải thêm' kích trang kế bằng cursor và nối dòng", async () => {
    grant("integrations.ai_admin")
    setStatus(false, true)
    renderPanel()
    openAudit()
    await waitFor(() => expect(screen.getAllByText("tool_1").length).toBeGreaterThan(0))
    expect(auditCalls()[0][1].params).toMatchObject({ limit: 50 })
    expect(auditCalls()[0][1].params.cursor).toBeUndefined()
    expect(screen.getAllByText("Bị từ chối").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "Tải thêm" }))
    await waitFor(() => expect(screen.getAllByText("tool_2").length).toBeGreaterThan(0))
    expect(auditCalls()[1][1].params.cursor).toBe("c1")
    expect(screen.getAllByText("tool_1").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "Tải thêm" })).toBeNull()
  })

  it("không có dòng nào → trạng thái rỗng", async () => {
    grant("integrations.ai_admin")
    mockGet.mockImplementation(async (url: string) =>
      url === "/integrations/status"
        ? { data: { webhooks_enabled: true, mcp_enabled: false } }
        : { data: { data: [], meta: { next_cursor: null } } },
    )
    renderPanel()
    openAudit()
    await waitFor(() => expect(screen.getByText(/Chưa có dòng nhật ký nào/)).toBeTruthy())
  })
})

describe("sectionFromParams — quay về từ OAuth mở đúng mục ở trang Kết nối", () => {
  it("muc ưu tiên; google/facebook/zalo_oa/ket_noi suy ra mục; không có gì ⇒ tổng quan", async () => {
    const { sectionFromParams } = await import("@/app/(dashboard)/settings/_components/settings-integrations")
    const q = (s: string) => sectionFromParams(new URLSearchParams(s))
    expect(q("muc=payments&google=connected")).toBe("payments")
    expect(q("google=connected")).toBe("google-sheets")
    expect(q("facebook=connected&pages=2")).toBe("facebook")
    expect(q("zalo_oa=connected")).toBe("zalo-oa")
    expect(q("ket_noi=ok")).toBe("ban-hang")
    expect(q("")).toBe("overview")
  })
})
