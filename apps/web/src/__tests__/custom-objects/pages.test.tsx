/**
 * Thực thể tuỳ biến — màn danh sách + form tạo bản ghi (render thật, API giả):
 * cổng quyền (0 request khi thiếu), nhãn select, liên kết ngoài phạm vi KHÔNG lộ tiêu đề, SĐT hiển thị đúng như BE trả
 * (FE không tự che/không tự mở), phân trang theo trang, sắp xếp/tìm → tham số, form: bắt buộc / payload / lỗi theo trường.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { CustomObjectDef, CustomRecord } from "@/types/custom-objects"

const get = vi.fn()
const post = vi.fn()
const push = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (_e: unknown, fb: string) => fb,
}))
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ isLoading: false }) }))
vi.mock("next/navigation", () => ({
  useParams: () => ({ objectKey: "khach_hang" }),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/x/khach_hang",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next/link", () => ({
  default: ({ href, children, className, onClick }: { href: string; children: ReactNode; className?: string; onClick?: (e: unknown) => void }) => (
    <a href={href} className={className} onClick={onClick}>{children}</a>
  ),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { useAuthStore } from "@/store/auth"
import ListPage from "@/app/(dashboard)/x/[objectKey]/page"
import NewPage from "@/app/(dashboard)/x/[objectKey]/new/page"

const INITIAL = useAuthStore.getState()
const f = (key: string, label: string, type: string, extra: Record<string, unknown> = {}) => ({
  id: key.length, key, label, type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: {}, help_text: null, ...extra,
})
const DEF: CustomObjectDef = {
  id: 1, key: "khach_hang", label: "Khách mới", label_plural: "Khách mới", icon: "graduation-cap", description: null, show_in_nav: true, nav_order: 1,
  visible_role_ids: [], is_active: true, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z",
  fields: [
    f("ten", "Họ tên", "text", { is_title: true, required: true }),
    f("tt", "Tình trạng", "select", { options: { choices: [{ value: "hoc", label: "Đang học", color: "green" }] } }),
    f("sdt", "SĐT phụ huynh", "phone"),
    f("diem", "Điểm", "number"),
    f("ph", "Phụ huynh", "relation", { options: { target_object_id: 2, target_key: "phu_huynh" } }),
  ],
} as unknown as CustomObjectDef

const rec = (id: number, over: Partial<CustomRecord> = {}): CustomRecord => ({
  id, title: `Bạn ${id}`, owner_id: 1, owner_name: "Trần Thị B", created_by: 1, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-02-01T03:00:00Z",
  data: { ten: `Bạn ${id}`, tt: "hoc", sdt: "***123", diem: 9, ph: 9 },
  relations: { ph: { id: 9, title: null, accessible: false } }, ...over,
})

function routeApi(pages: { items: CustomRecord[]; next_cursor: string | null; total: number | null }[]) {
  let call = 0
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/custom-objects/khach_hang")) return { data: DEF }
    if (url.endsWith("/records")) return { data: pages[Math.min(call++, pages.length - 1)] }
    if (url.includes("/lookup")) return { data: [] }
    return { data: [] }
  })
}
function renderPage(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}
const recordCalls = () => get.mock.calls.filter((c) => String(c[0]).endsWith("/records"))

beforeEach(() => { get.mockReset(); post.mockReset(); push.mockReset() })
afterEach(() => { useAuthStore.setState(INITIAL, true) })

describe("/x/[objectKey] — danh sách", () => {
  it("thiếu custom_records.view → Forbidden và 0 request", async () => {
    useAuthStore.setState({ permissions: { "contacts.view": "all" } as never })
    routeApi([{ items: [], next_cursor: null, total: 0 }])
    renderPage(<ListPage />)
    expect(screen.getByText(/không có quyền/i)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 40))
    expect(get).not.toHaveBeenCalled()
  })

  it("hiện bảng: tiêu đề là liên kết, select hiện NHÃN (không phải mã), liên kết ngoài phạm vi 'Không xem được', SĐT như BE trả", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all", "custom_records.manage": "all" } as never })
    routeApi([{ items: [rec(1), rec(2)], next_cursor: null, total: 2 }])
    renderPage(<ListPage />)
    await waitFor(() => expect(screen.getAllByText("Bạn 1").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Đang học").length).toBeGreaterThan(0)
    expect(screen.queryByText("hoc")).toBeNull()
    expect(screen.getAllByText("Không xem được").length).toBeGreaterThan(0)
    expect(screen.getAllByText("***123").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Trần Thị B").length).toBeGreaterThan(0)
    const link = screen.getAllByRole("link", { name: "Bạn 1" })[0] as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/x/khach_hang/1")
    // nút chính 'Thêm' chỉ khi có quyền manage
    expect(screen.getAllByRole("link", { name: /Thêm khách mới/i })[0].getAttribute("href")).toBe("/x/khach_hang/new")
    expect(screen.queryByRole("button", { name: /Xuất CSV/ })).toBeNull()
  })

  it("không có manage → không có nút Thêm; có export → có Xuất CSV", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "own", "custom_records.export": "own" } as never })
    routeApi([{ items: [rec(1)], next_cursor: null, total: 1 }])
    renderPage(<ListPage />)
    await waitFor(() => expect(screen.getAllByText("Bạn 1").length).toBeGreaterThan(0))
    expect(screen.queryByRole("link", { name: /Thêm khách mới/i })).toBeNull()
    expect(screen.getByRole("button", { name: /Xuất CSV/ })).toBeTruthy()
  })

  it("phân trang: hiện tổng + Trang 1/2; Sau → gọi lại với page=2; Trước bị khoá ở trang 1; hết trang thì khoá Sau", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    get.mockImplementation(async (url: string, cfg?: { params?: { page?: number; limit?: number } }) => {
      if (url.endsWith("/custom-objects/khach_hang")) return { data: DEF }
      if (url.endsWith("/records")) return { data: { items: [rec(cfg?.params?.page === 2 ? 21 : 1)], next_cursor: null, total: 25 } }
      return { data: [] }
    })
    renderPage(<ListPage />)
    expect(await screen.findByText(/Trang 1\/2/)).toBeTruthy()
    expect(screen.getByText(/Đang hiện 1–1 \/ 25/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Trang trước" }) as HTMLButtonElement).disabled).toBe(true)
    expect(recordCalls()[0][1]).toMatchObject({ params: { page: 1, limit: 20 } })
    fireEvent.click(screen.getByRole("button", { name: "Trang sau" }))
    await waitFor(() => expect(screen.getAllByText("Bạn 21").length).toBeGreaterThan(0))
    expect(recordCalls().at(-1)![1]).toMatchObject({ params: { page: 2, limit: 20 } })
    expect(screen.getByText(/Trang 2\/2/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Trang sau" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("đổi số bản ghi mỗi trang → limit mới và về trang 1", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    routeApi([{ items: [rec(1)], next_cursor: null, total: 120 }])
    renderPage(<ListPage />)
    const sel = await screen.findByLabelText("Số bản ghi mỗi trang")
    fireEvent.change(sel, { target: { value: "50" } })
    await waitFor(() => expect(recordCalls().at(-1)![1]).toMatchObject({ params: { page: 1, limit: 50 } }))
  })

  it("bấm tiêu đề cột sắp xếp được → gửi sort=field:<khoá>; SĐT KHÔNG có nút sắp xếp (chống dò)", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    routeApi([{ items: [rec(1)], next_cursor: null, total: 1 }])
    renderPage(<ListPage />)
    await waitFor(() => expect(screen.getAllByText("Bạn 1").length).toBeGreaterThan(0))
    expect(screen.queryByRole("button", { name: "SĐT phụ huynh" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Điểm" }))
    await waitFor(() => expect(recordCalls().length).toBeGreaterThan(1))
    const last = recordCalls().at(-1)![1] as { params: { sort?: string; dir?: string } }
    expect(last.params).toMatchObject({ sort: "field:diem", dir: "asc" })
  })

  it("rỗng → thông báo; thực thể 404 → 'Không tìm thấy tính năng này'", async () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    routeApi([{ items: [], next_cursor: null, total: 0 }])
    const { unmount } = renderPage(<ListPage />)
    await waitFor(() => expect(screen.getAllByText(/Chưa có khách mới nào/).length).toBeGreaterThan(0))
    unmount()
    get.mockReset()
    get.mockRejectedValue({ response: { status: 404 } })
    renderPage(<ListPage />)
    expect(await screen.findByText(/Không tìm thấy tính năng này/)).toBeTruthy()
  })
})

describe("/x/[objectKey]/new — form sinh từ định nghĩa", () => {
  beforeEach(() => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all", "custom_records.manage": "all" } as never })
    get.mockImplementation(async (url: string) => (url.endsWith("/custom-objects/khach_hang") ? { data: DEF } : { data: [] }))
  })

  it("thiếu custom_records.manage → Forbidden", () => {
    useAuthStore.setState({ permissions: { "custom_records.view": "all" } as never })
    renderPage(<NewPage />)
    expect(screen.getByText(/không có quyền/i)).toBeTruthy()
  })

  it("thiếu trường bắt buộc → báo lỗi dưới ô, KHÔNG gửi API", async () => {
    renderPage(<NewPage />)
    await screen.findByLabelText(/Họ tên/)
    fireEvent.click(screen.getByRole("button", { name: /Lưu khách mới/ }))
    expect(await screen.findByText("“Họ tên” là bắt buộc")).toBeTruthy()
    expect(post).not.toHaveBeenCalled()
  })

  it("gửi chỉ trường có giá trị (số là number); thành công → đóng form, về DANH SÁCH", async () => {
    post.mockResolvedValue({ data: rec(55) })
    renderPage(<NewPage />)
    fireEvent.change(await screen.findByLabelText(/Họ tên/), { target: { value: "Khách mới Mẫu 01" } })
    fireEvent.change(screen.getByLabelText("Điểm"), { target: { value: "8.5" } })
    fireEvent.click(screen.getByRole("button", { name: /Lưu khách mới/ }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toBe("/custom-objects/khach_hang/records")
    expect(post.mock.calls[0][1]).toEqual({ data: { ten: "Khách mới Mẫu 01", diem: 8.5 } })
    await waitFor(() => expect(push).toHaveBeenCalledWith("/x/khach_hang"))
  })

  it("thẻ chứa form KHÔNG cắt (overflow-visible) để dropdown Người phụ trách không bị che; dropdown nổi trên thanh Lưu (z-50)", async () => {
    renderPage(<NewPage />)
    await screen.findByLabelText(/Họ tên/)
    const card = document.querySelector('form [data-slot="card"]') as HTMLElement
    expect(card.className).toContain("overflow-visible")
    expect(card.className).not.toContain("overflow-hidden")
    fireEvent.click(screen.getByLabelText("Người phụ trách"))
    const box = (await screen.findByLabelText("Tìm")).parentElement as HTMLElement
    expect(box.className).toContain("z-50")
  })

  it("lỗi theo trường của BE hiện đúng dưới ô tương ứng", async () => {
    post.mockRejectedValue({ response: { status: 400, data: { message: "Dữ liệu không hợp lệ", errors: { sdt: "“SĐT phụ huynh” phải là số điện thoại Việt Nam" } } } })
    renderPage(<NewPage />)
    fireEvent.change(await screen.findByLabelText(/Họ tên/), { target: { value: "A" } })
    fireEvent.change(screen.getByLabelText("SĐT phụ huynh"), { target: { value: "123" } })
    fireEvent.click(screen.getByRole("button", { name: /Lưu khách mới/ }))
    expect(await screen.findByText(/phải là số điện thoại Việt Nam/)).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
  })
})
