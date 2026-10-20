"use client"

import type { ComponentType } from "react"
import type { OrgFeatureKey } from "@trinity/rbac"
import type { Permission } from "@/lib/rbac"
import { ReportRecruitment } from "./report-recruitment"
import { ReportOverview } from "./report-overview"
import { ReportCustomers } from "./report-customers"
import { ReportEmployeePerformance } from "./report-employee-performance"
import { ReportCustom } from "./custom/report-custom"

// ==== RBAC hiển thị tab — theo QUYỀN (RBAC quyền + phạm vi) ====
// Mỗi tab 1 quyền `reports.<tab>`; BE vẫn lọc dữ liệu theo phạm vi của quyền đó.
// Các tab chưa có quyền `reports.*` riêng mượn quyền của miền nghiệp vụ tương ứng
// (tuyển dụng → `reports.channels`) — đồng bộ với BE khi các cụm đó chuyển sang
// `@Can(...)`.

export interface ReportTabDef {
  value: string
  label: string
  /** Quyền cần có để thấy tab (xem `usePermissions().can`). */
  permission?: Permission
  /** Thay cho `permission`: có MỘT trong các quyền là thấy tab. Thiếu cả hai ⇒ không ai thấy (fail-closed). */
  anyPermission?: readonly Permission[]
  /** Tính năng tổ chức quản tab — tắt thì ẩn tab, AND với quyền. */
  feature?: OrgFeatureKey
  Component: ComponentType
}

export interface ReportTabGroup {
  key: string
  label: string
  tabs: ReportTabDef[]
}

// ==== Phân nhóm tab theo chủ đề — value/label/RBAC từng tab KHÔNG đổi ====
export const REPORT_TAB_GROUPS: ReportTabGroup[] = [
  // Các nhóm đầu mảng là mặc định cho vai trò CRM tổng quát
  // (khớp `resolveDefaultTab` bên dưới).
  {
    key: "overview",
    label: "Tổng quan",
    tabs: [
      {
        value: "overview", label: "Tổng quan", Component: ReportOverview,
        permission: "reports.overview",
      },
    ],
  },
  {
    key: "customers",
    label: "Khách hàng",
    tabs: [
      {
        value: "customers", label: "Khách hàng", Component: ReportCustomers,
        permission: "reports.customers",
      },
    ],
  },
  {
    key: "employee-performance",
    label: "Hiệu suất nhân viên",
    tabs: [
      {
        value: "employee-performance", label: "Hiệu suất nhân viên",
        Component: ReportEmployeePerformance,
        permission: "reports.staff",
      },
    ],
  },
  {
    key: "recruitment",
    label: "Tuyển dụng",
    tabs: [
      {
        value: "recruitment", label: "Tuyển dụng", Component: ReportRecruitment,
        // BE `GET /reports/marketing/recruitment-overview` yêu cầu quyền
        // `reports.channels` (không phải `recruitment.view`).
        permission: "reports.channels",
      },
    ],
  },
  {
    key: "custom",
    label: "Báo cáo tuỳ chỉnh",
    tabs: [
      {
        // Báo cáo dùng chung cho mọi bảng (#25): ai vào được Trung tâm báo cáo (hoặc cấu hình được bảng) thấy tab;
        // BE chỉ trả báo cáo của bảng người xem được xem, số liệu theo phạm vi quyền đó.
        value: "custom", label: "Báo cáo tuỳ chỉnh", Component: ReportCustom,
        anyPermission: ["reports.overview", "reports.customers", "reports.staff", "reports.channels", "custom_objects.manage"],
      },
    ],
  },
]

// Tab mặc định = "overview"; ai không có quyền tab đó tự rơi về tab hợp lệ đầu
// tiên qua fallback effect ở `page.tsx`.
export const DEFAULT_REPORT_TAB = "overview"
