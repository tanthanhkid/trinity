import type { ComponentType } from 'react'
import type { OrgFeatureKey, Permission } from '@trinity/rbac'
import { DashboardOverview } from './dashboard-overview'
import { DashboardRecentCustomersStandalone } from './dashboard-recent-customers'

/**
 * Widget Tổng quan theo QUYỀN (RBAC quyền + phạm vi). Trang render widget nào
 * mà người dùng `can(permission)`; thứ tự mảng = thứ tự trên màn.
 *
 * `permission` = quyền NGUỒN của endpoint widget gọi (BE kiểm lại độc lập,
 * widget tự ẩn khi BE trả `null`/không có số liệu):
 *  - `overview`        → `reports.overview` (dashboard-overview/-tasks/-filter-roster; phạm vi do BE quyết)
 *  - `recent-customers`→ `contacts.view` (`GET /contacts/recent`); khi đã có
 *    `overview` thì thẻ này nằm TRONG khối Tổng quan (cùng hàng việc hôm nay)
 *    nên widget độc lập tự ẩn — xem `DashboardRecentCustomersStandalone`.
 *
 * Thêm widget mới: thêm 1 dòng ở đây + khai quyền nguồn đúng với `@Can` của BE.
 */
export interface DashboardWidget {
  key: string
  permission: Permission
  /** Tính năng tổ chức quản widget — tắt thì ẩn, AND với quyền. */
  feature?: OrgFeatureKey
  Component: ComponentType
}

export const DASHBOARD_WIDGETS: readonly DashboardWidget[] = [
  { key: 'overview', permission: 'reports.overview', Component: DashboardOverview },
  { key: 'recent-customers', permission: 'contacts.view', Component: DashboardRecentCustomersStandalone },
]
