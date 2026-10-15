/**
 * RBAC quyền + phạm vi — cơ chế MỚI của `isItemVisible`/`isChildVisible`:
 * gate theo `permission`/`anyOf` (Grants), KHÔNG còn `deniedRoles`/`menuConfig` động.
 * Test bằng fixture tổng hợp (KHÔNG phụ thuộc nội dung thật của `nav-config.ts` —
 * đó là việc của test dùng `menuItems` thật, xem `products-menu.test.ts`).
 */
import { describe, expect, it } from "vitest"
import type { ChildMenuItem, MenuItem } from "@/components/nav-config"
import { isChildVisible, isItemVisible } from "@/components/nav-visibility"

function leaf(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    key: "x",
    title: "X",
    icon: (() => null) as unknown as MenuItem["icon"],
    href: "/x",
    iconColor: "",
    ...overrides,
  }
}

function child(overrides: Partial<ChildMenuItem> = {}): ChildMenuItem {
  return {
    key: "x_child",
    title: "X con",
    icon: (() => null) as unknown as ChildMenuItem["icon"],
    href: "/x/child",
    ...overrides,
  }
}

describe("isItemVisible — mục KHÔNG khai permission/anyOf", () => {
  it("mở cho mọi người đã đăng nhập (grants rỗng vẫn thấy)", () => {
    expect(isItemVisible(leaf(), {})).toBe(true)
  })

  it("hidden:true ẩn tuyệt đối, bất kể grants", () => {
    expect(isItemVisible(leaf({ hidden: true }), { "contacts.view": "all" })).toBe(false)
  })
})

describe("isItemVisible — mục khai `permission`", () => {
  const item = leaf({ permission: "contacts.view" })

  it("có quyền → thấy", () => {
    expect(isItemVisible(item, { "contacts.view": "own" })).toBe(true)
  })

  it("thiếu quyền → ẩn", () => {
    expect(isItemVisible(item, {})).toBe(false)
    expect(isItemVisible(item, { "deals.view": "own" })).toBe(false)
  })
})

describe("isItemVisible — mục khai `anyOf`", () => {
  const item = leaf({ anyOf: ["reports.overview", "reports.staff"] })

  it("có ÍT NHẤT MỘT quyền trong anyOf → thấy", () => {
    expect(isItemVisible(item, { "reports.staff": "own" })).toBe(true)
  })

  it("không có quyền nào trong anyOf → ẩn", () => {
    expect(isItemVisible(item, { "reports.customers": "own" })).toBe(false)
  })
})

describe("isItemVisible — mục có children: cha ẩn khi 0 con hiện, hiện khi ≥1 con hiện", () => {
  const parent = (children: ChildMenuItem[]): MenuItem => ({ ...leaf({ href: undefined }), children })

  it("0 con hiện (grants rỗng, mọi con đều cần quyền) → cha ẨN", () => {
    const item = parent([
      child({ key: "c1", permission: "contacts.view" }),
      child({ key: "c2", permission: "deals.view" }),
    ])
    expect(isItemVisible(item, {})).toBe(false)
  })

  it("≥1 con hiện → cha HIỆN", () => {
    const item = parent([
      child({ key: "c1", permission: "contacts.view" }),
      child({ key: "c2", permission: "deals.view" }),
    ])
    expect(isItemVisible(item, { "deals.view": "own" })).toBe(true)
  })

  it("con hidden:true không tính là 'hiện' dù có quyền", () => {
    const item = parent([child({ key: "c1", permission: "contacts.view", hidden: true })])
    expect(isItemVisible(item, { "contacts.view": "all" })).toBe(false)
  })

  it("mục cha CÓ children bỏ qua `permission` khai trên chính nó — chỉ xét children", () => {
    // Đúng hành vi kế thừa từ bản deniedRoles cũ: mục cha có children luôn
    // quyết định hiển thị qua children, không qua field permission của cha
    // (nếu ai đó lỡ khai permission trên cha có children, field đó vô tác dụng).
    const item: MenuItem = {
      ...leaf({ href: undefined, permission: "settings.integrations" }),
      children: [child({ key: "c1" })],
    }
    expect(isItemVisible(item, {})).toBe(true)
  })
})

describe("isChildVisible", () => {
  it("hidden:true ẩn tuyệt đối", () => {
    expect(isChildVisible(child({ hidden: true, permission: "contacts.view" }), { "contacts.view": "all" })).toBe(
      false,
    )
  })

  it("không khai permission/anyOf → mở cho mọi người", () => {
    expect(isChildVisible(child(), {})).toBe(true)
  })

  it("khai permission → cần đúng quyền", () => {
    const c = child({ permission: "kanban.view" })
    expect(isChildVisible(c, { "kanban.view": true })).toBe(true)
    expect(isChildVisible(c, {})).toBe(false)
  })
})
