/**
 * RBAC quyền + phạm vi — Trung tâm báo cáo: mỗi tab 1 quyền, ai có
 * quyền nào thấy tab đó.
 *
 * Khoá lại:
 *   1. 3 nhóm CRM tổng quát đứng ĐẦU mảng; các nhóm còn lại không mất tab.
 *   2. Tab → quyền đúng bảng (tab `reports.*` + tab mượn quyền miền khác).
 *   3. Mọi tab đều khai quyền hợp lệ trong danh mục `@trinity/rbac`.
 */
import { describe, expect, test } from "vitest"
import { PERMISSIONS, can } from "@/lib/rbac"
import type { Grants } from "@/lib/rbac"
import {
  DEFAULT_REPORT_TAB,
  REPORT_TAB_GROUPS,
} from "../../app/(dashboard)/reports/_components/report-tabs-config"
import { reportTabAllowed } from "../../app/(dashboard)/reports/_components/report-tab-access"

const allTabs = REPORT_TAB_GROUPS.flatMap((g) => g.tabs)

function visibleTabs(grants: Grants): string[] {
  return allTabs.filter((t) => reportTabAllowed(t, (p) => can(grants, p))).map((t) => t.value)
}

describe("Báo cáo — cấu trúc nhóm/tab", () => {
  test("3 nhóm đầu: overview, customers, employee-performance", () => {
    expect(REPORT_TAB_GROUPS.slice(0, 3).map((g) => g.key)).toEqual([
      "overview",
      "customers",
      "employee-performance",
    ])
  })

  test("nhóm Tuyển dụng giữ đủ tab", () => {
    const tabsOf = (key: string) =>
      REPORT_TAB_GROUPS.find((g) => g.key === key)?.tabs.map((t) => t.value).sort()
    expect(tabsOf("recruitment")).toEqual(["recruitment"])
  })

  test("mọi tab khai quyền có trong danh mục", () => {
    for (const t of allTabs) {
      const perms = t.permission ? [t.permission] : (t.anyPermission ?? [])
      expect(perms.length).toBeGreaterThan(0)
      for (const p of perms) expect(p in PERMISSIONS).toBe(true)
    }
  })

  test("tab mặc định là overview và tồn tại", () => {
    expect(DEFAULT_REPORT_TAB).toBe("overview")
    expect(allTabs.map((t) => t.value)).toContain(DEFAULT_REPORT_TAB)
  })
})

describe("Báo cáo — tab theo quyền", () => {
  test.each([
    ["overview", "reports.overview"],
    ["customers", "reports.customers"],
    ["employee-performance", "reports.staff"],
    ["recruitment", "reports.channels"],
  ] as const)("tab %s cần quyền %s", (tabValue, permission) => {
    const t = allTabs.find((x) => x.value === tabValue)
    expect(t?.permission).toBe(permission)
  })

  test("grants rỗng → không thấy tab nào (fail-closed)", () => {
    expect(visibleTabs({})).toEqual([])
  })

  test("chỉ reports.overview (scope own) → chỉ thấy tab Tổng quan", () => {
    expect(visibleTabs({ "reports.overview": "own" })).toEqual(["overview", "custom"])
  })

  test("reports.staff không kéo theo reports.customers", () => {
    const v = visibleTabs({ "reports.staff": "team" })
    expect(v).toEqual(["employee-performance", "custom"])
  })

  test("Báo cáo tuỳ chỉnh: có một quyền báo cáo bất kỳ hoặc quyền cấu hình bảng; không có ⇒ ẩn", () => {
    expect(visibleTabs({ "custom_objects.manage": "all" })).toEqual(["custom"])
    expect(visibleTabs({ "contacts.view": "own" })).toEqual([])
  })
})
