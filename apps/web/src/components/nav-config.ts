import {
  Gauge, ContactRound, ScrollText,
  Settings, ChartPie, Newspaper, PlugZap,
  Briefcase, Users, Wallet, Clock, UserPlus, CalendarDays,
  KanbanSquare, Share2,
} from "lucide-react"
import type { OrgFeatureKey, Permission } from "@trinity/rbac"

/**
 * RBAC quyền + phạm vi — mỗi mục khai `permission` (cần ĐÚNG
 * quyền đó) hoặc `anyOf` (cần ÍT NHẤT MỘT trong các quyền liệt kê). Không khai
 * gì cả = mở cho MỌI người đã đăng nhập (mirror `@AuthOnly` phía BE — vd
 * "Bảng tin", "Cài đặt", "Chấm công" cá nhân). Mục cha có `children` tự ẩn khi
 * KHÔNG con nào hiện (`nav-visibility.ts`) — bản thân mục cha không cần khai
 * `permission` riêng.
 *
 * Nguồn quyền THẬT (role nào có quyền gì) là dữ liệu do admin cấu hình ở
 * Cài đặt > Vai trò, KHÔNG hardcode trong file này.
 */
/** Nhóm nghiệp vụ trên sidebar. Mục KHÔNG khai `group` (Tổng quan, Bắt đầu) đứng đầu, ngoài mọi nhóm; Cài đặt ghim ở đáy. */
export type NavGroupKey = "ban_hang" | "cham_soc" | "van_hanh" | "nhan_su" | "he_thong"

/** Thứ tự + tiêu đề các nhóm trên sidebar; `order` = thứ tự mục trong nhóm (mục không liệt kê xếp cuối, giữ thứ tự gốc). */
export const NAV_GROUPS: readonly { key: NavGroupKey; title: string; order: readonly string[] }[] = [
  { key: "ban_hang", title: "Bán hàng", order: ["contacts", "products", "pos"] },
  { key: "cham_soc", title: "Chăm sóc", order: ["inbox", "social", "newsfeed"] },
  { key: "van_hanh", title: "Vận hành", order: ["kanban", "reports"] },
  { key: "nhan_su", title: "Nhân sự", order: ["attendance", "payroll", "management"] },
  { key: "he_thong", title: "Hệ thống", order: ["ai_actions", "connections"] },
]

export interface MenuItem {
  key: string
  /** Nhóm nghiệp vụ chứa mục này (xem `NavGroupKey`). */
  group?: NavGroupKey
  title: string
  icon: typeof Gauge
  href?: string
  iconColor: string
  badge?: boolean
  // Nhãn pill nhỏ cạnh tiêu đề (vd "Mới") — chỉ `ShellLeafItem` đọc field này.
  badgeLabel?: string
  /** Cần ĐÚNG quyền này để thấy mục. */
  permission?: Permission
  /** Cần ÍT NHẤT MỘT trong các quyền này (bỏ qua nếu đã khai `permission`). */
  anyOf?: readonly Permission[]
  /** Tính năng tổ chức quản mục này — tắt ở Cài đặt > Tính năng thì ẩn với MỌI người, kết hợp AND với quyền. */
  feature?: OrgFeatureKey
  children?: readonly ChildMenuItem[]
  // Ẩn hoàn toàn khỏi sidebar (override mọi thứ, kể cả admin) — page vẫn truy
  // cập được qua URL, chỉ giấu link khỏi điều hướng. KHÔNG liên quan RBAC.
  hidden?: boolean
  // Link NGOÀI (mở tab mới) thay vì điều hướng nội bộ — href là URL đầy đủ (http...).
  external?: boolean
}

export interface ChildMenuItem {
  key: string
  title: string
  icon: typeof Gauge
  href: string
  badge?: boolean
  permission?: Permission
  anyOf?: readonly Permission[]
  hidden?: boolean
}

export const menuItems: readonly MenuItem[] = [
  // ── CRM chính ──────────────────────────────────────────────────────────
  { key: "dashboard", title: "Tổng quan", icon: Gauge, href: "/dashboard", iconColor: "text-blue-600 dark:text-blue-400", feature: "dashboard" },
  { key: "contacts", group: "ban_hang", title: "Khách hàng", icon: ContactRound, href: "/contacts", iconColor: "text-emerald-600 dark:text-emerald-400", permission: "contacts.view", feature: "contacts" },
  // Menu "Dự án" — ẩn khỏi sidebar để menu gọn hơn. Page /projects vẫn truy cập qua URL trực tiếp.
  { key: "projects", group: "ban_hang", title: "Dự án", icon: Briefcase, href: "/projects", iconColor: "text-orange-500 dark:text-orange-400", hidden: true, permission: "products.view", feature: "products" },
  {
    key: "reports", group: "van_hanh",
    title: "Báo cáo",
    icon: ChartPie,
    href: "/reports",
    feature: "reports",
    iconColor: "text-rose-600 dark:text-rose-400",
    anyOf: [
      "reports.overview", "reports.customers", "reports.staff",
      "reports.channels",
    ],
  },
  // ── Khác ───────────────────────────────────────────────────────────────
  // "Bảng tin" — mở cho mọi role đã đăng nhập (mirror @AuthOnly phía BE).
  { key: "newsfeed", group: "cham_soc", title: "Bảng tin", icon: Newspaper, href: "/newsfeed", iconColor: "text-pink-500 dark:text-pink-400", feature: "newsfeed" },
  { key: "kanban", group: "van_hanh", title: "Công việc", icon: KanbanSquare, href: "/kanban", iconColor: "text-orange-600 dark:text-orange-400", permission: "kanban.view", feature: "kanban" },
  { key: "social", group: "cham_soc", title: "Đăng đa kênh", icon: Share2, href: "/social", iconColor: "text-sky-600 dark:text-sky-400", permission: "social.post", feature: "social_posting" },
  // "Chấm công" — mở cho mọi role đã đăng nhập: mọi nhân viên tự chấm công +
  // xem bản ghi của MÌNH, độc lập với quyền `attendance.view`/`.manage` (chỉ
  // chi phối phạm vi XEM NGƯỜI KHÁC bên trong trang, không chi phối menu).
  {
    key: "attendance", group: "nhan_su",
    title: "Chấm công",
    icon: Clock,
    href: "/attendance",
    feature: "attendance",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  { key: "payroll", group: "nhan_su", title: "Lương", icon: Wallet, href: "/payroll?tab=reports", iconColor: "text-emerald-600 dark:text-emerald-400", permission: "payroll.view", feature: "payroll" },
  // ── Quản lý (Nhân sự) ────────────────────────────────────────────────
  {
    key: "management", group: "nhan_su",
    title: "Quản lý",
    icon: Users,
    feature: "management",
    iconColor: "text-indigo-600 dark:text-indigo-400",
    children: [
      { key: "management_employees", title: "Quản lý nhân viên", icon: Users, href: "/management/employees", permission: "employees.view" },
      { key: "management_contracts", title: "Quản lý hợp đồng", icon: ScrollText, href: "/management/contracts", permission: "contracts.view" },
      { key: "management_job_titles", title: "Cấu hình chức danh", icon: Briefcase, href: "/management/job-titles", permission: "org.manage" },
      { key: "management_recruitment", title: "Tuyển dụng", icon: UserPlus, href: "/management/recruitment", permission: "recruitment.view" },
      { key: "management_workdays", title: "Quản lý chấm công", icon: CalendarDays, href: "/management/workdays", permission: "attendance.config" },
    ],
  },
  // Kết nối: trợ lý AI, Fanpage, Zalo OA, thanh toán, bán hàng, dữ liệu — tách khỏi Cài đặt cho gọn (nhóm theo loại bên trong).
  { key: "connections", group: "he_thong", title: "Kết nối", icon: PlugZap, href: "/connections", iconColor: "text-violet-600 dark:text-violet-400", anyOf: ["integrations.webhooks", "integrations.ai_connect", "integrations.ai_admin", "contacts.update", "deals.view", "pos.manage"], feature: "integrations" },
  { key: "settings", title: "Cài đặt", icon: Settings, href: "/settings", iconColor: "text-slate-600 dark:text-slate-400" },
] as const
