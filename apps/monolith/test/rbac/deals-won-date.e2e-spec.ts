import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'
import { BriefingAggregatorService } from '../../../../services/crm/src/briefings/briefing-aggregator.service'

/** Bản tin đếm deal thắng theo NGÀY THẮNG (won_at), dữ liệu cũ (won_at NULL) rơi về updated_at — trên Postgres thật. */
describe('RBAC E2E — deal thắng theo ngày thắng', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)
  afterAll(async () => { await close() })
  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM deals WHERE created_by IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await resetDb(prisma)
  })

  const NOW = new Date('2026-10-07T01:00:00Z') // 08:00 VN sáng → kỳ = 06/10 VN
  const IN_PERIOD = new Date('2026-10-06T03:00:00Z')
  const BEFORE = new Date('2026-09-20T03:00:00Z')

  it('chuyển sang won qua API ghi won_at; bản tin đếm theo won_at, dữ liệu cũ theo updated_at', async () => {
    const boss = await makeUser(prisma, { grants: { 'deals.manage': 'all', 'deals.view': 'all', 'contacts.view': 'all' } })
    const mk = (title: string) => prisma.deal.create({ data: { title, assigned_to: boss.id, created_by: boss.id, value: 100n }, select: { id: true } })
    const viaApi = await mk('qua API')
    const wonLongAgoTouchedNow = await mk('thắng cũ, vừa sửa')
    const legacy = await mk('dữ liệu cũ')
    const legacyOld = await mk('dữ liệu cũ, thắng từ lâu')

    await api(app, boss.token).patch(`/api/v1/deals/${viaApi.id}`).send({ status: 'won' }).expect(200)
    expect((await prisma.deal.findUniqueOrThrow({ where: { id: viaApi.id } })).won_at).not.toBeNull()

    // Thắng từ tháng trước nhưng updated_at vừa bị chạm vào kỳ này → KHÔNG được tính vào kỳ này.
    await prisma.$executeRaw`UPDATE deals SET status='won', won_at=${BEFORE}, updated_at=${IN_PERIOD} WHERE id=${wonLongAgoTouchedNow.id}`
    // Dữ liệu cũ (won_at NULL): rơi về updated_at.
    await prisma.$executeRaw`UPDATE deals SET status='won', won_at=NULL, updated_at=${IN_PERIOD} WHERE id=${legacy.id}`
    await prisma.$executeRaw`UPDATE deals SET status='won', won_at=NULL, updated_at=${BEFORE} WHERE id=${legacyOld.id}`
    // Deal tạo qua API ở kỳ này: đặt won_at vào kỳ để so sánh ổn định (API ghi now thật, ngoài kỳ giả lập).
    await prisma.$executeRaw`UPDATE deals SET won_at=${IN_PERIOD} WHERE id=${viaApi.id}`

    const out = await app.get(BriefingAggregatorService).collect([boss.id], 'morning', NOW)
    expect(out.metrics.dealsWon.value).toBe(2) // viaApi (won_at) + legacy (updated_at)
    expect(out.metrics.wonValue.value).toBe(200)
  })
})
