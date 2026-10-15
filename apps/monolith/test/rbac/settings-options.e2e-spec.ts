import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Ma trận quyền + phạm vi cho Danh mục động (settings/options) —
 * : đọc `@AuthOnly()` (mọi user đăng nhập), ghi
 * `contacts.catalog` (403 khi thiếu, 201 khi có).
 */
describe('RBAC E2E — Settings Options', () => {
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
    await prisma.$executeRawUnsafe(`DELETE FROM setting_options WHERE group_key = 'e2e_test_group'`)
    await resetDb(prisma)
  })

  it('GET /settings/options — mọi user đã đăng nhập đọc được (AuthOnly)', async () => {
    const u = await makeUser(prisma, { grants: {} })
    await api(app, u.token).get('/api/v1/settings/options').expect(200)
  })

  it('POST /settings/options không có quyền contacts.catalog → 403', async () => {
    const u = await makeUser(prisma, { grants: {} })
    await api(app, u.token)
      .post('/api/v1/settings/options')
      .send({ group_key: 'e2e_test_group', value: 'e2e_val', label: 'Nhãn E2E' })
      .expect(403)
  })

  it('POST /settings/options có quyền contacts.catalog → 201', async () => {
    const u = await makeUser(prisma, { grants: { 'contacts.catalog': true } })
    await api(app, u.token)
      .post('/api/v1/settings/options')
      .send({ group_key: 'e2e_test_group', value: 'e2e_val', label: 'Nhãn E2E' })
      .expect(201)
  })
})
