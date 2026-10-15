import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { decryptSecret, encryptSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { CommerceSyncService, type SyncOwner } from './commerce-sync.service';
import { ConnectorsService } from './connectors.service';
import { signState, verifyState } from './oauth-state';
import { ShopeeClient, mapShopeeOrder, shopeeAuthUrl, shopeeConfig, verifyShopeePush } from './shopee';

const WINDOW_S = 15 * 86_400; // Shopee: get_order_list tối đa 15 ngày mỗi lần
const FIRST_SYNC_DAYS = 30;
const MAX_WINDOWS = 4;

interface Creds { access_token: string; refresh_token: string; expires_at: number }
export interface ShopeeSettings { shop_id: number; cursor?: number; counts?: { orders?: number }; last_sync_at?: string | null }

/** Shopee: đơn của shop vào CRM. Chat với người mua: Shopee chỉ mở API chat cho đối tác được duyệt — chưa làm. */
@Injectable()
export class ShopeeService {
  private readonly logger = new Logger(ShopeeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly sync: CommerceSyncService,
  ) {}

  configured(): boolean {
    return shopeeConfig() !== null;
  }

  /** Bước 1: URL để chủ shop cấp quyền cho Trinity. */
  startConnect(userId: number): { authorize_url: string } {
    const cfg = shopeeConfig();
    if (!cfg) throw new ServiceUnavailableException('Máy chủ chưa đặt SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY (app đối tác Shopee của Trinity).');
    const base = publicBaseUrl();
    if (!base) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_PUBLIC_BASE_URL.');
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY.');
    const state = signState('shopee', userId, loadSecretKey());
    return { authorize_url: shopeeAuthUrl(cfg, `${base}/api/v1/connectors/shopee/callback?state=${encodeURIComponent(state)}`) };
  }

  /** Bước 2: Shopee chuyển về kèm code + shop_id ⇒ đổi token, lưu (mã hoá), đồng bộ lần đầu. */
  async completeConnect(code: string, shopIdRaw: string, state: string, fetchFn: typeof fetch = fetch): Promise<void> {
    const cfg = shopeeConfig();
    if (!cfg || !isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa cấu hình Shopee.');
    const st = verifyState(state, 'shopee', loadSecretKey());
    if (!st) throw new BadRequestException('Phiên cấp quyền không hợp lệ hoặc đã hết hạn — bấm Kết nối lại.');
    const shopId = Number(shopIdRaw);
    if (!code || !Number.isSafeInteger(shopId) || shopId <= 0) throw new BadRequestException('Thiếu code hoặc shop_id từ Shopee.');
    const t = await new ShopeeClient(cfg, fetchFn).token({ code, shopId });
    const creds: Creds = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expire_in * 1000 };
    const old = await this.prisma.connectorAccount.findUnique({ where: { provider: 'shopee' } });
    const sameShop = (old?.settings as ShopeeSettings | undefined)?.shop_id === shopId && old?.status !== 'disconnected';
    const settings: ShopeeSettings = sameShop ? { ...(old!.settings as unknown as ShopeeSettings) } : { shop_id: shopId };
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()), settings: settings as object, last_error: null, connected_by: st.userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'shopee' }, update: data, create: { provider: 'shopee', ...data } });
    await this.runSync(fetchFn).catch((e) => this.logger.warn(`Shopee đồng bộ lần đầu lỗi: ${(e as Error).message}`));
  }

  async runSync(fetchFn: typeof fetch = fetch, nowS = Math.floor(Date.now() / 1000)): Promise<{ added: { orders: number }; more: boolean }> {
    const cfg = shopeeConfig();
    const c = await this.session(fetchFn);
    if (!cfg || !c) throw new BadRequestException('Chưa kết nối Shopee.');
    const client = new ShopeeClient(cfg, fetchFn);
    const owner = await this.owner();
    let from = c.settings.cursor ?? nowS - FIRST_SYNC_DAYS * 86_400;
    let added = 0;
    let windows = 0;
    try {
      while (from < nowS && windows < MAX_WINDOWS) {
        const to = Math.min(from + WINDOW_S, nowS);
        let cursor = '';
        do {
          const page = await client.orderList(c.shop, from, to, cursor);
          const sns = (page.order_list ?? []).map((o) => o.order_sn);
          for (let i = 0; i < sns.length; i += 50) {
            const d = await client.orderDetail(c.shop, sns.slice(i, i + 50));
            for (const o of d.order_list ?? []) await this.sync.upsertOrder('shopee', String(c.shop.shopId), mapShopeeOrder(o), owner);
            added += (d.order_list ?? []).length;
          }
          cursor = page.more ? page.next_cursor ?? '' : '';
        } while (cursor);
        from = to;
        windows++;
      }
      const counts = { orders: (c.settings.counts?.orders ?? 0) + added };
      await this.prisma.connectorAccount.update({ where: { provider: 'shopee' }, data: { settings: { ...c.settings, cursor: from, counts, last_sync_at: new Date().toISOString() } as object } });
      await this.connectors.touch('shopee');
    } catch (err) {
      await this.connectors.touch('shopee', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    return { added: { orders: added }, more: from < nowS };
  }

  /** Push của Shopee: kiểm chữ ký theo URL đã khai; đơn đổi trạng thái (code 3) ⇒ đọc chi tiết rồi ghi. */
  async handlePush(url: string, raw: Buffer | undefined, auth: string | undefined, body: { shop_id?: number; code?: number; data?: { ordersn?: string } }, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; applied: number }> {
    const cfg = shopeeConfig();
    if (!cfg || !verifyShopeePush(cfg, url, raw, auth)) return { ok: false, applied: 0 };
    const c = await this.session(fetchFn);
    if (!c || body?.shop_id !== c.shop.shopId || body.code !== 3 || !body.data?.ordersn) return { ok: true, applied: 0 };
    const d = await new ShopeeClient(cfg, fetchFn).orderDetail(c.shop, [body.data.ordersn]);
    for (const o of d.order_list ?? []) await this.sync.upsertOrder('shopee', String(c.shop.shopId), mapShopeeOrder(o), await this.owner());
    await this.connectors.touch('shopee');
    return { ok: true, applied: (d.order_list ?? []).length };
  }

  /** Token còn hạn (tự làm mới khi còn < 10 phút). */
  private async session(fetchFn: typeof fetch): Promise<{ shop: { accessToken: string; shopId: number }; settings: ShopeeSettings } | null> {
    const cfg = shopeeConfig();
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'shopee' } });
    if (!cfg || !r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    const settings = r.settings as unknown as ShopeeSettings;
    let creds = JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as Creds;
    if (creds.expires_at < Date.now() + 10 * 60_000) {
      try {
        const t = await new ShopeeClient(cfg, fetchFn).token({ refreshToken: creds.refresh_token, shopId: settings.shop_id });
        creds = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expire_in * 1000 };
        await this.prisma.connectorAccount.update({ where: { provider: 'shopee' }, data: { credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()) } });
      } catch (err) {
        await this.connectors.touch('shopee', `Cần cấp quyền lại: ${(err as Error).message}`);
        return null;
      }
    }
    return { shop: { accessToken: creds.access_token, shopId: settings.shop_id }, settings };
  }

  private async owner(): Promise<SyncOwner> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'shopee' }, select: { connected_by: true } });
    const u = r ? await this.prisma.user.findUnique({ where: { id: r.connected_by }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? r?.connected_by ?? 0, team_id: u?.team_id ?? null };
  }
}
