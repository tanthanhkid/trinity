/**
 * Báo cáo tuỳ chỉnh (#25) — tab dùng chung cho mọi bảng (render thật, API giả): người xem không có nút cấu hình,
 * kỳ → tham số `period`, ô tổng + bảng nhóm; quản trị viên thêm báo cáo ⇒ PUT cả danh sách (giữ báo cáo cũ).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { periodValue, reportIdFromName } from "@/app/(dashboard)/reports/_components/custom/custom-report-types"

const get = vi.fn()
const put = vi.fn()
const post = vi.fn()
vi.mock("@/lib/api-client", () => ({
  default: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (_e: unknown, fb: string) => fb,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { ReportCustom } from "@/app/(dashboard)/reports/_components/custom/report-custom"

const DEF = { id: "thu_tien", name: "Thu tiền", source: "x:thanh_toan", date_field: "ngay_tt", sum_fields: ["so_tien"], group_by: "hinh_thuc" }
const RESULT = {
  report: DEF, period: { value: "this_month", label: "Tháng 10/2026" }, count: 3, sums: { so_tien: 2_500_000 }, missing_date: 0,
  groups: [{ key: "ck", label: "Chuyển khoản", count: 2, sums: { so_tien: 2_000_000 } }, { key: null, label: "(Trống)", count: 1, sums: { so_tien: 500_000 } }],
  by_month: [{ month: "2026-10", count: 3, sums: { so_tien: 2_500_000 } }],
  fields: { date: "Ngày thanh toán", sums: [{ key: "so_tien", label: "Số tiền" }], group: "Hình thức" },
}
const SOURCES = [{ source: "deals", label: "Deal", fields: [
  { key: "created_at", label: "Ngày tạo", role: "date" }, { key: "value", label: "Giá trị", role: "number" }, { key: "status", label: "Trạng thái", role: "group" },
] }]

function routes(canManage: boolean) {
  get.mockImplementation((url: string, cfg?: { params?: Record<string, string> }) => {
    if (url === "/reports/custom") return Promise.resolve({ data: { reports: [{ ...DEF, source_label: "Thanh toán" }], can_manage: canManage } })
    if (url === "/reports/custom/definitions") return Promise.resolve({ data: { reports: [DEF] } })
    if (url === "/reports/custom/sources") return Promise.resolve({ data: SOURCES })
    if (url === "/reports/custom/thu_tien") return Promise.resolve({ data: { ...RESULT, period: { value: cfg?.params?.period, label: "x" } } })
    return Promise.reject(new Error(url))
  })
}
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ReportCustom /></QueryClientProvider>)

afterEach(() => { get.mockReset(); put.mockReset(); post.mockReset() })

describe("Báo cáo tuỳ chỉnh", () => {
  it("người xem: số bản ghi, tổng cột, bảng nhóm; không có nút cấu hình; kỳ mặc định Tháng này", async () => {
    routes(false)
    wrap()
    expect(await screen.findByText("Chuyển khoản")).toBeTruthy()
    expect(screen.getByText("Tổng số tiền")).toBeTruthy()
    expect(screen.getByText((2_500_000).toLocaleString("vi-VN"))).toBeTruthy()
    expect(screen.getByText("(Trống)")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Thêm báo cáo|Sửa/ })).toBeNull()
    expect(get).toHaveBeenCalledWith("/reports/custom/thu_tien", { params: { period: "this_month" } })
  })

  it("quản trị viên thêm báo cáo ⇒ PUT danh sách cũ + báo cáo mới", async () => {
    routes(true)
    put.mockResolvedValue({ data: {} })
    wrap()
    fireEvent.click(await screen.findByRole("button", { name: /Thêm báo cáo/ }))
    fireEvent.change(await screen.findByLabelText("Tên báo cáo"), { target: { value: "Deal theo trạng thái" } })
    // Chọn bảng qua Select (base-ui): mở trigger rồi chọn mục.
    fireEvent.click(screen.getByRole("combobox", { name: "Bảng" }))
    fireEvent.click(await screen.findByRole("option", { name: "Deal" }))
    fireEvent.click(await screen.findByLabelText("Giá trị"))
    fireEvent.click(screen.getByRole("button", { name: "Lưu" }))
    await waitFor(() => expect(put).toHaveBeenCalled())
    expect(put.mock.calls[0][1]).toEqual({ reports: [DEF, {
      id: "deal_theo_trang_thai", name: "Deal theo trạng thái", source: "deals", date_field: "created_at", sum_fields: ["value"], group_by: null,
    }] })
  })

  it("không có báo cáo: người xem thấy lời nhắn, không có nút", async () => {
    get.mockResolvedValue({ data: { reports: [], can_manage: false } })
    wrap()
    expect(await screen.findByText(/chưa cấu hình báo cáo nào/)).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })
})

describe("Báo cáo mẫu", () => {
  it("quản trị viên chưa có báo cáo ⇒ mở Báo cáo mẫu, thấy báo cáo thiếu bảng, cài ⇒ POST đúng bộ", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/reports/custom") return Promise.resolve({ data: { reports: [], can_manage: true } })
      if (url === "/reports/custom/presets") return Promise.resolve({ data: [{ key: "giao_duc", name: "Trung tâm giáo dục", description: "d", reports: [
        { id: "thu_tien", name: "Thu tiền", source_label: "Thanh toán", installed: false, installable: true },
        { id: "phu_huynh_moi", name: "Phụ huynh mới", source_label: null, installed: false, installable: false },
      ] }] })
      return Promise.reject(new Error(url))
    })
    post.mockResolvedValue({ data: { installed: ["thu_tien"], skipped: [] } })
    wrap()
    fireEvent.click(await screen.findByRole("button", { name: /Dùng báo cáo mẫu/ }))
    expect(await screen.findByText("Chưa có bảng")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cài Trung tâm giáo dục" }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/reports/custom/presets/giao_duc/install"))
  })
})

describe("tiện ích", () => {
  it("kỳ và mã báo cáo", () => {
    expect(periodValue("month", "2026-09", "2026")).toBe("month:2026-09")
    expect(periodValue("year", "", "2025")).toBe("year:2025")
    expect(periodValue("all", "", "")).toBe("all")
    expect(periodValue("month", "", "")).toBe("this_month")
    expect(reportIdFromName("Thu tiền đợt 1", new Set(["thu_tien_dot_1"]))).toBe("thu_tien_dot_1_2")
    expect(reportIdFromName("2026 Học phí", new Set())).toBe("hoc_phi")
    expect(reportIdFromName("Sources", new Set())).toBe("sources_2")
  })
})
