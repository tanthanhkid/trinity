import { Injectable } from '@nestjs/common';
import { NETWORK_LABELS, SOCIAL_NETWORKS, type SocialNetwork } from '../social.config';
import { FacebookSocialProvider } from './facebook.provider';
import { SocialPublishError, type SocialProvider } from './provider.types';

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

  constructor(facebook: FacebookSocialProvider) {
    this.map = { facebook };
  }

  get(network: SocialNetwork): SocialProvider {
    return this.map[network];
  }

  all(): SocialProvider[] {
    return SOCIAL_NETWORKS.map((n) => this.map[n]);
  }
}
