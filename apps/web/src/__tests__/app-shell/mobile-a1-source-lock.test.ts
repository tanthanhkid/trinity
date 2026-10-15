import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const read = (p: string) => readFileSync(join(__dirname, "../../app", p), "utf8")

/** Khoá mã nguồn các sửa điện thoại. */
describe("điện thoại — Tổng quan / Báo cáo / Đăng nhập", () => {
  it("Tổng quan: bộ lọc nằm trong MobileFilterSheet, chip tab biểu đồ cuộn ngang 44px", () => {
    expect(read("(dashboard)/dashboard/_components/dashboard-overview-filter.tsx")).toContain("<MobileFilterSheet")
    const chart = read("(dashboard)/dashboard/_components/dashboard-overview-tabbed-chart.tsx")
    expect(chart).toContain("max-sm:flex-nowrap")
    expect(chart).toContain("max-sm:min-h-11")
  })
  it("Báo cáo: dải nhóm chủ đề 1 hàng cuộn ngang", () => {
    const page = read("(dashboard)/reports/page.tsx")
    expect(page).toContain("max-sm:flex-nowrap")
    expect(page).toContain("max-sm:min-h-11")
  })
  it("Đăng nhập: dùng dvh, không còn min-h-screen", () => {
    const src = read("login/page.tsx")
    expect(src).toContain("min-h-dvh")
    expect(src).not.toContain("min-h-screen")
  })
})
