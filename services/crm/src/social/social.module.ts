import { Module } from '@nestjs/common';
import { PrismaModule } from '@trinity/prisma';
import { FacebookSocialProvider } from './providers/facebook.provider';
import { InstagramSocialProvider } from './providers/instagram.provider';
import { SocialProviderRegistry } from './providers/provider.registry';
import { TiktokSocialProvider } from './providers/tiktok.provider';
import { GoogleBusinessSocialProvider } from './providers/google-business.provider';
import { YoutubeSocialProvider } from './providers/youtube.provider';
import { SocialAccountsService } from './social-accounts.service';
import { SocialDraftsService } from './social-drafts.service';
import { SocialImportService } from './social-import.service';
import { SocialMediaService } from './social-media.service';
import { SocialSnippetsService } from './social-snippets.service';
import { SocialRecurrenceService } from './social-recurrence.service';
import { SocialQueueService } from './social-queue.service';
import { SocialPostsService } from './social-posts.service';
import { SocialPublishJob } from './social-publish.job';
import { SocialController } from './social.controller';
import { SocialPublicController } from './social-public.controller';

/** Đăng đa kênh (Facebook Page, Instagram, YouTube, TikTok). Cờ tổ chức `social_posting`. */
@Module({
  imports: [PrismaModule],
  controllers: [SocialController, SocialPublicController],
  providers: [FacebookSocialProvider, InstagramSocialProvider, YoutubeSocialProvider, TiktokSocialProvider, GoogleBusinessSocialProvider, SocialProviderRegistry, SocialAccountsService, SocialMediaService, SocialPostsService, SocialDraftsService, SocialQueueService, SocialSnippetsService, SocialImportService, SocialRecurrenceService, SocialPublishJob],
  exports: [SocialAccountsService, SocialPostsService, SocialDraftsService, SocialQueueService, SocialSnippetsService, SocialImportService, SocialRecurrenceService],
})
export class SocialModule {}
