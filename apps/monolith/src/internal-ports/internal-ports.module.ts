import { Global, Module } from '@nestjs/common'

import { SubscribersModule } from '../../../../services/notification/src/subscribers/subscribers.module'
import { SubscribersService } from '../../../../services/notification/src/subscribers/subscribers.service'
import {
  CRM_WS_EMIT_PORT,
  WsEmitPort,
} from '../../../../services/crm/src/notifications/ws-emit.port'
import {
  PAYROLL_PAYSLIP_NOTIFY_PORT,
  PayslipNotifyPort,
} from '../../../../services/payroll/src/payslips/payslip-notify.port'

/**
 * Nối "cổng" gọi nội bộ giữa các service ngay trong process.
 *
 * Mỗi service khai một TOKEN + interface của riêng nó (không import chéo
 * service, build độc lập vẫn chạy) và CHỈ module này — nơi duy nhất biết cả hai
 * phía — nối token tới implementation thật (chuông realtime, thông báo phiếu
 * lương). Module `@Global()` để provider thấy được từ mọi module.
 *
 * ⚠️ Service tiêu thụ port bằng `@Optional()`: THIẾU nối ở đây = log ERROR,
 * KHÔNG im lặng. Test khoá: `__tests__/internal-ports.module.spec.ts`.
 */
@Global()
@Module({
  imports: [SubscribersModule],
  providers: [
    {
      provide: CRM_WS_EMIT_PORT,
      inject: [SubscribersService],
      useFactory: (subscribers: SubscribersService): WsEmitPort => ({
        emit: (items) => subscribers.emitWsNotifications(items),
      }),
    },
    {
      provide: PAYROLL_PAYSLIP_NOTIFY_PORT,
      inject: [SubscribersService],
      useFactory: (subscribers: SubscribersService): PayslipNotifyPort => ({
        onPayslipApproved: (payload) => subscribers.onPayslipApproved(payload),
      }),
    },
  ],
  exports: [CRM_WS_EMIT_PORT, PAYROLL_PAYSLIP_NOTIFY_PORT],
})
export class InternalPortsModule {}
