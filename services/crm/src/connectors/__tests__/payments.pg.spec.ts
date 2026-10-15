import type { PrismaService } from '@trinity/prisma';
import { describePg, pgClient, resetTables } from '../../__pg__/pg-harness';
import { PaymentsService } from '../payments.service';
import { CommerceSyncService } from '../commerce-sync.service';
import { PublicApiService } from '../../public-api/public-api.service';
import { parseSepayTransaction } from '../sepay';

const TABLES = ['payment_intents', 'connector_events', 'integration_events', 'store_orders', 'connector_records', 'activities', 'contacts', 'users'];
const tx = (id: number, content: string, amount: number) =>
  parseSepayTransaction({ id, gateway: 'MBBank', transactionDate: '2026-10-15 09:00:00', accountNumber: '0123', code: null, content, transferType: 'in', transferAmount: amount, accumulated: 0, subAccount: null, referenceCode: 'FT', description: '' })!;

describePg('Thanh toán trên Postgres thật', () => {
  let db: PrismaService;
  let svc: PaymentsService;
  beforeAll(() => {
    db = pgClient();
    const connectors = { active: async () => null, touch: async () => undefined };
    svc = new PaymentsService(db, connectors as never, { ownerIds: async () => 'all' } as never);
  });
  beforeEach(() => resetTables(db, TABLES));
  afterAll(() => db.$disconnect());

  it('SePay: khớp mã → yêu cầu "paid" + sự kiện payment.received + event matched (câu SQL tiền tố chạy được)', async () => {
    const p = await svc.create({ amount: 150000, description: 'Thử' }, null);
    await expect(svc.handleSepay(tx(1001, `ck ${p.code.toLowerCase()} abc`, 150000), 'TRN')).resolves.toEqual({ status: 'matched', payment_intent_id: p.id });
    const row = await db.paymentIntent.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe('paid');
    expect(await db.integrationEvent.count({ where: { event_type: 'payment.received' } })).toBe(1);
    expect((await db.connectorEvent.findFirstOrThrow({ where: { external_id: '1001' } })).status).toBe('matched');
    await expect(svc.handleSepay(tx(1001, `ck ${p.code}`, 150000), 'TRN')).resolves.toEqual({ status: 'duplicate' });
  });

  it('đổi tiền tố khi còn yêu cầu cũ ⇒ vẫn khớp mã cũ (SQL DISTINCT left(...)::int)', async () => {
    const p = await svc.create({ amount: 50000 }, null);
    await expect(svc.handleSepay(tx(1002, `noi dung ${p.code}`, 50000), 'XYZ')).resolves.toMatchObject({ status: 'matched' });
  });

  it('yêu cầu của đơn online ⇒ đơn chuyển "paid" cùng giao dịch', async () => {
    const order = await db.storeOrder.create({ data: { code: 'DH-TEST01', customer_name: 'An', customer_phone: '0912345678', items: [], total: 70000n, payment_method: 'bank_transfer' } });
    const p = await svc.create({ amount: 70000, source_type: 'store_order', source_id: order.id }, null);
    await svc.handleSepay(tx(1003, p.code, 70000), 'TRN');
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('paid');
  });

  it('lọc "quá hạn" theo expires_at', async () => {
    await svc.create({ amount: 10000, expires_in_hours: 1 }, null);
    await db.paymentIntent.updateMany({ data: { expires_at: new Date(Date.now() - 60_000) } });
    expect(await svc.list({ status: 'expired' })).toHaveLength(1);
    expect(await svc.list({ status: 'pending' })).toHaveLength(0);
  });
});

describePg('Đồng bộ bán hàng trên Postgres thật', () => {
  let db: PrismaService;
  let sync: CommerceSyncService;
  let owner: { id: number; team_id: number | null };
  beforeAll(() => {
    db = pgClient();
    sync = new CommerceSyncService(db, new PublicApiService(db), { ownerIds: async () => 'all' } as never);
  });
  beforeEach(async () => {
    await resetTables(db, TABLES);
    const u = await db.user.create({ data: { email: 'owner@test.local', password_hash: 'x', full_name: 'Chủ shop thử' } });
    owner = { id: u.id, team_id: null };
  });
  afterAll(() => db.$disconnect());

  it('ghép khách theo SĐT (khoá advisory + tạo khách + sự kiện), gọi lại không tạo trùng', async () => {
    const a = await sync.contactFor('kiotviet', { name: 'An', phone: '0912 345 678' }, owner);
    const b = await sync.contactFor('sapo', { phone: '+84912345678' }, owner);
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a);
    expect(await db.contact.count()).toBe(1);
  });

  it('đơn mới ⇒ bản ghi + lịch sử; gửi lại ⇒ cập nhật, không thêm lịch sử; hai gian hàng trùng id không đè nhau', async () => {
    const order = { kind: 'invoice' as const, external_id: '77', code: 'HD1', total: 350000, customer: { phone: '0912345678', name: 'An' } };
    await expect(sync.upsertOrder('kiotviet', 'shop-a', order, owner)).resolves.toMatchObject({ created: true });
    await expect(sync.upsertOrder('kiotviet', 'shop-a', { ...order, total: 360000 }, owner)).resolves.toMatchObject({ created: false });
    await expect(sync.upsertOrder('kiotviet', 'shop-b', order, owner)).resolves.toMatchObject({ created: true });
    expect(await db.connectorRecord.count()).toBe(2);
    expect(Number((await db.connectorRecord.findFirstOrThrow({ where: { account: 'shop-a' } })).amount)).toBe(360000);
    expect(await db.activity.count({ where: { action: 'note', details: { path: ['source'], equals: 'connector:kiotviet' } } })).toBe(3);
  });
});
