import { Injectable, Logger } from '@nestjs/common'
import { NotificationChannel, DeliveryResult } from './channel.interface'

/**
 * Kênh push (FCM) CHƯA được tích hợp: hiện chưa có lệnh gọi FCM nào. Vì vậy kênh này KHÔNG báo
 * "đã gửi" — nó trả `success: false` với lý do rõ ràng để thông báo không bị đánh dấu `sent` oan.
 * Thông báo trong ứng dụng (in_app) vẫn hoạt động bình thường.
 */
export const PUSH_NOT_CONFIGURED = 'Push (FCM) chua duoc tich hop - thong bao khong duoc gui qua push'

@Injectable()
export class PushChannel implements NotificationChannel {
  private readonly logger = new Logger(PushChannel.name)

  async send(
    recipientId: number,
    _title: string,
    _body: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const fcmToken = metadata?.['fcm_token'] as string | undefined
    if (!fcmToken) {
      return { success: false, error: 'Khong co FCM token' }
    }
    this.logger.warn(`Push cho user ${recipientId} bi bo qua: ${PUSH_NOT_CONFIGURED}`)
    return { success: false, error: PUSH_NOT_CONFIGURED, skipped: true, retryable: false }
  }
}
