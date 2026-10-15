import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser } from './harness'
import { NotificationsService } from '../../../../services/notification/src/notifications/notifications.service'
import { DeliveryService } from '../../../../services/notification/src/notifications/delivery.service'
import { NotifChannel } from '../../../../services/notification/src/notifications/dto/send-notification.dto'

/** Thông báo hẹn giờ trên Postgres thật: giữ webhook_url, reaper trả dòng kẹt `processing` về pending hoặc failed. */
describe('RBAC E2E — thông báo hẹn giờ: webhook_url + reaper', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)
  afterAll(async () => { await close() })
  afterEach(async () => { await resetDb(prisma) })

  const NOW = new Date('2026-10-12T03:00:00Z')
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

  it('createLog lưu webhook_url (để lúc gửi hẹn giờ vẫn có)', async () => {
    const u = await makeUser(prisma, { grants: {} })
    const log = await app.get(DeliveryService).createLog({
      user_id: u.id, channel: NotifChannel.WEBHOOK, title: 't', body: 'b', metadata: { webhook_url: 'https://hooks.example.com/x' },
    } as never)
    expect((await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } })).webhook_url).toBe('https://hooks.example.com/x')
  })

  it('reaper: kẹt > 15 phút còn lượt → scheduled; hết lượt → failed; còn mới hoặc dòng khác → không đụng', async () => {
    const u = await makeUser(prisma, { grants: {} })
    const mk = (data: Record<string, unknown>) =>
      prisma.notificationLog.create({ data: { recipient_id: u.id, channel: 'in_app', title: 't', body: 'b', ...data } as never, select: { id: true } })
    const stuck = await mk({ status: 'processing', claimed_at: minutesAgo(30), scheduled_at: minutesAgo(31), retry_count: 0 })
    const exhausted = await mk({ status: 'processing', claimed_at: minutesAgo(30), scheduled_at: minutesAgo(31), retry_count: 2 })
    const legacy = await mk({ status: 'processing', claimed_at: null, scheduled_at: minutesAgo(60), retry_count: 0 })
    const fresh = await mk({ status: 'processing', claimed_at: minutesAgo(2), scheduled_at: minutesAgo(3) })
    const sent = await mk({ status: 'sent', claimed_at: minutesAgo(90) })

    const res = await app.get(NotificationsService).reapStuckProcessing(NOW)
    expect(res).toEqual({ requeued: 2, failed: 1 })

    const get = (id: number) => prisma.notificationLog.findUniqueOrThrow({ where: { id } })
    expect(await get(stuck.id)).toMatchObject({ status: 'scheduled', retry_count: 1, claimed_at: null })
    expect(await get(legacy.id)).toMatchObject({ status: 'scheduled', retry_count: 1 })
    expect(await get(exhausted.id)).toMatchObject({ status: 'failed', retry_count: 3 })
    expect((await get(exhausted.id)).error).toContain('processing')
    expect((await get(fresh.id)).status).toBe('processing')
    expect((await get(sent.id)).status).toBe('sent')
  })
})
