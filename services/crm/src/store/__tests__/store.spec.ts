import { cleanStoreSettings, StoreService, type StoreSettings } from '../store.service';
import { decodeEmv } from './emv-decoder';

const BASE: StoreSettings = { slug: 'cua-hang-abc', name: 'Cửa hàng ABC', tagline: null, theme: 'toi-gian', accent: '#2563eb', phone: null, address: null, cover_url: null, logo_url: null, cod: true, bank_transfer: false, bank_bin: null, bank_account: null, bank_account_name: null, bank_notice: null, published: true, product_ids: [10, 11], owner_user_id: 3 };

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

  it('chuyển khoản: cần ngân hàng trong danh sách VietQR + số tài khoản; tên kiểu SePay ánh xạ sang BIN; lưu đủ thì xoá lời nhắc', () => {
    expect(() => cleanStoreSettings({ bank_transfer: true }, BASE)).toThrow('chọn ngân hàng');
    expect(() => cleanStoreSettings({ bank_transfer: true, bank_bin: 'NganHangLa', bank_account: '0123456789' }, BASE)).toThrow('không có trong danh sách');
    expect(() => cleanStoreSettings({ bank_transfer: true, bank_bin: '970422', bank_account: '01 23' }, BASE)).not.toThrow();
    expect(() => cleanStoreSettings({ bank_transfer: true, bank_bin: '970422', bank_account: '12-34' }, BASE)).toThrow('Số tài khoản');
    const s = cleanStoreSettings({ bank_transfer: true, bank_bin: 'MBBank', bank_account: '0123 456 789', bank_account_name: 'NGUYEN VAN A' }, { ...BASE, bank_notice: 'nhập lại' });
    expect(s).toMatchObject({ bank_transfer: true, bank_bin: '970422', bank_account: '0123456789', bank_account_name: 'NGUYEN VAN A', bank_notice: null });
  });

  it('cấu hình cũ bật chuyển khoản nhưng thiếu tài khoản: sửa trường khác vẫn lưu được; tắt chuyển khoản thì xoá lời nhắc', () => {
    const old = { ...BASE, bank_transfer: true, bank_notice: 'nhập lại' };
    expect(cleanStoreSettings({ name: 'Tên mới' }, old)).toMatchObject({ name: 'Tên mới', bank_transfer: true, bank_notice: 'nhập lại' });
    expect(() => cleanStoreSettings({ bank_account_name: 'A' }, old)).toThrow('chọn ngân hàng');
    expect(cleanStoreSettings({ bank_transfer: false }, old)).toMatchObject({ bank_transfer: false, bank_notice: null });
  });
});

function setup(over: Partial<StoreSettings> = {}, enabled = true) {
  const settings = { ...BASE, ...over };
  const prisma = {
    setting: { findUnique: jest.fn().mockResolvedValue({ value: JSON.stringify(settings) }) },
    product: { findMany: jest.fn().mockResolvedValue([{ id: 10, name: 'Sách', price: 145000n, image_url: null, description: null }, { id: 11, name: 'Áo', price: 199000n, image_url: null, description: null }]) },
    storeOrder: { create: jest.fn().mockResolvedValue({ id: 1, code: 'DH-ABCDEF', status: 'new', customer_name: 'An', customer_phone: '0912345678', customer_address: null, note: null, total: 290000n, payment_method: 'cod', contact_id: 55, created_at: new Date('2026-10-15T00:00:00Z') }), update: jest.fn().mockResolvedValue({ ...{ id: 1, code: 'DH-ABCDEF', status: 'new', customer_name: 'An', customer_phone: '0912345678', customer_address: null, note: null, total: 290000n, payment_method: 'cod', contact_id: 55, created_at: new Date('2026-10-15T00:00:00Z') }, payment_method: 'bank_transfer', payment_intent_id: 9 }), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), delete: jest.fn().mockResolvedValue({}) },
    contact: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ assigned_to: 3 }), findFirst: jest.fn().mockResolvedValue({ id: 55 }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
    $transaction: jest.fn(),
    user: { findUnique: jest.fn().mockResolvedValue({ id: 3, team_id: null }) },
    activity: { create: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  const features = { isEnabled: jest.fn().mockResolvedValue(enabled) };
  const publicApi = { createContactInTx: jest.fn().mockResolvedValue({ id: 77 }) };
  const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
  const svc = new StoreService(prisma as never, features as never, publicApi as never, scope as never);
  return { svc, prisma, publicApi, scope };
}

describe('StoreService', () => {
  it('cờ tắt / chưa mở bán / sai địa chỉ ⇒ 404 như không có trang', async () => {
    await expect(setup({}, false).svc.publicStore('cua-hang-abc')).rejects.toThrow('Không có cửa hàng');
    await expect(setup({ published: false }).svc.publicStore('cua-hang-abc')).rejects.toThrow('Không có cửa hàng');
    await expect(setup().svc.publicStore('khac')).rejects.toThrow('Không có cửa hàng');
  });

  it('đặt đơn COD: giá lấy từ danh mục (bỏ qua giá trình duyệt), ghép khách theo SĐT, ghi lịch sử', async () => {
    const { svc, prisma, publicApi } = setup();
    const out = await svc.placeOrder('cua-hang-abc', '1.2.3.4', { name: 'An', phone: '0912 345 678', address: '12 Lê Lợi', payment_method: 'cod', items: [{ product_id: 10, quantity: 2, price: 1 } as never, { product_id: 999, quantity: 1 }] });
    expect(out).toMatchObject({ code: 'DH-ABCDEF', total: 290000, payment_method: 'cod', payment: null });
    expect(prisma.contact.findFirst.mock.calls[0][0].where.phone).toEqual({ in: ['0912345678', '84912345678', '+84912345678'] });
    expect(publicApi.createContactInTx).not.toHaveBeenCalled(); // SĐT trùng khách cũ ⇒ dùng khách đó
    expect(prisma.storeOrder.create.mock.calls[0][0].data).toMatchObject({ total: 290000n, items: [{ product_id: 10, name: 'Sách', price: 145000, quantity: 2 }] });
    expect(prisma.activity.create.mock.calls[0][0].data.details.description).toBe('Đơn online DH-ABCDEF — 290.000đ (Sách ×2) · COD');    // Sự kiện webhook "đơn mới" ghi cùng transaction với đơn COD.
    const ev = prisma.integrationEvent.create.mock.calls[0][0].data;
    expect(ev).toMatchObject({ event_type: 'store_order.created', payload: { order: { code: 'DH-ABCDEF', contact_assigned_to: 3 } } });
    expect(JSON.stringify(ev)).toContain('DH-ABCDEF');
  });

  it('chuyển khoản ⇒ QR VietQR tự sinh (tài khoản, số tiền, nội dung = mã đơn), không gọi dịch vụ ngoài, phát sự kiện ngay', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { svc, prisma } = setup({ bank_transfer: true, bank_bin: '970422', bank_account: '0123456789', bank_account_name: 'CUA HANG ABC' });
    expect((await svc.publicStore('cua-hang-abc')).payment).toEqual({ cod: true, bank_transfer: true });
    const out = await svc.placeOrder('cua-hang-abc', '1.2.3.5', { name: 'An', phone: '0912345678', payment_method: 'bank_transfer', items: [{ product_id: 11, quantity: 1 }] });
    expect(out.payment).toMatchObject({ transfer_content: 'DH-ABCDEF', bank: { bin: '970422', bank: 'MBBank', account_number: '0123456789', account_name: 'CUA HANG ABC' } });
    const qr = decodeEmv(out.payment!.qr_data);
    expect(qr).toMatchObject({ bin: '970422', account: '0123456789', amount: '199000', content: 'DH-ABCDEF', crcOk: true });
    expect(prisma.integrationEvent.create).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('chuyển khoản bật nhưng thiếu tài khoản (vd sau migration) ⇒ trang không nhận chuyển khoản', async () => {
    const { svc } = setup({ bank_transfer: true, bank_bin: null, bank_account: null });
    expect((await svc.publicStore('cua-hang-abc')).payment.bank_transfer).toBe(false);
    await expect(svc.placeOrder('cua-hang-abc', '1.2.3.6', { name: 'An', phone: '0912345678', payment_method: 'bank_transfer', items: [{ product_id: 11, quantity: 1 }] })).rejects.toThrow('chưa nhận chuyển khoản');
  });

  it('khách mới ⇒ tạo qua lõi tạo khách chung, nguồn connector:store', async () => {
    const { svc, prisma, publicApi } = setup();
    prisma.contact.findFirst.mockResolvedValue(null);
    await svc.placeOrder('cua-hang-abc', '1.2.3.7', { name: 'Bình', phone: '0987654321', address: 'x', items: [{ product_id: 10, quantity: 1 }] });
    expect(publicApi.createContactInTx).toHaveBeenCalledWith(prisma, { phone: '0987654321', full_name: 'Bình', email: null }, { id: 3, team_id: null }, 'connector:store');
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

  it('chuyển khoản: tổng < 1.000đ ⇒ từ chối trước khi lưu', async () => {
    const b = setup({ bank_transfer: true, bank_bin: '970422', bank_account: '0123456789' });
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

  it('đổi trạng thái đơn: ghi store_order.status_changed (+ store_order.paid khi sang paid) cùng transaction', async () => {
    const { svc, prisma } = setup();
    const row = { id: 1, code: 'DH-ABCDEF', status: 'new', customer_name: 'An', customer_phone: '0912345678', customer_address: null, note: null, items: [{ product_id: 10, name: 'Sách', price: 145000, quantity: 2 }], total: 290000n, payment_method: 'bank_transfer', contact_id: 55, created_at: new Date('2026-10-15T00:00:00Z') };
    prisma.storeOrder.findUnique.mockResolvedValue(row);
    prisma.contact.findMany.mockResolvedValue([{ id: 55, assigned_to: 3 }]);
    prisma.storeOrder.update.mockResolvedValue({ ...row, status: 'paid' });
    await svc.updateOrderStatus({ userId: 1 } as never, 1, 'paid');
    expect(prisma.$transaction).toHaveBeenCalled();
    const evs = prisma.integrationEvent.create.mock.calls.map((c: Array<{ data: { event_type: string; payload: Record<string, unknown> } }>) => c[0].data);
    expect(evs.map((e: { event_type: string }) => e.event_type)).toEqual(['store_order.status_changed', 'store_order.paid']);
    expect(evs[0].payload).toMatchObject({ previous_status: 'new', order: { code: 'DH-ABCDEF', status: 'paid', contact_assigned_to: 3, items: [{ product_id: 10, quantity: 2 }] } });
    prisma.integrationEvent.create.mockClear();
    prisma.storeOrder.update.mockResolvedValue({ ...row, status: 'shipped' });
    await svc.updateOrderStatus({ userId: 1 } as never, 1, 'shipped');
    expect(prisma.integrationEvent.create.mock.calls.map((c: Array<{ data: { event_type: string } }>) => c[0].data.event_type)).toEqual(['store_order.status_changed']);
  });

  it('người cấu hình cửa hàng không còn tồn tại ⇒ khách mới không có người phụ trách (null, không phải 0)', async () => {
    const { svc, prisma, publicApi } = setup();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.contact.findFirst.mockResolvedValue(null);
    await svc.placeOrder('cua-hang-abc', '1.2.3.8', { name: 'Bình', phone: '0987654322', address: 'x', items: [{ product_id: 10, quantity: 1 }] });
    expect(publicApi.createContactInTx.mock.calls[0][2]).toEqual({ id: null, team_id: null });
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
