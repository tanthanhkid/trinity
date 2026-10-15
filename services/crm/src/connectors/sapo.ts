import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExternalCustomer, ExternalOrder, ExternalProduct } from './commerce-sync.service';

/**
 * Sapo (sapo.vn — mô hình API giống Shopify). Private app: Basic auth `api_key:secret` tới `https://{store}.mysapo.net/admin/*.json`.
 * Danh sách: `limit` (≤250) + `page`, lọc `modified_on_min`. Webhook: POST /admin/webhooks.json { webhook: { topic, address, format } }.
 * Tài liệu công khai không mô tả cách ký webhook ⇒ Trinity (1) đặt mã bí mật trong đường dẫn webhook, (2) nếu có header HMAC
 * kiểu Shopify thì kiểm, (3) không tin nội dung gửi kèm — đọc lại bản ghi từ API Sapo theo id rồi mới ghi.
 */
export const SAPO_WEBHOOK_TOPICS = ['customers/create', 'customers/update', 'customers/delete', 'orders/create', 'orders/updated', 'orders/delete', 'products/create', 'products/update', 'products/delete'] as const;

export function sapoBase(store: string): string {
  return `https://${store}.mysapo.net/admin`;
}

/** Header HMAC (base64 HMAC-SHA256 thân, khoá = secret của app) nếu Sapo gửi; không có header ⇒ null (dựa vào token đường dẫn + đọc lại). */
export function verifySapoHmac(raw: Buffer | undefined, header: string | undefined, secret: string): boolean | null {
  if (!header) return null;
  if (!raw || !secret) return false;
  const want = createHmac('sha256', secret).update(raw).digest('base64');
  const got = header.trim();
  return want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

type Obj = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === '' ? null : String(v));
const date = (o: Obj) => {
  const v = o.modified_on ?? o.updated_on ?? o.updated_at ?? o.created_on ?? o.created_at;
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const fullName = (o: Obj | undefined | null) => (o ? [o.last_name, o.first_name].filter(Boolean).join(' ').trim() || s(o.name) : null);

export function mapSapoCustomer(c: Obj): ExternalCustomer {
  const addr = (c.default_address as Obj | undefined) ?? undefined;
  return {
    external_id: String(c.id),
    code: s(c.code),
    name: fullName(c),
    phone: s(c.phone) ?? s(addr?.phone),
    email: s(c.email),
    updated_at: date(c),
    data: { orders_count: c.orders_count ?? null, total_spent: c.total_spent ?? null },
  };
}

export function mapSapoOrder(o: Obj): ExternalOrder {
  const cust = (o.customer as Obj | undefined) ?? null;
  const lines = ((o.line_items as Obj[] | undefined) ?? []).slice(0, 50);
  return {
    kind: 'order',
    external_id: String(o.id),
    code: s(o.name) ?? s(o.order_number),
    total: Number(o.total_price ?? 0),
    status: s(o.cancelled_on ?? o.cancelled_at) ? 'Đã huỷ' : s(o.financial_status),
    customer: cust ? { external_id: s(cust.id), name: fullName(cust), phone: s(cust.phone) ?? s((o.billing_address as Obj | undefined)?.phone) } : null,
    items: lines.map((l) => ({ name: String(l.title ?? l.name ?? ''), quantity: Number(l.quantity ?? 0), price: Number(l.price ?? 0) })),
    updated_at: date(o),
    data: { financial_status: o.financial_status ?? null, fulfillment_status: o.fulfillment_status ?? null, source: o.source_name ?? null },
  };
}

export function mapSapoProduct(p: Obj): ExternalProduct {
  const v = ((p.variants as Obj[] | undefined) ?? [])[0];
  return {
    external_id: String(p.id),
    code: s(v?.sku),
    name: String(p.name ?? p.title ?? ''),
    price: v?.price == null ? null : Number(v.price),
    updated_at: date(p),
    data: { vendor: p.vendor ?? null, product_type: p.product_type ?? null, variants: ((p.variants as Obj[] | undefined) ?? []).length },
  };
}

export class SapoHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type SapoResource = 'customers' | 'orders' | 'products';
const SINGULAR: Record<SapoResource, string> = { customers: 'customer', orders: 'order', products: 'product' };

export class SapoClient {
  constructor(
    private readonly cfg: { store: string; apiKey: string; secret: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${sapoBase(this.cfg.store)}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${this.cfg.apiKey}:${this.cfg.secret}`).toString('base64')}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('Sapo từ chối khoá: kiểm tra tên cửa hàng, API key và mật khẩu/secret của ứng dụng riêng (Private app).');
    if (res.status === 404 && path.startsWith('/store')) throw new SapoHttpError(404, 'Không tìm thấy cửa hàng Sapo này — kiểm tra tên cửa hàng (phần trước .mysapo.net).');
    if (!res.ok) throw new SapoHttpError(res.status, `Sapo ${method} ${path.split('?')[0]} lỗi HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Kiểm khoá: đọc thông tin cửa hàng. */
  async store(): Promise<{ name?: string }> {
    const r = await this.request<{ store?: { name?: string }; shop?: { name?: string } }>('GET', '/store.json');
    return r.store ?? r.shop ?? {};
  }

  async page(resource: SapoResource, since: Date | null, page: number): Promise<Obj[]> {
    const q = new URLSearchParams({ limit: '250', page: String(page) });
    if (since) q.set('modified_on_min', since.toISOString());
    if (resource === 'orders') q.set('status', 'any');
    const r = await this.request<Record<string, Obj[]>>('GET', `/${resource}.json?${q.toString()}`);
    return r[resource] ?? [];
  }

  /** null CHỈ khi Sapo trả 404 (bản ghi không còn); lỗi tạm thời/khoá ném ra để webhook báo lỗi và Sapo gửi lại. */
  async get(resource: SapoResource, id: string): Promise<Obj | null> {
    try {
      const r = await this.request<Record<string, Obj>>('GET', `/${resource}/${encodeURIComponent(id)}.json`);
      return r[SINGULAR[resource]] ?? null;
    } catch (err) {
      if (err instanceof SapoHttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** Đăng ký đủ topic; hỏng giữa chừng ⇒ gỡ các hook đã tạo rồi mới báo lỗi (không để hook mồ côi). */
  async registerWebhooks(address: string): Promise<number[]> {
    const ids: number[] = [];
    try {
      await this.registerAll(address, ids);
    } catch (err) {
      await this.removeWebhooks(ids);
      throw err;
    }
    return ids;
  }

  private async registerAll(address: string, ids: number[]): Promise<void> {
    for (const topic of SAPO_WEBHOOK_TOPICS) {
      // Topic gắn vào địa chỉ: không phụ thuộc tên header topic của Sapo.
      const r = await this.request<{ webhook?: { id?: number } }>('POST', '/webhooks.json', { webhook: { topic, address: `${address}?topic=${encodeURIComponent(topic)}`, format: 'json' } });
      if (r.webhook?.id) ids.push(r.webhook.id);
    }
  }

  async removeWebhooks(ids: number[]): Promise<void> {
    for (const id of ids) await this.request('DELETE', `/webhooks/${id}.json`).catch(() => undefined);
  }
}
