import { PrismaClient, PrismaService } from '@trinity/prisma'
import { ScopeService } from './scope.service'
import { RbacCache } from './rbac-cache'
import type { AuthUser } from './auth-user'

const DB_URL = process.env.RBAC_TEST_DATABASE_URL
const describeDb = DB_URL ? describe : describe.skip

function mkUser(userId: number, grants: AuthUser['grants']): AuthUser {
  return { userId, email: `u${userId}@t`, isAdmin: false, grants }
}

describeDb('ScopeService (Postgres thật)', () => {
  let prisma: PrismaClient
  let cache: RbacCache
  let service: ScopeService
  // id thật của user seed trong DB, theo cây:
  // root(1) -> a(2), b(3); a(2) -> c(4); c(4) -> d(5)
  // vòng lặp: x(8) <-> y(9)
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } })
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE user_roles, users RESTART IDENTITY CASCADE',
    )

    const mk = async (email: string, managerId: number | null) => {
      const u = await prisma.user.create({
        data: {
          email,
          password_hash: 'x',
          full_name: email,
          status: 'active',
          manager_id: managerId,
        },
      })
      return u.id
    }

    ids.root = await mk('root@t', null)
    ids.a = await mk('a@t', ids.root)
    ids.b = await mk('b@t', ids.root)
    ids.c = await mk('c@t', ids.a)
    ids.d = await mk('d@t', ids.c)
    ids.x = await mk('x@t', null)
    ids.y = await mk('y@t', ids.x)
    // vòng lặp cố ý: x.manager_id = y (test phòng thủ CTE không treo)
    await prisma.user.update({ where: { id: ids.x }, data: { manager_id: ids.y } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(() => {
    cache = new RbacCache()
    service = new ScopeService(prisma as unknown as PrismaService, cache)
  })

  afterEach(async () => {
    await cache.onModuleDestroy()
  })

  it("scope 'own' → chỉ chính mình", async () => {
    const user = mkUser(ids.a, { 'contacts.view': 'own' })
    await expect(service.ownerIds(user, 'contacts.view')).resolves.toEqual([ids.a])
  })

  it("scope 'team' → mình + cấp dưới trực tiếp", async () => {
    const user = mkUser(ids.a, { 'contacts.view': 'team' })
    const result = await service.ownerIds(user, 'contacts.view')
    expect(result).toEqual(expect.arrayContaining([ids.a, ids.c]))
    expect(result).toHaveLength(2)
  })

  it("scope 'subtree' → mình + toàn bộ hậu duệ", async () => {
    const user = mkUser(ids.root, { 'contacts.view': 'subtree' })
    const result = await service.ownerIds(user, 'contacts.view')
    expect(result).toEqual(expect.arrayContaining([ids.root, ids.a, ids.b, ids.c, ids.d]))
    expect(result).toHaveLength(5)
  })

  it("scope 'all' → 'all'", async () => {
    const user = mkUser(ids.a, { 'contacts.view': 'all' })
    await expect(service.ownerIds(user, 'contacts.view')).resolves.toBe('all')
  })

  it('không có quyền → null', async () => {
    const user = mkUser(ids.a, {})
    await expect(service.ownerIds(user, 'contacts.view')).resolves.toBeNull()
  })

  it('vòng lặp manager không làm CTE treo — subtree(x) → [x, y]', async () => {
    const user = mkUser(ids.x, { 'contacts.view': 'subtree' })
    const result = await service.ownerIds(user, 'contacts.view')
    expect(result).toEqual(expect.arrayContaining([ids.x, ids.y]))
    expect(result).toHaveLength(2)
  })
})
