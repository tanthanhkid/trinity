import { createHmac } from 'node:crypto';
import { KiotVietClient, kvDate, mapKvCustomer, mapKvOrder, mapKvProduct, verifyKiotvietSignature } from '../kiotviet';
import { KiotVietService } from '../kiotviet.service';

/** Mẫu webhook order.update theo tài liệu Public API KiotViet (trường PascalCase). */
const ORDER_WEBHOOK = {
  Id: 'a1b2c3',
  Attempt: 1,
  Notifications: [{
    Action: 'order.update',
    Data: [{
      Id: 1000123, Code: 'DH000045', PurchaseDate: '2026-10-15T09:30:00.0000000', BranchId: 1, CustomerId: 555, CustomerName: 'Nguyễn Văn An',
      Total: 350000, Status: 1, StatusValue: 'Phiếu tạm', ModifiedDate: '2026-10-15T09:31:00.0000000',
      OrderDetails: [{ ProductId: 9, ProductCode: 'SP01', ProductName: 'Cà phê sữa', Quantity: 2, Price: 25000 }],
    }],
  }],
};

describe('KiotViet — hàm thuần', () => {
  it('đọc đơn từ webhook (PascalCase) và từ API (camelCase) ra cùng một dạng', () => {
    const a = mapKvOrder(ORDER_WEBHOOK.Notifications[0].Data[0], 'order');
    expect(a).toMatchObject({ kind: 'order', external_id: '1000123', code: 'DH000045', total: 350000, status: 'Phiếu tạm', customer: { external_id: '555', name: 'Nguyễn Văn An' } });
    expect(a.items).toEqual([{ name: 'Cà phê sữa', quantity: 2, price: 25000 }]);
    const b = mapKvOrder({ id: 1000123, code: 'DH000045', total: 350000, customerId: 555, orderDetails: [{ productName: 'Cà phê sữa', quantity: 2, price: 25000 }] }, 'order');
    expect(b.external_id).toBe(a.external_id);
    expect(b.items).toEqual(a.items);
  });

  it('khách + hàng hoá', () => {
    expect(mapKvCustomer({ id: 555, code: 'KH01', name: 'An', contactNumber: '0912 345 678', email: 'an@x.vn', modifiedDate: '2026-10-15T09:00:00' })).toMatchObject({ external_id: '555', phone: '0912 345 678', email: 'an@x.vn' });
    expect(mapKvProduct({ id: 9, code: 'SP01', fullName: 'Cà phê sữa (ly)', basePrice: 25000 })).toMatchObject({ external_id: '9', name: 'Cà phê sữa (ly)', price: 25000 });
  });

  it('ngày KiotViet không có múi giờ ⇒ hiểu là giờ Việt Nam', () => {
    expect(kvDate('2026-10-15T09:30:00.0000000')!.toISOString()).toBe('2026-10-15T02:30:00.000Z');
    expect(kvDate('rác')).toBeNull();
  });

  it('chữ ký X-Hub-Signature: HMAC-SHA256 hex/base64, khoá thô hoặc base64, có/không tiền tố sha256=', () => {
    const raw = Buffer.from(JSON.stringify(ORDER_WEBHOOK));
    const secret = 'webhook-secret-for-test'; // gitleaks:allow — khoá giả
    const hex = createHmac('sha256', secret).update(raw).digest('hex');
    const b64 = createHmac('sha256', Buffer.from(secret).toString('base64')).update(raw).digest('base64');
    expect(verifyKiotvietSignature(raw, hex, secret)).toBe(true);
    expect(verifyKiotvietSignature(raw, `sha256=${hex}`, secret)).toBe(true);
    expect(verifyKiotvietSignature(raw, b64, secret)).toBe(true);
    expect(verifyKiotvietSignature(raw, hex, 'khoa-khac')).toBe(false);
    expect(verifyKiotvietSignature(Buffer.from('{}'), hex, secret)).toBe(false);
    expect(verifyKiotvietSignature(raw, undefined, secret)).toBe(false);
  });

  it('client: lấy token client_credentials đúng tham số, gửi header Retailer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('connect/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 86400 }), { status: 200 });
      return new Response(JSON.stringify({ total: 0, data: [] }), { status: 200 });
    });
    const c = new KiotVietClient({ retailer: 'cuahang', clientId: 'cid-123456', clientSecret: 'sec-123456' }, fetchFn as never);
    await c.page('customers', null, 0);
    expect(calls[0].url).toBe('https://id.kiotviet.vn/connect/token');
    expect(String(calls[0].init.body)).toContain('scopes=PublicApi.Access');
    expect(String(calls[0].init.body)).toContain('grant_type=client_credentials');
    expect(calls[1].url).toMatch(/^https:\/\/public\.kiotapi\.com\/customers\?pageSize=100&currentItem=0/);
    expect(calls[1].url).toContain('includeRemoveIds=true');
    expect((calls[1].init.headers as Record<string, string>).Retailer).toBe('cuahang');
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('client: sai Client ID ⇒ báo lỗi tiếng Việt', async () => {
    const fetchFn = jest.fn(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }));
    await expect(new KiotVietClient({ retailer: 'x', clientId: 'a', clientSecret: 'b' }, fetchFn as never).accessToken()).rejects.toThrow('Sai Client ID');
  });
});

describe('KiotVietService.handleWebhook', () => {
  const secret = 'webhook-secret-for-test'; // gitleaks:allow — khoá giả
  function setup() {
    const prisma = {
      connectorAccount: { findUnique: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: 2 }) },
    };
    const sync = { upsertOrder: jest.fn().mockResolvedValue({ contact_id: 1, created: true }), upsertCustomer: jest.fn(), upsertProduct: jest.fn(), markRemoved: jest.fn() };
    const connectors = { touch: jest.fn() };
    const svc = new KiotVietService(prisma as never, connectors as never, sync as never);
    // creds() giải mã khoá — thay bằng giá trị cố định cho test.
    jest.spyOn(svc as never, 'creds' as never).mockResolvedValue({ creds: { client_secret: 's', webhook_secret: secret, webhook_token: 'tok-abc' }, settings: { retailer: 'x', client_id: 'y' }, connected_by: 3 } as never);
    prisma.connectorAccount.findUnique.mockResolvedValue({ connected_by: 3 });
    return { svc, sync };
  }

  it('đúng token + chữ ký ⇒ ghi đơn', async () => {
    const { svc, sync } = setup();
    const raw = Buffer.from(JSON.stringify(ORDER_WEBHOOK));
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    await expect(svc.handleWebhook('tok-abc', raw, sig, ORDER_WEBHOOK)).resolves.toEqual({ ok: true, applied: 1 });
    expect(sync.upsertOrder).toHaveBeenCalledWith('kiotviet', 'x', expect.objectContaining({ code: 'DH000045', total: 350000 }), { id: 3, team_id: 2 });
  });

  it('sai token đường dẫn hoặc sai chữ ký ⇒ từ chối, không ghi', async () => {
    const { svc, sync } = setup();
    const raw = Buffer.from(JSON.stringify(ORDER_WEBHOOK));
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    await expect(svc.handleWebhook('sai', raw, sig, ORDER_WEBHOOK)).resolves.toEqual({ ok: false, applied: 0 });
    await expect(svc.handleWebhook('tok-abc', raw, 'deadbeef', ORDER_WEBHOOK)).resolves.toEqual({ ok: false, applied: 0 });
    expect(sync.upsertOrder).not.toHaveBeenCalled();
  });

  it('customer.delete ⇒ đánh dấu removed, không xoá dữ liệu CRM', async () => {
    const { svc, sync } = setup();
    const body = { Id: 'x', Attempt: 1, Notifications: [{ Action: 'customer.delete', Data: [{ Id: 555 }] }] };
    const raw = Buffer.from(JSON.stringify(body));
    await svc.handleWebhook('tok-abc', raw, createHmac('sha256', secret).update(raw).digest('hex'), body);
    expect(sync.markRemoved).toHaveBeenCalledWith('kiotviet', 'x', 'customer', '555');
  });
});

describe('KiotVietService.connect — đổi gian hàng', () => {
  // Biến môi trường dùng chung cả worker jest ⇒ đặt trong test thì phải trả lại, kẻo rò sang file test khác.
  const saved = { key: process.env.INTEGRATIONS_SECRET_KEY, base: process.env.INTEGRATIONS_PUBLIC_BASE_URL };
  afterAll(() => {
    if (saved.key === undefined) delete process.env.INTEGRATIONS_SECRET_KEY; else process.env.INTEGRATIONS_SECRET_KEY = saved.key;
    if (saved.base === undefined) delete process.env.INTEGRATIONS_PUBLIC_BASE_URL; else process.env.INTEGRATIONS_PUBLIC_BASE_URL = saved.base;
  });
  it('gỡ webhook cũ bằng khoá CŨ và đổi token/secret', async () => {
    const calls: Array<{ url: string; auth?: string; retailer?: string }> = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, retailer: h.Retailer });
      if (url.includes('connect/token')) return new Response(JSON.stringify({ access_token: String(init.body).includes('old-client') ? 'old' : 'new', expires_in: 86400 }), { status: 200 });
      if (init.method === 'POST' && url.endsWith('/webhooks')) return new Response(JSON.stringify({ id: 9 }), { status: 200 });
      return new Response(JSON.stringify({ total: 0, data: [] }), { status: 200 });
    });
    const prisma = { connectorAccount: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ connected_by: 3 }) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: null }) } };
    const svc = new KiotVietService(prisma as never, { list: jest.fn().mockResolvedValue([]), touch: jest.fn() } as never, { upsertCustomer: jest.fn(), upsertOrder: jest.fn(), upsertProduct: jest.fn(), markRemoved: jest.fn() } as never);
    const old = { creds: { client_secret: 'old-secret-1', webhook_secret: 'ws-old', webhook_token: 'tok-old' }, settings: { retailer: 'shopcu', client_id: 'old-client', webhook_ids: [101, 102] }, connected_by: 3 };
    jest.spyOn(svc as never, 'creds' as never).mockResolvedValue(old as never);
    process.env.INTEGRATIONS_SECRET_KEY = Buffer.alloc(32, 7).toString('base64'); // gitleaks:allow — khoá giả cho test
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = 'https://crm.example.com';
    await svc.connect({ retailer: 'shopmoi', client_id: 'new-client', client_secret: 'new-secret-1' }, 3, fetchFn as never);
    const deletes = calls.filter((c) => c.url.includes('/webhooks/10'));
    expect(deletes.map((d) => d.retailer)).toEqual(['shopcu', 'shopcu']);
    const reg = calls.find((c) => c.url.endsWith('/webhooks') && c.retailer === 'shopmoi');
    expect(reg).toBeTruthy();
    const saved = prisma.connectorAccount.upsert.mock.calls[0][0].update;
    expect(saved.settings).toMatchObject({ retailer: 'shopmoi', client_id: 'new-client' });
    expect(saved.settings.cursors).toBeUndefined();
  });
});
