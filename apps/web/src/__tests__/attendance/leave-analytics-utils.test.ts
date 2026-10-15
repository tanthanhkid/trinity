import { describe, it, expect } from "vitest"
import {
  LEAVE_TYPE_COLORS,
  GENDER_COLORS,
  departmentColor,
  leaveTypeColor,
  lighten,
  darken,
  polarToXY,
  donutSlicePath,
  labelLineGeometry,
  DEPARTMENT_PALETTE,
} from "@/app/(dashboard)/attendance/_components/leave-analytics-utils"
import { categoryColor, CHART_NEUTRAL } from "@/components/app-shell/charts/chart-colors"

/*
 * Bảng màu lấy từ TOKEN biểu đồ (`components/app-shell/charts/chart-colors`), không
 * còn hex cứng — nên test đối chiếu với chính hàm token thay vì chép lại giá
 * trị. Chép hex vào đây là dựng nguồn sự thật thứ hai: đổi token thì test vẫn
 * xanh trong khi màn hình đã đổi màu.
 */
describe("bảng màu cố định", () => {
  it("đủ 6 loại đơn + 3 giới tính, lấy từ token biểu đồ", () => {
    expect(Object.keys(LEAVE_TYPE_COLORS)).toHaveLength(6)
    expect(LEAVE_TYPE_COLORS.leave).toBe(categoryColor(4))
    expect(GENDER_COLORS.M).toBe(categoryColor(2))
    expect(GENDER_COLORS.F).toBe(categoryColor(5))
    expect(GENDER_COLORS.unknown).toBe(CHART_NEUTRAL)
  })

  it("leaveTypeColor fallback màu trung tính cho loại lạ", () => {
    expect(leaveTypeColor("maternity")).toBe(categoryColor(5))
    expect(leaveTypeColor("khong_ton_tai")).toBe(CHART_NEUTRAL)
  })

  it("departmentColor xoay vòng theo đúng độ dài palette", () => {
    expect(DEPARTMENT_PALETTE.length).toBeGreaterThan(1)
    expect(departmentColor(0)).toBe(departmentColor(DEPARTMENT_PALETTE.length))
    expect(departmentColor(1)).not.toBe(departmentColor(0))
  })
})

describe("lighten / darken", () => {
  it("lighten tiến về trắng, darken tiến về đen, giữ format #rrggbb", () => {
    expect(lighten("#000000", 1)).toBe("#ffffff")
    expect(darken("#ffffff", 1)).toBe("#000000")
    expect(lighten("#3B82F6", 0)).toBe("#3b82f6")
    expect(/^#[0-9a-f]{6}$/.test(lighten("#EC4899", 0.3))).toBe(true)
  })
})

describe("hình học donut", () => {
  it("polarToXY: 0 = đỉnh (12h), 0.25 = phải (3h)", () => {
    const top = polarToXY(100, 100, 50, 0)
    expect(top.x).toBeCloseTo(100, 5)
    expect(top.y).toBeCloseTo(50, 5)
    const right = polarToXY(100, 100, 50, 0.25)
    expect(right.x).toBeCloseTo(150, 5)
    expect(right.y).toBeCloseTo(100, 5)
  })

  it("donutSlicePath: một lát 100% không suy biến thành điểm (cung đầu ≠ cung cuối)", () => {
    const d = donutSlicePath(100, 100, 80, 50, 0, 1)
    const m = /^M ([\d.-]+) ([\d.-]+) A \d+ \d+ 0 1 1 ([\d.-]+) ([\d.-]+)/.exec(d)
    expect(m).not.toBeNull()
    expect(`${m![1]} ${m![2]}`).not.toBe(`${m![3]} ${m![4]}`)
  })

  it("donutSlicePath trả path hợp lệ (M/A/L/Z)", () => {
    const d = donutSlicePath(100, 100, 80, 50, 0, 0.5)
    expect(d.startsWith("M ")).toBe(true)
    expect(d).toContain("A 80 80")
    expect(d).toContain("A 50 50")
    expect(d.endsWith("Z")).toBe(true)
  })

  it("labelLineGeometry: nửa phải neo 'start', nửa trái neo 'end'", () => {
    const right = labelLineGeometry(100, 100, 80, 0.1) // ~36° → bên phải
    expect(right.anchor).toBe("start")
    expect(right.textX).toBeGreaterThan(100)
    const left = labelLineGeometry(100, 100, 80, 0.65) // ~234° → bên trái
    expect(left.anchor).toBe("end")
    expect(left.textX).toBeLessThan(100)
  })
})
