import type { PrismaService } from '@trinity/prisma';
import { describePg, pgClient, resetTables } from '../../__pg__/pg-harness';
import { PaymentsService } from '../payments.service';
import { seedPendingPayment } from './seed-payment';
import { parseSepayTransaction } from '../sepay';

const TABLES = ['payment_intents', 'connector_events', 'integration_events', 'store_orders', 'activities', 'contacts', 'users'];
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
    const p = await seedPendingPayment(db, { amount: 150000, description: 'Thử' });
    await expect(svc.handleSepay(tx(1001, `ck ${p.code.toLowerCase()} abc`, 150000), 'TRN')).resolves.toEqual({ status: 'matched', payment_intent_id: p.id });
    const row = await db.paymentIntent.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe('paid');
    expect(await db.integrationEvent.count({ where: { event_type: 'payment.received' } })).toBe(1);
    expect((await db.connectorEvent.findFirstOrThrow({ where: { external_id: '1001' } })).status).toBe('matched');
    await expect(svc.handleSepay(tx(1001, `ck ${p.code}`, 150000), 'TRN')).resolves.toEqual({ status: 'duplicate' });
  });

  it('đổi tiền tố khi còn yêu cầu cũ ⇒ vẫn khớp mã cũ (SQL DISTINCT left(...)::int)', async () => {
    const p = await seedPendingPayment(db, { amount: 50000 });
    await expect(svc.handleSepay(tx(1002, `noi dung ${p.code}`, 50000), 'XYZ')).resolves.toMatchObject({ status: 'matched' });
  });

  it('yêu cầu của đơn online ⇒ đơn chuyển "paid" cùng giao dịch', async () => {
    const order = await db.storeOrder.create({ data: { code: 'DH-TEST01', customer_name: 'An', customer_phone: '0912345678', items: [], total: 70000n, payment_method: 'bank_transfer' } });
    const p = await seedPendingPayment(db, { amount: 70000, source_type: 'store_order', source_id: order.id });
    await svc.handleSepay(tx(1003, p.code, 70000), 'TRN');
    expect((await db.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('paid');
  });

  it('lọc "quá hạn" theo expires_at', async () => {
    await seedPendingPayment(db, { amount: 10000, expires_at: new Date(Date.now() + 3_600_000) });
    await db.paymentIntent.updateMany({ data: { expires_at: new Date(Date.now() - 60_000) } });
    expect(await svc.list({ status: 'expired' })).toHaveLength(1);
    expect(await svc.list({ status: 'pending' })).toHaveLength(0);
  });
});
