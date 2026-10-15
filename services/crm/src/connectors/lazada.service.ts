import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { decryptSecret, encryptSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { CommerceSyncService, type SyncOwner } from './commerce-sync.service';
import { ConnectorsService } from './connectors.service';
import { signState, verifyState } from './oauth-state';
import { LazadaClient, lazadaAuthUrl, lazadaConfig, mapLazadaOrder, verifyLazadaPush } from './lazada';

const FIRST_SYNC_DAYS = 30;
const MAX_PAGES = 3;

interface Creds { access_token: string; refresh_token: string; expires_at: number }
export interface LazadaSettings { seller_id: string | null; account?: string | null; cursor?: string; offset?: number; counts?: { orders?: number }; last_sync_at?: string | null }

/** Lazada: đơn của shop vào CRM. Chat (IM) cần quyền riêng Lazada cấp — chưa làm. */
@Injectable()
export class LazadaService {
  private readonly logger = new Logger(LazadaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly sync: CommerceSyncService,
  ) {}

  configured(): boolean {
    return lazadaConfig() !== null;
  }

  startConnect(userId: number): { authorize_url: string } {
    const cfg = lazadaConfig();
    if (!cfg) throw new ServiceUnavailableException('Máy chủ chưa đặt LAZADA_APP_KEY / LAZADA_APP_SECRET (app đối tác Lazada của Trinity).');
    const base = publicBaseUrl();
    if (!base) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_PUBLIC_BASE_URL.');
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY.');
    return { authorize_url: lazadaAuthUrl(cfg, `${base}/api/v1/connectors/lazada/callback`, signState('lazada', userId, loadSecretKey())) };
  }

  async completeConnect(code: string, state: string, fetchFn: typeof fetch = fetch): Promise<void> {
    const cfg = lazadaConfig();
    if (!cfg || !isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa cấu hình Lazada.');
    const st = verifyState(state, 'lazada', loadSecretKey());
    if (!st) throw new BadRequestException('Phiên cấp quyền không hợp lệ hoặc đã hết hạn — bấm Kết nối lại.');
    if (!code) throw new BadRequestException('Thiếu code từ Lazada.');
    const t = await new LazadaClient(cfg, fetchFn).token({ code });
    const creds: Creds = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
    const old = await this.prisma.connectorAccount.findUnique({ where: { provider: 'lazada' } });
    const same = (old?.settings as LazadaSettings | undefined)?.seller_id === t.seller_id && old?.status !== 'disconnected';
    const settings: LazadaSettings = same ? { ...(old!.settings as unknown as LazadaSettings), account: t.account } : { seller_id: t.seller_id, account: t.account };
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()), settings: settings as object, last_error: null, connected_by: st.userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'lazada' }, update: data, create: { provider: 'lazada', ...data } });
    await this.runSync(fetchFn).catch((e) => this.logger.warn(`Lazada đồng bộ lần đầu lỗi: ${(e as Error).message}`));
  }

  async runSync(fetchFn: typeof fetch = fetch): Promise<{ added: { orders: number }; more: boolean }> {
    const cfg = lazadaConfig();
    const c = await this.session(fetchFn);
    if (!cfg || !c) throw new BadRequestException('Chưa kết nối Lazada.');
    const client = new LazadaClient(cfg, fetchFn);
    const owner = await this.owner();
    const since = c.settings.cursor ? new Date(c.settings.cursor) : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);
    let offset = c.settings.offset ?? 0;
    let newest = since;
    let added = 0;
    let more = false;
    try {
      for (let p = 0; p < MAX_PAGES; p++) {
        const page = await client.orders(c.token, since, offset);
        const items = await client.items(c.token, page.orders.map((o) => String(o.order_id)));
        for (const o of page.orders) {
          await this.sync.upsertOrder('lazada', c.account, mapLazadaOrder(o, items.get(String(o.order_id)) ?? []), owner);
          const d = typeof o.updated_at === 'string' ? new Date(o.updated_at) : null;
          if (d && !Number.isNaN(d.getTime()) && d > newest) newest = d;
        }
        added += page.orders.length;
        offset += page.orders.length;
        if (page.orders.length < 100) break;
        if (p === MAX_PAGES - 1) more = true;
      }
      const settings: LazadaSettings = more
        ? { ...c.settings, offset }
        : { ...c.settings, cursor: newest.toISOString(), offset: 0 };
      settings.counts = { orders: (c.settings.counts?.orders ?? 0) + added };
      settings.last_sync_at = new Date().toISOString();
      await this.prisma.connectorAccount.update({ where: { provider: 'lazada' }, data: { settings: settings as object } });
      await this.connectors.touch('lazada');
    } catch (err) {
      await this.connectors.touch('lazada', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    return { added: { orders: added }, more };
  }

  /** Push Lazada: kiểm chữ ký; tin đơn (message_type 0) ⇒ đọc lại đơn + mặt hàng rồi ghi. */
  async handlePush(raw: Buffer | undefined, auth: string | undefined, body: { seller_id?: string; message_type?: number; data?: { trade_order_id?: string } }, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; applied: number }> {
    const cfg = lazadaConfig();
    if (!cfg || !verifyLazadaPush(cfg, raw, auth)) return { ok: false, applied: 0 };
    const c = await this.session(fetchFn);
    const orderId = body?.data?.trade_order_id;
    if (!c || body?.message_type !== 0 || !orderId || (c.settings.seller_id && String(body.seller_id) !== String(c.settings.seller_id))) return { ok: true, applied: 0 };
    const client = new LazadaClient(cfg, fetchFn);
    const o = await client.order(c.token, String(orderId));
    if (!o) return { ok: true, applied: 0 };
    const items = await client.items(c.token, [String(orderId)]);
    await this.sync.upsertOrder('lazada', c.account, mapLazadaOrder(o, items.get(String(orderId)) ?? []), await this.owner());
    await this.connectors.touch('lazada');
    return { ok: true, applied: 1 };
  }

  private async session(fetchFn: typeof fetch): Promise<{ token: string; account: string; settings: LazadaSettings } | null> {
    const cfg = lazadaConfig();
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'lazada' } });
    if (!cfg || !r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    const settings = r.settings as unknown as LazadaSettings;
    let creds = JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as Creds;
    if (creds.expires_at < Date.now() + 60 * 60_000) {
      try {
        const t = await new LazadaClient(cfg, fetchFn).token({ refreshToken: creds.refresh_token });
        creds = { access_token: t.access_token, refresh_token: t.refresh_token || creds.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
        await this.prisma.connectorAccount.update({ where: { provider: 'lazada' }, data: { credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()) } });
      } catch (err) {
        await this.connectors.touch('lazada', `Cần cấp quyền lại: ${(err as Error).message}`);
        return null;
      }
    }
    return { token: creds.access_token, account: String(settings.seller_id ?? settings.account ?? ''), settings };
  }

  private async owner(): Promise<SyncOwner> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'lazada' }, select: { connected_by: true } });
    const u = r ? await this.prisma.user.findUnique({ where: { id: r.connected_by }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? r?.connected_by ?? 0, team_id: u?.team_id ?? null };
  }
}
