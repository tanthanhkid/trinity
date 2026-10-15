import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptSecret, encryptSecret, isSecretKeyConfigured, loadSecretKey } from '../integrations/webhooks/secret-crypto';
import { publicBaseUrl } from '../integrations/oauth/oauth-config';
import { CommerceSyncService, type SyncOwner } from './commerce-sync.service';
import { ConnectorsService } from './connectors.service';
import { KiotVietClient, mapKvCustomer, mapKvOrder, mapKvProduct, verifyKiotvietSignature, kvDate, type KvWebhookBody } from './kiotviet';

const RESOURCES = ['customers', 'products', 'orders', 'invoices'] as const;
type Resource = (typeof RESOURCES)[number];
/** Mỗi lần bấm đồng bộ đọc tối đa ngần này trang (100 bản ghi/trang) mỗi loại — vừa thời gian một request serverless. */
const MAX_PAGES = 3;
/** Lần đầu chỉ kéo dữ liệu sửa trong ngần này ngày. */
const FIRST_SYNC_DAYS = 90;

export interface KiotVietSettings {
  retailer: string;
  client_id: string;
  webhook_ids?: number[];
  webhook_error?: string | null;
  cursors?: Partial<Record<Resource, string>>;
  counts?: Partial<Record<Resource, number>>;
  last_sync_at?: string | null;
}

interface Creds {
  client_secret: string;
  webhook_secret: string;
  webhook_token: string;
}

@Injectable()
export class KiotVietService {
  private readonly logger = new Logger(KiotVietService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly sync: CommerceSyncService,
  ) {}

  /** Kết nối: kiểm khoá bằng cách lấy token thật, đăng ký webhook, rồi đồng bộ lần đầu. */
  async connect(input: { retailer?: string; client_id?: string; client_secret?: string }, userId: number, fetchFn: typeof fetch = fetch) {
    if (!isSecretKeyConfigured()) throw new ServiceUnavailableException('Máy chủ chưa đặt INTEGRATIONS_SECRET_KEY nên chưa lưu được khoá.');
    const retailer = String(input.retailer ?? '').trim().toLowerCase();
    const clientId = String(input.client_id ?? '').trim();
    const old = await this.creds();
    const clientSecret = String(input.client_secret ?? '').trim() || old?.creds.client_secret || '';
    if (!/^[a-z0-9-]{2,60}$/.test(retailer)) throw new BadRequestException('Tên gian hàng KiotViet không hợp lệ (phần trước .kiotviet.vn).');
    if (!/^[A-Za-z0-9-]{8,80}$/.test(clientId) || clientSecret.length < 8) throw new BadRequestException('Thiếu Client ID hoặc mã bảo mật (Thiết lập › Thiết lập kết nối API của KiotViet).');
    const client = new KiotVietClient({ retailer, clientId, clientSecret }, fetchFn);
    try {
      await client.accessToken();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    // Đổi sang gian hàng/ứng dụng khác ⇒ gỡ webhook cũ bằng KHOÁ CŨ, rồi đổi token + secret để gian hàng cũ không gửi vào được nữa.
    const switched = !!old && (old.settings.retailer !== retailer || old.settings.client_id !== clientId);
    if (old?.settings.webhook_ids?.length) {
      const oldClient = new KiotVietClient({ retailer: old.settings.retailer, clientId: old.settings.client_id, clientSecret: old.creds.client_secret }, fetchFn);
      await oldClient.removeWebhooks(old.settings.webhook_ids).catch(() => undefined);
    }
    const creds: Creds = {
      client_secret: clientSecret,
      webhook_secret: !switched && old?.creds.webhook_secret ? old.creds.webhook_secret : randomBytes(24).toString('base64url'),
      webhook_token: !switched && old?.creds.webhook_token ? old.creds.webhook_token : randomBytes(18).toString('base64url'),
    };
    const settings: KiotVietSettings = switched ? { retailer, client_id: clientId } : { ...(old?.settings ?? {}), retailer, client_id: clientId, webhook_ids: [] };
    // Webhook cần địa chỉ công khai; thiếu thì vẫn chạy được bằng nút Đồng bộ.
    const base = publicBaseUrl();
    if (base) {
      try {
        settings.webhook_ids = await client.registerWebhooks(`${base}/api/v1/connectors/kiotviet/webhook/${creds.webhook_token}`, creds.webhook_secret);
        settings.webhook_error = null;
      } catch (err) {
        settings.webhook_ids = [];
        settings.webhook_error = (err as Error).message.slice(0, 200);
      }
    } else {
      settings.webhook_error = 'Chưa đặt INTEGRATIONS_PUBLIC_BASE_URL nên chưa đăng ký webhook — dùng nút Đồng bộ.';
    }
    const data = { status: 'active', credentials_enc: encryptSecret(JSON.stringify(creds), loadSecretKey()), settings: settings as object, last_error: null, connected_by: userId };
    await this.prisma.connectorAccount.upsert({ where: { provider: 'kiotviet' }, update: data, create: { provider: 'kiotviet', ...data } });
    const first = await this.runSync(fetchFn).catch((e) => ({ error: (e as Error).message }));
    return { status: (await this.connectors.list()).find((x) => x.provider === 'kiotviet'), first_sync: first };
  }

  async disconnect(fetchFn: typeof fetch = fetch): Promise<void> {
    const c = await this.creds();
    if (c?.settings.webhook_ids?.length) {
      await new KiotVietClient({ retailer: c.settings.retailer, clientId: c.settings.client_id, clientSecret: c.creds.client_secret }, fetchFn).removeWebhooks(c.settings.webhook_ids).catch(() => undefined);
    }
    await this.connectors.disconnect('kiotviet');
  }

  /** Đồng bộ tiếp từ mốc đã lưu. `more` = còn dữ liệu, bấm tiếp. */
  async runSync(fetchFn: typeof fetch = fetch): Promise<{ added: Record<Resource, number>; more: boolean }> {
    const c = await this.creds();
    if (!c) throw new BadRequestException('Chưa kết nối KiotViet.');
    const client = new KiotVietClient({ retailer: c.settings.retailer, clientId: c.settings.client_id, clientSecret: c.creds.client_secret }, fetchFn);
    const owner = await this.owner();
    const cursors = { ...(c.settings.cursors ?? {}) };
    const counts = { ...(c.settings.counts ?? {}) };
    const added = { customers: 0, products: 0, orders: 0, invoices: 0 } as Record<Resource, number>;
    let more = false;
    try {
      for (const r of RESOURCES) {
        const since = cursors[r] ? new Date(cursors[r]!) : new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);
        let item = 0;
        for (let p = 0; p < MAX_PAGES; p++) {
          const page = await client.page(r, since, item);
          const rows = page.data ?? [];
          for (const row of rows) await this.apply(c.settings.retailer, r, row, owner);
          for (const id of page.removeId ?? []) await this.sync.markRemoved('kiotviet', c.settings.retailer, r === 'customers' ? 'customer' : 'product', String(id));
          added[r] += rows.length;
          const last = rows.length ? kvDate(rows[rows.length - 1].modifiedDate ?? rows[rows.length - 1].createdDate) : null;
          if (last) cursors[r] = last.toISOString();
          item += rows.length;
          if (rows.length < 100) break;
          if (p === MAX_PAGES - 1) more = true;
        }
        counts[r] = (counts[r] ?? 0) + added[r];
      }
      await this.saveSettings({ ...c.settings, cursors, counts, last_sync_at: new Date().toISOString() });
      await this.connectors.touch('kiotviet');
    } catch (err) {
      await this.saveSettings({ ...c.settings, cursors, counts });
      await this.connectors.touch('kiotviet', (err as Error).message);
      throw new BadRequestException((err as Error).message);
    }
    return { added, more };
  }

  /** Webhook: kiểm token đường dẫn + chữ ký, rồi ghi từng bản ghi. Sai ⇒ 401; còn lại luôn 200 (4xx làm KiotViet ngừng gửi). */
  async handleWebhook(token: string, raw: Buffer | undefined, signature: string | undefined, body: KvWebhookBody): Promise<{ ok: boolean; applied: number }> {
    const c = await this.creds();
    if (!c || !safeEq(token, c.creds.webhook_token) || !verifyKiotvietSignature(raw, signature, c.creds.webhook_secret)) return { ok: false, applied: 0 };
    const owner = await this.owner();
    let applied = 0;
    for (const n of body?.Notifications ?? []) {
      const action = String(n.Action ?? '').toLowerCase();
      const resource: Resource | null = action.startsWith('customer') ? 'customers' : action.startsWith('product') ? 'products' : action.startsWith('order') ? 'orders' : action.startsWith('invoice') ? 'invoices' : null;
      if (!resource) continue;
      for (const row of (n.Data ?? []).slice(0, 200)) {
        try {
          if (action.endsWith('.delete')) {
            const ids = Array.isArray(row) ? row : [row?.Id ?? row?.id ?? row];
            for (const id of ids) await this.sync.markRemoved('kiotviet', c.settings.retailer, resource === 'customers' ? 'customer' : 'product', String(id));
          } else {
            await this.apply(c.settings.retailer, resource, row as Record<string, unknown>, owner);
          }
          applied++;
        } catch (err) {
          this.logger.warn(`KiotViet webhook ${action} lỗi: ${(err as Error).message}`);
        }
      }
    }
    await this.connectors.touch('kiotviet');
    return { ok: true, applied };
  }

  private async apply(account: string, r: Resource, row: Record<string, unknown>, owner: SyncOwner): Promise<void> {
    if (r === 'customers') await this.sync.upsertCustomer('kiotviet', account, mapKvCustomer(row), owner);
    else if (r === 'products') await this.sync.upsertProduct('kiotviet', account, mapKvProduct(row));
    else await this.sync.upsertOrder('kiotviet', account, mapKvOrder(row, r === 'orders' ? 'order' : 'invoice'), owner);
  }

  private async creds(): Promise<{ creds: Creds; settings: KiotVietSettings; connected_by: number } | null> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'kiotviet' } });
    if (!r || r.status === 'disconnected' || !r.credentials_enc || !isSecretKeyConfigured()) return null;
    return { creds: JSON.parse(decryptSecret(r.credentials_enc, loadSecretKey())) as Creds, settings: r.settings as unknown as KiotVietSettings, connected_by: r.connected_by };
  }

  private async owner(): Promise<SyncOwner> {
    const r = await this.prisma.connectorAccount.findUnique({ where: { provider: 'kiotviet' }, select: { connected_by: true } });
    const u = r ? await this.prisma.user.findUnique({ where: { id: r.connected_by }, select: { id: true, team_id: true } }) : null;
    return { id: u?.id ?? r?.connected_by ?? 0, team_id: u?.team_id ?? null };
  }

  private async saveSettings(settings: KiotVietSettings): Promise<void> {
    await this.prisma.connectorAccount.update({ where: { provider: 'kiotviet' }, data: { settings: settings as object } });
  }
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
