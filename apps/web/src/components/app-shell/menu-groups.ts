import { NAV_GROUPS, type MenuItem, type NavGroupKey } from "@/components/nav-config"

/** Một nhóm nghiệp vụ đã dựng: tiêu đề + các mục (đã lọc RBAC, đã bỏ mục ghim). */
export interface MenuSection {
  key: NavGroupKey
  title: string
  items: MenuItem[]
}

/**
 * Chia danh sách mục (đã lọc RBAC) thành các nhóm nghiệp vụ theo `NAV_GROUPS`.
 * Nhóm rỗng (không mục nào được thấy) bị bỏ — không hiện tiêu đề trống. Thứ tự mục trong nhóm theo
 * `NAV_GROUPS[].order`. Mục KHÔNG khai `group` trả ở `ungrouped` (đứng đầu, ngoài nhóm).
 */
export function groupMenuItems(items: readonly MenuItem[]): { ungrouped: MenuItem[]; sections: MenuSection[] } {
  const ungrouped = items.filter((i) => !i.group)
  const rank = (order: readonly string[], key: string) => {
    const at = order.indexOf(key)
    return at === -1 ? order.length : at
  }
  const sections = NAV_GROUPS.map((g) => ({
    key: g.key,
    title: g.title,
    // sort ổn định: mục ngoài `order` giữ thứ tự gốc ở cuối
    items: items.filter((i) => i.group === g.key).sort((a, b) => rank(g.order, a.key) - rank(g.order, b.key)),
  })).filter((s) => s.items.length > 0)
  return { ungrouped, sections }
}
