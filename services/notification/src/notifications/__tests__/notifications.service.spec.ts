import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException } from '@nestjs/common'
import { NotificationsService } from '../notifications.service'
import { DeliveryService } from '../delivery.service'
import { NotifChannel } from '../dto/send-notification.dto'
import { NotificationsGateway } from '../../websocket/notifications.gateway'
import { PrismaService } from '@trinity/prisma'

describe('NotificationsService', () => {
  let service: NotificationsService
  let prisma: { notificationLog: Record<string, jest.Mock> }
  let delivery: Record<string, jest.Mock>
  let gateway: { sendToUser: jest.Mock; emitUnreadCount: jest.Mock }

  beforeEach(async () => {
    prisma = {
      notificationLog: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(5),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    }

    delivery = {
      isDuplicate: jest.fn().mockResolvedValue(false),
      createLog: jest.fn().mockResolvedValue({ id: 1 }),
      deliverWithRetry: jest.fn().mockResolvedValue(undefined),
    }

    gateway = { sendToUser: jest.fn(), emitUnreadCount: jest.fn() }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: DeliveryService, useValue: delivery },
        { provide: NotificationsGateway, useValue: gateway },
      ],
    }).compile()

    service = module.get(NotificationsService)
  })

  describe('findByUser', () => {
    it('should return paginated notifications', async () => {
      const mockData = [
        { id: 10, title: 'Test', body: 'B', channel: 'in_app', is_read: false, created_at: new Date() },
      ]
      prisma.notificationLog.findMany.mockResolvedValue(mockData)

      const result = await service.findByUser(1, undefined, 20)
      expect(result.data).toHaveLength(1)
      expect(result.next_cursor).toBeNull()
    })

    it('should return next_cursor when more data exists', async () => {
      const mockData = Array.from({ length: 21 }, (_, i) => ({
        id: 21 - i, title: 'T', body: 'B', channel: 'in_app', is_read: false, created_at: new Date(),
      }))
      prisma.notificationLog.findMany.mockResolvedValue(mockData)

      const result = await service.findByUser(1, undefined, 20)
      expect(result.data).toHaveLength(20)
      expect(result.next_cursor).toBe(2)
    })
  })

  describe('processScheduled', () => {
    // Reaper có test riêng bên dưới; ở đây tắt để thứ tự mockResolvedValueOnce của findMany chỉ tính truy vấn claim.
    beforeEach(() => {
      jest.spyOn(service, 'reapStuckProcessing').mockResolvedValue({ requeued: 0, failed: 0 })
    })

    it('chạy reaper ở đầu mỗi nhịp', async () => {
      await service.processScheduled()
      expect(service.reapStuckProcessing).toHaveBeenCalledTimes(1)
    })

    it('delivers only the rows this instance actually claimed (a lost claim race is skipped)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-12T03:00:00Z'))
      try {
        const row = (id: number) => ({ id, recipient_id: 1, channel: 'in_app', title: 't', body: 'b' })
        prisma.notificationLog.findMany
          .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
          .mockResolvedValueOnce([row(2)])
        prisma.notificationLog.updateMany
          .mockResolvedValueOnce({ count: 0 }) // row 1 claimed by another instance
          .mockResolvedValueOnce({ count: 1 })
        expect(await service.processScheduled()).toBe(1)
        expect(prisma.notificationLog.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { id: { in: [2] } } }),
        )
        expect(delivery.deliverWithRetry).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    it('in_app đã giao: làm mới cache chưa-đọc và đẩy lại số đếm', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-12T03:00:00Z'))
      try {
        prisma.notificationLog.findMany
          .mockResolvedValueOnce([{ id: 1 }])
          .mockResolvedValueOnce([{ id: 1, recipient_id: 9, channel: 'in_app', title: 't', body: 'b' }])
        prisma.notificationLog.updateMany.mockResolvedValue({ count: 1 })
        const invalidate = jest.spyOn(service, 'invalidateUnreadCache')
        const emit = jest.spyOn(service, 'emitUnreadCounts').mockResolvedValue(undefined)
        await service.processScheduled()
        expect(invalidate).toHaveBeenCalledWith(9)
        expect(emit).toHaveBeenCalledWith(9)
      } finally {
        jest.useRealTimers()
      }
    })

    it('claims each due row individually, then delivers exactly those rows', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-12T03:00:00Z')) // 10:00 VN, business hours
      try {
        const row = (id: number) => ({ id, recipient_id: 1, channel: 'in_app', title: 't', body: 'b' })
        prisma.notificationLog.findMany
          .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
          .mockResolvedValueOnce([row(1), row(2)])
        prisma.notificationLog.updateMany.mockResolvedValue({ count: 1 })
        expect(await service.processScheduled()).toBe(2)
        expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith({
          where: { id: 1, status: 'scheduled' },
          data: { status: 'processing', claimed_at: expect.any(Date) },
        })
        expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith({
          where: { id: 2, status: 'scheduled' },
          data: { status: 'processing', claimed_at: expect.any(Date) },
        })
        expect(delivery.deliverWithRetry).toHaveBeenCalledTimes(2)
      } finally {
        jest.useRealTimers()
      }
    })

    it('delivers an explicitly scheduled row even outside business hours (20:00 VN)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-12T13:00:00Z')) // 20:00 VN
      try {
        prisma.notificationLog.findMany
          .mockResolvedValueOnce([{ id: 7 }])
          .mockResolvedValueOnce([{ id: 7, recipient_id: 1, channel: 'in_app', title: 't', body: 'b' }])
        prisma.notificationLog.updateMany.mockResolvedValue({ count: 1 })
        expect(await service.processScheduled()).toBe(1)
        expect(delivery.deliverWithRetry).toHaveBeenCalledTimes(1)
      } finally {
        jest.useRealTimers()
      }
    })

    it('hẹn giờ kênh webhook: webhook_url đã lưu được đưa lại vào metadata lúc gửi', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-12T03:00:00Z'))
      try {
        prisma.notificationLog.findMany
          .mockResolvedValueOnce([{ id: 4 }])
          .mockResolvedValueOnce([
            { id: 4, recipient_id: 1, channel: 'webhook', title: 't', body: 'b', webhook_url: 'https://hooks.example.com/x' },
          ])
        prisma.notificationLog.updateMany.mockResolvedValue({ count: 1 })
        await service.processScheduled()
        expect(delivery.deliverWithRetry).toHaveBeenCalledWith(
          4,
          expect.objectContaining({ channel: 'webhook', metadata: { webhook_url: 'https://hooks.example.com/x' } }),
        )
      } finally {
        jest.useRealTimers()
      }
    })

    it('does nothing when no row is due', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-12T03:00:00Z'))
      try {
        expect(await service.processScheduled()).toBe(0)
        expect(prisma.notificationLog.updateMany).not.toHaveBeenCalled()
      } finally {
        jest.useRealTimers()
      }
    })
  })

  describe('reapStuckProcessing', () => {
    const NOW = new Date('2026-10-12T03:00:00Z')
    const CUTOFF = new Date(NOW.getTime() - 15 * 60 * 1000)

    it('chỉ chọn dòng processing quá 15 phút (theo claimed_at; dòng cũ chưa có claimed_at thì theo scheduled_at)', async () => {
      await service.reapStuckProcessing(NOW)
      expect(prisma.notificationLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'processing',
            OR: [{ claimed_at: { lt: CUTOFF } }, { claimed_at: null, scheduled_at: { lt: CUTOFF } }],
          },
        }),
      )
    })

    it('dòng kẹt còn lượt thử → trả về scheduled, tăng retry_count, xoá claimed_at', async () => {
      prisma.notificationLog.findMany.mockResolvedValueOnce([{ id: 5, retry_count: 0 }])
      prisma.notificationLog.updateMany.mockResolvedValue({ count: 1 })
      expect(await service.reapStuckProcessing(NOW)).toEqual({ requeued: 1, failed: 0 })
      expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith({
        where: { id: 5, status: 'processing' },
        data: { status: 'scheduled', retry_count: 1, claimed_at: null },
      })
    })

    it('đã thử đủ 3 lần → failed kèm lý do, không trả về scheduled nữa', async () => {
      prisma.notificationLog.findMany.mockResolvedValueOnce([{ id: 6, retry_count: 2 }])
      prisma.notificationLog.updateMany.mockResolvedValue({ count: 1 })
      expect(await service.reapStuckProcessing(NOW)).toEqual({ requeued: 0, failed: 1 })
      expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith({
        where: { id: 6, status: 'processing' },
        data: expect.objectContaining({ status: 'failed', retry_count: 3, error: expect.stringContaining('processing') }),
      })
    })

    it('dòng vừa được instance khác xử lý xong (updateMany count 0) không bị tính', async () => {
      prisma.notificationLog.findMany.mockResolvedValueOnce([{ id: 7, retry_count: 0 }])
      prisma.notificationLog.updateMany.mockResolvedValue({ count: 0 })
      expect(await service.reapStuckProcessing(NOW)).toEqual({ requeued: 0, failed: 0 })
    })
  })

  describe('getUnreadCount', () => {
    it('should return count from DB', async () => {
      prisma.notificationLog.count.mockResolvedValue(3)
      const result = await service.getUnreadCount(1)
      expect(result).toEqual({ count: 3 })
    })

    it('should return cached count on second call', async () => {
      prisma.notificationLog.count.mockResolvedValue(3)
      await service.getUnreadCount(1)
      await service.getUnreadCount(1)
      expect(prisma.notificationLog.count).toHaveBeenCalledTimes(1)
    })
  })

  describe('markAsRead', () => {
    it('should mark notification as read', async () => {
      prisma.notificationLog.findUnique.mockResolvedValue({ id: 1, recipient_id: 1 })
      prisma.notificationLog.count.mockResolvedValue(4)

      const result = await service.markAsRead(1, 1)
      expect(result).toEqual({ success: true })
      expect(prisma.notificationLog.update).toHaveBeenCalled()
    })

    it('should throw NotFoundException for missing notification', async () => {
      prisma.notificationLog.findUnique.mockResolvedValue(null)
      await expect(service.markAsRead(999, 1)).rejects.toThrow(NotFoundException)
    })

    it('thông báo của người khác → 404 (KHÔNG 403)', async () => {
      prisma.notificationLog.findUnique.mockResolvedValue({ id: 1, recipient_id: 2 })
      await expect(service.markAsRead(1, 1)).rejects.toThrow(NotFoundException)
    })
  })

  describe('send', () => {
    // Giờ làm việc ảnh hưởng tới việc gửi ngay hay hẹn giờ → cố định đồng hồ (thứ Ba 12:00 giờ VN).
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-03-10T05:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate'] })
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    it('should create log and deliver via channel', async () => {
      const result = await service.send({
        user_id: 1, channel: NotifChannel.IN_APP, title: 'Test', body: 'Body',
      })

      expect(result.status).toBe('sent')
      expect(delivery.createLog).toHaveBeenCalled()
      expect(delivery.deliverWithRetry).toHaveBeenCalled()
    })

    it('should deduplicate same event within 5 minutes', async () => {
      delivery.isDuplicate.mockResolvedValue(true)

      const result = await service.send({
        user_id: 1, channel: NotifChannel.IN_APP,
        title: 'Test', body: 'Body',
        event_type: 'deal.stage.changed', entity_id: 10,
      })

      expect(result.status).toBe('deduplicated')
      expect(delivery.createLog).not.toHaveBeenCalled()
    })
  })
})
