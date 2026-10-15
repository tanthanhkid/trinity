import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NewsfeedController } from './newsfeed.controller';
import { NewsfeedService } from './newsfeed.service';

@Module({
  imports: [StorageModule, NotificationsModule],
  controllers: [NewsfeedController],
  providers: [NewsfeedService],
  exports: [NewsfeedService],
})
export class NewsfeedModule {}
