/** Kiểu xem Lịch + Bảng cho bảng tuỳ biến: lưới tháng/tuần giờ VN, lọc đúng khoảng, sửa nhanh tại ô. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { CustomObjectDef, CustomViewDef } from "@/types/custom-objects"
import { addMonths, dayOf, monthGrid, rangeFilter, startOfWeek, timeOf, visibleRange } from "@/lib/custom-objects/calendar"

const get = vi.fn()
const patch = vi.fn()
vi.mock("@/lib/api-client", () => ({ default: { get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patch(...a) }, getApiErrorMessage: (_e: unknown, fb: string) => fb }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/x/lich_hen/v/lich" }))
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => <a href={href} {...rest}>{children}</a> }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/format", async (orig) => ({ ...(await orig<typeof import("@/lib/format")>()), todayVn: () => "2026-10-08" }))
vi.mock("@/lib/rbac", () => ({ usePermissions: () => ({ can: () => true }) }))

import { CustomCalendarView } from "@/components/custom-objects/custom-calendar-view"
import { CustomTableView } from "@/components/custom-objects/custom-table-view"

const F = (key: string, label: string, type: string, extra: Record<string, unknown> = {}) => ({ id: 1, key, label, type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: {}, help_text: null, ...extra })
const DEF = {
  id: 3, key: "lich_hen", label: "Lịch hẹn", label_plural: "Lịch hẹn", icon: null, description: null, show_in_nav: true, nav_order: 1, visible_role_ids: [], is_active: true, created_at: "", updated_at: "",
  fields: [F("ten", "Tên", "text", { is_title: true }), F("ngay", "Ngày hẹn", "datetime"), F("trang_thai", "Trạng thái", "select", { options: { choices: [{ value: "moi", label: "Mới" }, { value: "xong", label: "Xong" }] } })],
} as unknown as CustomObjectDef
const rec = (id: number, code: string, ten: string, ngay: string) => ({ id, code, title: ten, owner_id: 1, owner_name: null, created_by: 1, created_at: "", updated_at: "", data: { ten, ngay, trang_thai: "moi" }, relations: {} })
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

afterEach(() => { get.mockReset(); patch.mockReset() })

describe("lịch — phần thuần", () => {
  it("lưới tháng bắt đầu thứ Hai, phủ trọn tháng", () => {
    const g = monthGrid("2026-10-08")
    expect(g[0][0]).toBe("2026-09-28")
    expect(g.at(-1)?.at(-1)).toBe("2026-11-01")
    expect(startOfWeek("2026-10-11")).toBe("2026-10-05")
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01")
  })
  it("giờ VN: 2026-10-07T18:30Z là 01:30 ngày 08/10; khoảng lọc datetime lùi 7 giờ", () => {
    expect(dayOf("2026-10-07T18:30:00.000Z", "datetime")).toBe("2026-10-08")
    expect(timeOf("2026-10-07T18:30:00.000Z", "datetime")).toBe("01:30")
    const r = visibleRange("week", "2026-10-08")
    expect(r).toEqual({ from: "2026-10-05", to: "2026-10-11" })
    expect(rangeFilter("datetime", r)).toEqual({ from: "2026-10-04T17:00:00.000Z", to: "2026-10-11T16:59:59.999Z" })
    expect(rangeFilter("date", r)).toEqual(r)
  })
})

describe("kiểu xem Lịch", () => {
  const VIEW = { id: 1, key: "lich", object_key: "lich_hen", label: "Lịch hẹn", type: "calendar", config: { date_field: "ngay", mode: "month" }, icon: null, show_in_nav: true, nav_order: 1, href: "/x/lich_hen/v/lich" } as CustomViewDef
  it("đặt bản ghi đúng ngày (giờ VN), lọc BE theo khoảng đang xem, đổi tháng/tuần", async () => {
    get.mockImplementation(async (url: string) => (url.endsWith("/views") ? { data: [VIEW] } : { data: { items: [rec(1, "LH001", "Hẹn An", "2026-10-07T18:30:00.000Z"), rec(2, "LH002", "Khám Bình", "2026-10-20T02:00:00.000Z")], total: 2, next_cursor: null } }))
    wrap(<CustomCalendarView def={DEF} view={VIEW} />)
    expect(screen.getByTestId("calendar-title").textContent).toBe("Tháng 10/2026")
    await waitFor(() => expect(screen.getAllByTestId("calendar-entry")).toHaveLength(2))
    const day8 = document.querySelector("[data-day='2026-10-08']") as HTMLElement
    expect(day8.textContent).toContain("01:30")
    expect(day8.textContent).toContain("LH001")
    const call = get.mock.calls.find((c) => String(c[0]).endsWith("/records"))
    expect(JSON.parse(call?.[1].params.filter)).toEqual({ ngay: { from: "2026-09-27T17:00:00.000Z", to: "2026-11-01T16:59:59.999Z" } })
    expect(call?.[1].params).toMatchObject({ sort: "field:ngay", dir: "asc", limit: 100 })
    fireEvent.click(screen.getByRole("button", { name: "Tuần" }))
    expect(screen.getByTestId("calendar-title").textContent).toBe("Tuần 05/10/2026 – 11/10/2026")
    fireEvent.click(screen.getByRole("button", { name: "Tuần sau" }))
    expect(screen.getByTestId("calendar-title").textContent).toBe("Tuần 12/10/2026 – 18/10/2026")
  })
})

describe("kiểu xem Bảng — sửa nhanh tại ô", () => {
  const VIEW = { id: 2, key: "bang", object_key: "lich_hen", label: "Bảng lịch hẹn", type: "table", config: { columns: ["ten", "trang_thai"] }, icon: null, show_in_nav: false, nav_order: 2, href: "/x/lich_hen/v/bang" } as CustomViewDef
  it("bấm ô chữ → sửa → Enter lưu; ô lựa chọn lưu ngay khi chọn; Esc huỷ", async () => {
    get.mockImplementation(async (url: string) => (url.endsWith("/views") ? { data: [VIEW] } : { data: { items: [rec(1, "LH001", "Hẹn An", "2026-10-07T18:30:00.000Z")], total: 1, next_cursor: null } }))
    patch.mockResolvedValue({ data: rec(1, "LH001", "Hẹn An 2", "2026-10-07T18:30:00.000Z") })
    wrap(<CustomTableView def={DEF} view={VIEW} />)
    const cells = await screen.findAllByTestId("table-cell")
    fireEvent.click(cells[0])
    const input = screen.getByTestId("table-cell-editing").querySelector("input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "Hẹn An 2" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/custom-objects/lich_hen/records/1", { data: { ten: "Hẹn An 2" } }))
    fireEvent.click(screen.getAllByTestId("table-cell")[1])
    fireEvent.change(screen.getByRole("combobox", { name: "Trạng thái" }), { target: { value: "xong" } })
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith("/custom-objects/lich_hen/records/1", { data: { trang_thai: "xong" } }))
    fireEvent.click(screen.getAllByTestId("table-cell")[0])
    fireEvent.keyDown(screen.getByTestId("table-cell-editing"), { key: "Escape" })
    expect(screen.queryByTestId("table-cell-editing")).toBeNull()
    expect(patch).toHaveBeenCalledTimes(2)
  })
})
