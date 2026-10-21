"use client"

import type { ComponentType } from "react"
import type { OrgFeatureKey } from "@trinity/rbac"
import type { Permission } from "@/lib/rbac"
import dynamic from "next/dynamic"
import { LoadingBlock } from "@/components/ui/loading-block"

// Mỗi tab (kèm biểu đồ của nó) là một chunk riêng, chỉ tải khi tab được mở — trang Báo cáo không nạp sẵn cả 5 tab.
const TabLoading = () => <LoadingBlock count={4} className="py-4" />
const ReportOverview = dynamic(() => import("./report-overview").then((m) => ({ default: m.ReportOverview })), { loading: TabLoading })
const ReportCustomers = dynamic(() => import("./report-customers").then((m) => ({ default: m.ReportCustomers })), { loading: TabLoading })
const ReportEmployeePerformance = dynamic(
  () => import("./report-employee-performance").then((m) => ({ default: m.ReportEmployeePerformance })),
  { loading: TabLoading },
)
const ReportRecruitment = dynamic(() => import("./report-recruitment").then((m) => ({ default: m.ReportRecruitment })), { loading: TabLoading })
const ReportCustom = dynamic(() => import("./custom/report-custom").then((m) => ({ default: m.ReportCustom })), { loading: TabLoading })

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
