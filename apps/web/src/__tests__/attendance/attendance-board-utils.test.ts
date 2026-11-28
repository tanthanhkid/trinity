import { describe, it, expect } from "vitest"
import {
  askOf,
  computeQuota,
  nameInitials,
  quotaFor,
  quotaGroupOf,
  shortTime,
} from "@/app/(dashboard)/attendance/_components/attendance-board-utils"
import type { AttendanceRequestConfig } from "@/hooks/use-attendance"

const cfg: AttendanceRequestConfig = {
  default_check_in: "08:00",
  default_check_out: "17:30",
  monthly_forgot_limit: 3,
  monthly_late_early_limit: 2,
}
const row = (id: number, type: string, status: string, work_date = "2026-11-10", user_id = 7) =>
  ({ id, user_id, type, status, work_date }) as never

describe("quotaGroupOf", () => {
  it("gom loại đơn theo nhóm hạn mức của máy chủ", () => {
    expect(quotaGroupOf("forgot_check_in")).toBe("forgot")
    expect(quotaGroupOf("forgot_check_out")).toBe("forgot")
    expect(quotaGroupOf("late_arrival")).toBe("late_early")
    expect(quotaGroupOf("early_leave")).toBe("late_early")
    expect(quotaGroupOf("leave")).toBe("none")
    expect(quotaGroupOf("maternity")).toBe("none")
  })
})

describe("computeQuota", () => {
  const all = [
    row(1, "forgot_check_in", "approved"),
    row(2, "forgot_check_out", "pending"),
    row(3, "forgot_check_in", "rejected"), // bị từ chối: không tính
    row(4, "forgot_check_in", "approved", "2026-10-30"), // tháng khác
    row(5, "forgot_check_in", "approved", "2026-11-12", 8), // người khác
    row(6, "late_arrival", "approved"),
  ]

  it("đếm đơn chờ + đã duyệt cùng nhóm, cùng tháng, cùng người; bỏ đơn bị từ chối", () => {
    const q = computeQuota({ id: 9, user_id: 7, type: "forgot_check_in", work_date: "2026-11-27" }, all, cfg)
    expect(q.used).toBe(2)
    expect(q.max).toBe(3)
    expect(q.over).toBe(false)
    expect(q.pct).toBe(67)
  })

  it("không tính chính đơn đang xem", () => {
    const q = computeQuota({ id: 1, user_id: 7, type: "forgot_check_in", work_date: "2026-11-10" }, all, cfg)
    expect(q.used).toBe(1)
  })

  it("vượt hạn mức khi đã dùng đủ", () => {
    const q = computeQuota({ id: 9, user_id: 7, type: "late_arrival", work_date: "2026-11-27" }, [...all, row(10, "early_leave", "pending")], cfg)
    expect(q.used).toBe(2)
    expect(q.over).toBe(true)
    expect(q.pct).toBe(100)
  })

  it("nghỉ phép / thai sản hoặc hạn mức 0 = không có hạn mức theo đơn", () => {
    expect(computeQuota({ id: 9, user_id: 7, type: "leave", work_date: "2026-11-27" }, all, cfg).max).toBeNull()
    expect(quotaFor(7, "forgot", "2026-11", all, { ...cfg, monthly_forgot_limit: 0 }).max).toBeNull()
    expect(quotaFor(7, "forgot", "2026-11", all, undefined).max).toBeNull()
  })
})

describe("nameInitials / shortTime / askOf", () => {
  it("lấy chữ cái đầu hai từ cuối", () => {
    expect(nameInitials("Nguyễn Thị Lan")).toBe("TL")
    expect(nameInitials("Hậu")).toBe("HẬ")
    expect(nameInitials("  ")).toBe("?")
    expect(nameInitials(null)).toBe("?")
  })

  it("rút giờ về HH:MM", () => {
    expect(shortTime("08:00:00")).toBe("08:00")
    expect(shortTime("8:05")).toBe("08:05")
    expect(shortTime(null)).toBeNull()
  })

  it("nhãn ô giờ đề nghị theo loại đơn", () => {
    expect(askOf({ type: "forgot_check_in", requested_check_in: "08:00:00", requested_check_out: null })).toEqual({
      label: "Xin bổ sung giờ vào",
      time: "08:00",
    })
    expect(askOf({ type: "early_leave", requested_check_in: null, requested_check_out: "16:00" })).toEqual({
      label: "Xin về lúc",
      time: "16:00",
    })
    expect(askOf({ type: "leave", requested_check_in: null, requested_check_out: null })).toBeNull()
    expect(askOf({ type: "forgot_check_out", requested_check_in: null, requested_check_out: null })).toBeNull()
  })
})
