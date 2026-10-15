import { describe, expect, it } from "vitest"
import { formatLongDateVn, greetingForHour, vnClockParts } from "@/app/(dashboard)/dashboard/_components/dashboard-greeting"

describe("lời chào + ngày Tổng quan", () => {
  it("chào theo khung giờ", () => {
    expect(greetingForHour(8)).toBe("Chào buổi sáng")
    expect(greetingForHour(12)).toBe("Chào buổi trưa")
    expect(greetingForHour(15)).toBe("Chào buổi chiều")
    expect(greetingForHour(21)).toBe("Chào buổi tối")
    expect(greetingForHour(2)).toBe("Chào buổi tối")
  })
  it("ngày theo giờ VN (UTC+7), không theo múi giờ máy", () => {
    // 2026-10-02 20:00 UTC = 03/10/2026 03:00 giờ VN (Thứ 7)
    const d = new Date("2026-10-02T20:00:00Z")
    expect(vnClockParts(d).hour).toBe(3)
    expect(formatLongDateVn(d)).toBe("Thứ 7, 3 Tháng 10, 2026")
  })
})
