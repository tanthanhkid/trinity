import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import type { SocialAccount } from '@prisma/client';
import { pkceS256, randomToken } from '../integrations/oauth/oauth-crypto';
import { IntegrationsKeyError, decryptSecret, encryptSecret, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { SocialProviderRegistry } from './providers/provider.registry';
import type { AccountForPublish } from './providers/provider.types';
import { NETWORK_LABELS, socialBaseUrl, socialRedirectUri, type SocialNetwork } from './social.config';
import { signSocialState, verifySocialState } from './social-oauth-state';

/** Dạng trả ra API — KHÔNG có token. */
export interface SocialAccountView {
  id: number;
  network: string;
  external_id: string;
  name: string;
  avatar_url: string | null;
  status: string;
  last_error: string | null;
  token_expires_at: Date | null;
  connected_by: number;
  created_at: Date;
}

export const toAccountView = (a: SocialAccount): SocialAccountView => ({
  id: a.id,
  network: a.network,
  external_id: a.external_id,
  name: a.name,
  avatar_url: a.avatar_url,
  status: a.status,
  last_error: a.last_error,
  token_expires_at: a.token_expires_at,
  connected_by: a.connected_by,
  created_at: a.created_at,
});

/** Liên kết / gỡ kênh. Token mã hoá AES-256-GCM bằng INTEGRATIONS_SECRET_KEY sẵn có. */
@Injectable()
export class SocialAccountsService {
  private readonly logger = new Logger(SocialAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: SocialProviderRegistry,
  ) {}

  private key(): Buffer {
    try {
      return loadSecretKey();
    } catch (err) {
      if (err instanceof IntegrationsKeyError) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY (khoá mã hoá token).');
      throw err;
    }
  }

  /** Trạng thái từng mạng cho màn Kênh: đã làm chưa, đủ env chưa, URL callback để dán vào app của mạng. */
  networks() {
    const base = socialBaseUrl();
    return this.providers.all().map((p) => ({
      network: p.network,
      label: NETWORK_LABELS[p.network],
      supported: p.supported,
      configured: p.supported && p.configured() && Boolean(base),
      env: [...p.envNames],
      scopes: [...p.scopes],
      redirect_uri: base ? socialRedirectUri(base, p.network) : null,
    }));
  }

  async list(): Promise<SocialAccountView[]> {
    const rows = await this.prisma.socialAccount.findMany({ where: { status: { not: 'disabled' } }, orderBy: [{ network: 'asc' }, { name: 'asc' }] });
    return rows.map(toAccountView);
  }

  connectUrl(network: SocialNetwork, actor: AuthUser): { url: string } {
    const p = this.providers.get(network);
    if (!p.supported) throw new BadRequestException(`${NETWORK_LABELS[network]} chưa hỗ trợ.`);
    const base = socialBaseUrl();
    if (!p.configured() || !base) throw new ServiceUnavailableException(`Chưa cấu hình ${NETWORK_LABELS[network]} trên máy chủ (${p.envNames.join(', ')}).`);
    this.key();
    const verifier = p.usesPkce ? randomToken(48) : undefined;
    const state = signSocialState(actor.userId, network, verifier);
    return { url: p.authorizeUrl(state, socialRedirectUri(base, network), verifier ? pkceS256(verifier) : undefined) };
  }

  /** Callback OAuth: lưu/ghi đè mọi tài khoản/trang nhận được. State sai/hết hạn ⇒ 400. */
  async handleCallback(network: SocialNetwork, code: string, state: string): Promise<{ connected: number }> {
    const st = verifySocialState(state, network);
    if (!st) throw new BadRequestException('Phiên liên kết không hợp lệ hoặc đã hết hạn. Hãy bấm "Liên kết" lại.');
    const p = this.providers.get(network);
    const base = socialBaseUrl();
    if (!p.supported || !p.configured() || !base) throw new ServiceUnavailableException(`Chưa cấu hình ${NETWORK_LABELS[network]} trên máy chủ.`);
    const key = this.key();
    const accounts = await p.exchange(code, socialRedirectUri(base, network), st.verifier);
    for (const a of accounts) {
      const data = {
        name: a.name.slice(0, 200),
        avatar_url: a.avatar_url ?? null,
        access_token_enc: encryptSecret(a.access_token, key),
        refresh_token_enc: a.refresh_token ? encryptSecret(a.refresh_token, key) : null,
        token_expires_at: a.token_expires_at ?? null,
        scopes: a.scopes.join(' '),
        status: 'active',
        last_error: null,
        connected_by: st.userId,
      };
      await this.prisma.socialAccount.upsert({
        where: { network_external_id: { network, external_id: a.external_id } },
        create: { network, external_id: a.external_id, ...data },
        update: data,
      });
    }
    this.logger.log(`Liên kết ${network}: ${accounts.length} tài khoản (user ${st.userId})`);
    return { connected: accounts.length };
  }

  /** Gỡ kênh: xoá token, bài hẹn giờ còn chờ trên kênh này chuyển "đã huỷ". */
  async disconnect(id: number): Promise<void> {
    const a = await this.prisma.socialAccount.findUnique({ where: { id } });
    if (!a || a.status === 'disabled') throw new NotFoundException('Không tìm thấy kênh');
    await this.prisma.$transaction([
      this.prisma.socialPostTarget.updateMany({ where: { account_id: id, status: 'queued' }, data: { status: 'cancelled', last_error: 'Kênh đã bị gỡ' } }),
      this.prisma.socialAccount.update({ where: { id }, data: { status: 'disabled', access_token_enc: '', refresh_token_enc: null } }),
    ]);
  }

  /** Giải mã token để đăng (chỉ dùng nội bộ job). */
  forPublish(a: SocialAccount): AccountForPublish {
    const key = loadSecretKey();
    return {
      id: a.id,
      external_id: a.external_id,
      name: a.name,
      access_token: decryptSecret(a.access_token_enc, key),
      refresh_token: a.refresh_token_enc ? decryptSecret(a.refresh_token_enc, key) : null,
      token_expires_at: a.token_expires_at,
    };
  }

  /** Lưu token mới sau khi provider làm mới. */
  async saveRefreshed(id: number, t: { access_token: string; refresh_token?: string | null; token_expires_at?: Date | null }): Promise<void> {
    const key = loadSecretKey();
    await this.prisma.socialAccount.update({
      where: { id },
      data: {
        access_token_enc: encryptSecret(t.access_token, key),
        ...(t.refresh_token ? { refresh_token_enc: encryptSecret(t.refresh_token, key) } : {}),
        token_expires_at: t.token_expires_at ?? null,
      },
    });
  }

  async markReauth(id: number, message: string): Promise<void> {
    await this.prisma.socialAccount.update({ where: { id }, data: { status: 'reauth', last_error: message.slice(0, 500) } });
  }
}
