import { describe, expect, it } from "vitest"
import { Gauge, ContactRound } from "lucide-react"
import { flattenMenuEntries, resolvePinnedEntries, findMenuEntry } from "@/components/app-shell/menu-resolve"
import type { MenuItem } from "@/components/nav-config"

const ITEMS: readonly MenuItem[] = [
  { key: "dashboard", title: "Tổng quan", icon: Gauge, href: "/dashboard", iconColor: "" },
  { key: "contacts", title: "Khách hàng", icon: ContactRound, href: "/contacts", iconColor: "" },
  {
    key: "management",
    title: "Quản lý",
    icon: Gauge,
    iconColor: "",
    children: [
      { key: "management_employees", title: "Nhân viên", icon: Gauge, href: "/management/employees" },
      { key: "management_contracts", title: "Hợp đồng", icon: Gauge, href: "/management/contracts" },
    ],
  },
  { key: "projects", title: "Dự án", icon: Gauge, href: "/projects", iconColor: "", hidden: true },
]

describe("flattenMenuEntries", () => {
  it("làm phẳng cả leaf item lẫn children, bỏ qua mục hidden", () => {
    const flat = flattenMenuEntries(ITEMS)
    expect(flat.map((e) => e.key)).toEqual(["dashboard", "contacts", "management_employees", "management_contracts"])
  })

  it("mục cha có children KHÔNG tự thành 1 entry (chỉ children mới có href riêng)", () => {
    const flat = flattenMenuEntries(ITEMS)
    expect(findMenuEntry(flat, "management")).toBeUndefined()
  })
})

describe("resolvePinnedEntries — 'ghim mục không còn quyền thì không hiện'", () => {
  const visibleFlat = flattenMenuEntries(ITEMS) // giả lập: role hiện tại thấy hết trừ "projects" (hidden)

  it("giữ đúng thứ tự pinnedKeys, chỉ lấy entry CÓ trong danh sách visible", () => {
    const result = resolvePinnedEntries(["management_employees", "contacts"], visibleFlat)
    expect(result.map((e) => e.key)).toEqual(["management_employees", "contacts"])
  })

  it("BỎ QUA key không còn visible (role đổi / bị ẩn qua menuConfig động)", () => {
    // "projects" bị hidden nên KHÔNG có trong visibleFlat dù user từng ghim nó.
    const result = resolvePinnedEntries(["projects", "contacts"], visibleFlat)
    expect(result.map((e) => e.key)).toEqual(["contacts"])
  })

  it("mô phỏng đổi role: role B không còn thấy 'contacts' → visibleFlat hẹp hơn → mục ghim tự biến mất", () => {
    const visibleFlatForRoleB = visibleFlat.filter((e) => e.key !== "contacts")
    const result = resolvePinnedEntries(["contacts", "management_employees"], visibleFlatForRoleB)
    expect(result.map((e) => e.key)).toEqual(["management_employees"])
  })

  it("trả [] khi không còn key ghim nào hợp lệ", () => {
    const result = resolvePinnedEntries(["unknown-key"], visibleFlat)
    expect(result).toEqual([])
  })
})
