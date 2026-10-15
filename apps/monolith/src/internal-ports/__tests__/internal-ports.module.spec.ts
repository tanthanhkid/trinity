import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ConfigModule } from '@nestjs/config'
import { PrismaService } from '@trinity/prisma'
import { ScopeService } from '@trinity/rbac-nest'

import { InternalPortsModule } from '../internal-ports.module'
import { SubscribersModule } from '../../../../../services/notification/src/subscribers/subscribers.module'
import { SubscribersService } from '../../../../../services/notification/src/subscribers/subscribers.service'
import { NotificationsService } from '../../../../../services/crm/src/notifications/notifications.service'
import {
  CRM_WS_EMIT_PORT,
  WsEmitPort,
} from '../../../../../services/crm/src/notifications/ws-emit.port'
import {
  PAYROLL_PAYSLIP_NOTIFY_PORT,
  PayslipNotifyPort,
} from '../../../../../services/payroll/src/payslips/payslip-notify.port'

/**
 * Khoá việc NỐI DÂY. Build xanh + unit test từng service xanh vẫn
 * không chứng minh port thật sự được nối trong monolith (producer có
 * mà "đầu ghi" thiếu ⇒ cả luồng INERT, không lỗi nào phát ra). Test này dựng
 * DI thật của `InternalPortsModule` (thay 2 module nặng bằng bản giả cung cấp
 * đúng service) rồi kiểm: token resolve được, gọi port là đi tới service đích,
 * và consumer thật (`NotificationsService` crm) nhận được port.
 */
describe('InternalPortsModule (nối dây gọi nội bộ in-process)', () => {
  const subscribers = {
    emitWsNotifications: jest.fn().mockResolvedValue({ emitted: 1 }),
    onPayslipApproved: jest.fn().mockResolvedValue(undefined),
  }

  @Module({
    providers: [{ provide: SubscribersService, useValue: subscribers }],
    exports: [SubscribersService],
  })
  class FakeSubscribersModule {}

  @Global()
  @Module({
    // `ScopeService` thật do `RbacModule` (@Global, cần DB + Redis) cấp — giả ở đây vì
    // controller crm (ActivitiesController…) inject nó khi dựng DI thật.
    providers: [
      { provide: PrismaService, useValue: {} },
      { provide: ScopeService, useValue: {} },
    ],
    exports: [PrismaService, ScopeService],
  })
  class FakePrismaModule {}

  async function build() {
    const ref = await Test.createTestingModule({
      imports: [InternalPortsModule, FakePrismaModule],
      providers: [NotificationsService],
    })
      .overrideModule(SubscribersModule)
      .useModule(FakeSubscribersModule)
      .compile()
    return ref
  }

  beforeEach(() => jest.clearAllMocks())

  it('CRM_WS_EMIT_PORT → SubscribersService.emitWsNotifications', async () => {
    const ref = await build()
    const port = ref.get<WsEmitPort>(CRM_WS_EMIT_PORT)
    const items = [
      { recipient_id: 1, title: 't', body: 'b', event_type: 'deal.assigned', action_url: null },
    ]

    await port.emit(items)

    expect(subscribers.emitWsNotifications).toHaveBeenCalledWith(items)
  })

  it('PAYROLL_PAYSLIP_NOTIFY_PORT → SubscribersService.onPayslipApproved', async () => {
    const ref = await build()
    const port = ref.get<PayslipNotifyPort>(PAYROLL_PAYSLIP_NOTIFY_PORT)
    const payload = {
      payslipId: 1, employeeId: 2, userId: 3, month: '2026-09',
      baseSalary: 1, kpiBonus: 1, totalAmount: 3,
      approvedBy: 9, approvedAt: '2026-09-30T00:00:00.000Z',
    }

    await port.onPayslipApproved(payload)

    expect(subscribers.onPayslipApproved).toHaveBeenCalledWith(payload)
  })

  it('consumer THẬT nhận port: crm NotificationsService phát WS', async () => {
    const ref = await build()
    const prisma = ref.get(PrismaService) as unknown as {
      notificationLog?: { createMany: jest.Mock }
    }
    prisma.notificationLog = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }

    await ref.get(NotificationsService).createPendingLogs([7], 'deal.assigned', {
      title: 'T', body: 'B',
    })

    // WS emit là fire-and-forget → chờ microtask
    await new Promise((r) => setImmediate(r))
    expect(subscribers.emitWsNotifications).toHaveBeenCalledTimes(1)
  })

  it('DI THẬT: SubscribersModule không bị override vẫn resolve đủ 2 port (bắt thiếu exports/provider)', async () => {
    // Chỉ giả PrismaService (cần DB); mọi module service còn lại là bản thật.
    const ref = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), InternalPortsModule, FakePrismaModule],
    }).compile()

    expect(ref.get(CRM_WS_EMIT_PORT)).toBeDefined()
    expect(ref.get(PAYROLL_PAYSLIP_NOTIFY_PORT)).toBeDefined()
  })
})
