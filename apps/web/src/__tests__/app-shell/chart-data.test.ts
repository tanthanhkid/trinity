import { describe, it, expect } from "vitest"
import {
  takeTopWithOther,
  withCategoryColors,
  withSequentialColors,
  CHART_PALETTE,
  CHART_SEQ,
} from "@/components/app-shell/charts/chart-data"
import { niceCeil, niceTicks } from "@/components/app-shell/charts/bar-h"

/**
 * Khoá phần SỐ của biểu đồ v2. Phần dễ sai của một biểu đồ là
 * dữ liệu, không phải SVG — nên tầng thuần này tách riêng để test được mà
 * không cần render.
 */
describe("v2 chart — gộp lát và gán màu", () => {
  it("≤4 lát thì giữ nguyên, chỉ sắp xếp giảm dần", () => {
    const out = takeTopWithOther([
      { label: "A", value: 3 },
      { label: "B", value: 9 },
    ])
    expect(out.map((o) => o.label)).toEqual(["B", "A"])
  })

  it("🔴 >4 lát thì gộp đuôi thành 'Khác' — ràng buộc của bảng màu, không phải thẩm mỹ", () => {
    // Bộ 6 màu chỉ đảm bảo phân biệt được với người mù màu ở 4 màu đầu,
    // nên quá 4 lát thì gộp phần đuôi thành "Khác".
    const out = takeTopWithOther([
      { label: "A", value: 10 },
      { label: "B", value: 9 },
      { label: "C", value: 8 },
      { label: "D", value: 7 },
      { label: "E", value: 6 },
      { label: "F", value: 5 },
    ])
    expect(out).toHaveLength(5)
    expect(out[4]).toEqual({ label: "Khác", value: 11 })
  })

  it("đuôi toàn 0 thì KHÔNG đẻ ra lát 'Khác' rỗng trong chú giải", () => {
    const out = takeTopWithOther([
      { label: "A", value: 4 },
      { label: "B", value: 3 },
      { label: "C", value: 2 },
      { label: "D", value: 1 },
      { label: "E", value: 0 },
    ])
    expect(out.map((o) => o.label)).not.toContain("Khác")
  })

  it("màu danh mục gán ĐÚNG THỨ TỰ bảng màu, không xoay vòng", () => {
    const out = withCategoryColors([
      { label: "A", value: 1 },
      { label: "B", value: 1 },
    ])
    expect(out[0].color).toBe(CHART_PALETTE[0])
    expect(out[1].color).toBe(CHART_PALETTE[1])
  })

  it("vượt số màu sẵn có thì kẹp ở màu cuối — KHÔNG quay lại màu đầu (2 lát cùng màu là đọc sai)", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: 1 }))
    const cat = withCategoryColors(many)
    expect(cat[8].color).toBe(CHART_PALETTE[CHART_PALETTE.length - 1])
    const seq = withSequentialColors(many)
    expect(seq[8].color).toBe(CHART_SEQ[CHART_SEQ.length - 1])
  })
})

describe("v2 chart — cận trên trục", () => {
  it.each([
    [[3], 5],
    [[12], 20],
    [[42], 50],
    [[87], 100],
    [[1234], 2000],
  ])("niceCeil(%j) = %i", (values, expected) => {
    expect(niceCeil(values)).toBe(expected)
  })

  it("mảng rỗng / toàn 0 / giá trị không hợp lệ → 1 (không chia cho 0)", () => {
    expect(niceCeil([])).toBe(1)
    expect(niceCeil([0, 0])).toBe(1)
    expect(niceCeil([Number.NaN, Number.POSITIVE_INFINITY])).toBe(1)
  })

  it("🔴 chịu được mảng cỡ lớn — KHÔNG dùng Math.max(...mảng)", () => {
    // Bảng cỡ triệu dòng là có thật; helper này dễ bị copy sang
    // chỗ đếm theo dòng nên khoá quy mô ngay từ đầu thay vì "đủ thấy logic".
    const big = new Array(500_000).fill(7)
    big[499_999] = 91
    expect(niceCeil(big)).toBe(100)
  })
})

describe("v2 chart — mốc trục KHÔNG được trùng nhau", () => {
  /**
   * Bản đầu chia `max/(ticks-1)` rồi `Math.round` từng mốc ⇒ với max nhỏ in ra
   * "0 | 0 | 1 | 1 | 1". Ca đó KHÔNG hiếm: mỗi bước chỉ có ≤2 deal, "Lý do
   * thất bại" thường 1–5 deal.
   */
  it.each([
    [1, [0, 1]],
    [2, [0, 1, 2]],
    [5, [0, 1, 2, 3, 4, 5].slice(0, 5)],
    [20, [0, 5, 10, 15, 20]],
    [50, [0, 12.5, 25, 37.5, 50].filter(Number.isInteger)],
  ])("niceTicks(%i) cho bước nguyên", (max) => {
    const ticks = niceTicks(max)
    // mọi mốc là số nguyên và tăng nghiêm ngặt ⇒ không thể trùng sau khi in
    expect(ticks.every(Number.isInteger)).toBe(true)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBe(max)
  })

  it("mọi cận trên `niceCeil` có thể sinh ra đều cho mốc nguyên", () => {
    // niceCeil chỉ trả 1/2/5 × 10^n — quét đủ dải dùng thật (đếm bản ghi → tiền).
    for (const pow of [1, 10, 100, 1000, 10000, 100000, 1000000]) {
      for (const base of [1, 2, 5]) {
        const max = base * pow
        const ticks = niceTicks(max)
        expect(ticks.every(Number.isInteger), `max=${max} → ${ticks.join(",")}`).toBe(true)
        expect(new Set(ticks).size).toBe(ticks.length)
      }
    }
  })

  it("max = 0 → chỉ 1 mốc, không chia cho 0", () => {
    expect(niceTicks(0)).toEqual([0])
  })
})
