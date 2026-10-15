import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExternalOrder } from './commerce-sync.service';

/**
 * Lazada Open Platform — https://open.lazada.com/apps/doc/doc?nodeId=10450&docId=108068
 * Ký: sắp xếp tham số theo tên, ghép `api_path + k1v1k2v2…`, HMAC-SHA256(app_secret) hex IN HOA (sign_method=sha256, timestamp ms).
 * OAuth: auth.lazada.com/oauth/authorize → code → /auth/token/create (auth.lazada.com/rest). API VN: api.lazada.vn/rest.
 * Push: header `Authorization` = HMAC-SHA256(app_secret, app_key + body) hex.
 * app_key/app_secret là app ĐỐI TÁC của Trinity ⇒ đặt ở máy chủ (LAZADA_APP_KEY, LAZADA_APP_SECRET).
 */
export const LAZADA = { authorize: 'https://auth.lazada.com/oauth/authorize', auth: 'https://auth.lazada.com/rest', api: 'https://api.lazada.vn/rest' } as const;

export interface LazadaConfig { appKey: string; appSecret: string }

export function lazadaConfig(env: NodeJS.ProcessEnv = process.env): LazadaConfig | null {
  const k = (env.LAZADA_APP_KEY ?? '').trim();
  const s = (env.LAZADA_APP_SECRET ?? '').trim();
  return /^\d{4,20}$/.test(k) && s.length >= 16 ? { appKey: k, appSecret: s } : null;
}

export function lazadaSign(secret: string, path: string, params: Record<string, string>): string {
  const base = path + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha256', secret).update(base, 'utf8').digest('hex').toUpperCase();
}

export function lazadaAuthUrl(cfg: LazadaConfig, redirect: string, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', force_auth: 'true', redirect_uri: redirect, client_id: cfg.appKey, state });
  return `${LAZADA.authorize}?${q.toString()}`;
}

export function verifyLazadaPush(cfg: LazadaConfig, raw: Buffer | undefined, header: string | undefined): boolean {
  if (!raw || !header) return false;
  const want = createHmac('sha256', cfg.appSecret).update(cfg.appKey + raw.toString('utf8')).digest('hex');
  const got = header.trim().toLowerCase();
  return want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

type Obj = Record<string, unknown>;
const num = (v: unknown) => Number(String(v ?? '0').replace(/,/g, '')) || 0;

/**
 * Số tiền khách thực trả: `price` (tổng tiền hàng trước giảm) − voucher (sàn + shop) + phí ship − giảm phí ship.
 * Lazada trả `voucher` tổng hoặc tách `voucher_platform`/`voucher_seller` tuỳ phiên bản ⇒ ưu tiên tổng.
 */
export function lazadaPaidTotal(o: Obj): number {
  const voucher = o.voucher != null ? num(o.voucher) : num(o.voucher_platform) + num(o.voucher_seller);
  const shipDiscount = num(o.shipping_fee_discount_platform) + num(o.shipping_fee_discount_seller);
  return Math.max(0, num(o.price) - voucher + num(o.shipping_fee) - shipDiscount);
}

export function mapLazadaOrder(o: Obj, items: Obj[] = []): ExternalOrder {
  const billing = (o.address_billing as Obj | undefined) ?? (o.address_shipping as Obj | undefined) ?? {};
  const phone = typeof billing.phone === 'string' && !billing.phone.includes('*') ? billing.phone : null;
  const name = [o.customer_first_name, o.customer_last_name].filter(Boolean).join(' ').trim() || null;
  return {
    kind: 'order',
    external_id: String(o.order_id),
    code: String(o.order_number ?? o.order_id),
    total: lazadaPaidTotal(o),
    status: Array.isArray(o.statuses) ? String(o.statuses[0] ?? '') || null : null,
    customer: { external_id: null, name, phone },
    // `paid_price` = giá khách thực trả sau khuyến mãi; `item_price` là giá niêm yết.
    items: items.slice(0, 50).map((i) => ({ name: String(i.name ?? ''), quantity: 1, price: num(i.paid_price ?? i.item_price) })),
    updated_at: typeof o.updated_at === 'string' ? new Date(o.updated_at) : null,
    data: { payment_method: o.payment_method ?? null, items_count: o.items_count ?? null },
  };
}

interface LzResp<T> { code?: string; message?: string; data?: T; access_token?: string; refresh_token?: string; expires_in?: number; country_user_info?: Array<{ country?: string; seller_id?: string }>; account?: string }

export class LazadaClient {
  constructor(
    private readonly cfg: LazadaConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  private async call<T>(host: string, path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<LzResp<T>> {
    const all: Record<string, string> = { ...params, app_key: this.cfg.appKey, timestamp: String(this.nowMs()), sign_method: 'sha256' };
    all.sign = lazadaSign(this.cfg.appSecret, path, all);
    const q = new URLSearchParams(all).toString();
    const res = await this.fetchFn(method === 'GET' ? `${host}${path}?${q}` : `${host}${path}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' } : undefined,
      body: method === 'POST' ? q : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as LzResp<T>;
    if (!res.ok || (j.code && j.code !== '0')) throw new Error(`Lazada ${path}: ${j.message || j.code || `HTTP ${res.status}`}`);
    return j;
  }

  async token(input: { code: string } | { refreshToken: string }) {
    const j = 'code' in input
      ? await this.call(LAZADA.auth, '/auth/token/create', { code: input.code }, 'POST')
      : await this.call(LAZADA.auth, '/auth/token/refresh', { refresh_token: input.refreshToken }, 'POST');
    if (!j.access_token) throw new Error('Lazada không trả access_token.');
    const vn = (j.country_user_info ?? []).find((c) => c.country === 'vn') ?? j.country_user_info?.[0];
    return { access_token: j.access_token, refresh_token: j.refresh_token ?? '', expires_in: j.expires_in ?? 0, seller_id: vn?.seller_id ?? null, account: j.account ?? null };
  }

  async orders(accessToken: string, updatedAfter: Date, offset: number): Promise<{ orders: Obj[]; count: number }> {
    const j = await this.call<{ orders?: Obj[]; count?: number; countTotal?: number }>(LAZADA.api, '/orders/get', {
      access_token: accessToken, update_after: updatedAfter.toISOString().replace(/\.\d+Z$/, '+00:00'), sort_by: 'updated_at', sort_direction: 'ASC', limit: '100', offset: String(offset),
    });
    return { orders: j.data?.orders ?? [], count: j.data?.countTotal ?? j.data?.count ?? 0 };
  }

  /** Mặt hàng của nhiều đơn — Lazada nhận tối đa 50 mã mỗi lần ⇒ chia lô, gộp kết quả. */
  async items(accessToken: string, orderIds: string[]): Promise<Map<string, Obj[]>> {
    const out = new Map<string, Obj[]>();
    for (let i = 0; i < orderIds.length; i += 50) {
      const batch = orderIds.slice(i, i + 50);
      const j = await this.call<Array<{ order_id?: number | string; order_items?: Obj[] }>>(LAZADA.api, '/orders/items/get', { access_token: accessToken, order_ids: JSON.stringify(batch.map(Number)) });
      for (const r of j.data ?? []) out.set(String(r.order_id), r.order_items ?? []);
    }
    return out;
  }

  async order(accessToken: string, orderId: string): Promise<Obj | null> {
    const j = await this.call<Obj>(LAZADA.api, '/order/get', { access_token: accessToken, order_id: orderId });
    return j.data ?? null;
  }
}
