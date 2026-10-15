import { createHmac } from 'node:crypto';
import { WooClient, mapWooCustomer, mapWooOrder, mapWooProduct, normalizeWooUrl, verifyWooSignature } from '../woocommerce';
import { WooCommerceService } from '../woocommerce.service';

/** Mẫu đơn theo tài liệu WooCommerce REST API v3 (rút gọn). */
const ORDER = {
  id: 727, number: '727', status: 'processing', currency: 'VND', total: '290000', customer_id: 26,
  date_modified_gmt: '2026-10-15T03:00:00',
  billing: { first_name: 'An', last_name: 'Nguyễn', phone: '0912345678', email: 'an@example.com' },
  line_items: [{ name: 'Sách lập trình', quantity: 2, price: 145000 }], payment_method_title: 'COD',
};
const noGuard = async () => undefined;

describe('WooCommerce — hàm thuần', () => {
  it('đơn, khách, sản phẩm', () => {
    expect(mapWooOrder(ORDER)).toMatchObject({ external_id: '727', code: '#727', total: 290000, status: 'processing', customer: { external_id: '26', name: 'Nguyễn An', phone: '0912345678' }, items: [{ name: 'Sách lập trình', quantity: 2, price: 145000 }] });
    expect(mapWooOrder({ ...ORDER, customer_id: 0 }).customer?.external_id).toBeNull();
    expect(mapWooCustomer({ id: 26, email: 'an@example.com', first_name: 'An', last_name: 'Nguyễn', billing: { phone: '0912345678' } })).toMatchObject({ external_id: '26', name: 'Nguyễn An', phone: '0912345678' });
    expect(mapWooProduct({ id: 9, sku: 'S01', name: 'Sách', price: '145000' })).toMatchObject({ external_id: '9', code: 'S01', price: 145000 });
  });

  it('địa chỉ cửa hàng: bắt buộc https công khai', () => {
    expect(normalizeWooUrl('shop.example.com/')).toBe('https://shop.example.com');
    expect(normalizeWooUrl('https://example.com/cua-hang/')).toBe('https://example.com/cua-hang');
    expect(normalizeWooUrl('http://shop.example.com')).toBeNull();
    expect(normalizeWooUrl('https://localhost')).toBeNull();
    expect(normalizeWooUrl('https://192.168.1.10')).toBeNull();
    expect(normalizeWooUrl('https://user:pass@shop.example.com')).toBeNull();
  });

  it('X-WC-Webhook-Signature = base64 HMAC-SHA256', () => {
    const raw = Buffer.from(JSON.stringify(ORDER));
    const secret = 'woo-webhook-secret-test'; // gitleaks:allow — khoá giả
    expect(verifyWooSignature(raw, createHmac('sha256', secret).update(raw).digest('base64'), secret)).toBe(true);
    expect(verifyWooSignature(raw, createHmac('sha256', 'khac').update(raw).digest('base64'), secret)).toBe(false);
  });

  it('client: Basic auth ck/cs, /wp-json/wc/v3, modified_after; chuyển hướng ⇒ báo lỗi, không theo', async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
    const transport = jest.fn(async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, init }); return { status: 200, text: '[]' }; });
    await new WooClient({ url: 'https://shop.example.com', key: 'ck_x', secret: 'cs_y' }, transport as never, noGuard).page('orders', new Date('2026-10-01T00:00:00Z'), 1);
    expect(calls[0].url).toBe('https://shop.example.com/wp-json/wc/v3/orders?per_page=100&page=1&orderby=modified&order=asc&modified_after=2026-10-01T00%3A00%3A00');
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('ck_x:cs_y').toString('base64')}`);
    const redirect = jest.fn(async () => ({ status: 301, text: '' }));
    await expect(new WooClient({ url: 'https://shop.example.com', key: 'ck_x', secret: 'cs_y' }, redirect as never, noGuard).check()).rejects.toThrow('chuyển hướng');
  });

  it('client: địa chỉ trỏ vào mạng nội bộ ⇒ chặn trước khi gọi', async () => {
    const fetchFn = jest.fn();
    const guard = jest.fn(async () => { throw new Error('blocked'); });
    await expect(new WooClient({ url: 'https://evil.example.com', key: 'ck_x', secret: 'cs_y' }, fetchFn as never, guard).check()).rejects.toThrow('mạng nội bộ');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('WooCommerceService.handleWebhook', () => {
  const secret = 'woo-webhook-secret-test'; // gitleaks:allow — khoá giả
  function setup() {
    const prisma = { connectorAccount: { findUnique: jest.fn().mockResolvedValue({ connected_by: 3 }) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: null }) } };
    const sync = { upsertOrder: jest.fn(), upsertCustomer: jest.fn(), upsertProduct: jest.fn(), markRemoved: jest.fn() };
    const svc = new WooCommerceService(prisma as never, { touch: jest.fn() } as never, sync as never);
    jest.spyOn(svc as never, 'creds' as never).mockResolvedValue({ creds: { key: 'ck', secret: 'cs', webhook_secret: secret, webhook_token: 'tok-w' }, settings: { url: 'https://shop.example.com' } } as never);
    return { svc, sync };
  }

  it('đúng token + chữ ký ⇒ ghi đơn (gian hàng = tên miền)', async () => {
    const { svc, sync } = setup();
    const raw = Buffer.from(JSON.stringify(ORDER));
    await expect(svc.handleWebhook('tok-w', 'order.created', raw, createHmac('sha256', secret).update(raw).digest('base64'), ORDER)).resolves.toEqual({ ok: true, applied: 1 });
    expect(sync.upsertOrder).toHaveBeenCalledWith('woocommerce', 'shop.example.com', expect.objectContaining({ code: '#727' }), { id: 3, team_id: null });
  });

  it('order.deleted ⇒ đánh dấu removed', async () => {
    const { svc, sync } = setup();
    const raw = Buffer.from('{"id":727}');
    await svc.handleWebhook('tok-w', 'order.deleted', raw, createHmac('sha256', secret).update(raw).digest('base64'), { id: 727 });
    expect(sync.markRemoved).toHaveBeenCalledWith('woocommerce', 'shop.example.com', 'order', '727');
  });

  it('lượt ping lúc tạo webhook ⇒ 200 bỏ qua; sai chữ ký ⇒ từ chối', async () => {
    const { svc, sync } = setup();
    await expect(svc.handleWebhook('tok-w', undefined, Buffer.from('webhook_id=15'), undefined, {})).resolves.toEqual({ ok: true, applied: 0 });
    await expect(svc.handleWebhook('tok-w', 'order.created', Buffer.from('{}'), 'sai', {})).resolves.toEqual({ ok: false, applied: 0 });
    expect(sync.upsertOrder).not.toHaveBeenCalled();
  });
});
