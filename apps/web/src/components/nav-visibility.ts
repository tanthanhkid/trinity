import type { Grants, OrgFeatures } from "@trinity/rbac"
import { can, isOrgFeatureOn } from "@trinity/rbac"
import type { ChildMenuItem, MenuItem } from "@/components/nav-config"

/**
 * 🔴 RBAC quyền + phạm vi — thay hoàn toàn cơ chế `deniedRoles` +
 * `menuConfig` động (tab Cài đặt "Menu theo vai trò", đã xoá cùng đợt này).
 * Hiển thị menu nay suy TRỰC TIẾP từ `permissions` (`Grants`) của user — không
 * còn bảng cấu hình role×menu riêng để giữ đồng bộ tay.
 */

/** Có quyền `permission`/`anyOf` khai trên mục hay không. Không khai gì → mở cho mọi người đã đăng nhập. */
function hasRequiredPermission(
  grants: Grants,
  permission: MenuItem["permission"],
  anyOf: MenuItem["anyOf"],
): boolean {
  if (permission) return can(grants, permission)
  if (anyOf && anyOf.length > 0) return anyOf.some((p) => can(grants, p))
  return true
}

export function isChildVisible(child: ChildMenuItem, grants: Grants): boolean {
  if (child.hidden) return false
  return hasRequiredPermission(grants, child.permission, child.anyOf)
}

export function isItemVisible(
  item: MenuItem,
  grants: Grants,
  features?: OrgFeatures,
): boolean {
  if (item.hidden) return false
  // Tính năng tổ chức: tắt = ẩn với MỌI người, AND với quyền. Mục
  // cha có `children` mang `feature` thì tắt cả nhóm. Không truyền `features`
  // (test cũ/đang tải) = bật hết.
  if (item.feature && features && !isOrgFeatureOn(features, item.feature)) return false
  if (item.children) {
    return item.children.some((child) => isChildVisible(child, grants))
  }
  return hasRequiredPermission(grants, item.permission, item.anyOf)
}
