import { NotificationsModule } from '../notifications/notifications.module';
import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { PublicApiModule } from '../public-api/public-api.module';
import { FacebookController } from './facebook.controller';
import { FacebookBroadcastsJob } from './facebook-broadcasts.job';
import { FacebookBroadcastsService } from './facebook-broadcasts.service';
import { FacebookChatLinksService } from './facebook-chat-links.service';
import { FacebookCommentsService } from './facebook-comments.service';
import { FacebookFlowsJob } from './facebook-flows.job';
import { FacebookFlowsService } from './facebook-flows.service';
import { FacebookLeadsService } from './facebook-leads.service';
import { FacebookMessengerService } from './facebook-messenger.service';
import { FacebookPagesService } from './facebook-pages.service';
import { FacebookPublicController } from './facebook-public.controller';
import { FacebookWebhookService } from './facebook-webhook.service';
import { GraphClient } from './graph-client';

/** Kết nối Fanpage Facebook: Messenger + Lead Ads + bình luận tự động + kịch bản nhắn tin + gửi tin hàng loạt. Cờ gói `facebook_page`. */
@Module({
  imports: [NotificationsModule, PrismaModule, PublicApiModule],
  controllers: [FacebookController, FacebookPublicController],
  providers: [GraphClient, FacebookPagesService, FacebookMessengerService, FacebookLeadsService, FacebookWebhookService, FacebookCommentsService, FacebookChatLinksService, FacebookFlowsService, FacebookFlowsJob, FacebookBroadcastsService, FacebookBroadcastsJob],
  exports: [FacebookMessengerService, FacebookCommentsService, FacebookChatLinksService, FacebookFlowsService, FacebookBroadcastsService],
})
export class FacebookModule {}
