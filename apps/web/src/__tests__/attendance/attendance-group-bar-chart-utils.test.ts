import { describe, it, expect } from "vitest"
import {
  pctOfHeadcount,
  buildGroupTooltip,
  CHART_METRICS,
  type AttendanceChartGroup,
} from "@/app/(dashboard)/attendance/_components/attendance-group-bar-chart-utils"
import type { GroupStatBase } from "@/hooks/use-attendance"

function makeStat(over: Partial<GroupStatBase> = {}): GroupStatBase {
  return {
    headcount: 20,
    checked_in_people: 18,
    present_people: 16,
    late_people: 3,
    insufficient_people: 1,
    absent_people: 2,
    attendance_rate: 90,
    total_late_minutes: 45,
    ...over,
  }
}

describe("pctOfHeadcount", () => {
  it("tính phần trăm theo tổng nhân viên của nhóm", () => {
    expect(pctOfHeadcount(3, 20)).toBe(15)
    expect(pctOfHeadcount(18, 20)).toBe(90)
  })

  it("làm tròn về số nguyên gần nhất", () => {
    expect(pctOfHeadcount(1, 3)).toBe(33)
    expect(pctOfHeadcount(2, 3)).toBe(67)
  })

  it("trả 0 khi headcount = 0 (không chia cho 0, không NaN)", () => {
    expect(pctOfHeadcount(0, 0)).toBe(0)
    expect(pctOfHeadcount(5, 0)).toBe(0)
  })
})

describe("buildGroupTooltip", () => {
  it("trả 4 chỉ số đúng thứ tự, nhãn, màu, giá trị và phần trăm", () => {
    const group: AttendanceChartGroup = {
      id: "1",
      name: "Team Sale 1",
      stat: makeStat(),
    }
    const tip = buildGroupTooltip(group)

    expect(tip.metrics).toHaveLength(4)
    expect(tip.metrics.map((m) => m.label)).toEqual([
      "Đã chấm công",
      "Có mặt",
      "Đi muộn",
      "Vắng",
    ])
    expect(tip.metrics.map((m) => m.value)).toEqual([18, 16, 3, 2])
    expect(tip.metrics.map((m) => m.pct)).toEqual([90, 80, 15, 10])
    expect(tip.metrics.map((m) => m.color)).toEqual(
      CHART_METRICS.map((m) => m.color),
    )
  })

  it("mang theo tên, headcount và 3 chỉ số chân (tỷ lệ / chưa đủ công / phút muộn)", () => {
    const tip = buildGroupTooltip({
      id: "x",
      name: "Phòng Kinh doanh",
      stat: makeStat({ attendance_rate: 88, insufficient_people: 4, total_late_minutes: 120 }),
    })
    expect(tip.name).toBe("Phòng Kinh doanh")
    expect(tip.headcount).toBe(20)
    expect(tip.attendanceRate).toBe(88)
    expect(tip.insufficient).toBe(4)
    expect(tip.lateMinutes).toBe(120)
  })

  it("giữ nguyên meta tuỳ chọn (vd Trưởng phòng), bỏ qua khi không có", () => {
    const withMeta = buildGroupTooltip({
      id: "d",
      name: "Phòng A",
      meta: "Trưởng phòng: Nguyễn Văn A",
      stat: makeStat(),
    })
    expect(withMeta.meta).toBe("Trưởng phòng: Nguyễn Văn A")

    const noMeta = buildGroupTooltip({ id: "d2", name: "Phòng B", stat: makeStat() })
    expect(noMeta.meta).toBeUndefined()
  })

  it("headcount = 0 → mọi phần trăm = 0 (không NaN)", () => {
    const tip = buildGroupTooltip({
      id: "z",
      name: "Chưa có team",
      stat: makeStat({
        headcount: 0,
        checked_in_people: 0,
        present_people: 0,
        late_people: 0,
        absent_people: 0,
      }),
    })
    expect(tip.metrics.every((m) => m.pct === 0)).toBe(true)
  })
})
