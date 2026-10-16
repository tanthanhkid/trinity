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
export interface MenuItem {
  key: string
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
  { key: "contacts", title: "Khách hàng", icon: ContactRound, href: "/contacts", iconColor: "text-emerald-600 dark:text-emerald-400", permission: "contacts.view", feature: "contacts" },
  // Menu "Dự án" — ẩn khỏi sidebar để menu gọn hơn. Page /projects vẫn truy cập qua URL trực tiếp.
  { key: "projects", title: "Dự án", icon: Briefcase, href: "/projects", iconColor: "text-orange-500 dark:text-orange-400", hidden: true, permission: "products.view", feature: "products" },
  {
    key: "reports",
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
  { key: "newsfeed", title: "Bảng tin", icon: Newspaper, href: "/newsfeed", iconColor: "text-pink-500 dark:text-pink-400", feature: "newsfeed" },
  { key: "kanban", title: "Công việc", icon: KanbanSquare, href: "/kanban", iconColor: "text-orange-600 dark:text-orange-400", permission: "kanban.view", feature: "kanban" },
  { key: "social", title: "Đăng đa kênh", icon: Share2, href: "/social", iconColor: "text-sky-600 dark:text-sky-400", permission: "social.post", feature: "social_posting" },
  // "Chấm công" — mở cho mọi role đã đăng nhập: mọi nhân viên tự chấm công +
  // xem bản ghi của MÌNH, độc lập với quyền `attendance.view`/`.manage` (chỉ
  // chi phối phạm vi XEM NGƯỜI KHÁC bên trong trang, không chi phối menu).
  {
    key: "attendance",
    title: "Chấm công",
    icon: Clock,
    href: "/attendance",
    feature: "attendance",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  { key: "payroll", title: "Lương", icon: Wallet, href: "/payroll?tab=reports", iconColor: "text-emerald-600 dark:text-emerald-400", permission: "payroll.view", feature: "payroll" },
  // ── Quản lý (Nhân sự) ────────────────────────────────────────────────
  {
    key: "management",
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
  { key: "connections", title: "Kết nối", icon: PlugZap, href: "/connections", iconColor: "text-violet-600 dark:text-violet-400", anyOf: ["integrations.webhooks", "integrations.ai_connect", "integrations.ai_admin", "contacts.update", "deals.view", "pos.manage", "extensions.view"], feature: "integrations" },
  { key: "settings", title: "Cài đặt", icon: Settings, href: "/settings", iconColor: "text-slate-600 dark:text-slate-400" },
] as const
