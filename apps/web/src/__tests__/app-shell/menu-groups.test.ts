import { describe, expect, it } from "vitest"
import { ALL_PERMISSIONS, PERMISSIONS, type Grants } from "@trinity/rbac"
import { menuItems, NAV_GROUPS } from "@/components/nav-config"
import { isItemVisible } from "@/components/nav-visibility"
import { withExtraMenuItems } from "@/components/app-shell/menu-extra"
import { groupMenuItems } from "@/components/app-shell/menu-groups"

function fullGrants(): Grants {
  const g: Grants = {}
  for (const p of ALL_PERMISSIONS) g[p] = PERMISSIONS[p].scoped ? "all" : true
  return g
}

const all = withExtraMenuItems(menuItems)
const visible = (grants: Grants) => all.filter((i) => isItemVisible(i, grants))
const keys = (items: readonly { key: string }[]) => items.map((i) => i.key)

describe("nhóm menu theo nghiệp vụ", () => {
  it("mọi mục có group trừ Tổng quan và Cài đặt; group nằm trong NAV_GROUPS", () => {
    const valid = new Set(NAV_GROUPS.map((g) => g.key))
    for (const item of all) {
      if (item.key === "dashboard" || item.key === "settings") {
        expect(item.group).toBeUndefined()
      } else {
        expect(valid.has(item.group!), item.key).toBe(true)
      }
    }
  })

  it("quản trị: Tổng quan đứng đầu, 5 nhóm đúng thứ tự, nhóm giữ thứ tự mục", () => {
    const { ungrouped, sections } = groupMenuItems(visible(fullGrants()).filter((i) => i.key !== "settings"))
    expect(keys(ungrouped)).toEqual(["dashboard"])
    expect(sections.map((s) => s.title)).toEqual(["Bán hàng", "Chăm sóc", "Vận hành", "Nhân sự", "Hệ thống"])
    expect(Object.fromEntries(sections.map((s) => [s.key, keys(s.items)]))).toEqual({
      ban_hang: ["contacts", "products", "pos"],
      cham_soc: ["inbox", "social", "newsfeed"],
      van_hanh: ["kanban", "reports"],
      nhan_su: ["attendance", "payroll", "management"],
      he_thong: ["ai_actions", "connections"],
    })
  })

  it("RBAC: nhóm không còn mục nào được thấy thì ẩn cả tiêu đề", () => {
    const { sections } = groupMenuItems(visible({ "contacts.view": "own" }))
    expect(sections.map((s) => s.key)).toEqual(["ban_hang", "cham_soc", "nhan_su"])
    expect(sections.find((s) => s.key === "ban_hang")!.items.map((i) => i.key)).toEqual(["contacts"])
    expect(sections.find((s) => s.key === "he_thong")).toBeUndefined()
    expect(sections.find((s) => s.key === "van_hanh")).toBeUndefined()
  })

  it("không có quyền gì: chỉ các mục mở cho mọi người đăng nhập, không nhóm rỗng", () => {
    const { sections } = groupMenuItems(visible({}))
    for (const s of sections) expect(s.items.length).toBeGreaterThan(0)
  })
})
