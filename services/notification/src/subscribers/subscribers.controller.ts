import { Controller, Post, Body, HttpCode } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger'
import { Internal } from '@trinity/rbac-nest'
import { SubscribersService } from './subscribers.service'
import { PayslipApprovedDto, WsEmitDto } from './dto/event-payloads.dto'

@ApiTags('Event Subscribers')
@ApiHeader({ name: 'X-Service-Secret', required: true, description: 'Internal service secret' })
@Internal()
@Controller('events')
export class SubscribersController {
  constructor(private readonly subscribersService: SubscribersService) {}

  @Post('payslip-approved')
  @HttpCode(200)
  @ApiOperation({ summary: 'Event: Phieu luong duoc duyet' })
  @ApiResponse({ status: 200, description: 'Xu ly thanh cong' })
  onPayslipApproved(@Body() dto: PayslipApprovedDto) {
    return this.subscribersService.onPayslipApproved(dto.payload)
  }

  /**
   * Emit WebSocket notification:new cho các record đã được insert vào
   * notification_logs bởi CRM service (createPendingLogs, status='sent').
   *
   * CRM service ghi trực tiếp vào DB dùng Prisma shared, nhưng không có
   * quyền truy cập WebSocket gateway của notification service. Endpoint này
   * cho phép CRM trigger WS emit ngay sau khi insert DB để chuông kêu real-time.
   *
   * Protected by @Internal() (X-Service-Secret, INTERNAL_SERVICE_SECRET).
   */
  @Post('notify-ws-emit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emit WebSocket notification:new (CRM internal — sau createPendingLogs)' })
  @ApiResponse({ status: 200, description: 'Emitted' })
  notifyWsEmit(@Body() dto: WsEmitDto) {
    return this.subscribersService.emitWsNotifications(dto.items)
  }
}
