import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Cụm auth/users/teams/api-keys/public-api — E2E ma trận quyền.
 * Mỗi route tối thiểu 1 ca 403
 * (không quyền), 1 ca scope hẹp, 1 ca 404 theo id ngoài scope, và ca
 * `phone_full`/`export` nếu có. Chạy trên monolith + Postgres thật.
 */
describe('RBAC E2E — cụm auth/users/teams/api-keys/public-api', () => {
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
    // `UsersService.create()` auto-provision 1 row `employees` cho
    // MỌI user mới — `resetDb()` dùng chung chỉ lo bảng RBAC,
    // KHÔNG biết về `employees` → xoá users trước sẽ vướng FK. Dọn riêng ở
    // đây (mirror JSDoc harness.ts: "cụm nào cần xoá thêm bảng nghiệp vụ tự
    // gọi $executeRawUnsafe riêng").
    await prisma.$executeRawUnsafe(
      `DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`,
    )
    await resetDb(prisma)
  })

  describe('GET /api/v1/users — Mẫu A (owner = chính user)', () => {
    it('không quyền → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/users').expect(403)
    })

    it('scope own → chỉ thấy chính mình', async () => {
      const other = await makeUser(prisma)
      const u = await makeUser(prisma, { grants: { 'users.view': 'own' } })

      const res = await api(app, u.token).get('/api/v1/users').expect(200)
      const ids = res.body.data.map((r: { id: number }) => r.id)
      expect(ids).toContain(u.id)
      expect(ids).not.toContain(other.id)
    })

    it('scope team → thấy cấp dưới trực tiếp, KHÔNG thấy cháu', async () => {
      const manager = await makeUser(prisma, { grants: { 'users.view': 'team' } })
      const directReport = await makeUser(prisma, { managerId: manager.id })
      const grandChild = await makeUser(prisma, { managerId: directReport.id })

      const res = await api(app, manager.token).get('/api/v1/users').expect(200)
      const ids = res.body.data.map((r: { id: number }) => r.id)
      expect(ids).toContain(manager.id)
      expect(ids).toContain(directReport.id)
      expect(ids).not.toContain(grandChild.id)
    })

    it('Mẫu C — thiếu users.phone_full → SĐT bị che; có → SĐT thật', async () => {
      const target = await makeUser(prisma)
      await prisma.user.update({ where: { id: target.id }, data: { phone: '0912345678' } })

      const masked = await makeUser(prisma, { grants: { 'users.view': 'all' } })
      const resMasked = await api(app, masked.token).get('/api/v1/users').expect(200)
      const rowMasked = resMasked.body.data.find((r: { id: number }) => r.id === target.id)
      expect(rowMasked.phone).toBe('***678')

      const full = await makeUser(prisma, {
        grants: { 'users.view': 'all', 'users.phone_full': 'all' },
      })
      const resFull = await api(app, full.token).get('/api/v1/users').expect(200)
      const rowFull = resFull.body.data.find((r: { id: number }) => r.id === target.id)
      expect(rowFull.phone).toBe('0912345678')
    })
  })

  describe('GET /api/v1/users/export — Mẫu C export', () => {
    it('không có users.export → 403', async () => {
      const u = await makeUser(prisma, { grants: { 'users.view': 'all' } })
      await api(app, u.token).get('/api/v1/users/export').expect(403)
    })

    it('có users.export → 200, đúng content-type xlsx', async () => {
      const u = await makeUser(prisma, { grants: { 'users.export': 'all' } })
      const res = await api(app, u.token).get('/api/v1/users/export').expect(200)
      expect(res.headers['content-type']).toContain('spreadsheetml')
    })
  })

  describe('GET /api/v1/users/:id — Mẫu B', () => {
    it('ngoài scope own → 404', async () => {
      const other = await makeUser(prisma)
      const u = await makeUser(prisma, { grants: { 'users.view': 'own' } })
      await api(app, u.token).get(`/api/v1/users/${other.id}`).expect(404)
    })

    it('trong scope → 200', async () => {
      const u = await makeUser(prisma, { grants: { 'users.view': 'own' } })
      const res = await api(app, u.token).get(`/api/v1/users/${u.id}`).expect(200)
      expect(res.body.id).toBe(u.id)
    })
  })

  describe('POST /api/v1/users — tạo mới', () => {
    it('không có users.manage → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token)
        .post('/api/v1/users')
        .send({ email: 'new1@rbac-e2e.test', full_name: 'New 1', password: 'password123' })
        .expect(403)
    })

    it('có users.manage → 201, KHÔNG cần role', async () => {
      const u = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      const res = await api(app, u.token)
        .post('/api/v1/users')
        .send({ email: 'new2@rbac-e2e.test', full_name: 'New 2', password: 'password123' })
        .expect(201)
      expect(res.body.email).toBe('new2@rbac-e2e.test')
    })
  })

  describe('PATCH /api/v1/users/:id — sửa + chống leo thang', () => {
    it('tự sửa chính mình → 403', async () => {
      const u = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      await api(app, u.token)
        .patch(`/api/v1/users/${u.id}`)
        .send({ full_name: 'X' })
        .expect(403)
    })

    it('target ngoài scope users.manage (own) → 404', async () => {
      const other = await makeUser(prisma)
      const u = await makeUser(prisma, { grants: { 'users.manage': 'own' } })
      await api(app, u.token)
        .patch(`/api/v1/users/${other.id}`)
        .send({ full_name: 'X' })
        .expect(404)
    })

    it('target có quyền KHÔNG ⊆ quyền actor → 403', async () => {
      const target = await makeUser(prisma, { grants: { 'payroll.manage': true } })
      const actor = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      await api(app, actor.token)
        .patch(`/api/v1/users/${target.id}`)
        .send({ full_name: 'X' })
        .expect(403)
    })

    it('trong scope + quyền target ⊆ actor → 200', async () => {
      const target = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const actor = await makeUser(prisma, {
        grants: { 'users.manage': 'all', 'contacts.view': 'all' },
      })
      const res = await api(app, actor.token)
        .patch(`/api/v1/users/${target.id}`)
        .send({ full_name: 'Đổi tên' })
        .expect(200)
      expect(res.body.full_name).toBe('Đổi tên')
    })
  })

  describe('PATCH /api/v1/users/:id/reset-password', () => {
    it('không có users.manage → 403', async () => {
      const target = await makeUser(prisma)
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token)
        .patch(`/api/v1/users/${target.id}/reset-password`)
        .send({ password: 'NewPassword123' })
        .expect(403)
    })

    it('target có quyền cao hơn actor → 403', async () => {
      const target = await makeUser(prisma, { grants: { 'roles.manage': true } })
      const actor = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      await api(app, actor.token)
        .patch(`/api/v1/users/${target.id}/reset-password`)
        .send({ password: 'NewPassword123' })
        .expect(403)
    })

    it('hợp lệ → 200, KHÔNG trả password trong response', async () => {
      const target = await makeUser(prisma)
      const actor = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      const res = await api(app, actor.token)
        .patch(`/api/v1/users/${target.id}/reset-password`)
        .send({ password: 'NewPassword123' })
        .expect(200)
      expect(res.body).not.toHaveProperty('password')
    })
  })

  describe('DELETE /api/v1/users/:id/permanent', () => {
    it('ngoài scope → 404', async () => {
      const other = await makeUser(prisma)
      const u = await makeUser(prisma, { grants: { 'users.manage': 'own' } })
      await api(app, u.token).delete(`/api/v1/users/${other.id}/permanent`).expect(404)
    })

    it('trong scope → 200', async () => {
      const target = await makeUser(prisma)
      const actor = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      await api(app, actor.token).delete(`/api/v1/users/${target.id}/permanent`).expect(200)
    })
  })

  describe('GET /api/v1/users/me/pinned-menu — @AuthOnly, không cần quyền nghiệp vụ', () => {
    it('không token → 401', async () => {
      await api(app).get('/api/v1/users/me/pinned-menu').expect(401)
    })

    it('bất kỳ user đăng nhập nào (grants rỗng) → 200', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/users/me/pinned-menu').expect(200)
    })
  })

  describe('PATCH /api/v1/users/:id/team', () => {
    it('không có users.manage → 403', async () => {
      const target = await makeUser(prisma)
      const team = await prisma.team.create({ data: { name: `Team-${Date.now()}` } })
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token)
        .patch(`/api/v1/users/${target.id}/team`)
        .send({ team_id: team.id })
        .expect(403)
    })

    it('có users.manage, trong scope → 200', async () => {
      const target = await makeUser(prisma)
      const team = await prisma.team.create({ data: { name: `Team-${Date.now()}-2` } })
      const actor = await makeUser(prisma, { grants: { 'users.manage': 'all' } })
      const res = await api(app, actor.token)
        .patch(`/api/v1/users/${target.id}/team`)
        .send({ team_id: team.id })
        .expect(200)
      expect(res.body.team_id).toBe(team.id)
    })
  })

  describe('GET/POST /api/v1/auth/teams — deprecated, đọc @AuthOnly + ghi org.manage', () => {
    it('GET không cần quyền nghiệp vụ (chỉ cần đăng nhập)', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/auth/teams').expect(200)
    })

    it('POST không có org.manage → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token)
        .post('/api/v1/auth/teams')
        .send({ name: `T-${Date.now()}`, leadUserId: u.id })
        .expect(403)
    })

    it('POST có org.manage → 201', async () => {
      const u = await makeUser(prisma, { grants: { 'org.manage': true } })
      await api(app, u.token)
        .post('/api/v1/auth/teams')
        .send({ name: `T-${Date.now()}`, leadUserId: u.id })
        .expect(201)
    })
  })

  describe('API keys — @Can(settings.integrations)', () => {
    it('GET /api/v1/api-keys không có settings.integrations → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/api-keys').expect(403)
    })

    it('POST /api/v1/api-keys owner KHÔNG có contacts.create → 400', async () => {
      const admin = await makeUser(prisma, { grants: { 'settings.integrations': true } })
      const owner = await makeUser(prisma, { grants: {} })
      await api(app, admin.token)
        .post('/api/v1/api-keys')
        .send({ name: 'Key test', scopes: ['auth:login'], owner_user_id: owner.id })
        .expect(400)
    })

    it('POST /api/v1/api-keys owner CÓ contacts.create → 201', async () => {
      const admin = await makeUser(prisma, { grants: { 'settings.integrations': true } })
      const owner = await makeUser(prisma, { grants: { 'contacts.create': true } })
      const res = await api(app, admin.token)
        .post('/api/v1/api-keys')
        .send({ name: 'Key test 2', scopes: ['auth:login'], owner_user_id: owner.id })
        .expect(201)
      expect(res.body.plain_key).toMatch(/^trinity_live_/)
    })
  })

  describe('Auth settings — đọc @AuthOnly, ghi settings.integrations', () => {
    it('GET login-wifi-check: bất kỳ user đăng nhập nào → 200', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/auth/settings/login-wifi-check').expect(200)
    })

    it('PATCH login-wifi-check không có settings.integrations → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token)
        .patch('/api/v1/auth/settings/login-wifi-check')
        .send({ enabled: true })
        .expect(403)
    })

    it('PATCH login-wifi-check có settings.integrations → 200', async () => {
      const u = await makeUser(prisma, { grants: { 'settings.integrations': true } })
      await api(app, u.token)
        .patch('/api/v1/auth/settings/login-wifi-check')
        .send({ enabled: false })
        .expect(200)
    })
  })

  describe('Health — @Public, không cần token', () => {
    it('GET /api/v1/health → 200 không token', async () => {
      await api(app).get('/api/v1/health').expect(200)
    })
  })
  describe('Phiên đăng nhập — blacklist dùng CHUNG 1 instance (review tổng RBAC)', () => {
    it('POST /auth/logout → access token cũ bị 401 ngay (AuthService ghi cùng blacklist mà JwtAuthGuard đọc)', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/auth/me').expect(200)
      await api(app, u.token).post('/api/v1/auth/logout').expect(200)
      await api(app, u.token).get('/api/v1/auth/me').expect(401)
    })
  })
})
