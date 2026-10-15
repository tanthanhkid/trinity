import { Module } from '@nestjs/common'
import { isServerless } from '@trinity/rbac-nest'
import { NotificationsGateway } from './notifications.gateway'
import { NoopNotificationsGateway } from './noop-notifications.gateway'

@Module({
  // Serverless: KHÔNG dựng Socket.IO (không có kết nối bền) — thay bằng bản rỗng cùng API; FE poll 30s.
  providers: [{ provide: NotificationsGateway, useClass: isServerless() ? NoopNotificationsGateway : NotificationsGateway }],
  exports: [NotificationsGateway],
})
export class WebsocketModule {}
