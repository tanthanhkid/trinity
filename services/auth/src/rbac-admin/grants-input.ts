import { BadRequestException } from '@nestjs/common'
import { PERMISSIONS, SCOPE_ORDER, isPermission, type Grants, type Scope } from '@trinity/rbac'

/**
 * Kiểm + chuẩn hoá `grants` do client gửi (body `POST /roles`, `PUT /roles/:id/grants`).
 * - khoá phải thuộc danh mục `@trinity/rbac` (khoá lạ → 400, KHÔNG lặng lẽ bỏ);
 * - quyền `scoped` → bắt buộc scope own|team|subtree|all;
 * - quyền không scoped → `null` hoặc `true` (= cấp); scope kèm theo → 400;
 * - `false`/`undefined` = không cấp (bỏ khoá).
 */
export function parseGrantsInput(input: Record<string, unknown>): Grants {
  const out: Grants = {}
  for (const [key, raw] of Object.entries(input)) {
    if (!isPermission(key)) {
      throw new BadRequestException(`Quyền không tồn tại: ${key}`)
    }
    if (raw === undefined || raw === false) continue
    const def = PERMISSIONS[key]
    if (def.scoped) {
      if (typeof raw !== 'string' || !SCOPE_ORDER.includes(raw as Scope)) {
        throw new BadRequestException(`Quyền "${def.label}" cần chọn phạm vi (own, team, subtree, all)`)
      }
      out[key] = raw as Scope
    } else {
      if (raw !== null && raw !== true) {
        throw new BadRequestException(`Quyền "${def.label}" không có phạm vi`)
      }
      out[key] = true
    }
  }
  return out
}

/** Grants → dòng `role_permissions` (scope NULL với quyền không scoped). */
export function grantsToRows(roleId: number, grants: Grants): { role_id: number; permission: string; scope: string | null }[] {
  return Object.entries(grants).map(([permission, g]) => ({
    role_id: roleId,
    permission,
    scope: g === true ? null : (g as string),
  }))
}
