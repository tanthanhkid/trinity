import { cleanStoreSettings, StoreService, type StoreSettings } from '../store.service';

const BASE: StoreSettings = { slug: 'cua-hang-abc', name: 'Cửa hàng ABC', tagline: null, theme: 'toi-gian', accent: '#2563eb', phone: null, address: null, cover_url: null, logo_url: null, cod: true, bank_transfer: false, published: true, product_ids: [10, 11], owner_user_id: 3 };

describe('cleanStoreSettings', () => {
  it('kiểm địa chỉ trang, giao diện, màu, phải có cách thanh toán khi mở bán', () => {
    expect(cleanStoreSettings({ slug: 'Cua-Hang-ABC' }, BASE).slug).toBe('cua-hang-abc');
    expect(() => cleanStoreSettings({ slug: 'admin' }, BASE)).toThrow();
    expect(() => cleanStoreSettings({ slug: 'có dấu' }, BASE)).toThrow();
    expect(() => cleanStoreSettings({ theme: 'la' }, BASE)).toThrow();
    expect(() => cleanStoreSettings({ accent: 'red' }, BASE)).toThrow();
    expect(() => cleanStoreSettings({ cod: false, bank_transfer: false }, BASE)).toThrow('ít nhất một cách thanh toán');
    expect(cleanStoreSettings({ product_ids: [3, 3, -1, 'x', 4] }, BASE).product_ids).toEqual([3, 4]);
    expect(cleanStoreSettings({ theme: 'dam-net' }, BASE).theme).toBe('soi-dong');
    expect(() => cleanStoreSettings({ cover_url: 'javascript:alert(1)' }, BASE)).toThrow('https');
    expect(cleanStoreSettings({ logo_url: 'https://cdn.example.com/logo.png' }, BASE).logo_url).toBe('https://cdn.example.com/logo.png');
  });
});

function setup(over: Partial<StoreSettings> = {}, enabled = true) {
  const settings = { ...BASE, ...over };
  const prisma = {
    setting: { findUnique: jest.fn().mockResolvedValue({ value: JSON.stringify(settings) }) },
    product: { findMany: jest.fn().mockResolvedValue([{ id: 10, name: 'Sách', price: 145000n, image_url: null, description: null }, { id: 11, name: 'Áo', price: 199000n, image_url: null, description: null }]) },
    storeOrder: { create: jest.fn().mockResolvedValue({ id: 1, code: 'DH-ABCDEF', status: 'new', customer_name: 'An', customer_phone: '0912345678', customer_address: null, note: null, total: 290000n, payment_method: 'cod', contact_id: 55, created_at: new Date('2026-10-15T00:00:00Z') }), update: jest.fn().mockResolvedValue({ ...{ id: 1, code: 'DH-ABCDEF', status: 'new', customer_name: 'An', customer_phone: '0912345678', customer_address: null, note: null, total: 290000n, payment_method: 'cod', contact_id: 55, created_at: new Date('2026-10-15T00:00:00Z') }, payment_method: 'bank_transfer', payment_intent_id: 9 }), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({}) },
    contact: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ assigned_to: 3 }) },
    integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
    $transaction: jest.fn(),
    user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: null }) },
    activity: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const features = { isEnabled: jest.fn().mockResolvedValue(enabled) };
  const sync = { contactFor: jest.fn().mockResolvedValue(55) };
  const payments = { create: jest.fn().mockResolvedValue({ id: 9, qr_url: 'https://qr.sepay.vn/img?x', transfer_content: 'TRNABCDEF', bank: { bank: 'MBBank' } }) };
  const connectors = { active: jest.fn().mockResolvedValue({ settings: {} }) };
  const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
  const svc = new StoreService(prisma as never, features as never, sync as never, payments as never, connectors as never, scope as never);
  return { svc, prisma, sync, payments, scope };
}

describe('StoreService', () => {
  it('cờ tắt / chưa mở bán / sai địa chỉ ⇒ 404 như không có trang', async () => {
    await expect(setup({}, false).svc.publicStore('cua-hang-abc')).rejects.toThrow('Không có cửa hàng');
    await expect(setup({ published: false }).svc.publicStore('cua-hang-abc')).rejects.toThrow('Không có cửa hàng');
    await expect(setup().svc.publicStore('khac')).rejects.toThrow('Không có cửa hàng');
  });

  it('đặt đơn COD: giá lấy từ danh mục (bỏ qua giá trình duyệt), ghép khách theo SĐT, ghi lịch sử', async () => {
    const { svc, prisma, sync } = setup();
    const out = await svc.placeOrder('cua-hang-abc', '1.2.3.4', { name: 'An', phone: '0912 345 678', address: '12 Lê Lợi', payment_method: 'cod', items: [{ product_id: 10, quantity: 2, price: 1 } as never, { product_id: 999, quantity: 1 }] });
    expect(out).toMatchObject({ code: 'DH-ABCDEF', total: 290000, payment_method: 'cod', payment: null });
    expect(sync.contactFor).toHaveBeenCalledWith('store', { name: 'An', phone: '0912345678' }, { id: 3, team_id: null });
    expect(prisma.storeOrder.create.mock.calls[0][0].data).toMatchObject({ total: 290000n, items: [{ product_id: 10, name: 'Sách', price: 145000, quantity: 2 }] });
    expect(prisma.activity.create.mock.calls[0][0].data.details.description).toBe('Đơn online DH-ABCDEF — 290.000đ (Sách ×2) · COD');    // Sự kiện webhook "đơn mới" ghi cùng transaction với đơn COD.
    const ev = prisma.integrationEvent.create.mock.calls[0][0].data;
    expect(ev).toMatchObject({ event_type: 'store_order.created', payload: { order: { code: 'DH-ABCDEF', contact_assigned_to: 3 } } });
    expect(JSON.stringify(ev)).toContain('DH-ABCDEF');
  });

  it('chuyển khoản ⇒ tạo yêu cầu thanh toán (source store_order) và trả QR', async () => {
    const { svc, payments, prisma } = setup({ bank_transfer: true });
    const out = await svc.placeOrder('cua-hang-abc', '1.2.3.5', { name: 'An', phone: '0912345678', payment_method: 'bank_transfer', items: [{ product_id: 11, quantity: 1 }] });
    expect(payments.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 199000, source_type: 'store_order', source_id: 1, contact_id: 55 }), 3);
    expect(out.payment).toMatchObject({ qr_url: 'https://qr.sepay.vn/img?x', transfer_content: 'TRNABCDEF' });
    expect(prisma.integrationEvent.create).toHaveBeenCalledTimes(1); // phát lúc gắn thanh toán, không phát lúc tạo đơn
  });

  it('đầu vào sai ⇒ báo rõ; quá 5 đơn/10 phút/IP ⇒ 429', async () => {
    const { svc } = setup();
    await expect(svc.placeOrder('cua-hang-abc', '9.9.9.9', { name: 'An', phone: 'abc', address: 'x', items: [{ product_id: 10, quantity: 1 }] })).rejects.toThrow('Số điện thoại');
    await expect(svc.placeOrder('cua-hang-abc', '9.9.9.8', { name: 'An', phone: '0912345678', address: 'x', items: [{ product_id: 999, quantity: 1 }] })).rejects.toThrow('Giỏ hàng trống');
    await expect(svc.placeOrder('cua-hang-abc', '9.9.9.7', { name: 'An', phone: '0912345678', items: [{ product_id: 10, quantity: 1 }] })).rejects.toThrow('địa chỉ giao hàng');
    const ok = { name: 'An', phone: '0912345678', address: 'x', items: [{ product_id: 10, quantity: 1 }] };
    for (let i = 0; i < 5; i++) await svc.placeOrder('cua-hang-abc', '7.7.7.7', ok);
    await expect(svc.placeOrder('cua-hang-abc', '7.7.7.7', ok)).rejects.toMatchObject({ status: 429 });
  });

  it('chuyển khoản: tạo thanh toán lỗi ⇒ gỡ đơn vừa tạo; tổng < 1.000đ ⇒ từ chối trước khi lưu', async () => {
    const a = setup({ bank_transfer: true });
    a.payments.create.mockRejectedValue(new Error('SePay lỗi'));
    await expect(a.svc.placeOrder('cua-hang-abc', '3.3.3.1', { name: 'An', phone: '0912345678', payment_method: 'bank_transfer', items: [{ product_id: 11, quantity: 1 }] })).rejects.toThrow('SePay lỗi');
    expect(a.prisma.storeOrder.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(a.prisma.integrationEvent.create).not.toHaveBeenCalled(); // đơn bị gỡ ⇒ không phát "đơn mới"
    const b = setup({ bank_transfer: true });
    b.prisma.product.findMany.mockResolvedValue([{ id: 10, name: 'Kẹo', price: 500n, image_url: null, description: null }]);
    await expect(b.svc.placeOrder('cua-hang-abc', '3.3.3.2', { name: 'An', phone: '0912345678', payment_method: 'bank_transfer', items: [{ product_id: 10, quantity: 1 }] })).rejects.toThrow('1.000đ');
    expect(b.prisma.storeOrder.create).not.toHaveBeenCalled();
  });

  it('danh sách đơn: phạm vi "own" ⇒ chỉ đơn của khách mình phụ trách; không có quyền xem SĐT đầy đủ ⇒ che', async () => {
    const { svc, prisma, scope } = setup();
    scope.ownerIds.mockImplementation(async (_u: unknown, p: string) => (p === 'deals.view' ? [42] : []));
    prisma.contact.findMany.mockImplementation(async (q: { where: { assigned_to?: unknown; id?: unknown } }) => (q.where.assigned_to ? [{ id: 55 }] : [{ id: 55, assigned_to: 42 }]));
    prisma.storeOrder.findMany.mockResolvedValue([{ id: 1, code: 'DH-1', total: 1000n, contact_id: 55, customer_phone: '0912345678', status: 'new' }]);
    const rows = await svc.listOrders({ userId: 42 } as never);
    expect(prisma.storeOrder.findMany.mock.calls[0][0].where).toEqual({ contact_id: { in: [55] } });
    expect(rows[0].customer_phone).toBe('***678');
  });

  it('đổi trạng thái đơn ngoài phạm vi deals.manage ⇒ 404, không sửa', async () => {
    const { svc, prisma, scope } = setup();
    scope.ownerIds.mockResolvedValue([1]);
    prisma.storeOrder.findUnique.mockResolvedValue({ id: 1, contact_id: 55 });
    prisma.contact.findMany.mockResolvedValue([{ id: 55, assigned_to: 42 }]);
    await expect(svc.updateOrderStatus({ userId: 1 } as never, 1, 'confirmed')).rejects.toThrow();
    expect(prisma.storeOrder.update).not.toHaveBeenCalled();
  });

  it('tra đơn: sai SĐT ⇒ không tìm thấy (không dò được đơn người khác)', async () => {
    const { svc, prisma } = setup();
    prisma.storeOrder.findUnique.mockResolvedValue({ code: 'DH-ABCDEF', status: 'paid', total: 290000n, payment_method: 'cod', customer_phone: '0912345678' });
    await expect(svc.orderStatus('cua-hang-abc', 'dh-abcdef', '0912 345 678')).resolves.toEqual({ code: 'DH-ABCDEF', status: 'paid', total: 290000, payment_method: 'cod' });
    await expect(svc.orderStatus('cua-hang-abc', 'DH-ABCDEF', '0900000000')).rejects.toThrow('Không tìm thấy');
  });
});
