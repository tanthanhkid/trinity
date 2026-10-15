/** Hướng dẫn người mới: dấu xong theo dữ liệu thật, thiếu quyền thì nhờ quản trị viên, tính năng tắt thì ẩn bước. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { resolveOrgFeatures, type OrgFeatures } from "@trinity/rbac"

let features: OrgFeatures = resolveOrgFeatures(undefined)
let allowed: (p: string) => boolean = () => true
vi.mock("@/hooks/use-org-features", () => ({ useOrgFeatures: () => ({ features, isResolved: true, isLoading: false, locked: {} }) }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: (p: string) => allowed(p), grants: {} }) }))
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { OnboardingChecklist } from "@/app/(dashboard)/bat-dau/_components/onboarding-checklist"
import { OnboardingIntro } from "@/app/(dashboard)/bat-dau/_components/onboarding-intro"
import { SETUP_PROMPTS } from "@/app/(dashboard)/bat-dau/_components/setup-prompts"

const none = { seen: true, ai_connected: false, workspace_built: false, has_data: false, channel_linked: false, first_post: false }

beforeEach(() => { features = resolveOrgFeatures(undefined); allowed = () => true })

describe("OnboardingChecklist", () => {
  it("5 bước, dấu xong theo dữ liệu, nút đi thẳng tới chỗ làm", () => {
    render(<OnboardingChecklist progress={{ ...none, ai_connected: true, has_data: true }} />)
    expect(screen.getByTestId("onboarding-progress").textContent).toBe("Đã xong 2/5")
    expect(screen.getByTestId("step-ai").dataset.done).toBe("true")
    expect(screen.getByTestId("step-build").dataset.done).toBe("false")
    const ch = within(screen.getByTestId("step-channels"))
    expect(ch.getByText("Kết nối kênh đăng bài").getAttribute("href")).toBe("/social?tab=channels")
    expect(ch.getByText("Nhận tin nhắn Fanpage").getAttribute("href")).toBe("/settings?tab=integrations")
    expect(within(screen.getByTestId("step-post")).getByText("Soạn bài").getAttribute("href")).toBe("/social?tab=compose")
  })
  it("thiếu quyền ⇒ báo nhờ quản trị viên, không đưa nút", () => {
    allowed = (p) => p !== "custom_objects.manage"
    render(<OnboardingChecklist progress={none} />)
    const b = within(screen.getByTestId("step-build"))
    expect(b.getByText(/quản trị viên/)).toBeTruthy()
    expect(b.queryByRole("button")).toBeNull()
  })
  it("tắt Đăng đa kênh ⇒ ẩn bước đăng bài, bước kênh chỉ còn nhận tin Fanpage", () => {
    features = resolveOrgFeatures({ social_posting: false })
    render(<OnboardingChecklist progress={none} />)
    expect(screen.queryByTestId("step-post")).toBeNull()
    const ch = within(screen.getByTestId("step-channels"))
    expect(ch.queryByText("Kết nối kênh đăng bài")).toBeNull()
    expect(ch.getByText("Nhận tin nhắn Fanpage")).toBeTruthy()
    expect(screen.getByTestId("onboarding-progress").textContent).toBe("Đã xong 0/4")
  })
})

describe("Lời trên màn không lộ kỹ thuật", () => {
  it("câu mẫu và giới thiệu không có tên công cụ/MCP", () => {
    const { container } = render(<><OnboardingIntro /><OnboardingChecklist progress={none} /></>)
    const text = container.textContent + SETUP_PROMPTS.map((p) => p.text).join(" ")
    expect(text).not.toMatch(/MCP|get_setup_guide|propose_workspace|import_records|create_view|set_menu|complete_setup|API/)
  })
})
