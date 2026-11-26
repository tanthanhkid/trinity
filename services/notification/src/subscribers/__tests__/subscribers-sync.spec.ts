import { SyncBus, syncBus } from '@trinity/prisma'
import { SubscribersService } from '../subscribers.service'
import { publishBell } from '../../common/bell-sync'

/**
 * G12b — chuông và phiếu lương qua `NOTIFY`: nửa NHẬN (tin của tiến trình khác → socket ở đây) và nửa PHÁT (khuôn tin).
 * Test hai tiến trình thật qua Postgres cho các kênh còn lại nằm ở `services/crm/src/__pg__/sync-notify.pg.spec.ts`.
 */
describe('SubscribersService — NOTIFY bell / payslip', () => {
  const other = new SyncBus('rust-other')
  let service: SubscribersService
  let notifications: { send: jest.Mock; invalidateUnreadCache: jest.Mock; emitUnreadCounts: jest.Mock }
  let gateway: { sendToUser: jest.Mock }
  let prisma: { notificationLog: { findMany: jest.Mock }; $transaction: jest.Mock }
  let lockOk = true

  const wire = (k: string, extra: Record<string, unknown>, c = 1): string => JSON.stringify({ v: 1, o: other.origin, k, c, ...extra })
  const flush = () => new Promise((r) => setTimeout(r, 20))

  beforeEach(() => {
    notifications = { send: jest.fn().mockResolvedValue({ id: 1, status: 'sent' }), invalidateUnreadCache: jest.fn(), emitUnreadCounts: jest.fn().mockResolvedValue(undefined) }
    gateway = { sendToUser: jest.fn() }
    lockOk = true
    prisma = {
      notificationLog: { findMany: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ $queryRaw: jest.fn().mockImplementation(async () => [{ ok: lockOk }]) })),
    }
    service = new SubscribersService(notifications as never, { renderByEventType: jest.fn().mockResolvedValue(null) } as never, gateway as never, prisma as never)
    service.onModuleInit()
  })
  afterEach(() => service.onModuleDestroy())

  it('chuông từ tiến trình khác: đọc nội dung từ DB, đẩy tới socket ở đây và làm mới số chưa đọc', async () => {
    prisma.notificationLog.findMany.mockResolvedValue([
      { id: 77, recipient_id: 5, title: 'T', body: 'B', channel: 'in_app', event_type: 'deal.assigned', action_url: '/contacts/1', is_read: false, created_at: new Date('2026-11-26T10:00:00Z') },
    ])
    syncBus.dispatch(wire('bell', { u: [5, 6], n: [77] }))
    await flush()
    expect(prisma.notificationLog.findMany).toHaveBeenCalledWith({ where: { id: { in: [77] } } })
    expect(gateway.sendToUser).toHaveBeenCalledTimes(1)
    expect(gateway.sendToUser).toHaveBeenCalledWith(5, expect.objectContaining({ id: 77, title: 'T', body: 'B', is_read: false, action_url: '/contacts/1' }))
    expect(notifications.emitUnreadCounts.mock.calls.map((c) => c[0]).sort()).toEqual([5, 6])
    expect(notifications.invalidateUnreadCache).toHaveBeenCalledWith(6)
  })

  it('n rỗng: chỉ làm mới số chưa đọc (đánh dấu đã đọc ở tiến trình kia)', async () => {
    syncBus.dispatch(wire('bell', { u: [9], n: [] }))
    await flush()
    expect(prisma.notificationLog.findMany).not.toHaveBeenCalled()
    expect(gateway.sendToUser).not.toHaveBeenCalled()
    expect(notifications.emitUnreadCounts).toHaveBeenCalledWith(9)
  })

  it('tin của chính tiến trình này không dội lại', async () => {
    syncBus.dispatch(JSON.stringify({ v: 1, o: syncBus.origin, k: 'bell', c: 1, u: [5], n: [] }))
    await flush()
    expect(notifications.emitUnreadCounts).not.toHaveBeenCalled()
  })

  it('phiếu lương duyệt ở Rust: chạy đường thông báo ở đây, người nhận đúng', async () => {
    syncBus.dispatch(wire('payslip', { p: 12, u: 42, m: '2026-11', a: 15000000 }))
    await flush()
    expect(notifications.send).toHaveBeenCalledTimes(1)
    expect(notifications.send.mock.calls[0][0]).toMatchObject({ user_id: 42, event_type: 'payslip.approved', entity_id: 12 })
  })

  it('phiếu lương: không giữ được khoá tư vấn (tiến trình khác đang xử lý) ⇒ không gửi trùng', async () => {
    lockOk = false
    syncBus.dispatch(wire('payslip', { p: 12, u: 42, m: '2026-11', a: 1 }))
    await flush()
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(notifications.send).not.toHaveBeenCalled()
  })

  it('phiếu lương thiếu trường: bỏ qua, không ném', async () => {
    syncBus.dispatch(wire('payslip', { p: 'x', u: 42 }))
    await flush()
    expect(notifications.send).not.toHaveBeenCalled()
  })

  it('phát chuông: chia lô để payload dưới giới hạn, khoá thay vì nội dung', async () => {
    const spy = jest.spyOn(syncBus, 'publish').mockResolvedValue()
    publishBell([1, 2], [10, 11])
    expect(spy).toHaveBeenCalledWith('bell', { u: [1, 2], n: [10, 11] })
    spy.mockClear()
    publishBell(Array.from({ length: 450 }, (_, i) => i + 1), Array.from({ length: 450 }, (_, i) => i + 1000))
    expect(spy).toHaveBeenCalledTimes(3)
    for (const [, data] of spy.mock.calls) expect(Buffer.byteLength(JSON.stringify({ v: 1, o: 'node-123456-abcdef12', k: 'bell', c: 1, ...data }))).toBeLessThan(7500)
    spy.mockRestore()
  })

  it('emitWsNotifications phát chuông kèm id dòng', async () => {
    const spy = jest.spyOn(syncBus, 'publish').mockResolvedValue()
    await service.emitWsNotifications([{ recipient_id: 5, title: 'A', body: 'a', event_type: 'x', action_url: null, log_id: 31 }])
    expect(spy).toHaveBeenCalledWith('bell', { u: [5], n: [31] })
    spy.mockRestore()
  })
})
