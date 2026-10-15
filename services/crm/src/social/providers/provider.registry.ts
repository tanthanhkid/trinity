import { Injectable } from '@nestjs/common';
import { NETWORK_LABELS, SOCIAL_NETWORKS, type SocialNetwork } from '../social.config';
import { FacebookSocialProvider } from './facebook.provider';
import { GoogleBusinessSocialProvider } from './google-business.provider';
import { InstagramSocialProvider } from './instagram.provider';
import { SocialPublishError, type SocialProvider } from './provider.types';
import { TiktokSocialProvider } from './tiktok.provider';
import { YoutubeSocialProvider } from './youtube.provider';

/** Mạng đã có chỗ trong khung nhưng chưa làm: hiện ở màn Kênh là "Sắp có", mọi thao tác báo chưa hỗ trợ. */
export class PlaceholderProvider implements SocialProvider {
  readonly supported = false;
  readonly usesPkce = false;
  readonly envNames: readonly string[] = [];
  readonly scopes: readonly string[] = [];
  constructor(readonly network: SocialNetwork) {}
  configured(): boolean {
    return false;
  }
  validateMedia(): string | null {
    return `${NETWORK_LABELS[this.network]} chưa hỗ trợ đăng bài.`;
  }
  authorizeUrl(): string {
    throw new SocialPublishError('invalid', `${NETWORK_LABELS[this.network]} chưa hỗ trợ.`);
  }
  exchange(): Promise<never> {
    throw new SocialPublishError('invalid', `${NETWORK_LABELS[this.network]} chưa hỗ trợ.`);
  }
  publish(): Promise<never> {
    throw new SocialPublishError('invalid', `${NETWORK_LABELS[this.network]} chưa hỗ trợ đăng bài.`);
  }
}

@Injectable()
export class SocialProviderRegistry {
  private readonly map: Record<SocialNetwork, SocialProvider>;

  constructor(
    facebook: FacebookSocialProvider,
    instagram: InstagramSocialProvider,
    youtube: YoutubeSocialProvider,
    tiktok: TiktokSocialProvider,
    googleBusiness: GoogleBusinessSocialProvider,
  ) {
    this.map = {
      facebook,
      // Instagram / TikTok chỉ bật ở máy chủ đã có khoá (TikTok) / đã bật cờ INSTAGRAM_PUBLISH_ENABLED (app Meta được duyệt quyền đăng IG);
      // chưa thì hiện "Sắp có" như cũ — môi trường thử dùng app sandbox/tài khoản tester.
      instagram: instagram.configured() ? instagram : new PlaceholderProvider('instagram'),
      youtube,
      tiktok: tiktok.configured() ? tiktok : new PlaceholderProvider('tiktok'),
      // Google Business Profile: chờ Google duyệt quyền API (quota 0 tới khi duyệt) ⇒ "Sắp có" tới khi GOOGLE_BUSINESS_ENABLED=true.
      google_business: googleBusiness.configured() ? googleBusiness : new PlaceholderProvider('google_business'),
    };
  }

  get(network: SocialNetwork): SocialProvider {
    return this.map[network];
  }

  all(): SocialProvider[] {
    return SOCIAL_NETWORKS.map((n) => this.map[n]);
  }
}
