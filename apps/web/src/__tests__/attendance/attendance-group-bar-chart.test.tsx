import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { AttendanceGroupBarChart } from "@/app/(dashboard)/attendance/_components/attendance-group-bar-chart"
import type { AttendanceChartGroup } from "@/app/(dashboard)/attendance/_components/attendance-group-bar-chart-utils"
import type { GroupStatBase } from "@/hooks/use-attendance"

function stat(over: Partial<GroupStatBase> = {}): GroupStatBase {
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

const groups: AttendanceChartGroup[] = [
  { id: "1", name: "Team Sale 1", stat: stat() },
  { id: "2", name: "Team Sale 2", stat: stat({ checked_in_people: 9, present_people: 8, late_people: 2, absent_people: 1 }) },
]

describe("AttendanceGroupBarChart", () => {
  it("hiển thị empty text khi không có nhóm", () => {
    render(<AttendanceGroupBarChart groups={[]} emptyText="Không có dữ liệu" />)
    expect(screen.getByText("Không có dữ liệu")).toBeInTheDocument()
  })

  it("vẽ tên cụm cho từng nhóm", () => {
    render(<AttendanceGroupBarChart groups={groups} />)
    expect(screen.getByText("Team Sale 1")).toBeInTheDocument()
    expect(screen.getByText("Team Sale 2")).toBeInTheDocument()
  })

  it("hiển thị 4 nhãn chú thích chỉ số", () => {
    render(<AttendanceGroupBarChart groups={groups} />)
    for (const label of ["Đã chấm công", "Có mặt", "Đi muộn", "Vắng"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })
})
