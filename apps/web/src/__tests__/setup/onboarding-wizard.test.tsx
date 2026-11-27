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
const perms = new Set<string>(["contacts.create", "settings.features"])
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: (p: string) => perms.has(p) }) }))
vi.mock("@/hooks/use-settings-options", () => ({ useSettingsOptions: () => ({ data: [{ id: 1, value: "other", label: "Khác" }] }) }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }))
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ clear: vi.fn() }) }))
vi.mock("@/store/auth", () => ({ useAuthStore: () => ({ clearAuth: vi.fn() }) }))
vi.mock("@/lib/auth-api", () => ({ logout: vi.fn() }))
const fbStatus = { data: { configured: true, secret_key_configured: true } as Record<string, unknown> | undefined }
const fbConnect = vi.fn()
const goToFacebookDialog = vi.fn()
vi.mock("@/app/(dashboard)/settings/_components/integrations/use-facebook", () => ({
  useFacebookStatus: () => fbStatus,
  useFacebookPageMutations: () => ({ connect: { mutate: fbConnect, isPending: false } }),
  goToFacebookDialog: (u: string) => goToFacebookDialog(u),
}))
vi.mock("@/app/(dashboard)/social/_components/social-channels", () => ({ SocialChannels: () => null }))
vi.mock("@/app/(dashboard)/social/_components/social-composer", () => ({ SocialComposer: () => null }))

import { OnboardingWizard } from "@/components/onboarding-wizard/onboarding-wizard"

const step = (key: WizardStep["key"], done = false): WizardStep => ({ key, done, skipped: false, can_skip: false, needs_admin: false })
const view = (steps: WizardStep[], current: WizardView["current"], completed = false, industry: string | null = null): WizardView => ({ enabled: true, completed, industry, current, steps })
const empty = () => view([step("industry"), step("modules"), step("data"), step("channels"), step("post")], "industry")
const reply = (r: WizardConfirmResult) => mutate.mockImplementationOnce((_k: string, o: { onSuccess: (r: WizardConfirmResult) => void }) => o.onSuccess(r))
const built = (wizard: WizardView): BuildSystemResult => ({ industry: "education_center", features: [], created_objects: [], sample_records: 3, sample_contacts: 0, wizard })

beforeEach(() => { perms.clear(); perms.add("contacts.create"); perms.add("settings.features"); mutate.mockReset(); buildMutate.mockReset(); replace.mockClear(); finish.mockClear() })

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
    fireEvent.click(document.getElementById("wiz-feature-lead_scoring") as HTMLElement)
    fireEvent.click(screen.getByTestId("wizard-build"))
    const [body] = buildMutate.mock.calls[0]
    expect(body.industry).toBe("education_center")
    expect(body.features).toContain("payroll")
    expect(body.features).not.toContain("lead_scoring")
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

  it("form thêm khách đầu tiên: bắt nhập tên và số, nút tắt khi thiếu tên", () => {
    render(<OnboardingWizard wizard={view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")} />)
    const btn = screen.getByTestId("add-contact") as HTMLButtonElement
    fireEvent.change(screen.getByLabelText(/Số điện thoại/), { target: { value: "0912345678" } })
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/Tên khách/), { target: { value: "An" } })
    expect(btn.disabled).toBe(false)
  })

  it("sau Dựng, bước kế tính theo danh sách bước MỚI (không nhảy sai bước, thanh tiến độ đúng)", () => {
    // danh sách mới ngắn hơn: bỏ bước channels/post; bước data nằm ở vị trí 3/3
    buildMutate.mockImplementationOnce((_b: unknown, o: { onSuccess: (r: BuildSystemResult) => void }) =>
      o.onSuccess(built(view([step("industry", true), step("modules", true), step("data")], "data", false, "other"))))
    render(<OnboardingWizard wizard={empty()} />)
    fireEvent.click(screen.getByTestId("industry-other"))
    fireEvent.click(screen.getByTestId("wizard-next-industry"))
    fireEvent.click(screen.getByTestId("wizard-build"))
    expect(screen.getByTestId("wizard-progress").textContent).toBe("Bước 3/3")
    expect(screen.getByTestId("step-data")).toBeTruthy()
  })

  it("không có quyền thêm khách: ẩn form, gợi ý bấm Bỏ qua; không gợi ý nhập file", () => {
    perms.delete("contacts.create")
    render(<OnboardingWizard wizard={view([step("industry", true), step("modules", true), { ...step("data"), can_skip: true }], "data", false, "clinic")} />)
    expect(screen.queryByTestId("add-contact")).toBeNull()
    expect(screen.getByTestId("no-create-contact").textContent).toMatch(/Bỏ qua bước này/)
    expect(screen.queryByTestId("import-hint")).toBeNull()
  })

  it("có quyền thêm khách (không cần quyền cấu hình): gợi ý gửi file Excel/Google Sheet cho trợ lý AI", () => {
    perms.delete("settings.features")
    render(<OnboardingWizard wizard={view([step("industry", true), step("modules", true), { ...step("data"), can_skip: true }], "data", false, "clinic")} />)
    const hint = screen.getByTestId("import-hint").textContent ?? ""
    expect(hint).toMatch(/gửi file cho trợ lý AI/)
    expect(hint).not.toMatch(/Cài đặt › Kết nối/)
  })

  it("chỉ nói 'dữ liệu mẫu' ở bước dữ liệu khi máy chủ báo còn mẫu", () => {
    const base = view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")
    const a = render(<OnboardingWizard wizard={{ ...base, sample_data: false }} />)
    expect(a.container.textContent).not.toMatch(/dữ liệu mẫu/)
    a.unmount()
    const b = render(<OnboardingWizard wizard={{ ...base, sample_data: true }} />)
    expect(b.container.textContent).toMatch(/dữ liệu mẫu/)
  })

  it("số điện thoại có dấu cách/gạch/+84 được chấp nhận (chuẩn hoá trước khi kiểm); số sai báo câu lỗi đúng", async () => {
    const { normalizePhoneInput } = await import("@/components/onboarding-wizard/wizard-steps")
    for (const v of ["0912 345 678", "0912-345-678", "0912.345.678", "+84 912 345 678"]) expect(/^(0\d{9}|\+84\d{9})$/.test(normalizePhoneInput(v))).toBe(true)
    expect(/^(0\d{9}|\+84\d{9})$/.test(normalizePhoneInput("091234567"))).toBe(false)
    render(<OnboardingWizard wizard={view([step("industry", true), step("modules", true), step("data")], "data", false, "clinic")} />)
    fireEvent.change(screen.getByLabelText(/Tên khách/), { target: { value: "An" } })
    fireEvent.change(screen.getByLabelText(/Số điện thoại/), { target: { value: "12345" } })
    fireEvent.click(screen.getByTestId("add-contact"))
    expect((await screen.findByRole("alert")).textContent).toMatch(/\+84 kèm 9 số/)
  })

  describe("bước Kết nối Facebook (channels)", () => {
    const atChannels = () => view([step("industry", true), step("modules", true), step("data", true), { ...step("channels"), can_skip: true }, step("post")], "channels", false, "education_center")

    beforeEach(() => { fbConnect.mockReset(); goToFacebookDialog.mockReset(); fbStatus.data = { configured: true, secret_key_configured: true } })

    it("có nút Kết nối Facebook: bấm xin URL rồi chuyển sang hộp thoại Facebook", () => {
      fbConnect.mockImplementationOnce((_v: unknown, o: { onSuccess: (u: string) => void }) => o.onSuccess("https://www.facebook.com/dialog"))
      render(<OnboardingWizard wizard={atChannels()} />)
      fireEvent.click(screen.getByTestId("wizard-facebook-connect"))
      expect(fbConnect).toHaveBeenCalledTimes(1)
      expect(goToFacebookDialog).toHaveBeenCalledWith("https://www.facebook.com/dialog")
    })

    it("nút 'Để sau' bỏ qua bước này", () => {
      reply({ ok: true, message: null, wizard: view([step("industry", true), step("modules", true), step("data", true), { ...step("channels"), skipped: true }, step("post")], "post") })
      render(<OnboardingWizard wizard={atChannels()} />)
      fireEvent.click(screen.getByRole("button", { name: "Để sau" }))
      expect(mutate.mock.calls[0][0]).toBe("channels")
    })

    it("máy chủ chưa cấu hình Facebook ⇒ khoá nút, nói bằng lời khách hiểu, không lộ tên biến", () => {
      fbStatus.data = { configured: false, secret_key_configured: true }
      const { container } = render(<OnboardingWizard wizard={atChannels()} />)
      expect((screen.getByTestId("wizard-facebook-connect") as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByTestId("wizard-facebook-unavailable")).toBeTruthy()
      expect(container.textContent).not.toMatch(/FACEBOOK_|app id/i)
    })

    it("lỗi xin URL ⇒ hiện câu tiếng Việt", () => {
      fbConnect.mockImplementationOnce((_v: unknown, o: { onError: (e: unknown) => void }) => o.onError(new Error("x")))
      render(<OnboardingWizard wizard={atChannels()} />)
      fireEvent.click(screen.getByTestId("wizard-facebook-connect"))
      expect(screen.getByRole("alert").textContent).toMatch(/Chưa mở được hộp thoại Facebook|x/)
    })
  })
})
