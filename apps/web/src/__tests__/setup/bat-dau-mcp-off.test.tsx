import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"

let canAdmin = true
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => canAdmin, grants: {} }) }))
vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => ({ status: "chua_dung", isLoading: false, data: { status: "chua_dung", mcp_url: null, can_build: true, ai_connected: false, ai_connected_anyone: false } }),
  useCompleteSetup: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/ai-actions/use-ai-actions", () => ({ useAiActionsPendingCount: () => ({ data: 0 }) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))
vi.mock("@/app/(dashboard)/bat-dau/_components/connect-steps", () => ({ ConnectSteps: () => null }))
vi.mock("@/hooks/use-onboarding", () => ({ useOnboarding: () => ({ data: undefined }), useMarkOnboardingSeen: () => ({ mutate: vi.fn(), isIdle: true }) }))
vi.mock("@/app/(dashboard)/bat-dau/_components/onboarding-intro", () => ({ OnboardingIntro: () => null }))
vi.mock("@/app/(dashboard)/bat-dau/_components/onboarding-checklist", () => ({ OnboardingChecklist: () => null }))

import { BatDauScreen } from "@/app/(dashboard)/bat-dau/_components/bat-dau-screen"

describe("Bắt đầu khi MCP tắt", () => {
  beforeEach(() => { canAdmin = true })
  it("admin: nêu tên biến + nhắc deploy lại, không bảo nhờ quản trị viên", () => {
    render(<BatDauScreen />)
    const el = screen.getByTestId("mcp-off-admin")
    expect(el.textContent).toMatch(/INTEGRATIONS_MCP_ENABLED=true/)
    expect(el.textContent).toMatch(/INTEGRATIONS_SECRET_KEY/)
    expect(el.textContent).toMatch(/deploy lại/)
    expect(screen.queryByText(/nhờ quản trị viên/i)).toBeNull()
  })
  it("người dùng thường: vẫn nhờ quản trị viên", () => {
    canAdmin = false
    render(<BatDauScreen />)
    expect(screen.getByTestId("mcp-off-user").textContent).toMatch(/nhờ quản trị viên/)
  })
})
