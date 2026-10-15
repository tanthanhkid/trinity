import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ExternalCustomer, ExternalOrder, ExternalProduct } from './commerce-sync.service';

/**
 * KiotViet Public API — https://www.kiotviet.vn/huong-dan-su-dung-public-api-retail/
 * Token: POST id.kiotviet.vn/connect/token (client_credentials, scopes=PublicApi.Access), hạn 86400s.
 * Gọi API: public.kiotapi.com, header `Retailer: <tên gian hàng>` + `Authorization: Bearer`.
 * Webhook: POST /webhooks { Webhook: { Type, Url, IsActive, Description, Secret(base64) } };
 * KiotViet ký thân bằng HMAC-SHA256 với secret, header `X-Hub-Signature`. Trả 4xx là KiotViet NGỪNG gửi ⇒ chỉ 401 khi sai chữ ký.
 */
export const KIOTVIET = {
  token: 'https://id.kiotviet.vn/connect/token',
  api: 'https://public.kiotapi.com',
  webhookTypes: ['customer.update', 'customer.delete', 'order.update', 'invoice.update', 'product.update', 'product.delete'] as const,
};

/**
 * Kiểm `X-Hub-Signature`. Tài liệu không ghi rõ khoá là secret thô hay bản base64, đầu ra hex hay base64, có tiền tố `sha256=` không
 * ⇒ chấp nhận các biến thể đó (vẫn bắt buộc biết secret). So sánh thời gian hằng.
 */
export function verifyKiotvietSignature(raw: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!raw || !header || !secret) return false;
  const got = header.trim().replace(/^sha256=/i, '');
  const keys = [secret, Buffer.from(secret).toString('base64')];
  for (const k of keys) {
    const mac = createHmac('sha256', k).update(raw).digest();
    for (const want of [mac.toString('hex'), mac.toString('base64')]) {
      if (want.length === got.length && timingSafeEqual(Buffer.from(want), Buffer.from(got))) return true;
      if (want.toLowerCase() === got.toLowerCase() && want.length === got.length) return true;
    }
  }
  return false;
}

/** Ngày KiotViet ("2026-10-15T08:30:00.0000000" giờ VN, không múi) → Date. */
export function kvDate(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(/\.\d+$/, '')}+07:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Obj = Record<string, unknown>;
const pick = (o: Obj, ...keys: string[]) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
};
const s = (v: unknown) => (v == null ? null : String(v));

/** Webhook gửi tên trường PascalCase, API trả camelCase ⇒ đọc cả hai. */
export function mapKvCustomer(c: Obj): ExternalCustomer {
  return {
    external_id: String(pick(c, 'id', 'Id')),
    code: s(pick(c, 'code', 'Code')),
    name: s(pick(c, 'name', 'Name')),
    phone: s(pick(c, 'contactNumber', 'ContactNumber')),
    email: s(pick(c, 'email', 'Email')),
    updated_at: kvDate(pick(c, 'modifiedDate', 'ModifiedDate', 'createdDate', 'CreatedDate')),
    data: { debt: pick(c, 'debt', 'Debt') ?? null, total_revenue: pick(c, 'totalRevenue', 'TotalRevenue') ?? null, address: pick(c, 'address', 'Address') ?? null },
  };
}

export function mapKvOrder(o: Obj, kind: 'order' | 'invoice'): ExternalOrder {
  const details = (pick(o, kind === 'order' ? 'orderDetails' : 'invoiceDetails', kind === 'order' ? 'OrderDetails' : 'InvoiceDetails') as Obj[] | undefined) ?? [];
  return {
    kind,
    external_id: String(pick(o, 'id', 'Id')),
    code: s(pick(o, 'code', 'Code')),
    total: Number(pick(o, 'total', 'Total') ?? 0),
    status: s(pick(o, 'statusValue', 'StatusValue', 'status', 'Status')),
    customer: {
      external_id: s(pick(o, 'customerId', 'CustomerId')),
      name: s(pick(o, 'customerName', 'CustomerName')),
      phone: s(pick((pick(o, 'customer', 'Customer') as Obj) ?? {}, 'contactNumber', 'ContactNumber')),
    },
    items: details.slice(0, 50).map((d) => ({
      name: String(pick(d, 'productName', 'ProductName', 'productCode', 'ProductCode') ?? ''),
      quantity: Number(pick(d, 'quantity', 'Quantity') ?? 0),
      price: Number(pick(d, 'price', 'Price') ?? 0),
    })),
    updated_at: kvDate(pick(o, 'modifiedDate', 'ModifiedDate', 'purchaseDate', 'PurchaseDate')),
    data: { branch: pick(o, 'branchName', 'BranchName') ?? null, purchase_date: pick(o, 'purchaseDate', 'PurchaseDate') ?? null },
  };
}

export function mapKvProduct(p: Obj): ExternalProduct {
  return {
    external_id: String(pick(p, 'id', 'Id')),
    code: s(pick(p, 'code', 'Code')),
    name: String(pick(p, 'fullName', 'FullName', 'name', 'Name') ?? ''),
    price: pick(p, 'basePrice', 'BasePrice') == null ? null : Number(pick(p, 'basePrice', 'BasePrice')),
    updated_at: kvDate(pick(p, 'modifiedDate', 'ModifiedDate', 'createdDate', 'CreatedDate')),
    data: { unit: pick(p, 'unit', 'Unit') ?? null, category: pick(p, 'categoryName', 'CategoryName') ?? null },
  };
}

/** Một thông báo trong webhook KiotViet: { Id, Attempt, Notifications: [{ Action, Data: [...] }] }. */
export interface KvWebhookBody {
  Id?: string;
  Attempt?: number;
  Notifications?: Array<{ Action?: string; Data?: Obj[] }>;
}

export class KiotVietClient {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private readonly cfg: { retailer: string; clientId: string; clientSecret: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchFn(KIOTVIET.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ scopes: 'PublicApi.Access', grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) throw new Error(j.error === 'invalid_client' ? 'Sai Client ID hoặc mã bảo mật KiotViet.' : `KiotViet không cấp token (HTTP ${res.status}).`);
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 86_400) * 1000 };
    return j.access_token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${KIOTVIET.api}${path}`, {
      method,
      headers: { Retailer: this.cfg.retailer, Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`KiotViet ${method} ${path.split('?')[0]} lỗi HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Một trang dữ liệu (tối đa 100) sửa từ `since`. */
  page(resource: 'customers' | 'orders' | 'invoices' | 'products', since: Date | null, currentItem: number): Promise<{ total?: number; data?: Obj[]; removeId?: number[] }> {
    const q = new URLSearchParams({ pageSize: '100', currentItem: String(currentItem), orderBy: 'modifiedDate', orderDirection: 'Asc' });
    if (since) q.set('lastModifiedFrom', since.toISOString());
    if (resource === 'invoices' || resource === 'orders') q.set('includePayment', 'false');
    // Không xin thì KiotViet không trả removeId ⇒ bản ghi bị xoá bên nguồn không bao giờ được đánh dấu.
    if (resource === 'customers' || resource === 'products') q.set('includeRemoveIds', 'true');
    return this.request('GET', `/${resource}?${q.toString()}`);
  }

  get(resource: 'customers' | 'orders' | 'invoices' | 'products', id: string): Promise<Obj> {
    return this.request('GET', `/${resource}/${encodeURIComponent(id)}`);
  }

  /** Đăng ký đủ loại; hỏng giữa chừng ⇒ gỡ các hook đã tạo rồi mới báo lỗi (không để hook mồ côi). */
  async registerWebhooks(url: string, secret: string): Promise<number[]> {
    const ids: number[] = [];
    try {
      for (const type of KIOTVIET.webhookTypes) {
        const r = await this.request<{ id?: number }>('POST', '/webhooks', {
          Webhook: { Type: type, Url: url, IsActive: true, Description: 'Trinity CRM', Secret: Buffer.from(secret).toString('base64') },
        });
        if (r.id) ids.push(r.id);
      }
    } catch (err) {
      await this.removeWebhooks(ids);
      throw err;
    }
    return ids;
  }

  async removeWebhooks(ids: number[]): Promise<void> {
    for (const id of ids) await this.request('DELETE', `/webhooks/${id}`).catch(() => undefined);
  }
}
