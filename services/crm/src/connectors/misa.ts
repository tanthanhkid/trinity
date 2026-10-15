import type { ExternalCustomer, ExternalProduct } from './commerce-sync.service';

/**
 * MISA AMIS Kế toán — ACT Open API (https://actapp.misa.vn).
 * Token: POST /api/oauth/actopen/connect { app_id, access_code, org_company_code } → { Success, Data: { access_token } } (~12 giờ).
 * Danh mục: POST /apir/sync/actopen/get_dictionary { app_id, data_type (1 = đối tượng/khách, 2 = vật tư hàng hoá), skip, take ≤100, last_sync_time }
 *   → { Success, Data: [...] | "json", CustomData: { LastSyncTime } }. Header `X-MISA-AccessToken`.
 * `app_id` là mã ứng dụng ĐỐI TÁC (Trinity đăng ký với MISA) ⇒ đặt ở máy chủ (`MISA_APP_ID`); khách nhập `access_code`
 * (AMIS Kế toán › Thiết lập › Kết nối ứng dụng) + mã công ty.
 */
export const MISA_BASE = 'https://actapp.misa.vn';
export const MISA_DATA_TYPE = { customer: 1, item: 2 } as const;

export function misaAppId(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.MISA_APP_ID ?? '').trim();
  return /^[0-9a-fA-F-]{8,64}$/.test(v) ? v : null;
}

type Obj = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === '' ? null : String(v));
const parse = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);

interface MisaEnvelope {
  Success?: boolean;
  ErrorCode?: string | null;
  ErrorMessage?: string | null;
  Data?: unknown;
  CustomData?: unknown;
}

export function unwrapMisa(body: MisaEnvelope, what: string): unknown {
  if (!body?.Success) throw new Error(`MISA ${what} lỗi: ${body?.ErrorMessage || body?.ErrorCode || 'không rõ'}`);
  return parse(body.Data);
}

/** Đối tượng kế toán → khách. Bỏ đối tượng chỉ là nhà cung cấp / nhân viên khi MISA có cờ phân loại. */
export function mapMisaCustomer(o: Obj): ExternalCustomer | null {
  if (o.is_customer === false || (o.is_customer !== true && (o.is_vendor === true || o.is_employee === true))) return null;
  const id = s(o.account_object_id) ?? s(o.account_object_code);
  if (!id) return null;
  return {
    external_id: id,
    code: s(o.account_object_code),
    name: s(o.account_object_name),
    phone: s(o.mobile) ?? s(o.tel) ?? s(o.contact_mobile) ?? s(o.contact_tel),
    email: s(o.email_address) ?? s(o.email) ?? s(o.contact_email),
    updated_at: o.modified_date ? new Date(String(o.modified_date)) : null,
    data: { tax_code: o.company_tax_code ?? o.tax_code ?? null, address: o.address ?? null, debt: o.debt_amount ?? o.closing_amount ?? null },
  };
}

export function mapMisaItem(o: Obj): ExternalProduct | null {
  const id = s(o.inventory_item_id) ?? s(o.inventory_item_code);
  if (!id) return null;
  const price = o.unit_price ?? o.sale_price1 ?? o.sale_price ?? null;
  return {
    external_id: id,
    code: s(o.inventory_item_code),
    name: String(o.inventory_item_name ?? o.inventory_item_code ?? ''),
    price: price == null ? null : Number(price),
    updated_at: o.modified_date ? new Date(String(o.modified_date)) : null,
    data: { unit: o.unit_name ?? null },
  };
}

export class MisaClient {
  private token: string | null = null;

  constructor(
    private readonly cfg: { appId: string; accessCode: string; companyCode: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: unknown, auth: boolean): Promise<MisaEnvelope> {
    const res = await this.fetchFn(`${MISA_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { 'X-MISA-AccessToken': await this.accessToken() } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new Error('MISA đang giới hạn tần suất gọi, thử lại sau ít phút.');
    if (!res.ok) throw new Error(`MISA ${path} lỗi HTTP ${res.status}`);
    return (await res.json()) as MisaEnvelope;
  }

  async accessToken(): Promise<string> {
    if (this.token) return this.token;
    const body = await this.post('/api/oauth/actopen/connect', { app_id: this.cfg.appId, access_code: this.cfg.accessCode, org_company_code: this.cfg.companyCode }, false);
    const data = unwrapMisa(body, 'cấp token') as { access_token?: string } | null;
    if (!data?.access_token) throw new Error('MISA không trả access_token — kiểm tra mã kết nối và mã công ty.');
    this.token = data.access_token;
    return this.token;
  }

  async dictionary(dataType: number, skip: number, lastSyncTime: string | null): Promise<{ rows: Obj[]; last_sync_time: string | null }> {
    return this.page('/apir/sync/actopen/get_dictionary', dataType, skip, lastSyncTime);
  }

  /** Danh mục đã bị xoá bên MISA (cùng dạng tham số với get_dictionary). */
  async dictionaryDeleted(dataType: number, skip: number, lastSyncTime: string | null): Promise<{ rows: Obj[]; last_sync_time: string | null }> {
    return this.page('/apir/sync/actopen/get_dictionary_delete', dataType, skip, lastSyncTime);
  }

  private async page(path: string, dataType: number, skip: number, lastSyncTime: string | null): Promise<{ rows: Obj[]; last_sync_time: string | null }> {
    const body = await this.post(path, { app_id: this.cfg.appId, data_type: dataType, skip, take: 100, last_sync_time: lastSyncTime }, true);
    const rows = unwrapMisa(body, 'đọc danh mục');
    const custom = parse(body.CustomData) as { LastSyncTime?: string } | null;
    return { rows: Array.isArray(rows) ? (rows as Obj[]) : [], last_sync_time: custom?.LastSyncTime ?? null };
  }
}
