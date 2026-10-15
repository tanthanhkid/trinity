import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { Prisma, PrismaService } from '@trinity/prisma'
import { isSubset, mergeGrants, normalizeGrant, type Grants, type Permission } from '@trinity/rbac'
import { assertInScope, type AuthUser, type PermissionService, type ScopeService } from '@trinity/rbac-nest'

/**
 * Chống leo thang quyền — MỘT luật duy nhất so theo QUYỀN (không theo tên vai
 * trò): actor không bao giờ cấp/thao tác được ai đó có
 * quyền KHÔNG PHẢI tập con của quyền chính actor đang giữ (`isSubset`).
 *
 * Gồm `assertCanManageUser` (dùng ở `UsersService`), các luật cho `RolesService`
 * (`PUT /users/:id/roles`, `/roles*`) như `assertCanModifyExistingRole` (không phá/sửa vai trò "to" hơn mình),
 * `assertNotLastAdmin` (khoá/xoá Quản trị cuối cùng → 409) + luật "người
 * thường không gỡ vai trò Quản trị của người khác".
 */

export function grantsOfRoles(roles: { grants: { permission: string; scope: string | null }[] }[]): Grants {
  return mergeGrants(
    roles.map((r) => {
      const g: Grants = {}
      for (const rp of r.grants) {
        const v = normalizeGrant(rp.permission, rp.scope)
        if (v !== null) g[rp.permission as Permission] = v
      }
      return g
    }),
  )
}

/**
 * sửa quyền của 1 vai trò: tập quyền MỚI phải ⊆ quyền actor,
 * scope ≤ scope actor (`isSubset`); vai trò hệ thống ("Quản trị") không sửa
 * được. Hàm THUẦN — actor.grants đã có sẵn trên request, không cần DB.
 */
export function assertCanEditRole(actor: AuthUser, role: { is_system: boolean }, next: Grants): void {
  if (role.is_system) {
    throw new ForbiddenException('Không thể sửa vai trò hệ thống')
  }
  if (!actor.isAdmin && !isSubset(next, actor.grants)) {
    throw new ForbiddenException('Không thể cấp quyền bạn không có')
  }
}

/**
 * Vai trò đã tồn tại — sửa tên/quyền/xoá 1 vai trò ĐANG CÓ:
 * ngoài `assertCanEditRole` (quyền MỚI ⊆ actor), quyền HIỆN CÓ của vai trò
 * cũng phải ⊆ actor — nếu không, người chỉ có `roles.manage` hạ/phá được vai
 * trò "to" hơn mình (vd rút hết quyền của vai trò Kế toán trưởng). Quản trị
 * (`isAdmin`) bỏ qua; vai trò hệ thống không ai sửa được.
 */
export function assertCanModifyExistingRole(
  actor: AuthUser,
  role: { is_system: boolean },
  current: Grants,
): void {
  if (role.is_system) {
    throw new ForbiddenException('Không thể sửa vai trò hệ thống')
  }
  if (!actor.isAdmin && !isSubset(current, actor.grants)) {
    throw new ForbiddenException('Không thể sửa vai trò có quyền cao hơn bạn')
  }
}

/** Khoá advisory xuyên-process cho mọi thay đổi có thể làm hết Quản trị. */
export const ADMIN_MUTATION_LOCK = 724_001

/**
 * Tuần tự hoá mọi thao tác có thể làm hết Quản trị (khoá/xoá user, đổi vai trò):
 * gọi ĐẦU transaction, TRƯỚC `assertNotLastAdmin` — nếu không, 2 Quản trị bị
 * khoá song song mỗi bên đều thấy bên kia còn active → hết sạch Quản trị.
 */
export async function lockAdminMutation(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK})`
}

/**
 * Hệ thống luôn phải còn ≥1 Quản trị đang hoạt động. Gọi TRƯỚC
 * khi khoá / xoá / gỡ vai trò Quản trị của `userId`: nếu `userId` đang là
 * Quản trị và KHÔNG còn Quản trị active khác → 409.
 */
export async function assertNotLastAdmin(
  db: Pick<Prisma.TransactionClient, 'user'>,
  userId: number,
): Promise<void> {
  const isAdmin = await db.user.findFirst({
    where: { id: userId, user_roles: { some: { role: { is_system: true } } } },
    select: { id: true },
  })
  if (!isAdmin) return
  const others = await db.user.count({
    where: {
      id: { not: userId },
      status: 'active',
      deleted_at: null,
      user_roles: { some: { role: { is_system: true } } },
    },
  })
  if (others === 0) {
    throw new ConflictException('Phải còn ít nhất 1 Quản trị')
  }
}

/**
 * gán (thay toàn bộ) danh sách vai trò cho 1 người dùng.
 * - target ngoài scope `users.manage` của actor → 404 (`assertInScope`).
 * - `roleIds` chứa id không tồn tại → 404.
 * - hợp quyền của các vai trò MỚI phải ⊆ quyền actor (bỏ qua nếu actor là
 *   Quản trị — Quản trị cấp được mọi quyền).
 * - có vai trò hệ thống trong danh sách mới mà actor KHÔNG phải Quản trị → 403.
 * - actor (không phải Quản trị) tự đổi vai trò CHÍNH MÌNH → 403.
 * - set mới KHÔNG còn vai trò hệ thống trong khi target ĐANG giữ vai trò đó
 *   và target là Quản trị CUỐI CÙNG còn hoạt động → 409 (áp dụng cho MỌI
 *   target, không riêng actor tự gỡ chính mình — hệ thống luôn phải còn
 *   ≥1 Quản trị).
 */
export async function assertCanGrantRoles(
  prisma: PrismaService,
  scope: ScopeService,
  actor: AuthUser,
  targetUserId: number,
  roleIds: number[],
): Promise<void> {
  await assertInScope(scope, actor, 'users.manage', [targetUserId])

  const roles = await prisma.role.findMany({
    where: { id: { in: roleIds } },
    select: { id: true, is_system: true, grants: { select: { permission: true, scope: true } } },
  })
  if (roles.length !== roleIds.length) {
    throw new NotFoundException('Không tìm thấy vai trò')
  }
  const nextHasSystemRole = roles.some((r) => r.is_system)

  if (nextHasSystemRole && !actor.isAdmin) {
    throw new ForbiddenException('Chỉ Quản trị mới được gán vai trò Quản trị')
  }
  // "Quản trị chỉ người Quản trị gán/gỡ": người thường không gỡ
  // được vai trò Quản trị của người khác dù chỉ bằng cách gửi danh sách
  // KHÔNG chứa nó.
  if (!actor.isAdmin) {
    const targetIsAdmin = await prisma.userRole.findFirst({
      where: { user_id: targetUserId, role: { is_system: true } },
      select: { user_id: true },
    })
    if (targetIsAdmin) {
      throw new ForbiddenException('Chỉ Quản trị mới được gỡ vai trò Quản trị')
    }
  }
  if (!actor.isAdmin) {
    const next = grantsOfRoles(roles)
    if (!isSubset(next, actor.grants)) {
      throw new ForbiddenException('Không thể cấp quyền bạn không có')
    }
  }
  if (targetUserId === actor.userId && !actor.isAdmin) {
    throw new ForbiddenException('Không thể tự đổi vai trò của mình')
  }

  if (!nextHasSystemRole) {
    const targetCurrentlyAdmin = await prisma.userRole.findFirst({
      where: { user_id: targetUserId, role: { is_system: true } },
      select: { user_id: true },
    })
    if (targetCurrentlyAdmin) {
      const remainingAdmins = await prisma.user.count({
        where: {
          id: { not: targetUserId },
          status: 'active',
          deleted_at: null,
          user_roles: { some: { role: { is_system: true } } },
        },
      })
      if (remainingAdmins === 0) {
        throw new ConflictException('Phải còn ít nhất 1 Quản trị')
      }
    }
  }
}

/**
 * sửa / khoá / xoá / reset mật khẩu MỘT người dùng đã tồn tại:
 * target phải trong scope `users.manage` của actor (404 nếu ngoài phạm vi)
 * VÀ quyền HIỆN CÓ của target phải ⊆ quyền actor (không thao tác được
 * người "to" hơn hoặc ngang mình theo quyền, áp dụng cho MỌI quyền). Actor là Quản trị
 * (`isAdmin`) luôn qua — Quản trị không bị giới hạn bởi luật này.
 */
export async function assertCanManageUser(
  scope: ScopeService,
  permissionService: PermissionService,
  actor: AuthUser,
  targetUserId: number,
): Promise<void> {
  await assertInScope(scope, actor, 'users.manage', [targetUserId])
  if (actor.isAdmin) return
  const target = await permissionService.grantsFor(targetUserId)
  if (target.isAdmin || !isSubset(target.grants, actor.grants)) {
    throw new ForbiddenException('Không thể thao tác người có quyền cao hơn bạn')
  }
}
