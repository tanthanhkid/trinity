import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { PrismaService, companyRef, runWithCompany, syncBus, type SyncEnvelope } from '@trinity/prisma'
import { publishBell } from '../common/bell-sync'
import { NotificationsService } from '../notifications/notifications.service'
import { TemplatesService } from '../templates/templates.service'
import { NotifChannel } from '../notifications/dto/send-notification.dto'
import { NotificationsGateway } from '../websocket/notifications.gateway'
import {
  PayslipApprovedPayloadDto,
  WsEmitItemDto,
} from './dto/event-payloads.dto'

@Injectable()
export class SubscribersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscribersService.name)
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly notifications: NotificationsService,
    private readonly templates: TemplatesService,
    private readonly gateway: NotificationsGateway,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  onModuleInit(): void {
    // G12b: bên GIỮ socket nghe chuông và phiếu lương do tiến trình khác phát (`NOTIFY bell` / `payslip`).
    this.unsubscribe.push(
      syncBus.on('bell', (m) => void this.inCompany(m, () => this.onRemoteBell(m))),
      syncBus.on('payslip', (m) => void this.inCompany(m, () => this.onRemotePayslip(m))),
    )
  }

  onModuleDestroy(): void {
    for (const u of this.unsubscribe.splice(0)) u()
  }

  private async inCompany(m: SyncEnvelope, fn: () => Promise<void>): Promise<void> {
    try {
      if (m.c > 0) await runWithCompany(companyRef(m.c), fn)
      else await fn()
    } catch (err) {
      this.logger.warn(`sync ${m.k} lỗi: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Phát chuông tới socket của tiến trình này cho thông báo do tiến trình khác tạo: đọc nội dung từ DB rồi đẩy số chưa đọc. */
  private async onRemoteBell(m: SyncEnvelope): Promise<void> {
    const ids = Array.isArray(m['n']) ? (m['n'] as unknown[]).map(Number).filter(Number.isInteger) : []
    const users = new Set<number>(Array.isArray(m['u']) ? (m['u'] as unknown[]).map(Number).filter(Number.isInteger) : [])
    if (ids.length && this.prisma) {
      const rows = await this.prisma.notificationLog.findMany({ where: { id: { in: ids } } })
      for (const r of rows) {
        users.add(r.recipient_id)
        this.gateway.sendToUser(r.recipient_id, {
          id: r.id,
          title: r.title ?? '',
          body: r.body ?? '',
          channel: r.channel,
          event_type: r.event_type ?? undefined,
          action_url: r.action_url ?? null,
          is_read: r.is_read,
          created_at: r.created_at.toISOString(),
        })
      }
    }
    for (const uid of users) {
      this.notifications.invalidateUnreadCache(uid)
      await this.notifications.emitUnreadCounts(uid)
    }
  }

  /**
   * Phiếu lương duyệt ở tiến trình khác (Rust phát `NOTIFY payslip`): chạy đường thông báo (mẫu, dedup, chuông) ở đây vì
   * mẫu thông báo nằm ở Node. Phiếu do Node duyệt thì không phát tin này (đã gọi thẳng `onPayslipApproved`; chuông tới
   * tiến trình khác đi qua kênh `bell`). `send` có dedup theo sự kiện + phiếu + user nên tin lặp không tạo thông báo thứ hai.
   * Giả định: một tiến trình Node xử lý yêu cầu này (giai đoạn lai: một Node + một Rust).
   */
  private async onRemotePayslip(m: SyncEnvelope): Promise<void> {
    const payslipId = Number(m['p'])
    const userId = Number(m['u'])
    if (!Number.isInteger(payslipId) || !Number.isInteger(userId) || typeof m['m'] !== 'string') return
    const payload = { payslipId, userId, month: m['m'], totalAmount: Number(m['a'] ?? 0) } as PayslipApprovedPayloadDto
    if (!this.prisma) return await this.onPayslipApproved(payload)
    // Nhận sự kiện NGUYÊN TỬ: nhiều tiến trình Node cùng nghe tin này ⇒ chỉ một bên giữ được khoá tư vấn mức giao dịch
    // (theo công ty + phiếu + người nhận) và chạy; khoá giữ suốt lúc tạo thông báo nên bên đến sau (nếu lấy được khoá) đã thấy
    // dòng thông báo trong `send` (dedup) và bỏ qua.
    const key = `payslip.approved:${m.c}:${payslipId}:${userId}`
    await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS ok`
        if (!rows[0]?.ok) return
        await this.onPayslipApproved(payload)
      },
      { maxWait: 5_000, timeout: 30_000 },
    )
  }

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
    // G12b: phát cho tiến trình khác TRƯỚC khi đẩy/đếm cục bộ — lỗi ở đó không được làm mất chuông bên kia. Nội dung đọc từ DB theo id.
    publishBell([...new Set(items.map((i) => i.recipient_id))], items.map((i) => i.log_id).filter((n): n is number => typeof n === 'number'))
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
