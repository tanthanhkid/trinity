import 'reflect-metadata';
import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { PosOrdersService } from '../pos-orders.service';
import { PosQrService } from '../pos-qr.service';

/** Guard của luồng thanh toán với Prisma mock (bản chạy được trong CI không có DB; luồng đầy đủ ở pos-flow.integration). */
const mkUser = (userId: number, grants: Grants): AuthUser => ({ userId, email: `u${userId}@t.vn`, isAdmin: false, grants });
const user = mkUser(5, { 'pos.sell': 'own' });
const manager = mkUser(1, { 'pos.sell': 'all', 'pos.manage': true });
const scope = {
  ownerIds: async (u: AuthUser) => ((u.grants as Record<string, unknown>)['pos.sell'] === 'all' ? 'all' : [u.userId]),
} as unknown as ScopeService;

function make(over: { order?: unknown; updateCount?: number; shift?: unknown } = {}) {
  const tx = {
    posOrder: {
      findUnique: jest.fn().mockResolvedValue(over.order === undefined ? { total: 60000n, status: 'open' } : over.order),
      updateMany: jest.fn().mockResolvedValue({ count: over.updateCount ?? 1 }),
      findFirst: jest.fn().mockResolvedValue({ status: 'paid' }),
      // đọc lại đơn đã thu để dựng payload outbox `pos.order.completed`.
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 1, code: '20261004-0001', status: 'paid', order_type: 'dine_in', table_id: null, shift_id: 7, note: null,
        subtotal: 60000n, discount_type: 'none', discount_amount: 0n, total: 60000n, created_by: 5, paid_by: 5,
        paid_at: new Date('2026-10-04T01:00:00Z'), created_at: new Date('2026-10-04T00:00:00Z'),
        items: [{ product_id: 3, product_name: 'Cà phê', unit_price: 30000n, quantity: 2, line_total: 60000n }],
        payments: [{ method: 'cash', amount: 60000n, reference: null }],
      }),
    },
    posPayment: { createMany: jest.fn().mockResolvedValue({}) },
    integrationEvent: { create: jest.fn().mockResolvedValue({ id: 1n }) },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const shifts = { requireOpenShift: jest.fn().mockResolvedValue(over.shift ?? { id: 7 }) };
  const svc = new PosOrdersService(prisma as never, shifts as never, {} as never, scope);
  jest.spyOn(svc, 'getById').mockResolvedValue({ id: 1 } as never);
  return { svc, tx, shifts };
}

describe('PosOrdersService.pay', () => {
  it('lấy tổng từ DB (không tin client): thanh toán lệch tổng bị 400 và không ghi gì', async () => {
    const { svc, tx } = make();
    await expect(svc.pay(1, { payments: [{ method: 'cash', amount: 1000 }] }, user)).rejects.toThrow('phải đúng bằng tổng đơn 60000');
    expect(tx.posOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.posPayment.createMany).not.toHaveBeenCalled();
  });

  it('thu đôi: guard updateMany WHERE status=open trả 0 → 409, không tạo payment', async () => {
    const { svc, tx } = make({ updateCount: 0 });
    await expect(svc.pay(1, { payments: [{ method: 'cash', amount: 60000 }] }, user)).rejects.toThrow('đã được thanh toán');
    expect(tx.posOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1, status: 'open', total: 60000n } }));
    expect(tx.posPayment.createMany).not.toHaveBeenCalled();
  });

  it('đơn đã paid/void bị chặn; thu thành công ghi payment gắn ca của NGƯỜI THU', async () => {
    await expect(make({ order: { total: 60000n, status: 'paid' } }).svc.pay(1, { payments: [] }, user)).rejects.toThrow('đã được thanh toán');
    const { svc, tx } = make();
    await svc.pay(1, { payments: [{ method: 'cash', amount: 60000, tendered: 100000 }] }, user);
    const rows = tx.posPayment.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ order_id: 1, shift_id: 7, amount: 60000n, tendered: 100000n, change: 40000n, created_by: 5 });
  });

  it('thu thành công ghi outbox pos.order.completed (BigInt → chuỗi) CÙNG transaction, sau khi ghi payment', async () => {
    const { svc, tx } = make();
    await svc.pay(1, { payments: [{ method: 'cash', amount: 60000 }] }, user);
    expect(tx.integrationEvent.create).toHaveBeenCalledTimes(1);
    const data = tx.integrationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ event_type: 'pos.order.completed', resource: 'pos_order', resource_id: '1', actor_user_id: 5 });
    expect(data.payload.order).toMatchObject({ code: '20261004-0001', total: '60000', items: [{ line_total: '60000' }], payments: [{ method: 'cash', amount: '60000' }] });
    expect(tx.posPayment.createMany.mock.invocationCallOrder[0]).toBeLessThan(tx.integrationEvent.create.mock.invocationCallOrder[0]);
  });

  it('thu lỗi (thu đôi / lệch tổng / lỗi payment) → KHÔNG ghi outbox', async () => {
    const dup = make({ updateCount: 0 });
    await expect(dup.svc.pay(1, { payments: [{ method: 'cash', amount: 60000 }] }, user)).rejects.toThrow();
    expect(dup.tx.integrationEvent.create).not.toHaveBeenCalled();
    const bad = make();
    await expect(bad.svc.pay(1, { payments: [{ method: 'cash', amount: 1000 }] }, user)).rejects.toThrow();
    expect(bad.tx.integrationEvent.create).not.toHaveBeenCalled();
    const failPay = make();
    failPay.tx.posPayment.createMany.mockRejectedValue(new Error('db'));
    await expect(failPay.svc.pay(1, { payments: [{ method: 'cash', amount: 60000 }] }, user)).rejects.toThrow('db');
    expect(failPay.tx.integrationEvent.create).not.toHaveBeenCalled();
  });

  it('chưa mở ca thì không thu được (lỗi từ requireOpenShift)', async () => {
    const { svc, shifts } = make();
    shifts.requireOpenShift.mockRejectedValue(new Error('Chưa mở ca'));
    await expect(svc.pay(1, { payments: [{ method: 'cash', amount: 60000 }] }, user)).rejects.toThrow('Chưa mở ca');
  });
});

describe('PosOrdersService.voidOrder', () => {
  it('đơn đã thu: chỉ có pos.sell bị 403, có pos.manage huỷ được', async () => {
    await expect(make().svc.voidOrder(1, { reason: 'nhầm' }, user)).rejects.toThrow('pos.manage');
    const { svc, tx } = make();
    await svc.voidOrder(1, { reason: 'nhầm' }, manager);
    expect(tx.posOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1, status: 'paid' } }));
  });
});

describe('PosQrService.forOrder', () => {
  const settings = { bank_bin: '970436', bank_account_no: '0123456789', bank_account_name: 'QUAN A' };
  const qr = (status = 'open') =>
    new PosQrService({
      posOrder: { findUnique: jest.fn().mockResolvedValue({ code: '20260930-0001', total: 100000n, status }) },
      posSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    } as never);

  it('mặc định = tổng đơn; chia thanh toán dùng amount ≤ tổng; vượt tổng / đơn đã đóng bị chặn', async () => {
    expect((await qr().forOrder(1, user)).amount).toBe(100000);
    const part = await qr().forOrder(1, user, 40000);
    expect(part.amount).toBe(40000);
    expect(part.payload).toContain('540540000'); // tag 54, dài 05, "40000"
    await expect(qr().forOrder(1, user, 100001)).rejects.toThrow('trong khoảng');
    await expect(qr('paid').forOrder(1, user)).rejects.toThrow('đang mở');
  });
});
