import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService, Prisma } from '@trinity/prisma'
import { normalizeGrant, type Grants, type Permission } from '@trinity/rbac'
import { RbacCache, PermissionService, ScopeService, adminGrants, type AuthUser } from '@trinity/rbac-nest'
import {
  assertCanEditRole,
  assertCanGrantRoles,
  assertCanManageUser,
  assertCanModifyExistingRole,
  lockAdminMutation,
} from './role-guardrails'
import { RbacAuditService } from './rbac-audit.service'
import { grantsToRows, parseGrantsInput } from './grants-input'
import type { CreateRoleDto } from './dto/create-role.dto'
import type { UpdateRoleDto } from './dto/update-role.dto'

interface RoleRow {
  id: number
  name: string
  description: string | null
  is_system: boolean
  grants: { permission: string; scope: string | null }[]
  _count: { user_roles: number }
}

const ROLE_SELECT = {
  id: true,
  name: true,
  description: true,
  is_system: true,
  grants: { select: { permission: true, scope: true } },
  _count: { select: { user_roles: { where: { user: { deleted_at: null } } } } },
} satisfies Prisma.RoleSelect

function rowsToGrants(rows: { permission: string; scope: string | null }[]): Grants {
  const g: Grants = {}
  for (const r of rows) {
    const v = normalizeGrant(r.permission, r.scope)
    if (v !== null) g[r.permission as Permission] = v
  }
  return g
}

/** Quản trị = mọi quyền (không lưu dòng `role_permissions`) — trả đủ cho UI/clone. */
function effectiveGrants(r: RoleRow): Grants {
  return r.is_system ? adminGrants() : rowsToGrants(r.grants)
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: RbacAuditService,
    private readonly rbacCache: RbacCache,
    private readonly scope: ScopeService,
    private readonly permissionService: PermissionService,
  ) {}

  async list() {
    const roles = await this.prisma.role.findMany({ orderBy: { id: 'asc' }, select: ROLE_SELECT })
    return roles.map((r) => this.summary(r))
  }

  async get(id: number) {
    const r = await this.load(id)
    return { ...this.summary(r), grants: effectiveGrants(r) }
  }

  async create(actor: AuthUser, dto: CreateRoleDto) {
    const name = dto.name.trim()
    const grants = parseGrantsInput(dto.grants)
    assertCanEditRole(actor, { is_system: false }, grants)
    await this.assertNameFree(name)
    const id = await this.insertRole(actor, name, dto.description?.trim() || null, grants, 'role.create')
    return this.get(id)
  }

  async clone(actor: AuthUser, id: number) {
    const src = await this.load(id)
    const grants = effectiveGrants(src)
    assertCanEditRole(actor, { is_system: false }, grants)
    const name = await this.freeCopyName(src.name)
    const newId = await this.insertRole(actor, name, src.description, grants, 'role.create')
    return this.get(newId)
  }

  async update(actor: AuthUser, id: number, dto: UpdateRoleDto) {
    const role = await this.load(id)
    assertCanModifyExistingRole(actor, role, effectiveGrants(role))
    const name = dto.name !== undefined ? dto.name.trim() : role.name
    if (name.toLowerCase() !== role.name.toLowerCase()) await this.assertNameFree(name, id)
    const description = dto.description !== undefined ? dto.description?.trim() || null : role.description
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id }, data: { name, description } })
      await this.audit.record(tx, {
        actorId: actor.userId,
        action: 'role.update',
        targetType: 'role',
        targetId: id,
        before: { name: role.name, description: role.description },
        after: { name, description },
      })
    })
    return this.get(id)
  }

  async setGrants(actor: AuthUser, id: number, input: Record<string, unknown>) {
    const role = await this.load(id)
    const before = effectiveGrants(role)
    assertCanModifyExistingRole(actor, role, before)
    const next = parseGrantsInput(input)
    assertCanEditRole(actor, role, next)
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { role_id: id } })
      await tx.rolePermission.createMany({ data: grantsToRows(id, next) })
      await this.audit.record(tx, {
        actorId: actor.userId,
        action: 'role.grants',
        targetType: 'role',
        targetId: id,
        before,
        after: next,
      })
    })
    await this.invalidateMembers(id)
    return this.get(id)
  }

  async remove(actor: AuthUser, id: number) {
    const role = await this.load(id)
    if (role.is_system) throw new ConflictException('Không thể xoá vai trò hệ thống')
    const grants = effectiveGrants(role)
    assertCanModifyExistingRole(actor, role, grants)
    if (role._count.user_roles > 0) {
      throw new ConflictException(`Không thể xoá vai trò đang có ${role._count.user_roles} người giữ`)
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id } })
      await this.audit.record(tx, {
        actorId: actor.userId,
        action: 'role.delete',
        targetType: 'role',
        targetId: id,
        before: { name: role.name, description: role.description, grants },
      })
    })
    return { message: 'Đã xoá vai trò' }
  }

  /**
   * Người giữ vai trò. `roles.manage` KHÔNG kéo theo quyền xem người dùng →
   * email (PII) chỉ trả cho người nằm trong phạm vi `users.view` của actor;
   * ngoài phạm vi chỉ lộ id/tên/trạng thái (email = null).
   */
  async members(actor: AuthUser, id: number) {
    await this.load(id)
    const owners = await this.scope.ownerIds(actor, 'users.view')
    const visible = owners === 'all' ? null : new Set(owners ?? [])
    const rows = await this.prisma.userRole.findMany({
      where: { role_id: id, user: { deleted_at: null } },
      select: { user: { select: { id: true, full_name: true, email: true, status: true } } },
      orderBy: { user_id: 'asc' },
    })
    return rows.map(({ user }) => ({
      ...user,
      email: visible === null || visible.has(user.id) ? user.email : null,
    }))
  }

  /** `PUT /users/:id/roles` — THAY toàn bộ vai trò của 1 người. */
  async setUserRoles(actor: AuthUser, userId: number, roleIds: number[]) {
    await assertCanManageUser(this.scope, this.permissionService, actor, userId)
    const target = await this.prisma.user.findFirst({
      where: { id: userId, deleted_at: null },
      select: { id: true, status: true },
    })
    if (!target) throw new NotFoundException('Không tìm thấy người dùng')
    await assertCanGrantRoles(this.prisma, this.scope, actor, userId, roleIds)
    await this.prisma.$transaction(async (tx) => {
      await lockAdminMutation(tx)
      await this.replaceUserRoles(tx, actor, target, roleIds)
    })
    await this.rbacCache.invalidateUsers([userId])
    return this.userRoles(userId)
  }

  private async replaceUserRoles(
    tx: Prisma.TransactionClient,
    actor: AuthUser,
    target: { id: number; status: string },
    roleIds: number[],
  ): Promise<void> {
    const prev = await tx.userRole.findMany({
      where: { user_id: target.id },
      select: { role_id: true, role: { select: { name: true, is_system: true } } },
    })
    const prevIds = prev.map((p) => p.role_id).sort((a, b) => a - b)
    const nextIds = [...roleIds].sort((a, b) => a - b)
    if (prevIds.join(',') === nextIds.join(',')) return
    await tx.userRole.deleteMany({ where: { user_id: target.id } })
    await tx.userRole.createMany({ data: nextIds.map((role_id) => ({ user_id: target.id, role_id })) })
    const next = await tx.role.findMany({ where: { id: { in: nextIds } }, select: { name: true, is_system: true } })
    if (target.status === 'active' && prev.some((p) => p.role.is_system) && !next.some((r) => r.is_system)) {
      const remaining = await tx.user.count({
        where: { status: 'active', deleted_at: null, user_roles: { some: { role: { is_system: true } } } },
      })
      if (remaining === 0) throw new ConflictException('Phải còn ít nhất 1 Quản trị')
    }
    await this.audit.record(tx, {
      actorId: actor.userId,
      action: 'user.roles',
      targetType: 'user',
      targetId: target.id,
      before: { roleIds: prevIds, roles: prev.map((p) => p.role.name) },
      after: { roleIds: nextIds, roles: next.map((r) => r.name) },
    })
  }

  private async userRoles(userId: number) {
    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      select: { role: { select: { id: true, name: true, is_system: true } } },
    })
    return { user_id: userId, roles: rows.map((r) => r.role) }
  }

  private async insertRole(
    actor: AuthUser,
    name: string,
    description: string | null,
    grants: Grants,
    action: 'role.create',
  ): Promise<number> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.create({ data: { name, description, is_system: false } })
        await tx.rolePermission.createMany({ data: grantsToRows(role.id, grants) })
        await this.audit.record(tx, {
          actorId: actor.userId,
          action,
          targetType: 'role',
          targetId: role.id,
          after: { name, description, grants },
        })
        return role.id
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Tên vai trò đã tồn tại')
      }
      throw e
    }
  }

  private async load(id: number): Promise<RoleRow> {
    const role = await this.prisma.role.findUnique({ where: { id }, select: ROLE_SELECT })
    if (!role) throw new NotFoundException('Không tìm thấy vai trò')
    return role
  }

  private summary(r: RoleRow) {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      is_system: r.is_system,
      member_count: r._count.user_roles,
    }
  }

  private async assertNameFree(name: string, exceptId?: number): Promise<void> {
    const dup = await this.prisma.role.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    })
    if (dup) throw new ConflictException('Tên vai trò đã tồn tại')
  }

  private async freeCopyName(base: string): Promise<string> {
    for (let i = 1; i < 100; i += 1) {
      const name = i === 1 ? `${base} (bản sao)` : `${base} (bản sao ${i})`
      const dup = await this.prisma.role.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      })
      if (!dup) return name
    }
    throw new ConflictException('Quá nhiều bản sao cùng tên')
  }

  private async invalidateMembers(roleId: number): Promise<void> {
    const rows = await this.prisma.userRole.findMany({ where: { role_id: roleId }, select: { user_id: true } })
    if (rows.length > 0) await this.rbacCache.invalidateUsers(rows.map((r) => r.user_id))
  }
}
