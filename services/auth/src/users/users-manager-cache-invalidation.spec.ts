import { PrismaClient, PrismaService } from '@trinity/prisma'
import { RbacCache, ScopeService, PermissionService, TokenBlacklistService } from '@trinity/rbac-nest'
import type { AuthUser } from '@trinity/rbac-nest'
import { UsersService } from './users.service'
import { AuditLogService } from '../auth/services/audit-log.service'

/**
 * Đổi `manager_id` qua
 * `UsersService.update()` PHẢI làm `ScopeService.ownerIds` phản ánh NGAY
 * (không đợi TTL cache 60s hết hạn) — "không cần đăng nhập lại khi
 * admin sửa quyền/cây quản lý".
 *
 * `assertManagerActive`: manager chỉ cần active, không ràng buộc theo tên vai
 * trò — test này không cần seed vai trò giả.
 *
 * Chạy trên Postgres thật (tương tự packages/rbac-nest/src/scope.service.spec.ts)
 * — tự skip khi thiếu RBAC_TEST_DATABASE_URL, KHÔNG fake xanh.
 */
const DB_URL = process.env.RBAC_TEST_DATABASE_URL
const describeDb = DB_URL ? describe : describe.skip

function mkUser(userId: number, grants: AuthUser['grants'] = { 'contacts.view': 'team' }): AuthUser {
  return { userId, email: `u${userId}@t`, isAdmin: false, grants }
}

/**
 * Actor Quản trị — chỉ để bypass `assertCanManageUser` trong `update()`,
 * không liên quan hành vi đang test. `isAdmin:true` KHÔNG tự miễn
 * `assertInScope` (nó vẫn đọc `actor.grants['users.manage']` qua
 * `ScopeService.ownerIds` trước khi xét `isAdmin`) — mirror ĐÚNG cách
 * `PermissionService.grantsFor()` populate `adminGrants()` (mọi quyền scoped
 * = `'all'`) cho Quản trị thật, nếu không `ownerIds` trả `null` (không có
 * grant) → 404 oan dù actor là Quản trị.
 */
function mkAdmin(userId: number): AuthUser {
  return { userId, email: `admin${userId}@t`, isAdmin: true, grants: { 'users.manage': 'all' } }
}

describeDb('UsersService.update() → invalidate cache ScopeService (Postgres thật)', () => {
  let prisma: PrismaClient
  let cache: RbacCache
  let scope: ScopeService
  let usersService: UsersService
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } })
    await prisma.$executeRawUnsafe('TRUNCATE TABLE user_roles, users RESTART IDENTITY CASCADE')

    const mk = async (email: string) =>
      (
        await prisma.user.create({
          data: { email, password_hash: 'x', full_name: email, status: 'active' },
        })
      ).id

    ids.manager = await mk('mgr@t')
    ids.sale = await mk('sale@t')
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(() => {
    cache = new RbacCache()
    scope = new ScopeService(prisma as unknown as PrismaService, cache)
    const permissionService = new PermissionService(prisma as unknown as PrismaService, cache)
    usersService = new UsersService(
      prisma as unknown as PrismaService,
      new TokenBlacklistService(),
      new AuditLogService(prisma as unknown as PrismaService),
      cache,
      scope,
      permissionService,
    )
  })

  afterEach(async () => {
    await cache.onModuleDestroy()
  })

  it("đổi manager_id → ownerIds(scope='team') của manager mới thấy NGAY, không cần đợi TTL", async () => {
    const manager = mkUser(ids.manager)

    // Trước khi gán: manager CHƯA quản lý sale.
    const before = await scope.ownerIds(manager, 'contacts.view')
    expect(before).toEqual([ids.manager])

    // Đổi manager_id của sale → manager (đi qua ĐÚNG UsersService.update() thật,
    // KHÔNG ghi thẳng Prisma) — actor Quản trị để bypass `assertCanManageUser`
    // (guardrail chống leo thang, không liên quan tới hành vi đang test).
    await usersService.update(ids.sale, { manager_id: ids.manager }, mkAdmin(999))

    // ScopeService PHẢI thấy ngay — không đợi TTL cache 60s.
    const after = await scope.ownerIds(manager, 'contacts.view')
    expect(after).toEqual(expect.arrayContaining([ids.manager, ids.sale]))
    expect(after).toHaveLength(2)
  })
})
