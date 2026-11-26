/** Wizard bắt đầu: toàn màn hình, mỗi lần một bước; chọn ngành → chọn phân hệ → Dựng hệ thống (không AI); máy chủ chưa xác nhận thì không qua được bước. */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { BuildSystemResult, WizardConfirmResult, WizardStep, WizardView } from "@/hooks/use-onboarding-wizard"

const mutate = vi.fn()
const buildMutate = vi.fn()
const replace = vi.fn()
const finish = vi.fn()
vi.mock("@/hooks/use-onboarding-wizard", () => ({
  useWizardAction: () => ({ mutate, isPending: false }),
  useBuildSystem: () => ({ mutate: buildMutate, isPending: false }),
  useFinishWizard: () => finish,
}))
vi.mock("@/hooks/use-settings-options", () => ({ useSettingsOptions: () => ({ data: [{ id: 1, value: "other", label: "Khác" }] }) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ clear: vi.fn() }) }))
vi.mock("@/store/auth", () => ({ useAuthStore: () => ({ clearAuth: vi.fn() }) }))
vi.mock("@/lib/auth-api", () => ({ logout: vi.fn() }))
vi.mock("@/app/(dashboard)/social/_components/social-channels", () => ({ SocialChannels: () => null }))
vi.mock("@/app/(dashboard)/social/_components/social-composer", () => ({ SocialComposer: () => null }))

import { OnboardingWizard } from "@/components/onboarding-wizard/onboarding-wizard"

const step = (key: WizardStep["key"], done = false): WizardStep => ({ key, done, skipped: false, can_skip: false, needs_admin: false })
const view = (steps: WizardStep[], current: WizardView["current"], completed = false, industry: string | null = null): WizardView => ({ enabled: true, completed, industry, current, steps })
const empty = () => view([step("industry"), step("modules"), step("data"), step("channels"), step("post")], "industry")
const reply = (r: WizardConfirmResult) => mutate.mockImplementationOnce((_k: string, o: { onSuccess: (r: WizardConfirmResult) => void }) => o.onSuccess(r))
const built = (wizard: WizardView): BuildSystemResult => ({ industry: "education_center", features: [], created_objects: [], sample_records: 3, sample_contacts: 0, wizard })

beforeEach(() => { mutate.mockReset(); buildMutate.mockReset(); replace.mockClear(); finish.mockClear() })

describe("OnboardingWizard", () => {
  it("mở ở bước chọn loại doanh nghiệp: hiện 5 thẻ (4 mẫu + Khác), không còn chữ nối AI", () => {
    const { container } = render(<OnboardingWizard wizard={empty()} />)
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 1/5")
    expect(screen.getByTestId("wizard-step-title").textContent).toBe("Công ty bạn làm nghề gì?")
    expect(screen.getAllByRole("radio")).toHaveLength(5)
    expect(container.textContent).not.toMatch(/trợ lý AI|MCP|OAuth|token|API/i)
  })

  it("chưa chọn ngành thì chưa Tiếp tục được; chọn rồi sang bước phân hệ với bộ tick sẵn theo ngành", () => {
    render(<OnboardingWizard wizard={empty()} />)
    expect((screen.getByTestId("wizard-next-industry") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId("industry-retail_service"))
    fireEvent.click(screen.getByTestId("wizard-next-industry"))
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 2/5")
    const sw = (k: string) => document.getElementById(`wiz-feature-${k}`) as HTMLElement
    expect(sw("pos").getAttribute("aria-checked")).toBe("true")
    expect(sw("payroll").getAttribute("aria-checked")).toBe("false")
    expect(sw("contacts").getAttribute("aria-checked")).toBe("true")
    expect((sw("contacts") as HTMLButtonElement).disabled).toBe(true)
  })

  it("thêm/bớt phân hệ rồi Dựng hệ thống ⇒ gửi đúng ngành + phân hệ, rồi sang bước dữ liệu", () => {
    buildMutate.mockImplementationOnce((_b: unknown, o: { onSuccess: (r: BuildSystemResult) => void }) =>
      o.onSuccess(built(view([step("industry", true), step("modules", true), step("data"), step("channels"), step("post")], "data", false, "education_center"))))
    render(<OnboardingWizard wizard={empty()} />)
    fireEvent.click(screen.getByTestId("industry-education_center"))
    fireEvent.click(screen.getByTestId("wizard-next-industry"))
    fireEvent.click(document.getElementById("wiz-feature-payroll") as HTMLElement)
    fireEvent.click(document.getElementById("wiz-feature-payments") as HTMLElement)
    fireEvent.click(screen.getByTestId("wizard-build"))
    const [body] = buildMutate.mock.calls[0]
    expect(body.industry).toBe("education_center")
    expect(body.features).toContain("payroll")
    expect(body.features).not.toContain("payments")
    expect(body.features).toEqual(expect.arrayContaining(["dashboard", "contacts", "kanban", "reports"]))
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 3/5")
    expect(screen.getByTestId("step-data")).toBeTruthy()
  })

  it("dựng lỗi ⇒ hiện lời báo, đứng yên ở bước phân hệ", () => {
    buildMutate.mockImplementationOnce((_b: unknown, o: { onError: (e: unknown) => void }) => o.onError(new Error("x")))
    render(<OnboardingWizard wizard={empty()} />)
    fireEvent.click(screen.getByTestId("industry-other"))
    fireEvent.click(screen.getByTestId("wizard-next-industry"))
    fireEvent.click(screen.getByTestId("wizard-build"))
    expect(screen.getByTestId("wizard-message")).toBeTruthy()
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 2/5")
  })

  it("công ty đã dựng ⇒ mở thẳng bước dữ liệu; hai bước đầu hiện dấu xong, không hiện lại thẻ chọn ngành", () => {
    render(<OnboardingWizard wizard={view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")} />)
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 3/3")
    fireEvent.click(screen.getByTestId("wizard-back"))
    fireEvent.click(screen.getByTestId("wizard-back"))
    expect(screen.getByTestId("wizard-step-done")).toBeTruthy()
    expect(screen.queryByTestId("industry-other")).toBeNull()
  })

  it("bấm Tôi đã làm xong khi chưa có khách thật ⇒ máy chủ chặn, hiện việc còn thiếu, đứng yên", () => {
    const w = view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")
    reply({ ok: false, message: "Trinity chưa có khách hàng hay bản ghi thật nào (bản ghi mẫu không tính).", wizard: w })
    render(<OnboardingWizard wizard={w} />)
    fireEvent.click(screen.getByTestId("wizard-confirm"))
    expect(mutate).toHaveBeenCalledWith("data", expect.anything())
    expect(screen.getByTestId("wizard-message").textContent).toMatch(/bản ghi mẫu không tính/)
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 3/3")
  })

  it("xong hết ⇒ màn hoàn tất, bấm Vào Trinity mới mở ứng dụng", () => {
    const w = view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")
    const done = view([step("industry", true), step("modules", true), step("data", true)], null, true, "clinic")
    reply({ ok: true, message: null, wizard: done })
    render(<OnboardingWizard wizard={w} />)
    fireEvent.click(screen.getByTestId("wizard-confirm"))
    expect(screen.getByTestId("wizard-finished")).toBeTruthy()
    expect(finish).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("wizard-enter"))
    expect(finish).toHaveBeenCalledWith(done)
    expect(replace).toHaveBeenCalledWith("/dashboard")
  })

  it("chỉ hiện Bỏ qua khi cấu hình cho phép", () => {
    render(<OnboardingWizard wizard={view([{ ...step("post"), can_skip: true }], "post")} />)
    expect(screen.getByTestId("wizard-skip")).toBeTruthy()
  })

  it("người không có quyền quản trị ở bước dựng: không thấy lựa chọn/nút Dựng, có nút Tôi đã làm xong để đọc lại", () => {
    const w = view([{ ...step("industry"), needs_admin: true }, { ...step("modules"), needs_admin: true }, step("data")], "industry")
    const again = view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")
    reply({ ok: true, message: null, wizard: again })
    render(<OnboardingWizard wizard={w} />)
    expect(screen.queryByRole("radiogroup")).toBeNull()
    expect(screen.queryByTestId("wizard-build")).toBeNull()
    fireEvent.click(screen.getByTestId("wizard-confirm"))
    expect(mutate).toHaveBeenCalledWith("industry", expect.anything())
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 3/3")
  })

  it("chữ 'bỏ qua được' chỉ hiện khi máy chủ cho bỏ qua bước đó", () => {
    const first = render(<OnboardingWizard wizard={view([{ ...step("data"), can_skip: false }], "data")} />)
    expect(screen.queryByTestId("wizard-can-skip")).toBeNull()
    expect(screen.queryByText(/Bỏ qua bước này”/)).toBeNull()
    first.unmount()
    render(<OnboardingWizard wizard={view([{ ...step("data"), can_skip: true }], "data")} />)
    expect(screen.getByTestId("wizard-can-skip")).toBeTruthy()
  })
})
