import { Test } from '@nestjs/testing'
import { PrismaService } from '@trinity/prisma'
import { NotificationsModule } from '../notifications.module'
import { NotificationsService } from '../notifications.service'
import { DeliveryService } from '../delivery.service'
import { NotificationsGateway } from '../../websocket/notifications.gateway'
import { WebsocketModule } from '../../websocket/websocket.module'

describe('NotificationsModule — lịch @Cron và gateway thật', () => {
  it('có NotificationsScheduler + ScheduleModule', () => {
    const providers = (Reflect.getMetadata('providers', NotificationsModule) as Array<{ name?: string }>).map((p) => p.name)
    const imports = (Reflect.getMetadata('imports', NotificationsModule) as Array<{ module?: { name: string }; name?: string }>).map(
      (i) => i.module?.name ?? i.name,
    )
    expect(providers).toContain('NotificationsScheduler')
    expect(imports).toContain('ScheduleModule')
  })

  it('WebsocketModule dựng gateway Socket.IO thật', () => {
    const providers = Reflect.getMetadata('providers', WebsocketModule) as unknown[]
    expect(providers).toEqual([NotificationsGateway])
    expect(Reflect.getMetadata('websockets:is_gateway', NotificationsGateway)).toBe(true)
  })
})

describe('NotificationsService — cache badge', () => {
  it('đọc lần hai trong 5 phút lấy từ cache', async () => {
    const prisma = { notificationLog: { count: jest.fn().mockResolvedValue(3) } }
    const mod = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DeliveryService, useValue: {} },
        { provide: NotificationsGateway, useValue: { sendToUser: jest.fn(), emitUnreadCount: jest.fn() } },
      ],
    }).compile()
    const service = mod.get(NotificationsService)
    expect(await service.getUnreadCount(1)).toEqual({ count: 3 })
    expect(await service.getUnreadCount(1)).toEqual({ count: 3 })
    expect(prisma.notificationLog.count).toHaveBeenCalledTimes(1)
  })
})
