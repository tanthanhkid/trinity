import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { CommerceSyncService, type SyncOwner } from './commerce-sync.service';
import { ConnectorsService } from './connectors.service';
import { SapoClient, mapSapoCustomer, mapSapoOrder, mapSapoProduct, verifySapoHmac, type SapoResource } from './sapo';

const RESOURCES: readonly SapoResource[] = ['customers', 'products', 'orders'];
/** Mỗi lần đồng bộ tối đa ngần này trang (250 bản ghi/trang) mỗi loại. */
const MAX_PAGES = 2;
const FIRST_SYNC_DAYS = 90;

export interface SapoSettings {
  store: string;
  store_name?: string | null;
  webhook_ids?: number[];
  webhook_error?: string | null;
  cursors?: Partial<Record<SapoResource, string>>;
  /** Còn trang chưa đọc từ mốc `cursors` (lần đồng bộ trước dừng giữa chừng). */
  next_page?: Partial<Record<SapoResource, number>>;
  counts?: Partial<Record<SapoResource, number>>;
  last_sync_at?: string | null;
}

interface Creds {
  api_key: string;
  secret: string;
  webhook_token: string;
}

@Injectable()
export class SapoService {
  private readonly logger = new Logger(SapoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly sync: CommerceSyncService,
  ) {}

  async connect(input: { store?: string; api_key?: string; secret?: string }, userId: number, fetchFn: typeof fetch = fetch) {
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY nên chưa lưu được khoá.');
    const store = String(input.store ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.mysapo\.net.*$/, '');
    const apiKey = String(input.api_key ?? '').trim();
    const old = await this.creds();
    const secret = String(input.secret ?? '').trim() || (old && old.settings.store === store ? old.creds.secret : '');
    if (!/^[a-z0-9-]{2,60}$/.test(store)) throw new BadRequestException('Tên cửa hàng Sapo không hợp lệ (phần trước .mysapo.net).');
    if (!/^[A-Za-z0-9]{8,80}$/.test(apiKey) || secret.length < 8) throw new BadRequestException('Thiếu API key hoặc mật khẩu/secret của ứng dụng riêng (Sapo › Ứng dụng › Ứng dụng riêng).');
    const client = new SapoClient({ store, apiKey, secret }, fetchFn);
    let storeName: string | null = null;
    try {
      storeName = (await client.store()).name ?? null;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const switched = !!old && (old.settings.store !== store || old.creds.api_key !== apiKey);
    // Gỡ webhook cũ bằng KHOÁ CŨ (đổi cửa hàng/app thì khoá mới không gỡ được hook cũ).
    if (old?.settings.webhook_ids?.length) {
      await new SapoClient({ store: old.settings.store, apiKey: old.creds.api_key, secret: old.creds.secret }, fetchFn).removeWebhooks(old.settings.webhook_ids).catch(() => undefined);
    }
    const creds: Creds = { api_key: apiKey, secret, webhook_token: !switched && old?.creds.webhook_token ? old.creds.webhook_token : randomBytes(18).toString('base64url') };
    const settings: SapoSettings = switched || !old ? { store, store_name: storeName } : { ...old.settings, store, store_name: storeName, webhook_ids: [] };
    const base = publicBaseUrl();
    if (base) {
      try {
        settings.webhook_ids = await client.registerWebhooks(`${base}/api/v1/connectors/sapo/webhook/${creds.webhook_token}`);
        settings.webhook_error = null;
      } catch (err) {
        settings.webhook_ids = [];
        settings.webhook_error = (err as Error).message.slice(0, 200);
      }
    } else {
      settings.webhook_error = 'Chưa đặt INTEGRATIONS_PUBLIC_BASE_URL nên chưa đăng ký webhook — dùng nút Đồng bộ.';
    }
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()), settings: settings as object, last_error: null, connected_by: userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'sapo' }, update: data, create: { provider: 'sapo', ...data } });
    const first = await this.runSync(fetchFn).catch((e) => ({ error: (e as Error).message }));
    return { status: (await this.connectors.list()).find((x) => x.provider === 'sapo'), first_sync: first };
  }

  async disconnect(fetchFn: typeof fetch = fetch): Promise<void> {
    const c = await this.creds();
    if (c?.settings.webhook_ids?.length) await this.client(c, fetchFn).removeWebhooks(c.settings.webhook_ids).catch(() => undefined);
    await this.connectors.disconnect('sapo');
  }

  async runSync(fetchFn: typeof fetch = fetch): Promise<{ added: Record<SapoResource, number>; more: boolean }> {
    const c = await this.creds();
    if (!c) throw new BadRequestException('Chưa kết nối Sapo.');
    const client = this.client(c, fetchFn);
    const owner = await this.owner();
    const cursors = { ...(c.settings.cursors ?? {}) };
    const nextPage = { ...(c.settings.next_page ?? {}) };
    const counts = { ...(c.settings.counts ?? {}) };
    const added = { customers: 0, products: 0, orders: 0 } as Record<SapoResource, number>;
    let more = false;
    try {
      for (const r of RESOURCES) {
        const since = cursors[r] ? new Date(cursors[r]!) : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);
        const start = nextPage[r] ?? 1;
        let newest = since;
        let unfinished = false;
        for (let page = start; page < start + MAX_PAGES; page++) {
          const rows = await client.page(r, since, page);
          for (const row of rows) {
            await this.apply(c.settings.store, r, row, owner);
            const d = new Date(String(row.modified_on ?? row.updated_on ?? row.updated_at ?? row.created_on ?? ''));
            if (!Number.isNaN(d.getTime()) && d > newest) newest = d;
          }
          added[r] += rows.length;
          if (rows.length < 250) break;
          if (page === start + MAX_PAGES - 1) unfinished = true;
        }
        if (unfinished) {
          // Giữ nguyên mốc, lần sau đọc tiếp từ trang kế (không đọc lại trang đã đọc).
          nextPage[r] = start + MAX_PAGES;
          more = true;
        } else {
          delete nextPage[r];
          cursors[r] = newest.toISOString();
        }
        counts[r] = (counts[r] ?? 0) + added[r];
      }
      await this.saveSettings({ ...c.settings, cursors, next_page: nextPage, counts, last_sync_at: new Date().toISOString() });
      await this.connectors.touch('sapo');
    } catch (err) {
      await this.connectors.touch('sapo', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    return { added, more };
  }

  /**
   * Webhook: token đường dẫn phải đúng; có header HMAC thì phải đúng. Nội dung gửi kèm chỉ dùng để lấy id —
   * bản ghi được đọc lại từ API Sapo bằng khoá của mình rồi mới ghi (không ai giả được dữ liệu).
   */
  async handleWebhook(token: string, topic: string | undefined, raw: Buffer | undefined, hmac: string | undefined, body: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; applied: number }> {
    const c = await this.creds();
    if (!c || !safeEq(token, c.creds.webhook_token)) return { ok: false, applied: 0 };
    if (verifySapoHmac(raw, hmac, c.creds.secret) === false) return { ok: false, applied: 0 };
    const t = String(topic ?? '').toLowerCase();
    const resource: SapoResource | null = t.startsWith('customers/') ? 'customers' : t.startsWith('orders/') ? 'orders' : t.startsWith('products/') ? 'products' : null;
    const id = body?.id != null ? String(body.id) : null;
    if (!resource || !id || !/^\d{1,20}$/.test(id)) return { ok: true, applied: 0 };
    const kind = resource === 'customers' ? 'customer' : resource === 'products' ? 'product' : 'order';
    // Xoá bên Sapo: không đọc lại được nữa ⇒ đánh dấu removed (token đường dẫn đã xác thực).
    if (t.endsWith('/delete')) {
      await this.sync.markRemoved('sapo', c.settings.store, kind, id);
      return { ok: true, applied: 1 };
    }
    const fresh = await this.client(c, fetchFn).get(resource, id);
    if (!fresh) {
      await this.sync.markRemoved('sapo', c.settings.store, kind, id);
      return { ok: true, applied: 0 };
    }
    await this.apply(c.settings.store, resource, fresh, await this.owner());
    await this.connectors.touch('sapo');
    return { ok: true, applied: 1 };
  }

  private async apply(account: string, r: SapoResource, row: Record<string, unknown>, owner: SyncOwner): Promise<void> {
    if (r === 'customers') await this.sync.upsertCustomer('sapo', account, mapSapoCustomer(row), owner);
    else if (r === 'products') await this.sync.upsertProduct('sapo', account, mapSapoProduct(row));
    else await this.sync.upsertOrder('sapo', account, mapSapoOrder(row), owner);
  }

  private client(c: { creds: Creds; settings: SapoSettings }, fetchFn: typeof fetch): SapoClient {
    return new SapoClient({ store: c.settings.store, apiKey: c.creds.api_key, secret: c.creds.secret }, fetchFn);
  }

  private async creds(): Promise<{ creds: Creds; settings: SapoSettings } | null> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'sapo' } });
    if (!r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    return { creds: JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as Creds, settings: r.settings as unknown as SapoSettings };
  }

  private async owner(): Promise<SyncOwner> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'sapo' }, select: { connected_by: true } });
    const u = r ? await this.prisma.user.findUnique({ where: { id: r.connected_by }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? r?.connected_by ?? 0, team_id: u?.team_id ?? null };
  }

  private async saveSettings(settings: SapoSettings): Promise<void> {
    await this.prisma.connectorAccount.update({ where: { provider: 'sapo' }, data: { settings: settings as object } });
  }
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
