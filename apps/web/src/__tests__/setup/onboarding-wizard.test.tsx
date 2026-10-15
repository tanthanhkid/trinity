/** Wizard bắt đầu: toàn màn hình, mỗi lần một bước; máy chủ chưa xác nhận thì không qua được bước. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { WizardConfirmResult, WizardStep, WizardView } from "@/hooks/use-onboarding-wizard"

const mutate = vi.fn()
const replace = vi.fn()
const finish = vi.fn()
vi.mock("@/hooks/use-onboarding-wizard", () => ({
  useWizardAction: () => ({ mutate, isPending: false }),
  useFinishWizard: () => finish,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ clear: vi.fn() }) }))
vi.mock("@/store/auth", () => ({ useAuthStore: () => ({ clearAuth: vi.fn() }) }))
vi.mock("@/lib/auth-api", () => ({ logout: vi.fn() }))
vi.mock("@/components/onboarding-wizard/wizard-steps", async (orig) => ({
  ...(await orig<typeof import("@/components/onboarding-wizard/wizard-steps")>()),
  StepBody: ({ step }: { step: string }) => <div>NỘI DUNG {step}</div>,
}))

import { OnboardingWizard } from "@/components/onboarding-wizard/onboarding-wizard"

const step = (key: WizardStep["key"], done = false): WizardStep => ({ key, done, skipped: false, can_skip: false, needs_admin: false })
const view = (steps: WizardStep[], current: WizardView["current"], completed = false): WizardView => ({ enabled: true, completed, current, steps })
const empty = () => view([step("ai"), step("build"), step("data"), step("channels"), step("post")], "ai")
const reply = (r: WizardConfirmResult) => mutate.mockImplementationOnce((_k: string, o: { onSuccess: (r: WizardConfirmResult) => void }) => o.onSuccess(r))

beforeEach(() => { mutate.mockReset(); replace.mockClear(); finish.mockClear() })

describe("OnboardingWizard", () => {
  it("mở ở bước đang phải làm, hiện Bước x/5, đúng một nhiệm vụ", () => {
    render(<OnboardingWizard wizard={empty()} />)
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 1/5")
    expect(screen.getByTestId("wizard-step-title").textContent).toBe("Kết nối trợ lý AI của bạn")
    expect(screen.getByText("NỘI DUNG ai")).toBeTruthy()
    expect(screen.queryByText("NỘI DUNG build")).toBeNull()
  })

  it("bấm Tôi đã làm xong khi chưa làm ⇒ máy chủ chặn, hiện việc còn thiếu, đứng yên", () => {
    reply({ ok: false, message: "Trinity chưa thấy trợ lý AI của bạn gọi vào.", wizard: empty() })
    render(<OnboardingWizard wizard={empty()} />)
    fireEvent.click(screen.getByTestId("wizard-confirm"))
    expect(mutate).toHaveBeenCalledWith("ai", expect.anything())
    expect(screen.getByTestId("wizard-message").textContent).toMatch(/chưa thấy trợ lý AI/)
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 1/5")
  })

  it("đạt ⇒ sang bước máy chủ báo còn phải làm (bước công ty đã xong thì tự qua)", () => {
    reply({ ok: true, message: null, wizard: view([step("ai", true), step("build", true), step("data"), step("channels"), step("post")], "data") })
    render(<OnboardingWizard wizard={empty()} />)
    fireEvent.click(screen.getByTestId("wizard-confirm"))
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 3/5")
    expect(screen.queryByTestId("wizard-message")).toBeNull()
  })

  it("xong hết ⇒ màn hoàn tất, bấm Vào Trinity mới mở ứng dụng", () => {
    const done = view([step("ai", true), step("build", true), step("data", true)], null, true)
    reply({ ok: true, message: null, wizard: done })
    render(<OnboardingWizard wizard={view([step("ai"), step("build", true), step("data", true)], "ai")} />)
    fireEvent.click(screen.getByTestId("wizard-confirm"))
    expect(screen.getByTestId("wizard-finished")).toBeTruthy()
    expect(finish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("wizard-enter"))
    expect(finish).toHaveBeenCalledWith(done)
    expect(replace).toHaveBeenCalledWith("/dashboard")
  })

  it("bước đã xong: hiện dấu xong + Tiếp tục; quay lại được bước trước", () => {
    render(<OnboardingWizard wizard={view([step("ai", true), step("build"), step("data")], "build")} />)
    fireEvent.click(screen.getByTestId("wizard-back"))
    expect(screen.getByTestId("wizard-step-done")).toBeTruthy()
    fireEvent.click(screen.getByTestId("wizard-next"))
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 2/3")
  })

  it("chỉ hiện Bỏ qua khi cấu hình cho phép", () => {
    render(<OnboardingWizard wizard={view([{ ...step("post"), can_skip: true }], "post")} />)
    expect(screen.getByTestId("wizard-skip")).toBeTruthy()
  })

  it("máy chủ chưa bật kết nối AI (không có bước ai) ⇒ báo rõ ở bước đầu, không nói 'bước trước'", () => {
    render(<OnboardingWizard wizard={view([step("build"), step("data")], "build")} />)
    expect(screen.getByTestId("wizard-ai-off").textContent).toMatch(/chưa bật kết nối trợ lý AI/)
    render(<OnboardingWizard wizard={empty()} />)
    expect(screen.getAllByTestId("wizard-ai-off")).toHaveLength(1)
  })

  it("không có thuật ngữ kỹ thuật trên màn", () => {
    const { container } = render(<OnboardingWizard wizard={empty()} />)
    expect(container.textContent).not.toMatch(/MCP|OAuth|token|API/i)
  })
})
