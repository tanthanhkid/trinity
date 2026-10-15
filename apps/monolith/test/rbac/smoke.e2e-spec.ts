import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

describe('RBAC E2E smoke (monolith thật, Postgres thật)', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp())
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  afterEach(async () => {
    await resetDb(prisma)
  })

  it("GET /api/v1/auth/me với user có {contacts.view:'team'} → permissions đúng", async () => {
    const u = await makeUser(prisma, { grants: { 'contacts.view': 'team', 'contacts.create': true } })

    const res = await api(app, u.token).get('/api/v1/auth/me').expect(200)

    expect(res.body.permissions).toEqual({ 'contacts.view': 'team', 'contacts.create': true })
    expect(res.body.isAdmin).toBe(false)
    expect(res.body.user.id).toBe(u.id)
  })

  it('GET /api/v1/auth/me với user admin → isAdmin true, mọi quyền scope all', async () => {
    const u = await makeUser(prisma, { admin: true })

    const res = await api(app, u.token).get('/api/v1/auth/me').expect(200)

    expect(res.body.isAdmin).toBe(true)
    expect(res.body.permissions['contacts.view']).toBe('all')
    expect(res.body.permissions['contacts.create']).toBe(true)
  })

  it('GET /api/v1/auth/me không token → 401', async () => {
    await api(app).get('/api/v1/auth/me').expect(401)
  })

  it('GET /api/v1/rbac/catalog → 62 quyền, 13 nhóm, 4 scope (mọi user đã đăng nhập đọc được)', async () => {
    const u = await makeUser(prisma, {})

    const res = await api(app, u.token).get('/api/v1/rbac/catalog').expect(200)

    // Danh mục hiện có 62 quyền trong 13 nhóm; thêm/bớt quyền thì cập nhật cả hai con số này.
    expect(res.body.permissions).toHaveLength(62)
    expect(res.body.groups).toHaveLength(13)
    expect(res.body.scopes).toHaveLength(4)
  })
})
