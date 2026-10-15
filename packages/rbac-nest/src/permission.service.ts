import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { ALL_PERMISSIONS, PERMISSIONS, Grants, Permission, mergeGrants, normalizeGrant } from '@trinity/rbac'
import { RbacCache } from './rbac-cache'

export interface GrantsResult {
  grants: Grants
  isAdmin: boolean
}

/** Vai trò hệ thống ("Quản trị") = mọi quyền, scope `all` cho quyền scoped. */
export function adminGrants(): Grants {
  const g: Grants = {}
  for (const p of ALL_PERMISSIONS) g[p] = PERMISSIONS[p].scoped ? 'all' : true
  return g
}

function toGrants(list: { permission: string; scope: string | null }[]): Grants {
  const g: Grants = {}
  for (const r of list) {
    const v = normalizeGrant(r.permission, r.scope)
    if (v !== null) g[r.permission as Permission] = v
  }
  return g
}

/**
 * `grants(user) = ⋃ role_permissions của mọi vai trò user giữ` —
 * trùng quyền lấy scope rộng nhất. Cache RAM theo user, vô hiệu qua RbacCache
 * (xoá cục bộ + publish Redis `rbac:invalidate`).
 */
@Injectable()
export class PermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RbacCache,
  ) {}

  async grantsFor(userId: number): Promise<GrantsResult> {
    const key = `g:${userId}`
    const hit = this.cache.get<GrantsResult>(key)
    if (hit) return hit

    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      select: {
        role: {
          select: {
            is_system: true,
            grants: { select: { permission: true, scope: true } },
          },
        },
      },
    })

    const isAdmin = rows.some((r) => r.role.is_system)
    const grants = isAdmin ? adminGrants() : mergeGrants(rows.map((r) => toGrants(r.role.grants)))
    const out: GrantsResult = { grants, isAdmin }
    this.cache.set(key, out)
    return out
  }
}
