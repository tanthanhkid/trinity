import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExternalCustomer, ExternalOrder, ExternalProduct } from './commerce-sync.service';
import https from 'node:https';
import { assertSafeUrl, createSafeLookup } from '../integrations/webhooks/ssrf-guard';

/**
 * WooCommerce REST API v3 — https://woocommerce.github.io/woocommerce-rest-api-docs/
 * Khoá REST do khách tạo (WooCommerce › Cài đặt › Nâng cao › REST API, quyền Đọc/Ghi): Basic auth `ck_…:cs_…` qua HTTPS.
 * Danh sách: `per_page` ≤100 + `page`, lọc `modified_after` (đơn, sản phẩm). Webhook: POST /webhooks { name, topic, delivery_url, secret };
 * Woo ký thân bằng HMAC-SHA256 (base64) với secret, header `X-WC-Webhook-Signature`.
 */
export const WOO_TOPICS = ['customer.created', 'customer.updated', 'customer.deleted', 'order.created', 'order.updated', 'order.deleted', 'product.created', 'product.updated', 'product.deleted'] as const;

/** Chuẩn hoá địa chỉ cửa hàng: bắt buộc https (khoá đi qua Basic auth), bỏ dấu / cuối. */
export function normalizeWooUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export function verifyWooSignature(raw: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!raw || !header || !secret) return false;
  const want = createHmac('sha256', secret).update(raw).digest('base64');
  return want.length === header.trim().length && timingSafeEqual(Buffer.from(want), Buffer.from(header.trim()));
}

type Obj = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === '' ? null : String(v));
const d = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null;
  const x = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(x.getTime()) ? null : x;
};
const name = (o: Obj | undefined) => (o ? [o.last_name, o.first_name].filter(Boolean).join(' ').trim() || null : null);

export function mapWooCustomer(c: Obj): ExternalCustomer {
  const billing = (c.billing as Obj | undefined) ?? {};
  return {
    external_id: String(c.id),
    code: s(c.username),
    name: name(c) ?? name(billing),
    phone: s(billing.phone),
    email: s(c.email) ?? s(billing.email),
    updated_at: d(c.date_modified_gmt ?? c.date_modified),
    data: { city: billing.city ?? null },
  };
}

export function mapWooOrder(o: Obj): ExternalOrder {
  const billing = (o.billing as Obj | undefined) ?? {};
  return {
    kind: 'order',
    external_id: String(o.id),
    code: s(o.number) ? `#${o.number}` : String(o.id),
    total: Number(o.total ?? 0),
    status: s(o.status),
    customer: { external_id: Number(o.customer_id) > 0 ? String(o.customer_id) : null, name: name(billing), phone: s(billing.phone) },
    items: ((o.line_items as Obj[] | undefined) ?? []).slice(0, 50).map((l) => ({ name: String(l.name ?? ''), quantity: Number(l.quantity ?? 0), price: Number(l.price ?? 0) })),
    updated_at: d(o.date_modified_gmt ?? o.date_modified),
    data: { payment_method: o.payment_method_title ?? null, currency: o.currency ?? null },
  };
}

export function mapWooProduct(p: Obj): ExternalProduct {
  return {
    external_id: String(p.id),
    code: s(p.sku),
    name: String(p.name ?? ''),
    price: p.price == null || p.price === '' ? null : Number(p.price),
    updated_at: d(p.date_modified_gmt ?? p.date_modified),
    data: { status: p.status ?? null, stock: p.stock_quantity ?? null },
  };
}

export type WooResource = 'customers' | 'orders' | 'products';

export interface WooTransportInit { method: string; headers: Record<string, string>; body?: string }
export type WooTransport = (url: string, init: WooTransportInit) => Promise<{ status: number; text: string }>;

/**
 * Gọi HTTPS với `lookup` tự kiểm (createSafeLookup): socket nối thẳng tới IP vừa kiểm ⇒ DNS rebinding (đổi đáp án giữa lúc
 * kiểm và lúc nối) không lọt vào mạng nội bộ. Không theo chuyển hướng, giới hạn 20s và 5 MB.
 */
export const pinnedHttps: WooTransport = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('chỉ https'));
    const req = https.request(
      { method: init.method, hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, headers: init.headers, agent: false, lookup: createSafeLookup() as never, timeout: 20_000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 5_000_000) req.destroy(new Error('phản hồi quá lớn'));
          else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(init.body);
  });

export class WooClient {
  constructor(
    private readonly cfg: { url: string; key: string; secret: string },
    private readonly transport: WooTransport = pinnedHttps,
    /** Chặn SSRF sớm (báo lỗi rõ); chặn thật nằm ở `lookup` của transport (gắn IP đã kiểm vào socket). */
    private readonly guard: (url: string) => Promise<unknown> = assertSafeUrl,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      await this.guard(this.cfg.url);
    } catch {
      throw new Error('Địa chỉ cửa hàng không hợp lệ hoặc trỏ vào mạng nội bộ.');
    }
    let res: { status: number; text: string };
    try {
      res = await this.transport(`${this.cfg.url}/wp-json/wc/v3${path}`, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${this.cfg.key}:${this.cfg.secret}`).toString('base64')}`, Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Không gọi được cửa hàng: ${(err as Error).message}`);
    }
    const text = res.text;
    if (res.status >= 300 && res.status < 400) throw new Error('Cửa hàng trả chuyển hướng — nhập đúng địa chỉ gốc (https, có/không www).');
    if (res.status === 401 || res.status === 403) throw new Error('WooCommerce từ chối khoá: kiểm tra Consumer key / Consumer secret và quyền Đọc/Ghi.');
    if (res.status === 404) throw new Error('Không thấy WooCommerce REST API ở địa chỉ này (cần WordPress + WooCommerce, đường dẫn tĩnh bật).');
    if (res.status < 200 || res.status >= 300) throw new Error(`WooCommerce ${method} ${path.split('?')[0]} lỗi HTTP ${res.status}`);
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Error('Địa chỉ này không trả dữ liệu WooCommerce (có thể bị trang khác chặn).');
    }
  }

  async check(): Promise<void> {
    await this.request('GET', '/system_status');
  }

  page(resource: WooResource, since: Date | null, page: number): Promise<Obj[]> {
    const q = new URLSearchParams({ per_page: '100', page: String(page), orderby: resource === 'customers' ? 'id' : 'modified', order: 'asc' });
    if (since && resource !== 'customers') q.set('modified_after', since.toISOString().replace(/\.\d+Z$/, ''));
    if (resource === 'customers') q.set('role', 'all');
    return this.request('GET', `/${resource}?${q.toString()}`);
  }

  async get(resource: WooResource, id: string): Promise<Obj | null> {
    try {
      return await this.request<Obj>('GET', `/${resource}/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  }

  /** Đăng ký đủ topic; hỏng giữa chừng ⇒ gỡ các hook đã tạo rồi mới báo lỗi. */
  async registerWebhooks(deliveryUrl: string, secret: string): Promise<number[]> {
    const ids: number[] = [];
    try {
      for (const topic of WOO_TOPICS) {
        const r = await this.request<{ id?: number }>('POST', '/webhooks', { name: `Trinity CRM — ${topic}`, topic, delivery_url: deliveryUrl, secret, status: 'active' });
        if (r.id) ids.push(r.id);
      }
    } catch (err) {
      await this.removeWebhooks(ids);
      throw err;
    }
    return ids;
  }

  async removeWebhooks(ids: number[]): Promise<void> {
    for (const id of ids) await this.request('DELETE', `/webhooks/${id}?force=true`).catch(() => undefined);
  }
}
