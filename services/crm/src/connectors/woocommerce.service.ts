import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { CommerceSyncService, type SyncOwner } from './commerce-sync.service';
import { ConnectorsService } from './connectors.service';
import { WooClient, type WooTransport, mapWooCustomer, mapWooOrder, mapWooProduct, normalizeWooUrl, verifyWooSignature, type WooResource } from './woocommerce';

const RESOURCES: readonly WooResource[] = ['customers', 'products', 'orders'];
const MAX_PAGES = 3;
const FIRST_SYNC_DAYS = 90;

export interface WooSettings {
  url: string;
  webhook_ids?: number[];
  webhook_error?: string | null;
  cursors?: Partial<Record<WooResource, string>>;
  next_page?: Partial<Record<WooResource, number>>;
  counts?: Partial<Record<WooResource, number>>;
  last_sync_at?: string | null;
}

interface Creds {
  key: string;
  secret: string;
  webhook_secret: string;
  webhook_token: string;
}

@Injectable()
export class WooCommerceService {
  private readonly logger = new Logger(WooCommerceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly sync: CommerceSyncService,
  ) {}

  async connect(input: { url?: string; consumer_key?: string; consumer_secret?: string }, userId: number, transport?: WooTransport, guard?: (u: string) => Promise<unknown>) {
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY nên chưa lưu được khoá.');
    const url = normalizeWooUrl(String(input.url ?? ''));
    if (!url) throw new BadRequestException('Địa chỉ cửa hàng phải là https://… công khai (vd https://shop.example.com).');
    const key = String(input.consumer_key ?? '').trim();
    const old = await this.creds();
    const secret = String(input.consumer_secret ?? '').trim() || (old && old.settings.url === url ? old.creds.secret : '');
    if (!/^ck_[A-Za-z0-9]{20,64}$/.test(key) || !/^cs_[A-Za-z0-9]{20,64}$/.test(secret)) throw new BadRequestException('Consumer key phải bắt đầu bằng ck_, Consumer secret bằng cs_ (WooCommerce › Cài đặt › Nâng cao › REST API).');
    const client = new WooClient({ url, key, secret }, transport, guard);
    try {
      await client.check();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const switched = !!old && (old.settings.url !== url || old.creds.key !== key);
    if (old?.settings.webhook_ids?.length) {
      await new WooClient({ url: old.settings.url, key: old.creds.key, secret: old.creds.secret }, transport, guard).removeWebhooks(old.settings.webhook_ids).catch(() => undefined);
    }
    const creds: Creds = {
      key, secret,
      webhook_secret: !switched && old?.creds.webhook_secret ? old.creds.webhook_secret : randomBytes(24).toString('base64url'),
      webhook_token: !switched && old?.creds.webhook_token ? old.creds.webhook_token : randomBytes(18).toString('base64url'),
    };
    const settings: WooSettings = switched || !old ? { url } : { ...old.settings, url, webhook_ids: [] };
    const base = publicBaseUrl();
    if (base) {
      try {
        settings.webhook_ids = await client.registerWebhooks(`${base}/api/v1/connectors/woocommerce/webhook/${creds.webhook_token}`, creds.webhook_secret);
        settings.webhook_error = null;
      } catch (err) {
        settings.webhook_ids = [];
        settings.webhook_error = (err as Error).message.slice(0, 200);
      }
    } else {
      settings.webhook_error = 'Chưa đặt INTEGRATIONS_PUBLIC_BASE_URL nên chưa đăng ký webhook — dùng nút Đồng bộ.';
    }
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()), settings: settings as object, last_error: null, connected_by: userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'woocommerce' }, update: data, create: { provider: 'woocommerce', ...data } });
    const first = await this.runSync(transport, guard).catch((e) => ({ error: (e as Error).message }));
    return { status: (await this.connectors.list()).find((x) => x.provider === 'woocommerce'), first_sync: first };
  }

  async disconnect(transport?: WooTransport): Promise<void> {
    const c = await this.creds();
    if (c?.settings.webhook_ids?.length) await this.client(c, transport).removeWebhooks(c.settings.webhook_ids).catch(() => undefined);
    await this.connectors.disconnect('woocommerce');
  }

  async runSync(transport?: WooTransport, guard?: (u: string) => Promise<unknown>): Promise<{ added: Record<WooResource, number>; more: boolean }> {
    const c = await this.creds();
    if (!c) throw new BadRequestException('Chưa kết nối WooCommerce.');
    const client = this.client(c, transport, guard);
    const owner = await this.owner();
    const cursors = { ...(c.settings.cursors ?? {}) };
    const nextPage = { ...(c.settings.next_page ?? {}) };
    const counts = { ...(c.settings.counts ?? {}) };
    const added = { customers: 0, products: 0, orders: 0 } as Record<WooResource, number>;
    let more = false;
    try {
      for (const r of RESOURCES) {
        // Khách: Woo không lọc theo ngày sửa ⇒ đọc theo id tăng dần, nhớ trang.
        const since = r === 'customers' ? null : cursors[r] ? new Date(cursors[r]!) : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);
        const start = nextPage[r] ?? 1;
        let newest = since ?? new Date(0);
        let unfinished = false;
        let lastPage = start;
        for (let page = start; page < start + MAX_PAGES; page++) {
          lastPage = page;
          const rows = await client.page(r, since, page);
          for (const row of rows) {
            await this.apply(c.settings.url, r, row, owner);
            const d = new Date(String(row.date_modified_gmt ? `${row.date_modified_gmt}Z` : row.date_modified ?? ''));
            if (!Number.isNaN(d.getTime()) && d > newest) newest = d;
          }
          added[r] += rows.length;
          if (rows.length < 100) break;
          if (page === start + MAX_PAGES - 1) unfinished = true;
        }
        if (unfinished) {
          nextPage[r] = start + MAX_PAGES;
          more = true;
        } else if (r === 'customers') {
          // Lần sau đọc lại từ trang cuối (khách mới có id lớn hơn nằm cuối danh sách).
          nextPage[r] = lastPage;
        } else {
          delete nextPage[r];
          cursors[r] = newest.toISOString();
        }
        counts[r] = (counts[r] ?? 0) + added[r];
      }
      await this.prisma.connectorAccount.update({ where: { provider: 'woocommerce' }, data: { settings: { ...c.settings, cursors, next_page: nextPage, counts, last_sync_at: new Date().toISOString() } as object } });
      await this.connectors.touch('woocommerce');
    } catch (err) {
      await this.connectors.touch('woocommerce', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    return { added, more };
  }

  /** Webhook Woo: token đường dẫn + X-WC-Webhook-Signature. Lượt "ping" lúc tạo webhook (không phải JSON đơn) ⇒ 200, bỏ qua. */
  async handleWebhook(token: string, topic: string | undefined, raw: Buffer | undefined, signature: string | undefined, body: Record<string, unknown>): Promise<{ ok: boolean; applied: number }> {
    const c = await this.creds();
    if (!c || !safeEq(token, c.creds.webhook_token)) return { ok: false, applied: 0 };
    if (!signature && raw && /^webhook_id=\d+$/.test(raw.toString('utf8').trim())) return { ok: true, applied: 0 };
    if (!verifyWooSignature(raw, signature, c.creds.webhook_secret)) return { ok: false, applied: 0 };
    const t = String(topic ?? '').toLowerCase();
    const resource: WooResource | null = t.startsWith('customer.') ? 'customers' : t.startsWith('order.') ? 'orders' : t.startsWith('product.') ? 'products' : null;
    if (!resource || body?.id == null) return { ok: true, applied: 0 };
    if (t.endsWith('.deleted')) {
      const kind = resource === 'customers' ? 'customer' : resource === 'products' ? 'product' : 'order';
      await this.sync.markRemoved('woocommerce', c.settings.url.replace(/^https:\/\//, '').slice(0, 80), kind, String(body.id));
      return { ok: true, applied: 1 };
    }
    await this.apply(c.settings.url, resource, body, await this.owner());
    await this.connectors.touch('woocommerce');
    return { ok: true, applied: 1 };
  }

  private async apply(account: string, r: WooResource, row: Record<string, unknown>, owner: SyncOwner): Promise<void> {
    const acc = account.replace(/^https:\/\//, '').slice(0, 80);
    if (r === 'customers') await this.sync.upsertCustomer('woocommerce', acc, mapWooCustomer(row), owner);
    else if (r === 'products') await this.sync.upsertProduct('woocommerce', acc, mapWooProduct(row));
    else await this.sync.upsertOrder('woocommerce', acc, mapWooOrder(row), owner);
  }

  private client(c: { creds: Creds; settings: WooSettings }, transport?: WooTransport, guard?: (u: string) => Promise<unknown>): WooClient {
    return new WooClient({ url: c.settings.url, key: c.creds.key, secret: c.creds.secret }, transport, guard);
  }

  private async creds(): Promise<{ creds: Creds; settings: WooSettings } | null> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'woocommerce' } });
    if (!r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    return { creds: JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as Creds, settings: r.settings as unknown as WooSettings };
  }

  private async owner(): Promise<SyncOwner> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'woocommerce' }, select: { connected_by: true } });
    const u = r ? await this.prisma.user.findUnique({ where: { id: r.connected_by }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? r?.connected_by ?? 0, team_id: u?.team_id ?? null };
  }
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
