import { describe, expect, it } from "vitest"
import {
  EMPTY_FILTER,
  applyFilterChange,
  describeFilter,
  filterToParams,
  isFilterActive,
  saleOptions,
  teamOptions,
  type DashboardFilterRoster,
} from "@/app/(dashboard)/dashboard/_components/dashboard-filter-utils"

// Phòng 10 → Team 20 → NV 30,31 ; Phòng 11 → Team 21 → NV 32
const roster: DashboardFilterRoster = {
  dept_heads: [{ id: 10, full_name: "Phòng A", manager_id: null }, { id: 11, full_name: "Phòng B", manager_id: null }],
  team_leads: [{ id: 20, full_name: "TL Một", manager_id: 10 }, { id: 21, full_name: "TL Hai", manager_id: 11 }],
  sales: [
    { id: 30, full_name: "NV 30", manager_id: 20 },
    { id: 31, full_name: "NV 31", manager_id: 20 },
    { id: 32, full_name: "NV 32", manager_id: 21 },
  ],
}

describe("bộ lọc dashboard — helper", () => {
  it("params chỉ chứa field có giá trị; rỗng = không lọc", () => {
    expect(filterToParams(EMPTY_FILTER)).toEqual({})
    expect(isFilterActive(EMPTY_FILTER)).toBe(false)
    expect(filterToParams({ deptHeadId: 10, teamLeadId: null, userId: 30 })).toEqual({ dept_head_id: 10, user_id: 30 })
  })
  it("Team/NV lọc phụ thuộc Phòng và Team", () => {
    expect(teamOptions(roster, { ...EMPTY_FILTER, deptHeadId: 10 }).map((t) => t.id)).toEqual([20])
    expect(saleOptions(roster, { ...EMPTY_FILTER, deptHeadId: 11 }).map((s) => s.id)).toEqual([32])
    expect(saleOptions(roster, { ...EMPTY_FILTER, teamLeadId: 20 }).map((s) => s.id)).toEqual([30, 31])
    expect(saleOptions(roster, EMPTY_FILTER)).toHaveLength(3)
  })
  it("đổi Phòng xoá Team/NV không còn thuộc Phòng đó", () => {
    const prev = { deptHeadId: 10, teamLeadId: 20, userId: 30 }
    expect(applyFilterChange(roster, prev, { deptHeadId: 11 })).toEqual({ deptHeadId: 11, teamLeadId: null, userId: null })
    expect(applyFilterChange(roster, prev, { deptHeadId: null })).toEqual({ deptHeadId: null, teamLeadId: 20, userId: 30 })
  })
  it("'Chính tôi' (ngoài roster) được giữ khi đổi Phòng", () => {
    expect(applyFilterChange(roster, { ...EMPTY_FILTER, userId: 99 }, { deptHeadId: 10 }).userId).toBe(99)
  })
  it("mô tả bộ lọc đang áp dụng", () => {
    expect(describeFilter(roster, { deptHeadId: 10, teamLeadId: 20, userId: 30 }, 1)).toBe("Phòng Phòng A · Team TL Một · NV NV 30")
    expect(describeFilter(roster, { ...EMPTY_FILTER, userId: 1 }, 1)).toBe("Chính tôi")
  })
})
