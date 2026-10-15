import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import type { Permission } from '@trinity/rbac'
import type { AuthUser } from './auth-user'
import { RbacCache } from './rbac-cache'

/**
 * Suy tập user id "sở hữu" hợp lệ cho 1 quyền theo phạm vi (`own|team|subtree
 * |all`) — CHỈ tính theo cây `users.manager_id`, KHÔNG dùng
 * `team_id`). `null` = user KHÔNG có quyền này (guard `@Can` đã chặn trước khi
 * caller gọi tới đây trong luồng bình thường).
 */
@Injectable()
export class ScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RbacCache,
  ) {}

  async ownerIds(user: AuthUser, p: Permission): Promise<number[] | 'all' | null> {
    const g = user.grants[p]
    if (g === undefined) return null
    if (g === true || g === 'all') return 'all'
    if (g === 'own') return [user.userId]

    const key = `s:${user.userId}:${g}`
    const hit = this.cache.get<number[]>(key)
    if (hit) return hit

    const ids = g === 'team' ? await this.team(user.userId) : await this.subtree(user.userId)
    this.cache.set(key, ids)
    return ids
  }

  private async team(id: number): Promise<number[]> {
    const rows = await this.prisma.user.findMany({ where: { manager_id: id }, select: { id: true } })
    return [id, ...rows.map((r) => r.id)]
  }

  private async subtree(id: number): Promise<number[]> {
    // UNION (không ALL) loại trùng → vòng lặp manager không treo.
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE t(id) AS (
        SELECT ${id}::int
        UNION
        SELECT u.id FROM users u JOIN t ON u.manager_id = t.id
      ) SELECT id FROM t`
    return rows.map((r) => r.id)
  }
}
