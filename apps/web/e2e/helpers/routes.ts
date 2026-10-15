import { can, isOrgFeatureOn, ORG_FEATURES, resolveOrgFeatures, type Grants, type OrgFeatureKey, type OrgFeatures, type Permission } from '@trinity/rbac'
import { featureForPath } from '@/lib/org-feature-routes'

/**
 * DANH SÁCH ROUTE — NƠI DUY NHẤT khai trang cho smoke/rbac-ui. Thêm trang mới vào
 * `app/(dashboard)/` → thêm 1 dòng ở đây (xem e2e/README.md §"Thêm trang mới").
 *
 * - `title`  : regex khớp ÍT NHẤT MỘT `<h1>` của trang (layout cũng có h1 breadcrumb
 *              ở topbar nên 1 trang thường có 2 h1).
 * - `need`   : quyền cần để VÀO trang (khớp gate trong page + `nav-config.ts`). Không
 *              khai = mọi người đã đăng nhập. Thiếu quyền → trang PHẢI hiện
 *              "Bạn không có quyền truy cập trang này".
 * - `redirectTo`: route chỉ là redirect sang trang khác (kiểm URL cuối, bỏ kiểm gate).
 * - `dynamic`: route có tham số, resolve lúc chạy (xem `resolveRoute` ở smoke.spec).
 */
export type Need = Permission | { anyOf: readonly Permission[] }

export interface RouteDef {
  path: string
  name: string
  title: RegExp
  need?: Need
  redirectTo?: RegExp
  dynamic?: 'contact-detail'
  /** Kiểm thêm viewport 390px (chỉ tập trang chính để chạy nhanh). */
  mobile?: boolean
}

const REPORT_ANY: readonly Permission[] = [
  'reports.overview', 'reports.customers', 'reports.staff',
  'reports.channels',
]

export const ROUTES: readonly RouteDef[] = [
  { path: '/dashboard', mobile: true, name: 'Tổng quan', title: /Tổng quan/ },
  { path: '/contacts', mobile: true, name: 'Khách hàng', title: /Khách hàng/, need: 'contacts.view' },
  { path: '/contacts/new', mobile: true, name: 'Thêm khách hàng', title: /Thêm khách hàng mới/, need: 'contacts.create' },
  { path: '/contacts/:id', name: 'Chi tiết khách hàng', title: /\S/, need: 'contacts.view', dynamic: 'contact-detail' },
  { path: '/kanban', mobile: true, name: 'Công việc', title: /Công việc/, need: 'kanban.view' },
  { path: '/kanban/settings', name: 'Cấu hình Kanban', title: /Cấu hình Kanban/, need: 'kanban.boards' },
  { path: '/products', mobile: true, name: 'Sản phẩm', title: /Sản phẩm/, need: 'products.view' },
  { path: '/pos', mobile: true, name: 'Bán hàng (POS)', title: /Bán hàng/, need: 'pos.sell' },
  { path: '/projects', name: 'Dự án', title: /Quản lý dự án/, need: 'products.view' },
  { path: '/reports', mobile: true, name: 'Báo cáo', title: /Trung tâm báo cáo/, need: { anyOf: REPORT_ANY } },
  { path: '/settings', mobile: true, name: 'Cài đặt', title: /Cài đặt/ },
  { path: '/payroll', mobile: true, name: 'Lương', title: /Lương/, need: 'payroll.view' },
  { path: '/attendance', mobile: true, name: 'Chấm công', title: /Chấm công/ },
  { path: '/management/employees', mobile: true, name: 'Quản lý nhân viên', title: /Quản lý nhân viên/, need: 'employees.view' },
  { path: '/management/employees/stats', name: 'Thống kê nhân viên', title: /Thống kê nhân viên/, need: 'employees.view' },
  { path: '/management/contracts', name: 'Quản lý hợp đồng', title: /Quản lý hợp đồng/, need: 'contracts.view' },
  { path: '/management/job-titles', name: 'Cấu hình chức danh', title: /Cấu hình chức danh/, need: 'org.manage' },
  { path: '/management/recruitment', name: 'Tuyển dụng', title: /Tuyển dụng/, need: 'recruitment.view' },
  { path: '/management/workdays', name: 'Quản lý chấm công (HR)', title: /Quản lý chấm công/, need: 'attendance.config' },
  { path: '/newsfeed', mobile: true, name: 'Bảng tin', title: /Bảng tin/ },
  // Hoạt động AI — @AuthOnly, mọi người đã đăng nhập vào được (chỉ thấy hoạt động của mình).
  { path: '/ai-actions', name: 'Hoạt động AI', title: /Hoạt động AI/ },
]

/** Route /oauth/authorize (màn đồng ý OAuth) nằm ngoài nhóm (dashboard). */

export function needAllows(grants: Grants, need: Need | undefined): boolean {
  if (!need) return true
  if (typeof need === 'string') return can(grants, need)
  return need.anyOf.some((p) => can(grants, p))
}

export function needLabel(need: Need | undefined): string {
  if (!need) return '(mọi người đã đăng nhập)'
  return typeof need === 'string' ? need : `một trong ${need.anyOf.join(' | ')}`
}

/** Câu chữ của `<Forbidden />` / AccessDenied — nguồn: lib/rbac/forbidden.tsx. */
export const FORBIDDEN_TEXT = /Bạn không có quyền truy cập trang này/

/** Tính năng tổ chức quản route (khớp `lib/org-feature-routes.ts`) — null nếu route lõi. */
export function featureOfRoute(path: string): OrgFeatureKey | null {
  return featureForPath(path)
}

/** Cấu hình tính năng hiện hành (từ `GET /settings/org-features`, thiếu = bật). */
export function parseFeatures(raw: unknown): OrgFeatures {
  const r = raw as { features?: unknown } | null
  return resolveOrgFeatures(r && typeof r === 'object' && 'features' in r ? r.features : raw)
}

export function featureOn(features: OrgFeatures, key: OrgFeatureKey | null): boolean {
  return key === null || isOrgFeatureOn(features, key)
}

/**
 * Câu chữ màn "Tính năng đang tắt" — nguồn: components/feature-route-gate.tsx. Bản serverless khoá cố định
 * một số tính năng và hiện "Tính năng … không khả dụng trên bản này" — coi như cùng trạng thái "tắt".
 */
export function featureOffText(key: OrgFeatureKey): RegExp {
  // Nhãn có thể chứa ký tự regex, vd "Bán hàng (POS)" — phải escape.
  const label = ORG_FEATURES[key].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`Tính năng (“${label}” đang tắt|${label} không khả dụng trên bản này)`)
}
