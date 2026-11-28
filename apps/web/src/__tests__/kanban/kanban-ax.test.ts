/** Hàm thuần của giao diện «Ánh xanh» màn Công việc: hạn nhanh, chữ hạn, tông giai đoạn. */
import { describe, expect, it } from "vitest"
import { dueIsoFromPreset, dueMeta, matchDuePreset, stageToneForColumn, vnDayMonth, vnFullDue } from "@/lib/kanban-ax"

// 28/11/2026 10:00 giờ VN
const NOW = new Date("2026-11-28T03:00:00Z")

describe("hạn nhanh", () => {
  it("Hôm nay 17:00, Ngày mai 09:00, Tuần sau 09:00 (giờ VN), Bỏ hạn = null", () => {
    expect(vnFullDue(dueIsoFromPreset("today", NOW))).toBe("28/11/2026 17:00")
    expect(vnFullDue(dueIsoFromPreset("tomorrow", NOW))).toBe("29/11/2026 09:00")
    expect(vnFullDue(dueIsoFromPreset("nextweek", NOW))).toBe("05/12/2026 09:00")
    expect(dueIsoFromPreset("none", NOW)).toBeNull()
  })

  it("qua nửa đêm giờ VN thì «hôm nay» đã là ngày mới (UTC còn hôm trước)", () => {
    const lateUtc = new Date("2026-11-28T18:30:00Z") // 29/11 01:30 VN
    expect(vnFullDue(dueIsoFromPreset("today", lateUtc))).toBe("29/11/2026 17:00")
  })

  it("nhận lại đúng mốc nhanh; hạn tự chọn không khớp mốc nào", () => {
    expect(matchDuePreset(dueIsoFromPreset("tomorrow", NOW), NOW)).toBe("tomorrow")
    expect(matchDuePreset("2026-11-30T05:00:00Z", NOW)).toBeNull()
    expect(matchDuePreset(null, NOW)).toBeNull()
  })
})

describe("chữ hạn trên thẻ", () => {
  const base = { due_at: "2026-11-26T10:00:00Z", due_completed_at: null, is_overdue: false }
  it("chưa đặt / còn hạn / quá hạn / xong", () => {
    expect(dueMeta({ ...base, due_at: null })).toEqual({ text: "Chưa đặt hạn", tone: "none" })
    expect(dueMeta(base)).toEqual({ text: "Hạn 26/11", tone: "normal" })
    expect(dueMeta({ ...base, is_overdue: true })).toEqual({ text: "Quá hạn 26/11", tone: "overdue" })
    expect(dueMeta({ ...base, is_overdue: true, due_completed_at: "2026-11-27T00:00:00Z" })).toEqual({ text: "26/11 · xong", tone: "done" })
  })
  it("dd/MM theo giờ VN", () => {
    expect(vnDayMonth("2026-11-25T18:00:00Z")).toBe("26/11") // 01:00 ngày 26 giờ VN
    expect(vnDayMonth(null)).toBe("")
  })
})

describe("tông giai đoạn", () => {
  it("theo vị trí cột, cột hoàn tất luôn là won", () => {
    expect(stageToneForColumn(0, false)).toBe("new")
    expect(stageToneForColumn(1, false)).toBe("consult")
    expect(stageToneForColumn(5, false)).toBe("new")
    expect(stageToneForColumn(1, true)).toBe("won")
  })
})
