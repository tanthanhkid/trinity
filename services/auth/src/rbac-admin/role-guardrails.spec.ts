import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import type { AuthUser, PermissionService, ScopeService } from '@trinity/rbac-nest'
import {
  assertCanEditRole,
  assertCanGrantRoles,
  assertCanManageUser,
  assertCanModifyExistingRole,
  assertNotLastAdmin,
} from './role-guardrails'

function mkUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return { userId: 1, email: 'a@t', isAdmin: false, grants: {}, ...overrides }
}

describe('assertCanEditRole', () => {
  it('vai trò hệ thống → 403 dù actor là Quản trị', () => {
    const admin = mkUser({ isAdmin: true, grants: {} })
    expect(() => assertCanEditRole(admin, { is_system: true }, {})).toThrow(ForbiddenException)
  })

  it('quyền mới ⊆ quyền actor → pass', () => {
    const actor = mkUser({ grants: { 'contacts.view': 'all', 'roles.manage': true } })
    expect(() =>
      assertCanEditRole(actor, { is_system: false }, { 'contacts.view': 'own' }),
    ).not.toThrow()
  })

  it('quyền mới có scope RỘNG hơn actor → 403', () => {
    const actor = mkUser({ grants: { 'contacts.view': 'team', 'roles.manage': true } })
    expect(() =>
      assertCanEditRole(actor, { is_system: false }, { 'contacts.view': 'all' }),
    ).toThrow(ForbiddenException)
  })

  it('quyền mới có khoá actor KHÔNG có → 403', () => {
    const actor = mkUser({ grants: { 'roles.manage': true } })
    expect(() =>
      assertCanEditRole(actor, { is_system: false }, { 'payroll.view': 'own' }),
    ).toThrow(ForbiddenException)
  })

  it('actor.isAdmin → bỏ qua kiểm isSubset (Quản trị cấp được mọi quyền)', () => {
    const admin = mkUser({ isAdmin: true, grants: {} })
    expect(() =>
      assertCanEditRole(admin, { is_system: false }, { 'payroll.view': 'all' }),
    ).not.toThrow()
  })
})

describe('assertCanGrantRoles', () => {
  function mkPrisma() {
    return {
      role: { findMany: jest.fn() },
      userRole: { findFirst: jest.fn() },
      user: { count: jest.fn() },
    } as unknown as PrismaService & {
      role: { findMany: jest.Mock }
      userRole: { findFirst: jest.Mock }
      user: { count: jest.Mock }
    }
  }
  function mkScope(ownerIds: number[] | 'all' | null) {
    return { ownerIds: jest.fn().mockResolvedValue(ownerIds) } as unknown as ScopeService
  }

  it('target ngoài scope users.manage → 404, không đọc role', async () => {
    const prisma = mkPrisma()
    const scope = mkScope([1])
    const actor = mkUser({ userId: 1, grants: { 'users.manage': 'team' } })

    await expect(assertCanGrantRoles(prisma, scope, actor, 99, [5])).rejects.toThrow(
      NotFoundException,
    )
    expect(prisma.role.findMany).not.toHaveBeenCalled()
  })

  it('roleIds có id không tồn tại → 404', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([{ id: 5, is_system: false, grants: [] }])
    const scope = mkScope('all')
    const actor = mkUser({ isAdmin: true })

    await expect(assertCanGrantRoles(prisma, scope, actor, 2, [5, 6])).rejects.toThrow(
      NotFoundException,
    )
  })

  it('actor thường gán vai trò hệ thống → 403', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([{ id: 1, is_system: true, grants: [] }])
    const scope = mkScope('all')
    const actor = mkUser({ grants: { 'users.manage': 'all' } })

    await expect(assertCanGrantRoles(prisma, scope, actor, 2, [1])).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('hợp quyền vai trò mới KHÔNG ⊆ quyền actor → 403', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([
      { id: 5, is_system: false, grants: [{ permission: 'payroll.manage', scope: null }] },
    ])
    const scope = mkScope('all')
    const actor = mkUser({ grants: { 'users.manage': 'all' } })

    await expect(assertCanGrantRoles(prisma, scope, actor, 2, [5])).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('hợp quyền vai trò mới ⊆ quyền actor → pass', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([
      { id: 5, is_system: false, grants: [{ permission: 'contacts.view', scope: 'own' }] },
    ])
    prisma.userRole.findFirst.mockResolvedValue(null)
    const scope = mkScope('all')
    const actor = mkUser({
      userId: 1,
      grants: { 'users.manage': 'all', 'contacts.view': 'all' },
    })

    await expect(assertCanGrantRoles(prisma, scope, actor, 2, [5])).resolves.toBeUndefined()
  })

  it('actor thường tự đổi vai trò CHÍNH MÌNH → 403', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([
      { id: 5, is_system: false, grants: [{ permission: 'contacts.view', scope: 'own' }] },
    ])
    const scope = mkScope('all')
    const actor = mkUser({
      userId: 7,
      grants: { 'users.manage': 'all', 'contacts.view': 'all' },
    })

    await expect(assertCanGrantRoles(prisma, scope, actor, 7, [5])).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('Quản trị tự đổi vai trò chính mình (giữ nguyên hệ thống) → pass', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([{ id: 1, is_system: true, grants: [] }])
    const scope = mkScope('all')
    const admin = mkUser({ userId: 1, isAdmin: true })

    await expect(assertCanGrantRoles(prisma, scope, admin, 1, [1])).resolves.toBeUndefined()
  })

  it('gỡ Quản trị khỏi Quản trị CUỐI CÙNG → 409', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([
      { id: 5, is_system: false, grants: [{ permission: 'contacts.view', scope: 'own' }] },
    ])
    prisma.userRole.findFirst.mockResolvedValue({ user_id: 1 })
    prisma.user.count.mockResolvedValue(0)
    const scope = mkScope('all')
    const admin = mkUser({ userId: 1, isAdmin: true })

    await expect(assertCanGrantRoles(prisma, scope, admin, 1, [5])).rejects.toThrow(
      ConflictException,
    )
  })

  it('gỡ Quản trị khỏi 1 người NHƯNG còn Quản trị khác hoạt động → pass', async () => {
    const prisma = mkPrisma()
    prisma.role.findMany.mockResolvedValue([
      { id: 5, is_system: false, grants: [{ permission: 'contacts.view', scope: 'own' }] },
    ])
    prisma.userRole.findFirst.mockResolvedValue({ user_id: 2 })
    prisma.user.count.mockResolvedValue(1)
    const scope = mkScope('all')
    const admin = mkUser({ userId: 1, isAdmin: true })

    await expect(assertCanGrantRoles(prisma, scope, admin, 2, [5])).resolves.toBeUndefined()
  })
})

describe('assertCanManageUser', () => {
  function mkScope(ownerIds: number[] | 'all' | null) {
    return { ownerIds: jest.fn().mockResolvedValue(ownerIds) } as unknown as ScopeService
  }
  function mkPermissionService(result: { grants: Record<string, unknown>; isAdmin: boolean }) {
    return { grantsFor: jest.fn().mockResolvedValue(result) } as unknown as PermissionService
  }

  it('target ngoài scope users.manage → 404', async () => {
    const scope = mkScope([1])
    const perm = mkPermissionService({ grants: {}, isAdmin: false })
    const actor = mkUser({ userId: 1, grants: { 'users.manage': 'own' } })

    await expect(assertCanManageUser(scope, perm, actor, 99)).rejects.toThrow(NotFoundException)
  })

  it('actor Quản trị → luôn pass (không kiểm isSubset)', async () => {
    const scope = mkScope('all')
    const perm = mkPermissionService({ grants: { 'roles.manage': true }, isAdmin: true })
    const admin = mkUser({ isAdmin: true })

    await expect(assertCanManageUser(scope, perm, admin, 2)).resolves.toBeUndefined()
  })

  it('target có quyền KHÔNG ⊆ quyền actor → 403', async () => {
    const scope = mkScope('all')
    const perm = mkPermissionService({ grants: { 'payroll.manage': true }, isAdmin: false })
    const actor = mkUser({ grants: { 'users.manage': 'all' } })

    await expect(assertCanManageUser(scope, perm, actor, 2)).rejects.toThrow(ForbiddenException)
  })

  it('target là Quản trị (isAdmin) mà actor không phải → 403', async () => {
    const scope = mkScope('all')
    const perm = mkPermissionService({ grants: {}, isAdmin: true })
    const actor = mkUser({ grants: { 'users.manage': 'all' } })

    await expect(assertCanManageUser(scope, perm, actor, 2)).rejects.toThrow(ForbiddenException)
  })

  it('target có quyền ⊆ quyền actor → pass', async () => {
    const scope = mkScope('all')
    const perm = mkPermissionService({ grants: { 'contacts.view': 'own' }, isAdmin: false })
    const actor = mkUser({ grants: { 'users.manage': 'all', 'contacts.view': 'all' } })

    await expect(assertCanManageUser(scope, perm, actor, 2)).resolves.toBeUndefined()
  })
})

describe('assertCanGrantRoles — người thường KHÔNG gỡ được Quản trị của người khác', () => {
  it('actor thường gửi danh sách không chứa vai trò hệ thống cho 1 Quản trị → 403', async () => {
    const prisma = {
      role: { findMany: jest.fn().mockResolvedValue([{ id: 5, is_system: false, grants: [] }]) },
      userRole: { findFirst: jest.fn().mockResolvedValue({ user_id: 2 }) },
      user: { count: jest.fn() },
    } as unknown as PrismaService
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') } as unknown as ScopeService
    const actor = mkUser({ userId: 1, grants: { 'users.manage': 'all' } })

    await expect(assertCanGrantRoles(prisma, scope, actor, 2, [5])).rejects.toThrow(ForbiddenException)
  })
})

describe('assertCanModifyExistingRole', () => {
  const actor = mkUser({ grants: { 'contacts.view': 'team', 'roles.manage': true } })

  it('vai trò hệ thống → 403 kể cả Quản trị', () => {
    expect(() => assertCanModifyExistingRole(mkUser({ isAdmin: true }), { is_system: true }, {})).toThrow(
      ForbiddenException,
    )
  })

  it('quyền hiện có của vai trò vượt actor → 403 (không phá được vai trò "to" hơn mình)', () => {
    expect(() =>
      assertCanModifyExistingRole(actor, { is_system: false }, { 'contacts.view': 'all' }),
    ).toThrow(ForbiddenException)
  })

  it('quyền hiện có ⊆ actor → pass', () => {
    expect(() =>
      assertCanModifyExistingRole(actor, { is_system: false }, { 'contacts.view': 'own' }),
    ).not.toThrow()
  })

  it('Quản trị sửa vai trò thường bất kỳ → pass', () => {
    expect(() =>
      assertCanModifyExistingRole(mkUser({ isAdmin: true }), { is_system: false }, { 'contacts.view': 'all' }),
    ).not.toThrow()
  })
})

describe('assertNotLastAdmin (Quản trị cuối cùng)', () => {
  function mkDb(targetIsAdmin: boolean, otherAdmins: number) {
    return {
      user: {
        findFirst: jest.fn().mockResolvedValue(targetIsAdmin ? { id: 9 } : null),
        count: jest.fn().mockResolvedValue(otherAdmins),
      },
    } as unknown as Parameters<typeof assertNotLastAdmin>[0]
  }

  it('target không phải Quản trị → pass', async () => {
    await expect(assertNotLastAdmin(mkDb(false, 0), 9)).resolves.toBeUndefined()
  })

  it('target là Quản trị, còn Quản trị khác → pass', async () => {
    await expect(assertNotLastAdmin(mkDb(true, 1), 9)).resolves.toBeUndefined()
  })

  it('target là Quản trị DUY NHẤT → 409', async () => {
    await expect(assertNotLastAdmin(mkDb(true, 0), 9)).rejects.toThrow(ConflictException)
  })
})
