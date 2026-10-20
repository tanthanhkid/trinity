import { describe, expect, it } from "vitest"
import { indexFromMidpoints, nearestColumn, neighboursAt } from "@/lib/board-drag-target"

describe("board-drag-target", () => {
  it("vị trí chèn = số thẻ có tâm nằm trên con trỏ", () => {
    const mids = [40, 140, 240]
    expect(indexFromMidpoints(mids, 0)).toBe(0)
    expect(indexFromMidpoints(mids, 41)).toBe(1)
    expect(indexFromMidpoints(mids, 239)).toBe(2)
    expect(indexFromMidpoints(mids, 999)).toBe(3)
    expect(indexFromMidpoints([], 50)).toBe(0)
  })

  it("chọn cột chứa con trỏ, đứng giữa hai cột thì lấy cột gần hơn", () => {
    const cols = [
      { key: "1", left: 0, right: 280 },
      { key: "2", left: 292, right: 572 },
    ]
    expect(nearestColumn(cols, 100)).toBe("1")
    expect(nearestColumn(cols, 300)).toBe("2")
    expect(nearestColumn(cols, 284)).toBe("1")
    expect(nearestColumn(cols, 290)).toBe("2")
    expect(nearestColumn(cols, 9999)).toBe("2")
    expect(nearestColumn([], 10)).toBeNull()
  })

  it("thẻ trước/sau vị trí chèn", () => {
    const snap = { ids: ["7", "8", "9"], mids: [1, 2, 3] }
    expect(neighboursAt(snap, 0)).toEqual({ prev: undefined, next: "7" })
    expect(neighboursAt(snap, 2)).toEqual({ prev: "8", next: "9" })
    expect(neighboursAt(snap, 3)).toEqual({ prev: "9", next: undefined })
  })
})
