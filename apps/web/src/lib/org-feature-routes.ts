import type { OrgFeatureKey } from "@trinity/rbac"
import { isUnderRoute } from "@/lib/route-match"

/**
 * Route gốc → tính năng tổ chức quản nó. Chỉ liệt kê module CÓ thể
 * tắt; `/settings` là lõi — không tắt được (Quản
 * trị phải luôn vào được Cài đặt để bật lại).
 */
export const FEATURE_ROUTES: readonly { route: string; feature: OrgFeatureKey }[] = [
  // Tổng quan/Khách hàng tắt được (hệ thống dựng bằng AI có thể không dùng). `/settings` vẫn là lõi.
  { route: "/dashboard", feature: "dashboard" },
  { route: "/contacts", feature: "contacts" },
  { route: "/reports", feature: "reports" },
  { route: "/newsfeed", feature: "newsfeed" },
  { route: "/kanban", feature: "kanban" },
  { route: "/attendance", feature: "attendance" },
  { route: "/payroll", feature: "payroll" },
  { route: "/products", feature: "products" },
  { route: "/projects", feature: "products" },
  { route: "/pos", feature: "pos" },
  { route: "/management", feature: "management" },
  // Hộp thư (Zalo OA + Messenger) thuộc khung "Kết nối & AI" — tắt công tắc này thì ẩn cả trang.
  { route: "/inbox", feature: "integrations" },
]

/** Tính năng quản `pathname`, hoặc null nếu route không thuộc module tắt được. Dùng `isUnderRoute` (không startsWith trần). */
export function featureForPath(pathname: string | null | undefined): OrgFeatureKey | null {
  return FEATURE_ROUTES.find((r) => isUnderRoute(pathname, r.route))?.feature ?? null
}
