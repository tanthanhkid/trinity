import { Test } from '@nestjs/testing'
import { cronRegistry, runCronTick } from '@trinity/rbac-nest'
import { PrismaService } from '@trinity/prisma'
import { NotificationsService, SCHEDULED_OPPORTUNISTIC_GAP_MS } from '../notifications.service'
import { DeliveryService } from '../delivery.service'
import { NotificationsGateway } from '../../websocket/notifications.gateway'
import { NoopNotificationsGateway } from '../../websocket/noop-notifications.gateway'
import { WebsocketModule } from '../../websocket/websocket.module'

const KEY = Symbol.for('@vercel/request-context')
const g = globalThis as Record<symbol, unknown>

describe('NotificationsService — nhánh serverless', () => {
  const old = process.env.TRINITY_RUNTIME
  let prisma: { notificationLog: Record<string, jest.Mock> }
  let service: NotificationsService

  async function build() {
    prisma = {
      notificationLog: {
        count: jest.fn().mockResolvedValue(3),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    }
    const mod = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DeliveryService, useValue: {} },
        { provide: NotificationsGateway, useValue: { sendToUser: jest.fn(), emitUnreadCount: jest.fn() } },
      ],
    }).compile()
    service = mod.get(NotificationsService)
    return mod
  }

  beforeEach(() => cronRegistry.clear())
  afterEach(() => {
    if (old === undefined) delete process.env.TRINITY_RUNTIME
    else process.env.TRINITY_RUNTIME = old
    delete g[KEY]
  })

  it('đăng ký job notification.scheduled; cron tick gọi processScheduled', async () => {
    delete process.env.TRINITY_RUNTIME
    const mod = await build()
    mod.get(NotificationsService).onModuleInit()
    const spy = jest.spyOn(service, 'processScheduled').mockResolvedValue(4)
    const s = await runCronTick()
    expect(s.jobs).toEqual([expect.objectContaining({ name: 'notification.scheduled', status: 'ok', result: { processed: 4 } })])
    expect(spy).toHaveBeenCalled()
  })

  it('badge không cache ở serverless (instance khác không bị cũ 5 phút), có cache khi không cờ', async () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    await build()
    await service.getUnreadCount(1)
    await service.getUnreadCount(1)
    expect(prisma.notificationLog.count).toHaveBeenCalledTimes(2)

    delete process.env.TRINITY_RUNTIME
    await build()
    await service.getUnreadCount(1)
    await service.getUnreadCount(1)
    expect(prisma.notificationLog.count).toHaveBeenCalledTimes(1)
  })

  it('maybeProcessScheduledInBackground: no-op ngoài serverless', async () => {
    delete process.env.TRINITY_RUNTIME
    await build()
    const spy = jest.spyOn(service, 'processScheduled').mockResolvedValue(0)
    expect(service.maybeProcessScheduledInBackground()).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('serverless: chạy nền qua waitUntil, giãn ≥ 60s mỗi instance', async () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    const waitUntil = jest.fn()
    g[KEY] = { get: () => ({ waitUntil }) }
    await build()
    const spy = jest.spyOn(service, 'processScheduled').mockResolvedValue(0)
    expect(service.maybeProcessScheduledInBackground()).toBe(true)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0][0]
    expect(spy).toHaveBeenCalledTimes(1)
    expect(service.maybeProcessScheduledInBackground()).toBe(false)
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now + SCHEDULED_OPPORTUNISTIC_GAP_MS + 1)
    expect(service.maybeProcessScheduledInBackground()).toBe(true)
    jest.restoreAllMocks()
  })

  it('processScheduled lỗi ở nền không ném ra ngoài', async () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    await build()
    jest.spyOn(service, 'processScheduled').mockRejectedValue(new Error('db'))
    expect(() => service.maybeProcessScheduledInBackground()).not.toThrow()
    await new Promise((r) => setImmediate(r))
  })
})

describe('WebsocketModule — gateway theo cờ', () => {
  const old = process.env.TRINITY_RUNTIME
  afterEach(() => {
    if (old === undefined) delete process.env.TRINITY_RUNTIME
    else process.env.TRINITY_RUNTIME = old
    jest.resetModules()
  })

  function providerClass(): unknown {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { WebsocketModule: M } = require('../../websocket/websocket.module') as { WebsocketModule: unknown }
    const providers = Reflect.getMetadata('providers', M as object) as Array<{ useClass?: unknown }>
    return providers[0].useClass
  }

  it('serverless → NoopNotificationsGateway (không @WebSocketGateway)', () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    jest.resetModules()
    expect((providerClass() as { name: string }).name).toBe('NoopNotificationsGateway')
    expect(Reflect.getMetadata('websockets:is_gateway', NoopNotificationsGateway)).toBeUndefined()
  })

  it('không cờ → gateway thật', () => {
    delete process.env.TRINITY_RUNTIME
    jest.resetModules()
    expect((providerClass() as { name: string }).name).toBe('NotificationsGateway')
  })

  it('Noop có đủ API, không ném', () => {
    const n = new NoopNotificationsGateway()
    expect(() => n.sendToUser()).not.toThrow()
    expect(() => n.emitUnreadCount()).not.toThrow()
    expect(WebsocketModule).toBeDefined()
  })
})
