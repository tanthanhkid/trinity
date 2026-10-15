import { describe, expect, it } from "vitest"
import { JOB_TITLE_RANK, jobTitleSeniorityRank } from "@/lib/job-title-rank"

describe("jobTitleSeniorityRank — xếp cấp bậc theo TÊN chức danh", () => {
  it("Trưởng nhóm / Team Lead → cấp cao nhất", () => {
    expect(jobTitleSeniorityRank("Trưởng nhóm")).toBe(JOB_TITLE_RANK.TEAM_LEAD)
    expect(jobTitleSeniorityRank("Trưởng nhóm Kinh doanh")).toBe(JOB_TITLE_RANK.TEAM_LEAD)
    expect(jobTitleSeniorityRank("Team Lead")).toBe(JOB_TITLE_RANK.TEAM_LEAD)
    expect(jobTitleSeniorityRank("team lead sale")).toBe(JOB_TITLE_RANK.TEAM_LEAD)
  })

  it("cấp phó thấp hơn trưởng", () => {
    expect(jobTitleSeniorityRank("Phó trưởng nhóm")).toBeLessThan(JOB_TITLE_RANK.TEAM_LEAD)
    expect(jobTitleSeniorityRank("Phó trưởng phòng")).toBeLessThan(JOB_TITLE_RANK.TEAM_LEAD)
  })

  it('"Chuyên viên chính" PHẢI hơn "Chuyên viên" (substring bẫy)', () => {
    expect(jobTitleSeniorityRank("Chuyên viên chính")).toBe(JOB_TITLE_RANK.SENIOR_SPECIALIST)
    expect(jobTitleSeniorityRank("Chuyên viên")).toBe(JOB_TITLE_RANK.SPECIALIST)
    expect(jobTitleSeniorityRank("Chuyên viên chính")).toBeGreaterThan(
      jobTitleSeniorityRank("Chuyên viên"),
    )
  })

  it("Nhân viên → cấp thấp nhất trong 4 nhóm", () => {
    expect(jobTitleSeniorityRank("Nhân viên")).toBe(JOB_TITLE_RANK.STAFF)
    expect(jobTitleSeniorityRank("Nhân viên kinh doanh")).toBe(JOB_TITLE_RANK.STAFF)
  })

  it("Thứ tự tổng thể: Trưởng nhóm > Chuyên viên chính > Chuyên viên > Nhân viên", () => {
    const ranks = [
      jobTitleSeniorityRank("Trưởng nhóm"),
      jobTitleSeniorityRank("Chuyên viên chính"),
      jobTitleSeniorityRank("Chuyên viên"),
      jobTitleSeniorityRank("Nhân viên"),
    ]
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    expect(new Set(ranks).size).toBe(4) // 4 cấp phân biệt rõ ràng
  })

  it("Chức danh lạ / rỗng / null → UNKNOWN (xếp cuối)", () => {
    expect(jobTitleSeniorityRank("Giám đốc khối")).toBe(JOB_TITLE_RANK.UNKNOWN)
    expect(jobTitleSeniorityRank("")).toBe(JOB_TITLE_RANK.UNKNOWN)
    expect(jobTitleSeniorityRank(null)).toBe(JOB_TITLE_RANK.UNKNOWN)
    expect(jobTitleSeniorityRank(undefined)).toBe(JOB_TITLE_RANK.UNKNOWN)
    expect(jobTitleSeniorityRank("Giám đốc khối")).toBeLessThan(jobTitleSeniorityRank("Nhân viên"))
  })

  it("Không phân biệt hoa/thường + bỏ khoảng trắng thừa", () => {
    expect(jobTitleSeniorityRank("  CHUYÊN VIÊN CHÍNH  ")).toBe(JOB_TITLE_RANK.SENIOR_SPECIALIST)
    expect(jobTitleSeniorityRank("nhân viên")).toBe(JOB_TITLE_RANK.STAFF)
  })
})
