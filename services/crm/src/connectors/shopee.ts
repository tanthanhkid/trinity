import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExternalOrder } from './commerce-sync.service';

/**
 * Shopee Open Platform v2 — https://open.shopee.com/developer-guide/16
 * Ký: HMAC-SHA256(partner_key) hex trên `partner_id + path + timestamp` (API công khai, auth) hoặc
 * `partner_id + path + timestamp + access_token + shop_id` (API của shop). Shop cấp quyền qua /api/v2/shop/auth_partner,
 * Shopee chuyển về redirect kèm `code` + `shop_id`; đổi bằng /api/v2/auth/token/get (access 4 giờ, refresh 30 ngày).
 * Push (webhook): header `Authorization` = HMAC-SHA256(partner_key, `${url}|${body}`) hex.
 * partner_id/partner_key là app ĐỐI TÁC của Trinity ⇒ đặt ở máy chủ (SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_SANDBOX).
 */
export const SHOPEE_HOSTS = { live: 'https://partner.shopeemobile.com', sandbox: 'https://partner.test-stable.shopeemobile.com' } as const;

export interface ShopeeConfig {
  partnerId: number;
  partnerKey: string;
  sandbox: boolean;
}

export function shopeeConfig(env: NodeJS.ProcessEnv = process.env): ShopeeConfig | null {
  const id = Number((env.SHOPEE_PARTNER_ID ?? '').trim());
  const key = (env.SHOPEE_PARTNER_KEY ?? '').trim();
  if (!Number.isSafeInteger(id) || id <= 0 || key.length < 16) return null;
  return { partnerId: id, partnerKey: key, sandbox: (env.SHOPEE_SANDBOX ?? '').trim() === '1' };
}

export function shopeeSign(cfg: ShopeeConfig, path: string, ts: number, shop?: { accessToken: string; shopId: number }): string {
  const base = `${cfg.partnerId}${path}${ts}${shop ? `${shop.accessToken}${shop.shopId}` : ''}`;
  return createHmac('sha256', cfg.partnerKey).update(base).digest('hex');
}

/** URL cho chủ shop bấm cấp quyền. */
export function shopeeAuthUrl(cfg: ShopeeConfig, redirect: string, ts = Math.floor(Date.now() / 1000)): string {
  const path = '/api/v2/shop/auth_partner';
  const q = new URLSearchParams({ partner_id: String(cfg.partnerId), timestamp: String(ts), sign: shopeeSign(cfg, path, ts), redirect });
  return `${cfg.sandbox ? SHOPEE_HOSTS.sandbox : SHOPEE_HOSTS.live}${path}?${q.toString()}`;
}

export function verifyShopeePush(cfg: ShopeeConfig, url: string, raw: Buffer | undefined, header: string | undefined): boolean {
  if (!raw || !header) return false;
  const want = createHmac('sha256', cfg.partnerKey).update(`${url}|${raw.toString('utf8')}`).digest('hex');
  const got = header.trim().toLowerCase();
  return want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

type Obj = Record<string, unknown>;

/** Chi tiết đơn (get_order_detail) → đơn chung. Shopee che SĐT/địa chỉ người mua với đa số app ⇒ thường không ghép được khách theo SĐT. */
export function mapShopeeOrder(o: Obj): ExternalOrder {
  const addr = (o.recipient_address as Obj | undefined) ?? {};
  const phone = typeof addr.phone === 'string' && !addr.phone.includes('*') ? addr.phone : null;
  return {
    kind: 'order',
    external_id: String(o.order_sn),
    code: String(o.order_sn),
    total: Number(o.total_amount ?? 0),
    status: o.order_status == null ? null : String(o.order_status),
    customer: { external_id: o.buyer_user_id == null ? null : String(o.buyer_user_id), name: (o.buyer_username as string) ?? (addr.name as string) ?? null, phone },
    items: ((o.item_list as Obj[] | undefined) ?? []).slice(0, 50).map((i) => ({
      name: String(i.item_name ?? ''),
      quantity: Number(i.model_quantity_purchased ?? 1),
      price: Number(i.model_discounted_price ?? i.model_original_price ?? 0),
    })),
    updated_at: typeof o.update_time === 'number' ? new Date(o.update_time * 1000) : null,
    data: { payment_method: o.payment_method ?? null, shipping_carrier: o.shipping_carrier ?? null },
  };
}

interface ShopeeResp<T> { error?: string; message?: string; response?: T; request_id?: string }

export class ShopeeClient {
  constructor(
    private readonly cfg: ShopeeConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private host() {
    return this.cfg.sandbox ? SHOPEE_HOSTS.sandbox : SHOPEE_HOSTS.live;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string>, body?: unknown, shop?: { accessToken: string; shopId: number }): Promise<T> {
    const ts = this.now();
    const q = new URLSearchParams({ partner_id: String(this.cfg.partnerId), timestamp: String(ts), sign: shopeeSign(this.cfg, path, ts, shop), ...params });
    if (shop) {
      q.set('access_token', shop.accessToken);
      q.set('shop_id', String(shop.shopId));
    }
    const res = await this.fetchFn(`${this.host()}${path}?${q.toString()}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as ShopeeResp<T> & T;
    if (!res.ok || (j.error && j.error !== '')) throw new Error(`Shopee ${path}: ${j.message || j.error || `HTTP ${res.status}`}`);
    return (j.response ?? j) as T;
  }

  /** Đổi code (sau khi shop cấp quyền) hoặc refresh token. */
  token(input: { code: string; shopId: number } | { refreshToken: string; shopId: number }): Promise<{ access_token: string; refresh_token: string; expire_in: number }> {
    const path = 'code' in input ? '/api/v2/auth/token/get' : '/api/v2/auth/access_token/get';
    const body = 'code' in input
      ? { code: input.code, shop_id: input.shopId, partner_id: this.cfg.partnerId }
      : { refresh_token: input.refreshToken, shop_id: input.shopId, partner_id: this.cfg.partnerId };
    return this.call('POST', path, {}, body);
  }

  /** Mã đơn cập nhật trong khoảng (Shopee giới hạn ≤15 ngày mỗi lần). */
  orderList(shop: { accessToken: string; shopId: number }, from: number, to: number, cursor = ''): Promise<{ order_list?: Array<{ order_sn: string }>; more?: boolean; next_cursor?: string }> {
    return this.call('GET', '/api/v2/order/get_order_list', { time_range_field: 'update_time', time_from: String(from), time_to: String(to), page_size: '100', cursor }, undefined, shop);
  }

  orderDetail(shop: { accessToken: string; shopId: number }, sns: string[]): Promise<{ order_list?: Obj[] }> {
    return this.call('GET', '/api/v2/order/get_order_detail', {
      order_sn_list: sns.slice(0, 50).join(','),
      response_optional_fields: 'buyer_user_id,buyer_username,recipient_address,item_list,total_amount,payment_method,shipping_carrier,update_time',
    }, undefined, shop);
  }
}
