import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { PosCatalogService } from '../pos-catalog.service';
import { PosOrderItemsBuilder } from '../pos-order-items.builder';
import { PosOrdersService } from '../pos-orders.service';
import { PosQrService } from '../pos-qr.service';
import { PosReportsService } from '../pos-reports.service';
import { PosShiftsService } from '../pos-shifts.service';
import { todayVn } from '../pos-mapper';

/**
 * Luồng POS trên Postgres THẬT. Chỉ chạy khi có `POS_TEST_DATABASE_URL` (DB đã `migrate deploy`);
 * CI không có DB thì bỏ qua. Chạy tay: POS_TEST_DATABASE_URL=postgresql://... npx jest pos-flow
 */
const url = process.env.POS_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('POS luồng bán hàng (DB thật)', () => {
  // `describe.skip` vẫn chạy thân hàm → chỉ dựng client khi có DB.
  const prisma = (url ? new PrismaClient({ datasources: { db: { url } } }) : null) as PrismaClient;
  const p = prisma as never;
  // Quyền + phạm vi: thu ngân = `own`; quản lý = `all` + pos.manage. Scope giả (không cần Redis/cây).
  const scope = {
    ownerIds: async (u: AuthUser, perm: string) => {
      const g = (u.grants as Record<string, unknown>)[perm];
      return g === 'all' || g === true ? 'all' : g === 'own' ? [u.userId] : null;
    },
  } as unknown as ScopeService;
  const shifts = new PosShiftsService(p, scope);
  const orders = new PosOrdersService(p, shifts, new PosOrderItemsBuilder(p), scope);
  const qr = new PosQrService(p);
  const reports = new PosReportsService(p);
  const catalog = new PosCatalogService(p);
  const mk = (userId: number, grants: Grants): AuthUser => ({ userId, email: `u${userId}@t.vn`, isAdmin: false, grants });
  const cashier = mk(9101, { 'pos.sell': 'own' });
  const cashier2 = mk(9102, { 'pos.sell': 'own' });
  const manager = mk(9103, { 'pos.sell': 'all', 'pos.manage': true, 'pos.report': true });
  let cafe = 0, tea = 0, sizeL = 0, tableId = 0;

  beforeAll(async () => {
    await prisma.posPayment.deleteMany(); await prisma.posOrderItem.deleteMany();
    await prisma.posOrder.deleteMany(); await prisma.posShift.deleteMany();
    const c = await prisma.product.create({ data: { code: `T-CF-${Date.now()}`, name: 'Cà phê sữa', price: 30000n } });
    const t = await prisma.product.create({ data: { code: `T-TR-${Date.now()}`, name: 'Trà đào', price: 45000n } });
    cafe = c.id; tea = t.id;
    const m = await prisma.posModifier.upsert({
      where: { group_name_name: { group_name: 'Size', name: 'L' } }, update: { price_delta: 5000n }, create: { group_name: 'Size', name: 'L', price_delta: 5000n },
    });
    sizeL = m.id;
    const a = await prisma.posArea.upsert({ where: { name: 'Tầng 1' }, update: {}, create: { name: 'Tầng 1' } });
    const tb = await prisma.posTable.upsert({ where: { area_id_name: { area_id: a.id, name: 'B1' } }, update: {}, create: { area_id: a.id, name: 'B1' } });
    tableId = tb.id;
    await catalog.updateSettings({ bank_bin: '970436', bank_account_no: '0123456789', menu_category_ids: [] });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('không có ca thì không tạo được đơn', async () => {
    await expect(orders.create({ items: [{ product_id: cafe, quantity: 1 }] }, cashier)).rejects.toThrow('Chưa mở ca');
  });

  it('mở ca; mở lần 2 bị chặn (unique từng phần)', async () => {
    await shifts.open({ opening_cash: 500000 }, cashier);
    await expect(shifts.open({ opening_cash: 0 }, cashier)).rejects.toThrow('đang có một ca mở');
    await shifts.open({ opening_cash: 100000 }, cashier2); // user khác vẫn mở được
  });

  it('BE tự tính giá + tuỳ chọn + giảm giá; tiền thối đúng; báo cáo & đóng ca khớp', async () => {
    const o = await orders.create({
      table_id: tableId, discount_type: 'percent', discount_value: 10,
      items: [{ product_id: cafe, quantity: 2, modifier_ids: [sizeL] }, { product_id: tea, quantity: 1 }],
    }, cashier);
    // (30000+5000)*2 + 45000 = 115000; giảm 10% = 11500 → 103500
    expect(o.subtotal).toBe(115000);
    expect(o.discount_amount).toBe(11500);
    expect(o.total).toBe(103500);
    expect(o.code).toMatch(/^\d{8}-\d{4}$/);

    const tables = await (async () => (await prisma.posOrder.findMany({ where: { table_id: tableId, status: 'open' } })).length)();
    expect(tables).toBe(1);
    expect((await qr.forOrder(o.id, cashier)).amount).toBe(103500);

    await expect(orders.pay(o.id, { payments: [{ method: 'cash', amount: 100000 }] }, cashier)).rejects.toThrow('phải đúng bằng');
    const paid = await orders.pay(o.id, { payments: [{ method: 'cash', amount: 3500, tendered: 5000 }, { method: 'bank_transfer', amount: 100000 }] }, cashier);
    expect(paid.status).toBe('paid');
    expect(paid.payments[0]).toMatchObject({ change: 1500 });
    await expect(orders.pay(o.id, { payments: [{ method: 'cash', amount: 103500 }] }, cashier)).rejects.toThrow('đã được thanh toán');
    await expect(orders.update(o.id, { note: 'x' }, cashier)).rejects.toThrow('đang mở');

    // ĐÚNG 1 dòng outbox cho đơn này (lần thu lỗi/thu đôi bị rollback không để lại dòng nào), payload có payments.
    const evs = await prisma.integrationEvent.findMany({ where: { event_type: 'pos.order.completed', resource_id: String(o.id) } });
    expect(evs).toHaveLength(1);
    expect(evs[0].actor_user_id).toBe(cashier.userId);
    expect((evs[0].payload as { order: { payments: unknown[]; total: string } }).order.payments).toHaveLength(2);

    const s = await shifts.current(cashier);
    expect(s.summary).toMatchObject({ paid_orders: 1, cash_sales: 3500, transfer_sales: 100000, expected_cash: 503500 });

    const rep = await reports.daily(todayVn());
    expect(rep.order_count).toBeGreaterThanOrEqual(1);
    expect(rep.revenue).toBeGreaterThanOrEqual(103500);
    expect(rep.by_product.find((x) => x.product_id === cafe)?.quantity).toBe(2);
    expect(rep.by_hour.length).toBeGreaterThan(0);
  });

  it('sửa đơn mở: thay dòng món + tính lại tổng; sale khác thu được (sàn chung); huỷ cần lý do', async () => {
    const o = await orders.create({ items: [{ product_id: tea, quantity: 1 }] }, cashier);
    const u = await orders.update(o.id, { items: [{ product_id: tea, quantity: 3 }], discount_type: 'amount', discount_value: 5000 }, cashier);
    expect(u.total).toBe(130000);
    const paid = await orders.pay(o.id, { payments: [{ method: 'cash', amount: 130000, tendered: 150000 }] }, cashier2);
    expect(paid.paid_by).toBe(cashier2.userId);
    await expect(orders.voidOrder(o.id, { reason: 'nhầm đơn' }, cashier)).rejects.toThrow('pos.manage');
    const v = await orders.voidOrder(o.id, { reason: 'nhầm đơn' }, manager);
    expect(v.status).toBe('void');
  });

  it('chặn đóng ca khi còn đơn mở; đóng ca tính chênh lệch; ca đã đóng không đóng lại', async () => {
    const o = await orders.create({ items: [{ product_id: cafe, quantity: 1 }] }, cashier);
    const cur = (await shifts.current(cashier)).shift!;
    await expect(shifts.close(cur.id, { closing_cash_counted: 503500 }, cashier)).rejects.toThrow('chưa thanh toán');
    await orders.voidOrder(o.id, { reason: 'khách đổi ý' }, cashier);
    const closed = await shifts.close(cur.id, { closing_cash_counted: 503000 }, cashier);
    expect(closed.shift).toMatchObject({ status: 'closed', expected_cash: 503500, cash_diff: -500 });
    await expect(shifts.close(cur.id, { closing_cash_counted: 1 }, cashier)).rejects.toThrow('đã đóng');
    await expect(shifts.getOwned(cur.id, cashier2)).rejects.toThrow(NotFoundException); // ca người khác: 404
    await expect(shifts.getOwned(cur.id, manager)).resolves.toBeDefined();
  });

  it('món ngoài menu cấu hình / đã tắt bị từ chối', async () => {
    await shifts.open({ opening_cash: 0 }, cashier);
    await prisma.product.update({ where: { id: tea }, data: { is_active: false } });
    await expect(orders.create({ items: [{ product_id: tea, quantity: 1 }] }, cashier)).rejects.toThrow('không tồn tại');
    const cat = await prisma.productCategory.create({ data: { code: `pos-${Date.now()}`, name: 'Đồ uống' } });
    await catalog.updateSettings({ menu_category_ids: [cat.id] });
    await expect(orders.create({ items: [{ product_id: cafe, quantity: 1 }] }, cashier)).rejects.toThrow('không có trong menu');
    await catalog.updateSettings({ menu_category_ids: [] });
  });
});
