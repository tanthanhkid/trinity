import { describe, expect, it } from "vitest"
import {
  areContactFiltersEqual,
  buildContactUrlParams,
  parseContactFiltersFromParams,
} from "@/hooks/use-contacts-filters"
import type { ContactFilters } from "@/hooks/use-contacts"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

describe("parseContactFiltersFromParams — (khôi phục bộ lọc từ URL)", () => {
  it("URL chỉ có dấu reset=1 (Đặt lại không sort) → KHÔNG áp lại default 7 ngày", () => {
    const { filters } = parseContactFiltersFromParams(new URLSearchParams("reset=1"))
    expect(filters.createdFrom).toBeUndefined()
    expect(filters.createdTo).toBeUndefined()
  })

  it("URL trống (lần đầu vào trang) → default 7 ngày trước → hôm nay", () => {
    const { filters, page } = parseContactFiltersFromParams(new URLSearchParams())
    expect(page).toBe(1)
    expect(filters.createdFrom).toMatch(ISO_DATE_RE)
    expect(filters.createdTo).toMatch(ISO_DATE_RE)
    expect(filters.createdFrom).not.toBe(filters.createdTo)
    // Không filter nào khác bị áp mặc định.
    expect(filters.search).toBeUndefined()
    expect(filters.assignedTo).toBeUndefined()
  })

  it("tham số lạ trong link (manager_id, team_lead_id, …) bị BỎ QUA, không vào filters", () => {
    const { filters } = parseContactFiltersFromParams(
      new URLSearchParams({ manager_id: "4", team_lead_id: "9", owner_group_id: "6" }),
    )
    const loose = filters as Record<string, unknown>
    for (const k of ["managerId", "teamLeadId", "ownerGroupId"]) expect(loose[k]).toBeUndefined()
    expect(filters.assignedTo).toBeUndefined()
  })

  it("đọc đủ mọi field filter + search + sort từ URL", () => {
    const params = new URLSearchParams({
      stage_id: "3",
      contact_status_id: "5",
      source_id: "7",
      assigned_to: "12",
      project_id: "2",
      search: "0901234567",
      sort_by: "full_name",
      sort_order: "asc",
      created_from: "2026-08-01",
      created_to: "2026-08-20",
      page: "3",
    })
    const { filters, page } = parseContactFiltersFromParams(params)
    expect(page).toBe(3)
    expect(filters).toMatchObject({
      stageId: "3",
      contactStatusId: "5",
      sourceId: "7",
      assignedTo: "12",
      projectId: "2",
      search: "0901234567",
      sortBy: "full_name",
      sortOrder: "asc",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-20",
    })
  })

  it("bỏ qua giá trị KHÔNG hợp lệ (URL bị sửa tay) thay vì crash/leak", () => {
    const params = new URLSearchParams({
      sort_by: "not_a_real_column",
      sort_order: "sideways",
      page: "-5",
    })
    const { filters, page } = parseContactFiltersFromParams(params)
    expect(filters.sortBy).toBeUndefined()
    expect(filters.sortOrder).toBeUndefined()
    expect(page).toBe(1)
  })

  it("page=1 hoặc thiếu param → page=1 (không phải 0/NaN)", () => {
    expect(parseContactFiltersFromParams(new URLSearchParams({ search: "x" })).page).toBe(1)
    expect(
      parseContactFiltersFromParams(new URLSearchParams({ search: "x", page: "1" })).page,
    ).toBe(1)
  })
})

describe("buildContactUrlParams — ghi filters vào URL", () => {
  it("page=1 KHÔNG xuất hiện trong URL (giữ URL gọn — mặc định ngầm)", () => {
    const params = buildContactUrlParams({ search: "abc" }, 1)
    expect(params.has("page")).toBe(false)
    expect(params.get("search")).toBe("abc")
  })

  it("page>1 được ghi vào URL", () => {
    const params = buildContactUrlParams({}, 5)
    expect(params.get("page")).toBe("5")
  })

  it("field undefined/rỗng KHÔNG xuất hiện trong URL", () => {
    const params = buildContactUrlParams({ search: "", assignedTo: undefined, sourceId: "9" }, 1)
    expect(params.has("search")).toBe(false)
    expect(params.has("assigned_to")).toBe(false)
    expect(params.get("source_id")).toBe("9")
  })

  it("round-trip build → parse cho ra ĐÚNG filters ban đầu (bất biến cốt lõi)", () => {
    const original: ContactFilters = {
      stageId: "1",
      contactStatusId: "2",
      sourceId: "3",
      assignedTo: "10",
      projectId: "4",
      search: "Nguyen Van A",
      sortBy: "created_at",
      sortOrder: "desc",
      createdFrom: "2026-07-01",
      createdTo: "2026-07-31",
    }
    const params = buildContactUrlParams(original, 7)
    const roundTripped = parseContactFiltersFromParams(params)
    expect(roundTripped.page).toBe(7)
    expect(roundTripped.filters).toEqual(original)
  })
})

describe("areContactFiltersEqual — bail-out sync pendingFilters", () => {
  it("true khi 2 object khác reference nhưng cùng giá trị", () => {
    const a: ContactFilters = { assignedTo: "1", search: "x" }
    const b: ContactFilters = { assignedTo: "1", search: "x" }
    expect(areContactFiltersEqual(a, b)).toBe(true)
  })

  it("undefined và chuỗi rỗng coi là TƯƠNG ĐƯƠNG (khớp cách buildContactUrlParams xoá field rỗng)", () => {
    expect(areContactFiltersEqual({ search: undefined }, { search: "" })).toBe(true)
  })

  it("false khi có field khác giá trị", () => {
    expect(areContactFiltersEqual({ assignedTo: "1" }, { assignedTo: "2" })).toBe(false)
  })
})

describe("lọc & sắp theo điểm lead", () => {
  it("lead_label và sort_by=lead_score đi vòng URL → filters → URL không mất", () => {
    const { filters } = parseContactFiltersFromParams(new URLSearchParams({ lead_label: "hot", sort_by: "lead_score", sort_order: "desc" }))
    expect(filters.leadLabel).toBe("hot")
    expect(filters.sortBy).toBe("lead_score")
    const p = buildContactUrlParams(filters, 1)
    expect(p.get("lead_label")).toBe("hot")
    expect(p.get("sort_by")).toBe("lead_score")
  })

  it("areContactFiltersEqual nhận ra khác biệt ở leadLabel", () => {
    expect(areContactFiltersEqual({ leadLabel: "hot" }, { leadLabel: "cold" })).toBe(false)
    expect(areContactFiltersEqual({ leadLabel: "hot" }, { leadLabel: "hot" })).toBe(true)
  })
})
