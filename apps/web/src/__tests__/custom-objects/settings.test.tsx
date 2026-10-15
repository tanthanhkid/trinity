/**
 * Thực thể tuỳ biến — Cài đặt › Tính năng: khu cấu hình chỉ hiện với `custom_objects.manage`; thêm tính năng (mã tự sinh
 * từ tên, không đổi); sửa trường chọn-một giữ nguyên mã lựa chọn cũ; công thức "Tính thử" gọi BE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { resolveOrgFeatures } from "@trinity/rbac"
import type { CustomFieldDef, CustomObjectDef } from "@/types/custom-objects"

const get = vi.fn()
const post = vi.fn()
const patch = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (_e: unknown, fb: string) => fb,
}))
vi.mock("@/hooks/use-org-features", () => ({
  ORG_FEATURES_KEY: ["settings", "org-features"],
  useOrgFeatures: () => ({ features: resolveOrgFeatures(undefined), isLoading: false }),
  useUpdateOrgFeatures: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/settings", useSearchParams: () => new URLSearchParams() }))
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { useAuthStore } from "@/store/auth"
import { SettingsFeatures } from "@/app/(dashboard)/settings/_components/settings-features"
import { FieldFormDialog } from "@/app/(dashboard)/settings/_components/custom-objects/field-form-dialog"
import { FormulaEditor } from "@/app/(dashboard)/settings/_components/custom-objects/formula-editor"
import { TemplateDialog } from "@/app/(dashboard)/settings/_components/custom-objects/template-dialog"

const INITIAL = useAuthStore.getState()
const field = (key: string, label: string, type: CustomFieldDef["type"], extra: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  id: key.length, key, label, type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: {}, help_text: null, ...extra,
})
const OBJ = {
  id: 1, key: "khoa_hoc", label: "Khoá học", label_plural: "Khoá học", icon: null, description: null, show_in_nav: true, nav_order: 1, visible_role_ids: [], is_active: true,
  created_at: "", updated_at: "",
  fields: [field("ten", "Tên", "text", { is_title: true }), field("gia_goc", "Giá gốc", "currency"), field("uu_dai", "Ưu đãi", "percent"), field("bat_dau", "Bắt đầu", "date")],
} as CustomObjectDef

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  get.mockReset(); post.mockReset(); patch.mockReset()
  get.mockImplementation(async (url: string) => (url === "/custom-objects" ? { data: [] } : { data: [] }))
})
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("Cài đặt › Tính năng — khu 'Tính năng tuỳ biến'", () => {
  it("chỉ hiện với custom_objects.manage; không có quyền thì không gọi API tuỳ biến", async () => {
    useAuthStore.setState({ permissions: { "settings.features": "all" } as never })
    const { unmount } = wrap(<SettingsFeatures />)
    expect(screen.queryByText("Tính năng tuỳ biến")).toBeNull()
    await new Promise((r) => setTimeout(r, 30))
    expect(get.mock.calls.some((c) => String(c[0]).includes("custom-objects"))).toBe(false)
    unmount()
    useAuthStore.setState({ permissions: { "settings.features": "all", "custom_objects.manage": "all" } as never })
    wrap(<SettingsFeatures />)
    expect(await screen.findByText("Tính năng tuỳ biến")).toBeTruthy()
    expect(await screen.findByText(/Chưa có tính năng tuỳ biến nào/)).toBeTruthy()
  })

  it("Thêm tính năng: mã tự sinh từ tên (bỏ dấu), gửi đúng payload", async () => {
    useAuthStore.setState({ permissions: { "settings.features": "all", "custom_objects.manage": "all", "roles.manage": "all" } as never })
    post.mockResolvedValue({ data: { ...OBJ, key: "khach_hang", label: "Khách hàng", label_plural: "Khách hàng" } })
    wrap(<SettingsFeatures />)
    fireEvent.click(await screen.findByRole("button", { name: /Thêm tính năng/ }))
    const name = await screen.findByLabelText(/Tên \(số ít\)/)
    fireEvent.change(name, { target: { value: "Khách hàng" } })
    expect((screen.getByLabelText(/Mã \(địa chỉ/) as HTMLInputElement).value).toBe("khach_hang")
    expect((screen.getByLabelText(/Tên \(số nhiều\)/) as HTMLInputElement).value).toBe("Khách hàng")
    fireEvent.click(screen.getAllByRole("button", { name: "Thêm tính năng" }).at(-1)!)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toBe("/custom-objects")
    expect(post.mock.calls[0][1]).toMatchObject({ key: "khach_hang", label: "Khách hàng", label_plural: "Khách hàng", show_in_nav: true, visible_role_ids: [], icon: "shapes" })
  })
})

describe("FieldFormDialog", () => {
  it("sửa trường 'Chọn một': giữ nguyên MÃ lựa chọn cũ khi đổi tên hiển thị; lựa chọn mới để BE sinh mã", async () => {
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all" } as never })
    patch.mockResolvedValue({ data: {} })
    const sel = field("tt", "Tình trạng", "select", { options: { choices: [{ value: "hoc", label: "Đang học" }, { value: "nghi", label: "Tạm nghỉ" }] } })
    wrap(<FieldFormDialog open onOpenChange={vi.fn()} object={{ ...OBJ, fields: [...OBJ.fields, sel] }} field={sel} />)
    const first = await screen.findByLabelText("Tên lựa chọn 1")
    fireEvent.change(first, { target: { value: "Đang học tập" } })
    fireEvent.click(screen.getByRole("button", { name: /Thêm lựa chọn/ }))
    fireEvent.change(screen.getByLabelText("Tên lựa chọn 3"), { target: { value: "Đã kết thúc" } })
    fireEvent.click(screen.getByRole("button", { name: "Lưu trường" }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0][0]).toBe("/custom-objects/khoa_hoc/fields/tt")
    const body = patch.mock.calls[0][1] as { options: { choices: { value?: string; label: string }[] }; type: string }
    expect(body.type).toBe("select")
    expect(body.options.choices).toEqual([
      { value: "hoc", label: "Đang học tập" },
      { value: "nghi", label: "Tạm nghỉ" },
      { value: undefined, label: "Đã kết thúc" },
    ])
  })

  it("mã trường không sửa được; trường công thức hiện bộ soạn biểu thức", async () => {
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all" } as never })
    const fm = field("thanh_toan", "Thanh toán", "formula", { options: { expression: "{gia_goc}*(1-{uu_dai})", format: "currency" } })
    wrap(<FieldFormDialog open onOpenChange={vi.fn()} object={{ ...OBJ, fields: [...OBJ.fields, fm] }} field={fm} />)
    expect((await screen.findByLabelText("Mã trường") as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText("Biểu thức công thức") as HTMLTextAreaElement).value).toBe("{gia_goc}*(1-{uu_dai})")
    expect(screen.queryByText("Bắt buộc")).toBeNull() // công thức tự tính: không bắt buộc / không trùng
  })
})

describe("FieldFormDialog — cờ chỉ gửi khi kiểu cho phép (BE từ chối cờ sai kiểu bằng 400)", () => {
  it("trường đầu tiên mặc định 'làm tiêu đề' nhưng kiểu Tiền không làm tiêu đề được → KHÔNG gửi is_title/is_unique/required sai", async () => {
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all" } as never })
    post.mockResolvedValue({ data: {} })
    const empty = { ...OBJ, fields: [] }
    wrap(<FieldFormDialog open onOpenChange={vi.fn()} object={empty} />)
    fireEvent.change(await screen.findByLabelText("Tên trường *"), { target: { value: "Giá" } })
    // đổi kiểu → Tiền (Select Base-UI): mở danh sách và chọn
    fireEvent.click(screen.getByRole("combobox", { name: "Kiểu dữ liệu" }))
    const opt = await screen.findByRole("option", { name: "Tiền (VNĐ)" })
    fireEvent.pointerEnter(opt); fireEvent.pointerMove(opt); fireEvent.mouseMove(opt) // Base UI chỉ chọn sau khi con trỏ "đi vào" mục (jsdom không tự làm)
    fireEvent.click(opt)
    fireEvent.click(screen.getByRole("button", { name: "Thêm trường" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][1]).toMatchObject({ type: "currency", is_title: false, is_unique: false, required: false })
  })
})

describe("FormulaEditor", () => {
  it("chèn trường bằng nút bấm; 'Tính thử' gọi BE với giá trị mẫu và hiện kết quả / lỗi", async () => {
    let expr = ""
    const { rerender } = wrap(<FormulaEditor objectKey="khoa_hoc" fields={OBJ.fields} expression={expr} onChange={(v) => { expr = v }} />)
    fireEvent.click(screen.getByRole("button", { name: "Giá gốc" }))
    expect(expr).toBe("{gia_goc}")
    const qc = new QueryClient()
    rerender(<QueryClientProvider client={qc}><FormulaEditor objectKey="khoa_hoc" fields={OBJ.fields} expression="{gia_goc}*(1-{uu_dai})" onChange={vi.fn()} /></QueryClientProvider>)
    fireEvent.change(screen.getByLabelText(/Giá gốc/), { target: { value: "9600000" } })
    fireEvent.change(screen.getByLabelText(/Ưu đãi/), { target: { value: "5" } })
    post.mockResolvedValueOnce({ data: { ok: true, result: 9120000 } })
    fireEvent.click(screen.getByRole("button", { name: /Tính thử/ }))
    expect(await screen.findByText(/9\.120\.000/)).toBeTruthy()
    expect(post.mock.calls[0][0]).toBe("/custom-objects/formula/preview")
    expect(post.mock.calls[0][1]).toMatchObject({ object_key: "khoa_hoc", expression: "{gia_goc}*(1-{uu_dai})", sample: { gia_goc: 9600000, uu_dai: 5 } })
    post.mockResolvedValueOnce({ data: { ok: false, error: "Công thức: Hàm không được hỗ trợ: eval" } })
    fireEvent.click(screen.getByRole("button", { name: /Tính thử/ }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText(/Hàm không được hỗ trợ/)).toBeTruthy()
  })
})

describe("TemplateDialog — Dùng mẫu theo ngành", () => {
  const TPL = [{ key: "education_center", label: "Trung tâm giáo dục", description: "Phụ huynh, Khách hàng…", objects: [{ key: "phu_huynh", label: "Phụ huynh", applied: true }, { key: "khach_hang", label: "Khách hàng", applied: false }] }]

  it("liệt kê tính năng của mẫu (đã có / sẽ tạo); mặc định KHÔNG kèm dữ liệu mẫu; áp mẫu gọi đúng endpoint", async () => {
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all", "custom_records.manage": "all" } as never })
    get.mockImplementation(async (url: string) => (url === "/custom-objects/templates" ? { data: TPL } : { data: [] }))
    post.mockResolvedValue({ data: { created: ["khach_hang"], existing: ["phu_huynh"], sample_records: 0 } })
    const onOpenChange = vi.fn()
    wrap(<TemplateDialog open onOpenChange={onOpenChange} />)
    expect(await screen.findByText("Đã có")).toBeTruthy()
    expect(screen.getByText("Sẽ tạo")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Áp mẫu" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toBe("/custom-objects/templates/education_center/apply")
    expect(post.mock.calls[0][1]).toEqual({ with_sample_data: false })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("bật 'Kèm dữ liệu mẫu' → gửi with_sample_data=true; thiếu custom_records.manage → công tắc khoá và KHÔNG gửi true", async () => {
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all", "custom_records.manage": "all" } as never })
    get.mockImplementation(async (url: string) => (url === "/custom-objects/templates" ? { data: TPL } : { data: [] }))
    post.mockResolvedValue({ data: { created: [], existing: [], sample_records: 0 } })
    const first = wrap(<TemplateDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole("switch", { name: "Kèm dữ liệu mẫu" }))
    fireEvent.click(screen.getByRole("button", { name: "Áp mẫu" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][1]).toEqual({ with_sample_data: true })
    first.unmount()
    post.mockClear()
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all" } as never })
    wrap(<TemplateDialog open onOpenChange={vi.fn()} />)
    const sw = await screen.findByRole("switch", { name: "Kèm dữ liệu mẫu" })
    expect((sw as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Áp mẫu" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][1]).toEqual({ with_sample_data: false })
  })
  it("chọn mẫu thứ hai trong danh sách → áp đúng khoá mẫu đó", async () => {
    useAuthStore.setState({ permissions: { "custom_objects.manage": "all", "custom_records.manage": "all" } as never })
    const two = [...TPL, { key: "clinic", label: "Phòng khám (nha khoa / thú y)", description: "Bệnh nhân, Lịch hẹn, Điều trị", objects: [{ key: "pk_benh_nhan", label: "Bệnh nhân", applied: false }] }]
    get.mockImplementation(async (url: string) => (url === "/custom-objects/templates" ? { data: two } : { data: [] }))
    post.mockResolvedValue({ data: { created: ["pk_benh_nhan"], existing: [], sample_records: 0 } })
    wrap(<TemplateDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole("radio", { name: /Phòng khám/ }))
    expect(screen.getByText("Bệnh nhân, Lịch hẹn, Điều trị")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Áp mẫu" }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toBe("/custom-objects/templates/clinic/apply")
  })
})
