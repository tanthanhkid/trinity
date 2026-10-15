import { Injectable } from '@nestjs/common'
import type { NotificationsGateway } from './notifications.gateway'

/**
 * Thay `NotificationsGateway` khi `TRINITY_RUNTIME=serverless`: hàm serverless không giữ được kết nối
 * WebSocket nên KHÔNG đăng ký `@WebSocketGateway` (Nest không dựng Socket.IO server). Cố ý KHÔNG có decorator
 * gateway. Thông báo vẫn được ghi DB; FE hỏi định kỳ (`NEXT_PUBLIC_REALTIME_MODE=poll`).
 */
@Injectable()
export class NoopNotificationsGateway
  implements Pick<NotificationsGateway, 'sendToUser' | 'emitUnreadCount'>
{
  sendToUser(): void {
    /* poll thay cho push */
  }

  emitUnreadCount(): void {
    /* poll thay cho push */
  }
}
