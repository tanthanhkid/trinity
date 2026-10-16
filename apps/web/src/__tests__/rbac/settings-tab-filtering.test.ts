/**
 * RBAC quyền + phạm vi — Settings `ALL_TABS` nay lọc theo
 * `permission` (Grants) thay `roles: string[] | null`.
 *
 * 🔴 Tab "Menu theo vai trò" (`menu-visibility`) đã XOÁ hẳn (component + entry):
 * hiển thị menu suy trực tiếp từ quyền.
 */
import { describe, expect, it } from "vitest"
import { can, resolveOrgFeatures, type Grants, type OrgFeatures, type Permission } from "@trinity/rbac"
import { ALL_TABS, TAB_GROUPS, isSettingsTabVisible } from "@/app/(dashboard)/settings/page"

/** Dùng ĐÚNG hàm lọc của `SettingsPageContent` (settings/page.tsx) — không mirror lại logic. */
function visibleTabValues(grants: Grants, features?: OrgFeatures): string[] {
  return ALL_TABS.filter((t) => isSettingsTabVisible(t, (p) => can(grants, p), features)).map((t) => t.value)
}

describe("Settings ALL_TABS — tab đã xoá", () => {
  // So bằng chuỗi trần (KHÔNG literal-compare thẳng `t.value === "menu-visibility"`)
  // vì kiểu `TabValue` suy ra từ `ALL_TABS` KHÔNG còn chứa giá trị này —
  // literal-compare sẽ tự thành lỗi biên dịch "no overlap" (chính là điều test
  // này muốn khoá, chỉ khác là khoá ở tầng TYPE thay vì runtime).
  const allValues: string[] = ALL_TABS.map((t): string => t.value)
  const groupedValues: string[] = TAB_GROUPS.flatMap((g) => g.tabs as readonly string[])

  it("'menu-visibility' không còn trong ALL_TABS", () => {
    expect(allValues).not.toContain("menu-visibility")
  })

  it("tab đã xoá cũng không còn trong TAB_GROUPS", () => {
    expect(groupedValues).not.toContain("menu-visibility")
  })

  it("mọi tab trong TAB_GROUPS đều tồn tại trong ALL_TABS (không group rỗng/lạc)", () => {
    const allValueSet = new Set(allValues)
    for (const group of TAB_GROUPS) {
      for (const tabValue of group.tabs as readonly string[]) {
        expect(allValueSet.has(tabValue), `tab "${tabValue}" (nhóm "${group.label}")`).toBe(true)
      }
    }
  })
})

describe("Settings ALL_TABS — lọc theo permission (Grants)", () => {
  it("grants rỗng → CHỈ thấy tab không khai permission (profile/notifications...)", () => {
    const visible = visibleTabValues({})
    for (const t of ALL_TABS) {
      if ("hidden" in t && t.hidden) continue
      if (!("permission" in t) && !("anyOf" in t)) {
        expect(visible, `tab "${t.value}" không cần quyền, phải luôn thấy`).toContain(t.value)
      } else {
        expect(visible, `tab "${t.value}" cần quyền, grants rỗng phải ẨN`).not.toContain(t.value)
      }
    }
  })

  it("cấp ĐÚNG 1 quyền → chỉ tab đó (+ tab mở-cho-mọi-người) hiện", () => {
    const visible = visibleTabValues({ "users.view": "all" })
    expect(visible).toContain("users")
    expect(visible).not.toContain("roles")
    expect(visible).not.toContain("api-keys")
  })

  it("cấp đủ MỌI quyền còn lại → mọi tab không-hidden đều hiện", () => {
    const grants: Grants = {}
    for (const t of ALL_TABS) {
      if ("permission" in t && t.permission) grants[t.permission] = "all"
      if ("anyOf" in t) for (const p of t.anyOf as readonly Permission[]) grants[p] = "all"
    }
    const visible = visibleTabValues(grants)
    for (const t of ALL_TABS) {
      if ("hidden" in t && t.hidden) continue
      expect(visible, `tab "${t.value}" phải thấy khi đủ quyền`).toContain(t.value)
    }
  })
})

describe("Kết nối tách khỏi Cài đặt thành mục menu riêng (/connections)", () => {
  const NEW_PERMS = ["integrations.webhooks", "integrations.ai_connect", "integrations.ai_admin"] as const

  it("Cài đặt không còn tab integrations", () => {
    const grouped: string[] = TAB_GROUPS.flatMap((g) => g.tabs as readonly string[])
    expect(grouped).not.toContain("integrations")
    expect(ALL_TABS.some((t) => t.value === ("integrations" as never))).toBe(false)
  })

  it("mục menu Kết nối: grants rỗng ⇒ ẩn; một trong các quyền kết nối ⇒ hiện; tắt công tắc integrations ⇒ ẩn", async () => {
    const { menuItems } = await import("@/components/nav-config")
    const { isItemVisible } = await import("@/components/nav-visibility")
    const item = menuItems.find((m) => m.key === "connections")!
    expect(item.href).toBe("/connections")
    expect(isItemVisible(item, {})).toBe(false)
    for (const p of NEW_PERMS) expect(isItemVisible(item, { [p]: true } as Grants), p).toBe(true)
    expect(isItemVisible(item, { "integrations.webhooks": true } as Grants, resolveOrgFeatures({ integrations: false }))).toBe(false)
  })
})
