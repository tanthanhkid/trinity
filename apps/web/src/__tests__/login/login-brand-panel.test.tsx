/** Chữ hướng ra khách trên trang đăng nhập + Bắt đầu: đúng định vị, KHÔNG lộ thuật ngữ kỹ thuật. */
import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"

// Prompt cho agent (có chữ MCP vì agent cần biết) nằm trong ô xem trước; chữ trên giao diện của AgentConnect có test riêng (agent-connect.test.tsx).
vi.mock("@/components/onboarding-wizard/agent-connect", () => ({ AgentConnect: () => null }))
vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => ({ status: "chua_dung", isLoading: false, data: { mcp_url: "https://crm.example.vn/mcp", can_build: true, ai_connected: false, ai_connected_anyone: false } }),
  useCompleteSetup: () => ({ isPending: false, mutate: vi.fn() }),
}))
vi.mock("@/hooks/ai-actions/use-ai-actions", () => ({ useAiActionsPendingCount: () => ({ data: 0 }) }))
vi.mock("@/hooks/use-onboarding", () => ({ useOnboarding: () => ({ data: { seen: true, ai_connected: false, workspace_built: false, has_data: false, channel_linked: false, first_post: false } }), useMarkOnboardingSeen: () => ({ mutate: vi.fn(), isIdle: true }) }))
vi.mock("@/hooks/use-org-features", async () => { const { resolveOrgFeatures } = await import("@trinity/rbac"); return { useOrgFeatures: () => ({ features: resolveOrgFeatures(undefined), isResolved: true, isLoading: false, locked: {} }) } })

import { LoginBrandPanel } from "@/app/login/_components/login-brand-panel"
import { BatDauScreen } from "@/app/(dashboard)/bat-dau/_components/bat-dau-screen"

const TECH = /\b(MCP|API|OAuth|token|plugin|server)\b/i

describe("chữ hướng ra khách", () => {
  it("/login: định vị mới, không còn Zalo và Email, không thuật ngữ kỹ thuật", () => {
    const { container } = render(<LoginBrandPanel />)
    const text = container.textContent ?? ""
    expect(text).toContain("Điều khiển toàn bộ doanh nghiệp")
    expect(text).toContain("trợ lý AI bạn yêu thích")
    expect(text).not.toContain("Zalo và Email")
    expect(text).not.toMatch(TECH)
  })

  it("/bat-dau: phần người dùng đọc không có MCP/OAuth (URL nằm trong ô sao chép, ô đó được bỏ qua)", () => {
    const { container } = render(<BatDauScreen />)
    container.querySelectorAll('[data-testid="connect-url"]').forEach((e) => e.remove())
    container.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""))
    const text = container.textContent ?? ""
    expect(text).toContain("địa chỉ kết nối")
    expect(text).not.toMatch(TECH)
    expect(text).not.toMatch(/INTEGRATIONS_/)
  })
})
