import { describe, expect, it } from "vitest"
import { dateToIso, isoToDate } from "@/lib/date-iso"
import { computeDateRangePreset, matchDateRangePreset } from "@/lib/date-range-presets"

describe("date-iso", () => {
  it("khứ hồi ISO -> Date -> ISO không lệch ngày (kể cả ranh giới tháng/năm/nhuận)", () => {
    for (const iso of ["2026-01-01", "2026-12-31", "2024-02-29", "2026-10-03", "2026-03-29"]) {
      expect(dateToIso(isoToDate(iso) as Date)).toBe(iso)
    }
  })
  it("ngày không có thật / rỗng -> undefined", () => {
    expect(isoToDate("2026-02-30")).toBeUndefined()
    expect(isoToDate("")).toBeUndefined()
    expect(isoToDate(undefined)).toBeUndefined()
    expect(isoToDate("abc")).toBeUndefined()
  })
  it("Date nửa đêm local luôn ra đúng ngày (không đi qua UTC)", () => {
    expect(dateToIso(new Date(2026, 9, 3, 0, 0, 0))).toBe("2026-10-03")
    expect(dateToIso(new Date(2026, 9, 3, 23, 59, 59))).toBe("2026-10-03")
  })
})

describe("date-range-presets", () => {
  const today = "2026-10-03" // Thứ Bảy
  it("các khoảng nhanh theo ngày VN", () => {
    expect(computeDateRangePreset("today", today)).toEqual({ date_from: today, date_to: today })
    expect(computeDateRangePreset("last7", today)).toEqual({ date_from: "2026-09-27", date_to: today })
    expect(computeDateRangePreset("last30", today)).toEqual({ date_from: "2026-09-04", date_to: today })
    expect(computeDateRangePreset("this_month", today)).toEqual({ date_from: "2026-10-01", date_to: today })
    expect(computeDateRangePreset("last_month", today)).toEqual({ date_from: "2026-09-01", date_to: "2026-09-30" })
    expect(computeDateRangePreset("this_week", today)).toEqual({ date_from: "2026-09-28", date_to: today })
    expect(computeDateRangePreset("this_year", today)).toEqual({ date_from: "2026-01-01", date_to: today })
  })
  it("tháng trước qua ranh giới năm + tháng nhuận", () => {
    expect(computeDateRangePreset("last_month", "2026-01-15")).toEqual({ date_from: "2025-12-01", date_to: "2025-12-31" })
    expect(computeDateRangePreset("last_month", "2024-03-10")).toEqual({ date_from: "2024-02-01", date_to: "2024-02-29" })
  })
  it("matchDateRangePreset nhận ra preset đang chọn", () => {
    expect(matchDateRangePreset({ date_from: "2026-09-27", date_to: today }, today)).toBe("last7")
    expect(matchDateRangePreset({ date_from: "2026-01-02", date_to: today }, today)).toBeNull()
  })
})
