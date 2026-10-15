import { menuItems } from "@/components/nav-config"
import { EXTRA_MENU_ITEMS } from "@/components/app-shell/menu-extra"

export interface Crumb {
  /** Tiêu đề trang hiện tại (mục lá khớp đường dẫn). */
  title: string
  /** Tiêu đề nhóm cha (nếu trang nằm trong menu con) — để hiển thị "Cha / Con". */
  parentTitle?: string
}

interface Entry {
  path: string
  title: string
  parentTitle?: string
}

/** Bỏ query string khỏi href (vd "/payroll?tab=reports" → "/payroll"). */
function stripQuery(href: string): string {
  const q = href.indexOf("?")
  return q === -1 ? href : href.slice(0, q)
}

/**
 * Phẳng hoá menuItems (kể cả children) thành danh sách {path, title, parentTitle}.
 *
 * 🔴 CỘNG THÊM `EXTRA_MENU_ITEMS` ("Sản phẩm")
 * — các mục này KHÔNG có trong `nav-config.ts` (route chỉ tồn tại ở `/*`,
 * xem docblock `menu-extra.ts`) nên trước bản sửa này `resolveBreadcrumb`
 * không khớp được gì và rơi về fallback "Tổng quan" sai. File này DÙNG CHUNG
 * `components/header.tsx` (v1) — an toàn 0-đổi-hành-vi cho v1 vì các path này
 * (`/products`) không phải route v1 nào, `header.tsx` không bao
 * giờ được gọi với path đó.
 */
/** Trang có route nhưng không nằm trong menu (vào từ chuông, trang chủ…) — để topbar không ghi nhầm "Tổng quan". */
const OFF_MENU_ENTRIES: Entry[] = [
  { path: "/briefings", title: "Bản tin" },
  { path: "/extensions", title: "Chương trình con" },
  { path: "/bat-dau", title: "Bắt đầu" },
  { path: "/kanban/settings", title: "Cài đặt bảng", parentTitle: "Công việc" },
  { path: "/management/employees/stats", title: "Thống kê nhân sự", parentTitle: "Quản lý nhân viên" },
]

function buildEntries(): Entry[] {
  const entries: Entry[] = [...OFF_MENU_ENTRIES]
  for (const item of [...menuItems, ...EXTRA_MENU_ITEMS]) {
    if (item.href) entries.push({ path: stripQuery(item.href), title: item.title })
    for (const child of item.children ?? []) {
      entries.push({ path: stripQuery(child.href), title: child.title, parentTitle: item.title })
    }
  }
  return entries
}

let cachedEntries: Entry[] | null = null
function getEntries(): Entry[] {
  if (process.env.NODE_ENV === "development") {
    return buildEntries()
  }
  if (!cachedEntries) cachedEntries = buildEntries()
  return cachedEntries
}

/**
 * Suy ra breadcrumb từ pathname bằng longest-prefix match trên danh sách menu.
 * - Khớp chính xác hoặc tiền tố ("/contacts/123" → mục "/contacts").
 * - Khớp dài nhất thắng ("/management/employees" thắng "/management").
 * - Mục con khớp trước mục cha trùng path (vd "/management/employees" → "Quản lý nhân viên", không phải mục cha "Quản lý").
 * - Không khớp → "Tổng quan" (mặc định trang chủ dashboard).
 */
export function resolveBreadcrumb(pathname: string): Crumb {
  let best: Entry | null = null
  const entries = getEntries()
  for (const e of entries) {
    if (pathname === e.path || pathname.startsWith(e.path + "/")) {
      if (!best || e.path.length > best.path.length) best = e
    }
  }
  if (!best) return { title: "Tổng quan" }
  return { title: best.title, parentTitle: best.parentTitle }
}

/**
 * Breadcrumb của "tính năng tuỳ biến": đường dẫn `/x/<key>[/…]` không có trong `menuItems` (menu này sinh động từ BE),
 * nên tra thẳng từ danh sách menu tuỳ biến đã tải. Không phải `/x/…` → `null` (dùng `resolveBreadcrumb`).
 */
export function resolveCustomBreadcrumb(
  pathname: string,
  nav: readonly { key: string; label_plural: string; menu_key?: string }[] | undefined,
): Crumb | null {
  const m = /^\/x\/([^/]+)(?:\/v\/([^/]+))?/.exec(pathname)
  if (!m) return null
  const [, key, view] = m
  // Một bảng có thể xuất hiện nhiều lần trong menu (trang mặc định + từng màn xem, cùng `key`): chọn ĐÚNG mục theo đường đang mở,
  // không lấy mục đầu tiên cùng khoá (trước đây trang "Lịch hẹn" ghi tên màn xem "Lịch tuần").
  const own = (nav ?? []).filter((n) => n.key === key)
  const item = view
    ? own.find((n) => n.menu_key === `${key}__${view}`)
    : own.find((n) => !n.menu_key || n.menu_key === key)
  return { title: item?.label_plural ?? "Tuỳ biến" }
}
