import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { NotifChannel, SendNotificationDto } from './dto/send-notification.dto'
import { NotificationChannel, DeliveryResult } from './channels/channel.interface'
import { PushChannel } from './channels/push.channel'
import { InAppChannel } from './channels/in-app.channel'
import { WebhookChannel } from './channels/webhook.channel'
import { NotificationsGateway } from '../websocket/notifications.gateway'

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name)
  private readonly channels: Record<string, NotificationChannel>

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
    pushChannel: PushChannel,
    inAppChannel: InAppChannel,
    webhookChannel: WebhookChannel,
  ) {
    this.channels = {
      [NotifChannel.PUSH]: pushChannel,
      [NotifChannel.IN_APP]: inAppChannel,
      [NotifChannel.WEBHOOK]: webhookChannel,
    }
  }

  async deliverWithRetry(
    logId: number,
    dto: SendNotificationDto,
    attempt = 1,
    maxAttempts = 3,
  ): Promise<'sent' | 'failed' | 'skipped'> {
    const channel = this.channels[dto.channel]
    if (!channel) {
      await this.markFailed(logId, `Kenh ${dto.channel} khong ho tro`)
      return 'failed'
    }

    const result: DeliveryResult = await channel.send(
      dto.user_id, dto.title, dto.body,
      { ...dto.metadata, log_id: logId, event_type: dto.event_type, action_url: dto.action_url ?? null },
    )

    if (result.success) {
      await this.markSent(logId)
      return 'sent'
    }

    if (result.skipped) {
      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: { status: 'skipped', error: result.error },
      })
      this.logger.warn(`Notification ${logId} skipped: ${result.error}`)
      return 'skipped'
    }

    await this.prisma.notificationLog.update({
      where: { id: logId },
      data: { retry_count: attempt, error: result.error },
    })

    if (attempt < maxAttempts && result.retryable !== false) {
      const delayMs = Math.pow(4, attempt) * 250 // 1s, 4s, 16s
      await this.delay(delayMs)
      return this.deliverWithRetry(logId, dto, attempt + 1, maxAttempts)
    }

    await this.markFailed(logId, result.error ?? 'Max retries exceeded')
    return 'failed'
  }

  async createLog(dto: SendNotificationDto) {
    return this.prisma.notificationLog.create({
      data: {
        template_id: dto.template_id ?? null,
        event_type: dto.event_type ?? 'manual',
        channel: dto.channel,
        recipient_id: dto.user_id,
        title: dto.title,
        body: dto.body,
        action_url: dto.action_url ?? null,
        // Giữ URL đích của kênh webhook: hẹn giờ/dời sang giờ hành chính thì lúc gửi vẫn còn.
        webhook_url: typeof dto.metadata?.['webhook_url'] === 'string' ? (dto.metadata['webhook_url'] as string) : null,
        status: 'pending',
        retry_count: 0,
        is_read: false,
      },
    })
  }

  async isDuplicate(dto: SendNotificationDto): Promise<boolean> {
    if (!dto.event_type || !dto.entity_id) return false

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
    const existing = await this.prisma.notificationLog.findFirst({
      where: {
        event_type: dto.event_type,
        recipient_id: dto.user_id,
        // Log chưa lưu entity_id, nên coi là trùng khi CÙNG nội dung (cùng sự kiện, cùng người nhận, cùng tiêu đề + nội dung):
        // hai thực thể khác nhau có nội dung khác nhau sẽ không bị nuốt.
        title: dto.title,
        body: dto.body,
        created_at: { gte: fiveMinAgo },
      },
      select: { id: true },
    })
    return !!existing
  }

  private async markSent(logId: number): Promise<void> {
    await this.prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'sent', sent_at: new Date() },
    })
  }

  private async markFailed(logId: number, error: string): Promise<void> {
    await this.prisma.notificationLog.update({
      where: { id: logId },
      data: { status: 'failed', error },
    })
    this.logger.error(`Notification ${logId} failed: ${error}`)
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
