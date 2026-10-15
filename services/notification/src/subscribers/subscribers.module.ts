import { Module } from '@nestjs/common'
import { SubscribersController } from './subscribers.controller'
import { SubscribersService } from './subscribers.service'
import { NotificationsModule } from '../notifications/notifications.module'
import { TemplatesModule } from '../templates/templates.module'
import { WebsocketModule } from '../websocket/websocket.module'

@Module({
  imports: [NotificationsModule, TemplatesModule, WebsocketModule],
  controllers: [SubscribersController],
  providers: [SubscribersService],
  exports: [SubscribersService],
})
export class SubscribersModule {}
