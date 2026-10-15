import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Cụm CRM kanban/newsfeed/reports/settings — E2E ma
 * trận quyền tối thiểu. KHÔNG bao phủ hết mọi
 * route trong cụm (tài nguyên/thời gian hạn chế) — chọn 1 route đại diện
 * cho mỗi khối lớn: Kanban (boards), Báo cáo (overview), Bảng tin
 * (newsfeed.post). Unit test trong thư mục __tests__ của từng module CRM
 * (kanban, reports, newsfeed) bao phủ chi tiết scope/mask từng service.
 */
describe('RBAC E2E — cụm CRM kanban/newsfeed/reports', () => {
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
    // newsfeed_posts.author_id có FK cứng tới users — xoá TRƯỚC users (mirror
    // cleanup employees ở auth-users.e2e-spec.ts) để resetDb() không vỡ FK.
    await prisma.$executeRawUnsafe(
      `DELETE FROM newsfeed_posts WHERE author_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`,
    )
    await prisma.$executeRawUnsafe(
      `DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`,
    )
    await resetDb(prisma)
  })

  describe('GET /api/v1/kanban/boards — Mẫu A (kanban.view)', () => {
    it('không có quyền kanban.view → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/kanban/boards').expect(403)
    })

    it('có kanban.view (scope own) → 200, danh sách rỗng hợp lệ khi chưa có board nào thấy được', async () => {
      const u = await makeUser(prisma, { grants: { 'kanban.view': 'own' } })
      const res = await api(app, u.token).get('/api/v1/kanban/boards').expect(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('admin (is_system) → 200, xem được toàn bộ board không cần khai grants riêng', async () => {
      const admin = await makeUser(prisma, { admin: true })
      await api(app, admin.token).get('/api/v1/kanban/boards').expect(200)
    })
  })

  describe('POST /api/v1/kanban/boards — kanban.boards (KHÔNG dùng kanban.view)', () => {
    it('chỉ có kanban.view, KHÔNG có kanban.boards → 403 khi tạo board', async () => {
      const u = await makeUser(prisma, { grants: { 'kanban.view': 'all' } })
      await api(app, u.token)
        .post('/api/v1/kanban/boards')
        .send({ name: 'Board test', visibility_role_ids: [] })
        .expect(403)
    })

    it('có kanban.boards → tạo board thành công (201/200)', async () => {
      const u = await makeUser(prisma, { grants: { 'kanban.boards': true, 'kanban.view': 'all' } })
      const res = await api(app, u.token)
        .post('/api/v1/kanban/boards')
        .send({ name: 'Board test RBAC E2E', visibility_role_ids: [] })
      expect([200, 201]).toContain(res.status)
      expect(res.body?.name).toBe('Board test RBAC E2E')
    })
  })

  describe('GET /api/v1/reports/overview — Mẫu A (reports.overview)', () => {
    // date_from/date_to bắt buộc (QueryReportRangeDto) — dùng chung cho mọi case dưới.
    const RANGE = '?date_from=2026-09-01&date_to=2026-09-28'

    it('không có quyền reports.overview → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get(`/api/v1/reports/overview${RANGE}`).expect(403)
    })

    it('scope own → 200, KHÔNG 500 dù chưa có dữ liệu (contacts rỗng)', async () => {
      const u = await makeUser(prisma, { grants: { 'reports.overview': 'own' } })
      const res = await api(app, u.token).get(`/api/v1/reports/overview${RANGE}`).expect(200)
      expect(res.body).toBeDefined()
    })

    it('scope all (không phải role tên cố định — chỉ là grant) vẫn 200', async () => {
      const u = await makeUser(prisma, { grants: { 'reports.overview': 'all' } })
      await api(app, u.token).get(`/api/v1/reports/overview${RANGE}`).expect(200)
    })
  })

  describe('POST /api/v1/newsfeed — Mẫu D (newsfeed.post, unscoped)', () => {
    it('không có quyền newsfeed.post → 403', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token)
        .post('/api/v1/newsfeed')
        .send({ category: 'training', content: 'nội dung test' })
        .expect(403)
    })

    it('có newsfeed.post → đăng bài thành công', async () => {
      const u = await makeUser(prisma, { grants: { 'newsfeed.post': true } })
      const res = await api(app, u.token)
        .post('/api/v1/newsfeed')
        .send({ category: 'training', content: 'nội dung test RBAC E2E' })
      expect([200, 201]).toContain(res.status)
    })

    it('GET /api/v1/newsfeed/permissions/me phản ánh đúng can_post theo grants (KHÔNG theo tên role)', async () => {
      const u = await makeUser(prisma, { grants: { 'newsfeed.post': true } })
      const res = await api(app, u.token).get('/api/v1/newsfeed/permissions/me').expect(200)
      expect(res.body.can_post).toBe(true)
      expect(res.body.can_moderate).toBe(false)
    })
  })
})
