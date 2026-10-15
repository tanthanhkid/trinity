import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * "Tính năng của tổ chức": GET = AuthOnly (mọi người đọc để dựng
 * menu), PUT = `settings.features`; cập nhật một phần, khoá lạ → 400. Công tắc
 * ĐỘC LẬP RBAC: tắt một tính năng KHÔNG làm API tương ứng bỏ kiểm quyền.
 */
describe('RBAC E2E — Org features', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp())
  }, 60_000)
  afterAll(async () => close())
  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM settings WHERE key = 'org_features'`)
    await resetDb(prisma)
  })

  it('GET không token → 401; user thường đọc được, mặc định bật hết', async () => {
    await api(app).get('/api/v1/settings/org-features').expect(401)
    const u = await makeUser(prisma, { grants: {} })
    const res = await api(app, u.token).get('/api/v1/settings/org-features').expect(200)
    expect(res.body.contacts).toBe(true)
    expect(res.body.kanban).toBe(true)
  })

  it('PUT thiếu settings.features → 403', async () => {
    const u = await makeUser(prisma, { grants: { 'settings.integrations': true } })
    await api(app, u.token).put('/api/v1/settings/org-features').send({ kanban: false }).expect(403)
  })

  it('PUT có quyền → lưu một phần; người khác thấy ngay; giá trị rác → 400; khoá lạ không được lưu', async () => {
    const admin = await makeUser(prisma, { grants: { 'settings.features': true } })
    const other = await makeUser(prisma, { grants: {} })
    await api(app, admin.token).put('/api/v1/settings/org-features').send({ kanban: false }).expect(200)
    await api(app, admin.token).put('/api/v1/settings/org-features').send({ pos: false }).expect(200)
    const res = await api(app, other.token).get('/api/v1/settings/org-features').expect(200)
    expect(res.body).toMatchObject({ kanban: false, pos: false })
    // Harness dùng ValidationPipe whitelist (môi trường thật: forbidNonWhitelisted → 400, xem unit spec) — ở đây chỉ cần khoá lạ KHÔNG lọt vào dữ liệu.
    await api(app, admin.token).put('/api/v1/settings/org-features').send({ hack: true })
    const after = await api(app, other.token).get('/api/v1/settings/org-features').expect(200)
    expect(after.body).not.toHaveProperty('hack')
    await api(app, admin.token).put('/api/v1/settings/org-features').send({ kanban: 'no' }).expect(400)
  })

  it('tắt kanban KHÔNG thay kiểm quyền: user thiếu kanban.view vẫn 403 ở API công việc', async () => {
    const admin = await makeUser(prisma, { grants: { 'settings.features': true } })
    await api(app, admin.token).put('/api/v1/settings/org-features').send({ kanban: false }).expect(200)
    const u = await makeUser(prisma, { grants: {} })
    await api(app, u.token).get('/api/v1/kanban/boards').expect(403)
  })
})
