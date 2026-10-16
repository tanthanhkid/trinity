import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ChannelNotificationsService } from './channel-notifications.service';

@Module({
  providers: [NotificationsService, ChannelNotificationsService],
  exports: [NotificationsService, ChannelNotificationsService],
})
export class NotificationsModule {}
