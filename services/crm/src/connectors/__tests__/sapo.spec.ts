import { createHmac } from 'node:crypto';
import { SapoClient, mapSapoCustomer, mapSapoOrder, mapSapoProduct, verifySapoHmac } from '../sapo';
import { SapoService } from '../sapo.service';

const ORDER = {
  id: 2001, name: '#1001', total_price: '450000.0', financial_status: 'paid', modified_on: '2026-10-15T03:00:00Z',
  customer: { id: 77, first_name: 'An', last_name: 'Nguyễn Văn', phone: '0912345678' },
  line_items: [{ title: 'Áo thun', quantity: 3, price: '150000.0' }],
};

describe('Sapo — hàm thuần', () => {
  it('đơn: mã, tổng, khách, mặt hàng', () => {
    expect(mapSapoOrder(ORDER)).toMatchObject({ kind: 'order', external_id: '2001', code: '#1001', total: 450000, status: 'paid', customer: { external_id: '77', name: 'Nguyễn Văn An', phone: '0912345678' }, items: [{ name: 'Áo thun', quantity: 3, price: 150000 }] });
    expect(mapSapoOrder({ ...ORDER, cancelled_on: '2026-10-15T04:00:00Z' }).status).toBe('Đã huỷ');
  });

  it('khách + hàng hoá', () => {
    expect(mapSapoCustomer({ id: 77, first_name: 'An', last_name: 'Nguyễn', default_address: { phone: '0987654321' } })).toMatchObject({ external_id: '77', name: 'Nguyễn An', phone: '0987654321' });
    expect(mapSapoProduct({ id: 5, name: 'Áo thun', variants: [{ sku: 'AT01', price: '150000' }] })).toMatchObject({ external_id: '5', code: 'AT01', price: 150000 });
  });

  it('HMAC base64 nếu có header; không header ⇒ null', () => {
    const raw = Buffer.from('{"id":1}');
    const secret = 'app-secret-for-test'; // gitleaks:allow — khoá giả
    expect(verifySapoHmac(raw, createHmac('sha256', secret).update(raw).digest('base64'), secret)).toBe(true);
    expect(verifySapoHmac(raw, 'sai', secret)).toBe(false);
    expect(verifySapoHmac(raw, undefined, secret)).toBeNull();
  });

  it('client: Basic auth tới {store}.mysapo.net/admin, lọc modified_on_min, đơn status=any', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ orders: [] }), { status: 200 }); });
    await new SapoClient({ store: 'cuahang', apiKey: 'key12345', secret: 'sec12345' }, fetchFn as never).page('orders', new Date('2026-10-01T00:00:00Z'), 1);
    expect(calls[0].url).toBe('https://cuahang.mysapo.net/admin/orders.json?limit=250&page=1&modified_on_min=2026-10-01T00%3A00%3A00.000Z&status=any');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('key12345:sec12345').toString('base64')}`);
  });

  it('client: 401 ⇒ báo lỗi khoá tiếng Việt', async () => {
    const fetchFn = jest.fn(async () => new Response('Unauthorized', { status: 401 }));
    await expect(new SapoClient({ store: 'x', apiKey: 'a', secret: 'b' }, fetchFn as never).store()).rejects.toThrow('Sapo từ chối khoá');
  });
});

describe('SapoService.handleWebhook', () => {
  function setup(fresh: object | null = ORDER) {
    const prisma = { connectorAccount: { findUnique: jest.fn().mockResolvedValue({ connected_by: 3 }) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: null }) } };
    const sync = { upsertOrder: jest.fn(), upsertCustomer: jest.fn(), upsertProduct: jest.fn(), markRemoved: jest.fn() };
    const svc = new SapoService(prisma as never, { touch: jest.fn() } as never, sync as never);
    jest.spyOn(svc as never, 'creds' as never).mockResolvedValue({ creds: { api_key: 'k', secret: 'app-secret-for-test', webhook_token: 'tok-1' }, settings: { store: 'cuahang' } } as never); // gitleaks:allow
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ order: fresh }), { status: fresh ? 200 : 404 }));
    return { svc, sync, fetchFn };
  }

  it('đúng token ⇒ đọc lại đơn từ API Sapo rồi ghi bản đọc lại (không tin nội dung gửi kèm)', async () => {
    const { svc, sync, fetchFn } = setup();
    const forged = { id: 2001, total_price: '1' };
    await expect(svc.handleWebhook('tok-1', 'orders/create', Buffer.from(JSON.stringify(forged)), undefined, forged, fetchFn as never)).resolves.toEqual({ ok: true, applied: 1 });
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe('https://cuahang.mysapo.net/admin/orders/2001.json');
    expect(sync.upsertOrder).toHaveBeenCalledWith('sapo', 'cuahang', expect.objectContaining({ total: 450000 }), { id: 3, team_id: null });
  });

  it('sai token hoặc sai HMAC ⇒ từ chối, không gọi API', async () => {
    const { svc, sync, fetchFn } = setup();
    await expect(svc.handleWebhook('sai', 'orders/create', Buffer.from('{}'), undefined, { id: 1 }, fetchFn as never)).resolves.toEqual({ ok: false, applied: 0 });
    await expect(svc.handleWebhook('tok-1', 'orders/create', Buffer.from('{}'), 'sai-hmac', { id: 1 }, fetchFn as never)).resolves.toEqual({ ok: false, applied: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(sync.upsertOrder).not.toHaveBeenCalled();
  });
});

describe('Sapo — sửa theo review', () => {
  function setup(status = 200) {
    const prisma = { connectorAccount: { findUnique: jest.fn().mockResolvedValue({ connected_by: 3 }) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: null }) } };
    const sync = { upsertOrder: jest.fn(), upsertCustomer: jest.fn(), upsertProduct: jest.fn(), markRemoved: jest.fn() };
    const svc = new SapoService(prisma as never, { touch: jest.fn() } as never, sync as never);
    jest.spyOn(svc as never, 'creds' as never).mockResolvedValue({ creds: { api_key: 'k', secret: 's', webhook_token: 'tok-1' }, settings: { store: 'cuahang' } } as never);
    const fetchFn = jest.fn(async () => new Response(status === 200 ? JSON.stringify({ order: ORDER }) : 'err', { status }));
    return { svc, sync, fetchFn };
  }

  it('topic xoá ⇒ đánh dấu removed, không đọc lại', async () => {
    const { svc, sync, fetchFn } = setup();
    await expect(svc.handleWebhook('tok-1', 'customers/delete', Buffer.from('{"id":77}'), undefined, { id: 77 }, fetchFn as never)).resolves.toEqual({ ok: true, applied: 1 });
    expect(sync.markRemoved).toHaveBeenCalledWith('sapo', 'cuahang', 'customer', '77');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('đọc lại gặp lỗi tạm thời (500) ⇒ ném lỗi để Sapo gửi lại; 404 ⇒ đánh dấu removed', async () => {
    const a = setup(500);
    await expect(a.svc.handleWebhook('tok-1', 'orders/updated', Buffer.from('{"id":2001}'), undefined, { id: 2001 }, a.fetchFn as never)).rejects.toThrow('HTTP 500');
    const b = setup(404);
    await expect(b.svc.handleWebhook('tok-1', 'orders/updated', Buffer.from('{"id":2001}'), undefined, { id: 2001 }, b.fetchFn as never)).resolves.toEqual({ ok: true, applied: 0 });
    expect(b.sync.markRemoved).toHaveBeenCalledWith('sapo', 'cuahang', 'order', '2001');
  });

  it('đăng ký webhook hỏng giữa chừng ⇒ gỡ các hook đã tạo', async () => {
    let n = 0;
    const calls: string[] = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'POST') return ++n <= 2 ? new Response(JSON.stringify({ webhook: { id: 100 + n } }), { status: 201 }) : new Response('fail', { status: 422 });
      return new Response('{}', { status: 200 });
    });
    await expect(new SapoClient({ store: 'cuahang', apiKey: 'k', secret: 's' }, fetchFn as never).registerWebhooks('https://crm.example.com/h')).rejects.toThrow('422');
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE https://cuahang.mysapo.net/admin/webhooks/101.json', 'DELETE https://cuahang.mysapo.net/admin/webhooks/102.json']);
  });
});
