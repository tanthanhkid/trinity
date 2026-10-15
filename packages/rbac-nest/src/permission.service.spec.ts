import { ALL_PERMISSIONS, PERMISSIONS } from '@trinity/rbac'
import { PermissionService } from './permission.service'
import { RbacCache } from './rbac-cache'

describe('PermissionService', () => {
  let prisma: { userRole: { findMany: jest.Mock } }
  let cache: RbacCache
  let service: PermissionService

  beforeEach(() => {
    prisma = { userRole: { findMany: jest.fn() } }
    cache = new RbacCache()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new PermissionService(prisma as any, cache)
  })

  afterEach(async () => {
    await cache.onModuleDestroy()
  })

  it('user giữ vai trò is_system → isAdmin true, mọi quyền scoped=all, không scoped=true', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      { role: { is_system: true, grants: [] } },
    ])
    const { grants, isAdmin } = await service.grantsFor(1)
    expect(isAdmin).toBe(true)
    for (const p of ALL_PERMISSIONS) {
      expect(grants[p]).toBe(PERMISSIONS[p].scoped ? 'all' : true)
    }
  })

  it('hợp nhiều vai trò, lấy scope rộng nhất + quyền không scoped', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      {
        role: {
          is_system: false,
          grants: [{ permission: 'contacts.view', scope: 'own' }],
        },
      },
      {
        role: {
          is_system: false,
          grants: [
            { permission: 'contacts.view', scope: 'subtree' },
            { permission: 'contacts.create', scope: null },
          ],
        },
      },
    ])
    const { grants, isAdmin } = await service.grantsFor(2)
    expect(isAdmin).toBe(false)
    expect(grants).toEqual({ 'contacts.view': 'subtree', 'contacts.create': true })
  })

  it('dòng khoá lạ bị bỏ qua', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      {
        role: {
          is_system: false,
          grants: [{ permission: 'unknown.view', scope: 'own' }],
        },
      },
    ])
    const { grants } = await service.grantsFor(3)
    expect(grants).toEqual({})
  })

  it('cache: gọi 2 lần chỉ query Prisma 1 lần, invalidate xong query lại', async () => {
    prisma.userRole.findMany.mockResolvedValue([
      { role: { is_system: false, grants: [{ permission: 'contacts.create', scope: null }] } },
    ])
    await service.grantsFor(4)
    await service.grantsFor(4)
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(1)

    await cache.invalidateUsers([4])
    await service.grantsFor(4)
    expect(prisma.userRole.findMany).toHaveBeenCalledTimes(2)
  })
})
