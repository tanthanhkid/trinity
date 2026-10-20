import type { Permission } from "@/lib/rbac"

/** Tab hiện với người có quyền này? (`permission` hoặc một trong `anyPermission`; thiếu cả hai ⇒ ẩn). */
export function reportTabAllowed(
  t: { permission?: Permission; anyPermission?: readonly Permission[] },
  can: (p: Permission) => boolean,
): boolean {
  if (t.permission) return can(t.permission)
  return !!t.anyPermission?.some((p) => can(p))
}
