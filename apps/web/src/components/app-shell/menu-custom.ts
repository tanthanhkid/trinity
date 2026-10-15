import type { MenuItem } from "@/components/nav-config"
import { customIcon } from "@/lib/custom-objects/icons"
import type { CustomNavItem } from "@/types/custom-objects"

/**
 * Menu "tính năng tuỳ biến": mỗi "tính năng" người dùng tự thêm ở Cài đặt > Tính năng là MỘT MỤC CẤP 1
 * trỏ `/x/<key>` (không còn nhóm dropdown "Tuỳ biến"). Danh sách lấy từ `GET /custom-objects/nav` — BE đã lọc theo
 * vai trò (`visible_role_ids`) và bật/tắt, giữ thứ tự `nav_order`; FE còn lọc thêm theo quyền `custom_records.view`
 * qua ĐÚNG bộ luật `isItemVisible` như mọi mục khác. Key mục: `custom_<key>`.
 */
export const CUSTOM_ITEM_KEY_PREFIX = "custom_"

const CUSTOM_ICON_COLOR = "text-fuchsia-600 dark:text-fuchsia-400"

export function buildCustomMenuItems(nav: readonly CustomNavItem[]): MenuItem[] {
  // mục có thể trỏ tới một VIEW (kanban/danh sách) — `href`/`menu_key` do BE trả; bản cũ thiếu thì về `/x/<key>`.
  return nav.map((n) => ({
    key: `${CUSTOM_ITEM_KEY_PREFIX}${n.menu_key ?? n.key}`,
    title: n.label_plural,
    icon: customIcon(n.icon),
    iconColor: CUSTOM_ICON_COLOR,
    href: n.href ?? `/x/${n.key}`,
    permission: "custom_records.view",
  }))
}

/** Chèn các mục tuỳ biến NGAY TRƯỚC "Cài đặt" (hoặc cuối danh sách nếu không có). Không đổi mảng đầu vào. */
export function withCustomObjectItems(items: readonly MenuItem[], nav: readonly CustomNavItem[]): readonly MenuItem[] {
  const extra = buildCustomMenuItems(nav)
  if (extra.length === 0) return items
  const at = items.findIndex((i) => i.key === "settings")
  return at === -1 ? [...items, ...extra] : [...items.slice(0, at), ...extra, ...items.slice(at)]
}
