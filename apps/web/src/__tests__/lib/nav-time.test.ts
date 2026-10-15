import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatRelativeTimeVn } from "@/lib/nav-time"

describe("formatRelativeTimeVn", () => {
  const NOW = new Date("2026-09-27T10:00:00+07:00").getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("rỗng khi không có giá trị", () => {
    expect(formatRelativeTimeVn(null)).toBe("")
    expect(formatRelativeTimeVn(undefined)).toBe("")
  })

  it("rỗng khi ngày không hợp lệ", () => {
    expect(formatRelativeTimeVn("not-a-date")).toBe("")
  })

  it("'Vừa xong' khi < 1 phút", () => {
    const iso = new Date(NOW - 30_000).toISOString()
    expect(formatRelativeTimeVn(iso)).toBe("Vừa xong")
  })

  it("'N phút' khi < 60 phút", () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString()
    expect(formatRelativeTimeVn(iso)).toBe("5 phút")
  })

  it("'N giờ' khi cùng ngày VN nhưng ≥ 1 giờ", () => {
    const iso = new Date(NOW - 3 * 3_600_000).toISOString()
    expect(formatRelativeTimeVn(iso)).toBe("3 giờ")
  })

  it("'Hôm qua' khi khác ngày VN đúng 1 ngày", () => {
    // NOW = 27/09 10:00 VN. 26/09 23:00 VN = hôm qua, dù chỉ cách 11 giờ.
    const iso = new Date("2026-09-26T23:00:00+07:00").toISOString()
    expect(formatRelativeTimeVn(iso)).toBe("Hôm qua")
  })

  it("ngày cụ thể khi xa hơn hôm qua", () => {
    const iso = new Date("2026-09-20T10:00:00+07:00").toISOString()
    expect(formatRelativeTimeVn(iso)).toBe("20/09/2026")
  })
})
