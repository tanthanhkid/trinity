import { Injectable } from '@nestjs/common';
import { SOCIAL_NETWORKS, type SocialNetwork } from '../social.config';
import { FacebookSocialProvider } from './facebook.provider';
import type { SocialProvider } from './provider.types';

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
