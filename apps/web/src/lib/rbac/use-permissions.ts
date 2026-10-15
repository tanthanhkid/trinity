"use client"

import { can, scopeOf, type Grants, type Permission, type Scope } from "@trinity/rbac"
import { useAuthStore } from "@/store/auth"

/**
 * RBAC quyền + phạm vi — nền quyền phía FE.
 *
 * `permissions`/`isAdmin` đến từ `/auth/me` (và response login/refresh —
 * xem `lib/auth-api.ts`), lưu trong `useAuthStore`. KHÔNG còn khái niệm
 * "vai trò" cố định ở tầng UI — mọi gate đọc qua `can()`/`scopeOf()` với
 * danh mục quyền thuần `@trinity/rbac` (dùng chung BE/FE).
 *
 * Chưa đăng nhập / chưa tải xong `/auth/me` → `grants = {}` (fail-closed,
 * KHÔNG mặc định mở bất kỳ quyền nào).
 */
export interface UsePermissionsResult {
  /** `true` khi user giữ vai trò hệ thống "Quản trị" (mọi quyền, scope `all`). */
  isAdmin: boolean
  /** Tập quyền đã hợp từ mọi vai trò đang giữ — dùng khi cần đọc thẳng scope. */
  grants: Grants
  /** Có quyền `permission` không (kèm ngưỡng scope tối thiểu tuỳ chọn). */
  can: (permission: Permission, min?: Scope) => boolean
  /** Có ÍT NHẤT MỘT trong các quyền truyền vào không. */
  canAny: (...permissions: Permission[]) => boolean
  /** Scope hiện có của 1 quyền scoped; `null` nếu không có quyền hoặc quyền không scoped. */
  scopeOf: (permission: Permission) => Scope | null
}

const EMPTY_GRANTS: Grants = {}

export function usePermissions(): UsePermissionsResult {
  const grants = useAuthStore((s) => s.permissions ?? EMPTY_GRANTS)
  const isAdmin = useAuthStore((s) => s.isAdmin)

  return {
    isAdmin,
    grants,
    can: (permission, min) => can(grants, permission, min),
    canAny: (...permissions) => permissions.some((p) => can(grants, p)),
    scopeOf: (permission) => scopeOf(grants, permission),
  }
}
