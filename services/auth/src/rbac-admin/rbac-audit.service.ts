import { Injectable } from '@nestjs/common'
import { Prisma, PrismaService } from '@trinity/prisma'

export type RbacAuditAction = 'role.create' | 'role.update' | 'role.delete' | 'role.grants' | 'user.roles'

export interface AuditEntry {
  actorId: number
  action: RbacAuditAction
  targetType: 'role' | 'user'
  targetId: number
  before?: unknown
  after?: unknown
}

/** Dấu vết MỌI thay đổi vai trò/quyền/gán người. */
@Injectable()
export class RbacAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ghi trong CÙNG transaction với thay đổi (không để lệch nhật ký ↔ dữ liệu). */
  async record(db: Pick<Prisma.TransactionClient, 'rbacAuditLog'>, e: AuditEntry): Promise<void> {
    await db.rbacAuditLog.create({
      data: {
        actor_id: e.actorId,
        action: e.action,
        target_type: e.targetType,
        target_id: e.targetId,
        before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  }

  /**
   * Với `targetType=role`, gộp thêm các dòng `user.roles` có chứa id vai trò đó
   * trong before/after (để tab "Nhật ký" của vai trò thấy cả việc thêm/gỡ người).
   */
  async list(q: { targetType?: 'role' | 'user'; targetId?: number; page?: number; limit?: number }) {
    const page = q.page ?? 1
    const limit = q.limit ?? 30
    const where = this.buildWhere(q.targetType, q.targetId)
    const [rows, total] = await Promise.all([
      this.prisma.rbacAuditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.rbacAuditLog.count({ where }),
    ])
    const names = await this.userNames(rows.flatMap((r) => [r.actor_id, ...(r.target_type === 'user' ? [r.target_id] : [])]))
    return {
      data: rows.map((r) => ({
        id: Number(r.id),
        actor_id: r.actor_id,
        actor_name: names.get(r.actor_id) ?? `#${r.actor_id}`,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        target_name: r.target_type === 'user' ? (names.get(r.target_id) ?? `#${r.target_id}`) : null,
        before: r.before,
        after: r.after,
        created_at: r.created_at,
      })),
      total,
      page,
      limit,
    }
  }

  private buildWhere(targetType?: 'role' | 'user', targetId?: number): Prisma.RbacAuditLogWhereInput {
    const base: Prisma.RbacAuditLogWhereInput = {}
    if (targetType) base.target_type = targetType
    if (targetId !== undefined) base.target_id = targetId
    if (targetType !== 'role' || targetId === undefined) return base
    return {
      OR: [
        base,
        { action: 'user.roles', before: { path: ['roleIds'], array_contains: targetId } },
        { action: 'user.roles', after: { path: ['roleIds'], array_contains: targetId } },
      ],
    }
  }

  private async userNames(ids: number[]): Promise<Map<number, string>> {
    const uniq = [...new Set(ids)]
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true, full_name: true },
    })
    return new Map(users.map((u) => [u.id, u.full_name]))
  }
}
