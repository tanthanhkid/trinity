import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'
import { DeliveryService } from './delivery.service'
import { isServerless } from '@trinity/rbac-nest'
import { NotificationsScheduler } from './notifications.scheduler'
import { PushChannel } from './channels/push.channel'
import { InAppChannel } from './channels/in-app.channel'
import { WebhookChannel } from './channels/webhook.channel'
import { WebsocketModule } from '../websocket/websocket.module'

@Module({
  // Serverless: không @Cron/timer nào — việc định kỳ đi qua `/internal/cron/tick` (xem NotificationsService.onModuleInit).
  imports: [...(isServerless() ? [] : [ScheduleModule.forRoot()]), WebsocketModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    DeliveryService,
    ...(isServerless() ? [] : [NotificationsScheduler]),
    PushChannel,
    InAppChannel,
    WebhookChannel,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
