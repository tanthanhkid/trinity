import { describe, expect, it } from "vitest"
import { scheduleError } from "../social-composer"

describe("scheduleError — giờ hẹn đăng bài", () => {
  const now = new Date("2026-10-20T09:00:00").getTime()
  it("trống / sai ⇒ báo lỗi", () => {
    expect(scheduleError("", now)).toBe("Chọn ngày giờ đăng.")
    expect(scheduleError("abc", now)).toBe("Ngày giờ không hợp lệ.")
  })
  it("quá khứ hoặc dưới 1 phút ⇒ lỗi", () => {
    expect(scheduleError("2026-10-20T08:00", now)).toMatch(/sau bây giờ/)
    expect(scheduleError("2026-10-20T09:00", now)).toMatch(/sau bây giờ/)
  })
  it("quá 90 ngày ⇒ lỗi; trong hạn ⇒ hợp lệ", () => {
    expect(scheduleError("2027-02-01T09:00", now)).toMatch(/90 ngày/)
    expect(scheduleError("2026-10-21T09:00", now)).toBeNull()
  })
})
