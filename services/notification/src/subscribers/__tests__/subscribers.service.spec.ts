import { Test, TestingModule } from '@nestjs/testing'
import { SubscribersService } from '../subscribers.service'
import { NotificationsService } from '../../notifications/notifications.service'
import { TemplatesService } from '../../templates/templates.service'
import { NotificationsGateway } from '../../websocket/notifications.gateway'

/**
 * `onPayslipApproved` + `emitWsNotifications` được gọi IN-PROCESS qua port do ứng dụng host nối.
 */
describe('SubscribersService', () => {
  let service: SubscribersService
  let notifications: {
    send: jest.Mock
    invalidateUnreadCache: jest.Mock
    emitUnreadCounts: jest.Mock
  }
  let templates: { renderByEventType: jest.Mock }
  let gateway: { sendToUser: jest.Mock }

  beforeEach(async () => {
    notifications = {
      send: jest.fn().mockResolvedValue({ id: 1, status: 'sent' }),
      invalidateUnreadCache: jest.fn(),
      emitUnreadCounts: jest.fn().mockResolvedValue(undefined),
    }
    templates = {
      renderByEventType: jest.fn().mockResolvedValue({
        subject: 'Test Subject',
        body: 'Test Body',
      }),
    }
    gateway = { sendToUser: jest.fn() }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscribersService,
        { provide: NotificationsService, useValue: notifications },
        { provide: TemplatesService, useValue: templates },
        { provide: NotificationsGateway, useValue: gateway },
      ],
    }).compile()

    service = module.get(SubscribersService)
  })

  describe('onPayslipApproved', () => {
    it('should notify employee user via in_app', async () => {
      await service.onPayslipApproved({
        payslipId: 1, employeeId: 7, userId: 42,
        month: '2026-03', baseSalary: 10000000, kpiBonus: 2000000,
        totalAmount: 15000000,
        approvedBy: 15, approvedAt: '2026-03-30T10:00:00Z',
      })

      const calls = notifications.send.mock.calls
      expect(calls.length).toBe(1)
      expect(calls[0][0].user_id).toBe(42)
      expect(calls[0][0].event_type).toBe('payslip.approved')
    })
  })

  describe('emitWsNotifications', () => {
    it('đẩy WS tới từng người nhận và làm mới badge chưa đọc (1 lần/người)', async () => {
      const result = await service.emitWsNotifications([
        { recipient_id: 5, title: 'A', body: 'a', event_type: 'deal.assigned', action_url: '/contacts/1' },
        { recipient_id: 5, title: 'B', body: 'b', event_type: 'deal.assigned', action_url: null },
        { recipient_id: 6, title: 'C', body: 'c', event_type: 'deal.assigned', action_url: null },
      ])

      expect(result).toEqual({ emitted: 3 })
      expect(gateway.sendToUser).toHaveBeenCalledTimes(3)
      expect(gateway.sendToUser).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ title: 'A', event_type: 'deal.assigned', is_read: false }),
      )
      expect(notifications.invalidateUnreadCache.mock.calls.map((c) => c[0])).toEqual([5, 6])
      expect(notifications.emitUnreadCounts).toHaveBeenCalledTimes(2)
    })

    it('danh sách rỗng → không làm gì', async () => {
      await expect(service.emitWsNotifications([])).resolves.toEqual({ emitted: 0 })
      expect(gateway.sendToUser).not.toHaveBeenCalled()
    })
  })
})
