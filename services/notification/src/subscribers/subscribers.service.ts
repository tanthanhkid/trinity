import { Injectable, Logger } from '@nestjs/common'
import { NotificationsService } from '../notifications/notifications.service'
import { TemplatesService } from '../templates/templates.service'
import { NotifChannel } from '../notifications/dto/send-notification.dto'
import { NotificationsGateway } from '../websocket/notifications.gateway'
import {
  PayslipApprovedPayloadDto,
  WsEmitItemDto,
} from './dto/event-payloads.dto'

@Injectable()
export class SubscribersService {
  private readonly logger = new Logger(SubscribersService.name)

  constructor(
    private readonly notifications: NotificationsService,
    private readonly templates: TemplatesService,
    private readonly gateway: NotificationsGateway,
  ) {}

  /**
   * Emit WebSocket notification:new cho các item đã được CRM service insert
   * vào notification_logs (status='sent') bằng Prisma trực tiếp (createPendingLogs).
   *
   * Vấn đề: CRM service dùng Prisma shared để insert notification_logs với
   * status='sent', nhưng WebSocket gateway chỉ tồn tại trong notification
   * service. Nếu không emit WS → bell dropdown có data nhưng KHÔNG có chuông
   * (tạo bản ghi + chuyển bước không kêu chuông).
   *
   * Pattern: CRM gọi in-process qua `CRM_WS_EMIT_PORT` (cầu nối in-process do ứng dụng host nối) ngay sau createPendingLogs(); endpoint
   * HTTP `notify-ws-emit` còn giữ cho client ngoài process.
   * Fire-and-forget từ CRM — lỗi ở đây KHÔNG block business logic CRM.
   */
  async emitWsNotifications(items: WsEmitItemDto[]): Promise<{ emitted: number }> {
    if (items.length === 0) return { emitted: 0 }
    const now = new Date().toISOString()
    for (const item of items) {
      this.gateway.sendToUser(item.recipient_id, {
        id: item.log_id ?? undefined,
        title: item.title,
        body: item.body,
        channel: 'in_app',
        event_type: item.event_type,
        action_url: item.action_url ?? null,
        is_read: false,
        created_at: now,
      })
    }
    // Invalidate unread count cho tất cả recipients rồi re-query từ DB.
    // Phải invalidate TRƯỚC khi gọi getUnreadCount vì notification service có
    // in-memory cache TTL 5 phút. Nếu không invalidate, cache trả về count cũ
    // (row mới do CRM insert chưa được cache phản ánh) → FE nhận count không đổi
    // → badge không tăng +1, notifications-bell không kêu chuông.
    const recipientIds = [...new Set(items.map((i) => i.recipient_id))]
    for (const uid of recipientIds) {
      this.notifications.invalidateUnreadCache(uid)
      await this.notifications.emitUnreadCounts(uid)
    }
    this.logger.log(`emitWsNotifications: emitted ${items.length} WS events for ${recipientIds.length} recipients`)
    return { emitted: items.length }
  }

  async onPayslipApproved(payload: PayslipApprovedPayloadDto): Promise<void> {
    const data = {
      payslipId: payload.payslipId,
      month: payload.month,
      totalAmount: payload.totalAmount,
    }
    await this.sendToRecipients(
      [payload.userId], 'payslip.approved', payload.payslipId,
      [NotifChannel.IN_APP], data,
    )
  }

  private async sendToRecipients(
    recipientIds: number[],
    eventType: string,
    entityId: number,
    channels: NotifChannel[],
    data: Record<string, unknown>,
  ): Promise<void> {
    for (const channel of channels) {
      // Template hỏng (cú pháp lưu từ trước) không được làm chết cả handler — rơi về nội dung mặc định.
      const rendered = await this.templates.renderByEventType(eventType, channel, data).catch((err: unknown) => {
        this.logger.error(`Render template ${eventType}/${channel} lỗi: ${err instanceof Error ? err.message : 'Unknown'}`)
        return null
      })
      const title = rendered?.subject ?? this.defaultTitle(eventType)
      const body = rendered?.body ?? this.defaultBody(eventType, data)

      for (const userId of recipientIds) {
        await this.notifications.send({
          user_id: userId,
          channel,
          title,
          body,
          event_type: eventType,
          entity_id: entityId,
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Unknown'
          this.logger.error(`Failed to notify user ${userId}: ${msg}`)
        })
      }
    }
  }

  private defaultTitle(eventType: string): string {
    const titles: Record<string, string> = {
      'payslip.approved': 'Phiếu lương đã duyệt',
    }
    return titles[eventType] ?? 'Thông báo mới'
  }

  private defaultBody(eventType: string, data: Record<string, unknown>): string {
    switch (eventType) {
      case 'payslip.approved':
        return `Phiếu lương tháng ${data['month'] ?? ''}: ${Number(data['totalAmount'] ?? 0).toLocaleString('vi-VN')} VNĐ`
      default:
        return JSON.stringify(data)
    }
  }
}
