import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { BriefingAggregatorService } from './briefing-aggregator.service';
import { BRIEFING_CHANNELS, InAppBriefingChannel } from './briefing-channel';
import { BriefingConfigService } from './briefing-config.service';
import { BriefingsController } from './briefings.controller';
import { BriefingsScheduler } from './briefings.scheduler';
import { BriefingsService } from './briefings.service';

@Module({
  imports: [NotificationsModule, SettingsModule],
  controllers: [BriefingsController],
  providers: [
    BriefingAggregatorService,
    BriefingConfigService,
    BriefingsService,
    BriefingsScheduler,
    InAppBriefingChannel,
    {
      // Thêm kênh mới (Zalo OA…) = thêm provider vào đây.
      provide: BRIEFING_CHANNELS,
      useFactory: (a: InAppBriefingChannel) => [a],
      inject: [InAppBriefingChannel],
    },
  ],
  exports: [BriefingsService],
})
export class BriefingsModule {}
