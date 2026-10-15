import type { MenuItem } from "@/components/nav-config"

/* =============================================================================
 * Chọn ĐÚNG MỘT mục menu sáng trong sidebar v2.
 *
 * Bug đã đo: một route có thể làm 2 mục cùng sáng (mục cha `/management` và mục con
 * `/management/employees`). Nguyên nhân: mỗi mục tự xét
 * `pathname.startsWith(href + '/')` một cách ĐỘC LẬP, nên mục cha khớp theo tiền tố
 * và mục con khớp chính xác — không ai biết có mục nào cụ thể hơn.
 *
 * Cách sửa: gom TOÀN BỘ href ứng viên rồi chọn href KHỚP DÀI NHẤT. Quyết định
 * tập trung 1 chỗ ⇒ không thể có 2 mục sáng, bất kể menu mọc thêm bao nhiêu
 * cặp cha/con kiểu này về sau.
 *
 * Tầng thuần (không React, không DOM) để test khoá được bằng unit test.
 * ========================================================================== */

/** `true` khi `pathname` là chính `href` hoặc một route con của nó. */
export function isHrefActive(pathname: string, href: string): boolean {
  if (!href) return false
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`))
}

/**
 * Mọi href ứng viên của menu đang hiển thị.
 *
 * `children` truyền vào phải là danh sách ĐÃ LỌC RBAC của đúng mục đó, để href
 * của một mục con bị ẩn không giành được trạng thái sáng.
 */
export function collectMenuHrefs(
  items: readonly MenuItem[],
  visibleChildrenOf: (item: MenuItem) => readonly { href: string }[],
): string[] {
  const out = new Set<string>()
  const push = (h: string | undefined) => {
    if (!h) return
    out.add(h)
  }
  for (const item of items) {
    if (item.external) continue
    if (item.children) {
      for (const child of visibleChildrenOf(item)) push(child.href)
      continue
    }
    push(item.href)
  }
  return [...out]
}

/**
 * href khớp DÀI NHẤT với `pathname`; `null` khi không href nào khớp.
 *
 * Dài nhất = cụ thể nhất. `/management/employees` thắng `/management` nên chỉ mục con sáng. Bằng độ dài thì không thể xảy ra với 2
 * href khác nhau cùng khớp 1 pathname (một trong hai phải là tiền tố của cái
 * kia, tức ngắn hơn thật sự).
 */
export function resolveActiveHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null
  for (const href of hrefs) {
    if (!isHrefActive(pathname, href)) continue
    if (best === null || href.length > best.length) best = href
  }
  return best
}

/** `true` nếu mục mang href này là mục đang sáng. */
export function isItemActive(
  activeHref: string | null,
  ...hrefs: readonly (string | undefined)[]
): boolean {
  if (activeHref === null) return false
  return hrefs.some((h) => h === activeHref)
}
