import { describe, expect, it } from "vitest"
import { formatTaskDue, taskHref } from "@/app/(dashboard)/dashboard/_components/dashboard-tasks-card"
import { formatMoneyAxis } from "@/app/(dashboard)/dashboard/_components/dashboard-overview-charts"
import type { DashboardTaskItem } from "@/app/(dashboard)/dashboard/_components/use-dashboard-overview"

const task = (kind: "kanban" | "reminder", id: number): DashboardTaskItem => ({
  key: "x", kind, id, title: "t", contact_id: null, contact_name: null,
  due_at: "2026-09-30T02:00:00Z", priority: null, overdue: false,
})

describe("dashboard tổng quan — helper", () => {
  it("link: card mở Kanban theo ?card=, lịch hẹn nhắc mở chi tiết khách", () => {
    expect(taskHref(task("kanban", 12))).toBe("/kanban?card=12")
    expect(taskHref(task("reminder", 5))).toBe("/contacts/5")
    expect(taskHref(task("reminder", 0))).toBe("/contacts")
  })
  it("hạn hôm nay hiện giờ VN, ngày khác hiện ngày", () => {
    expect(formatTaskDue("2026-09-30T02:00:00Z", "2026-09-30")).toBe("09:00")
    expect(formatTaskDue("2026-09-28T02:00:00Z", "2026-09-30")).not.toMatch(/^\d\d:\d\d$/)
  })
  it("trục tiền rút gọn tỷ/triệu", () => {
    expect(formatMoneyAxis(2_500_000_000)).toMatch(/tỷ$/)
    expect(formatMoneyAxis(86_500_000)).toMatch(/tr$/)
    expect(formatMoneyAxis(500)).toBe("500")
  })
})
