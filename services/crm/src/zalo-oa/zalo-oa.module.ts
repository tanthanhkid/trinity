import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { PublicApiModule } from '../public-api/public-api.module';
import { ZaloOaApiClient } from './zalo-oa-api.client';
import { ZaloOaContactLinker } from './zalo-oa-contact-linker.service';
import { ZaloOaController } from './zalo-oa.controller';
import { ZaloOaFeatureService } from './zalo-oa-feature.service';
import { ZaloOaMessagingService } from './zalo-oa-messaging.service';
import { ZaloOaThreadsService } from './zalo-oa-threads.service';
import { ZaloOaTokenService } from './zalo-oa-token.service';
import { ZaloOaWebhookService } from './zalo-oa-webhook.service';

/** Zalo OA chính thức + ZNS. Dùng API chính thức của Zalo, không dùng tài khoản cá nhân. */
@Module({
  imports: [PrismaModule, PublicApiModule],
  controllers: [ZaloOaController],
  providers: [
    ZaloOaApiClient, ZaloOaContactLinker, ZaloOaFeatureService, ZaloOaThreadsService,
    ZaloOaTokenService, ZaloOaMessagingService, ZaloOaWebhookService,
  ],
  // `ZaloOaMessagingService` cài `MessageChannel` — bot AI / bản tin inject để gửi.
  exports: [ZaloOaMessagingService],
})
export class ZaloOaModule {}
