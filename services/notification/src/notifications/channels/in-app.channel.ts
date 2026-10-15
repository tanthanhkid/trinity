import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { NotificationChannel, DeliveryResult } from './channel.interface'
import { NotificationsGateway } from '../../websocket/notifications.gateway'

@Injectable()
export class InAppChannel implements NotificationChannel {
  private readonly logger = new Logger(InAppChannel.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  async send(
    recipientId: number,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    try {
      const logId = metadata?.['log_id'] as number | undefined
      const eventType = metadata?.['event_type'] as string | undefined
      const actionUrl = metadata?.['action_url'] as string | undefined | null

      // Emit via WebSocket for real-time delivery
      this.gateway.sendToUser(recipientId, {
        id: logId,
        title,
        body,
        channel: 'in_app',
        event_type: eventType,
        action_url: actionUrl ?? null,
        is_read: false,
        created_at: new Date().toISOString(),
      })

      this.logger.log(`In-app notification sent to user ${recipientId}`)
      return { success: true, messageId: `inapp_${logId ?? Date.now()}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.logger.error(`In-app failed for user ${recipientId}: ${message}`)
      return { success: false, error: message }
    }
  }
}
