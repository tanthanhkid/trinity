import { describe, it, expect } from "vitest"
import { computeDelta } from "@/app/(dashboard)/dashboard/_components/dashboard-stats-shared"

// thẻ Dashboard "Khách mới" hiện "+1000% so với hôm qua" vì
// computeDelta không cap % + mẫu số hôm qua quá nhỏ (=1). Fix (option C):
// - previous < 5  → hiển thị chênh lệch tuyệt đối ("+10" / "-3") thay %.
// - previous >= 5 → cap |%| ở 999 (">999%").
describe("computeDelta — cap % + small-base guard", () => {
  it("regression: (11, 1) → '+10' (KHÔNG phải '+1000%')", () => {
    expect(computeDelta(11, 1)).toEqual({ trend: "up", label: "+10" })
  })

  it("mẫu số nhỏ tăng: (7, 2) → '+5' (có dấu +)", () => {
    expect(computeDelta(7, 2)).toEqual({ trend: "up", label: "+5" })
  })

  it("mẫu số nhỏ giảm: (1, 3) → '-2' (trend down)", () => {
    expect(computeDelta(1, 3)).toEqual({ trend: "down", label: "-2" })
  })

  it("biên ngưỡng OFF: previous=4 (<5) → tuyệt đối: (10, 4) → '+6'", () => {
    expect(computeDelta(10, 4)).toEqual({ trend: "up", label: "+6" })
  })

  it("biên ngưỡng ON: previous=5 (>=5) → phần trăm: (10, 5) → '+100%'", () => {
    expect(computeDelta(10, 5)).toEqual({ trend: "up", label: "+100%" })
  })

  it("cur=0 mẫu số nhỏ: (0, 3) → '-3' (KHÔNG phải '0%')", () => {
    expect(computeDelta(0, 3)).toEqual({ trend: "down", label: "-3" })
  })

  it("cap dương: (110, 10) → pct=1000 > 999 → '+>999%'", () => {
    expect(computeDelta(110, 10)).toEqual({ trend: "up", label: "+>999%" })
  })

  it("KHÔNG cap khi pct=990: (109, 10) → '+990%'", () => {
    expect(computeDelta(109, 10)).toEqual({ trend: "up", label: "+990%" })
  })

  it("phần trăm thường: (120, 100) → '+20%'", () => {
    expect(computeDelta(120, 100)).toEqual({ trend: "up", label: "+20%" })
  })

  it("phần trăm giảm: (80, 100) → '-20%'", () => {
    expect(computeDelta(80, 100)).toEqual({ trend: "down", label: "-20%" })
  })

  // Edge cases CŨ — phải GIỮ NGUYÊN
  it("cả 2 = 0 → null (ẩn delta)", () => {
    expect(computeDelta(0, 0)).toBeNull()
  })

  it("prev=0 & cur>0 → { trend:'up', label:'Mới' }", () => {
    expect(computeDelta(5, 0)).toEqual({ trend: "up", label: "Mới" })
  })

  it("cur === prev (nhỏ) → '0%' (check bằng nhau TRƯỚC nhánh tuyệt đối)", () => {
    expect(computeDelta(3, 3)).toEqual({ trend: "flat", label: "0%" })
  })

  it("NaN/Infinity → coi như 0 (cả 2 = 0 → null)", () => {
    expect(computeDelta(Number.NaN, Number.NaN)).toBeNull()
  })
})
