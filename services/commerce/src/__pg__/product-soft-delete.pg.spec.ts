import { BadRequestException, ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { describePg, pgClient, resetTables } from './pg-harness';
import { ProductsService } from '../products/products.service';
import { PosOrderItemsBuilder, lockProductsForOrder } from '../pos/pos-order-items.builder';

/**
 * Xoá mềm sản phẩm (#62) trên Postgres THẬT: cột của migration 0017, lọc `deleted_at` ở danh mục / POS,
 * khoá `FOR SHARE ... AND deleted_at IS NULL` khi tạo đơn, và xoá hẳn (`hardDeleteProduct`, khoá FOR UPDATE + đếm
 * tham chiếu soft-FK) chỉ khi chưa dùng.
 */
// pos_order_items.product_id không có FK ⇒ TRUNCATE products không kéo theo; bộ pos-flow chạy trước để lại đơn trỏ vào id 1, 2…
// (RESTART IDENTITY cấp lại các id đó) ⇒ phải xoá cả đơn POS, không thì "xoá hẳn" thấy sản phẩm mới như đã bán.
const TABLES = ['contacts', 'pos_payments', 'pos_order_items', 'pos_orders', 'products'];
const admin = { userId: 1, email: 'a@t', isAdmin: true, grants: {} } as unknown as AuthUser;
const owner = { userId: 7, email: 'o@t', isAdmin: false, grants: {} } as unknown as AuthUser;
const other = { userId: 8, email: 'x@t', isAdmin: false, grants: {} } as unknown as AuthUser;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describePg('Xoá mềm sản phẩm (Postgres thật)', () => {
  let db: PrismaService;
  let svc: ProductsService;
  let builder: PosOrderItemsBuilder;
  beforeAll(() => {
    db = pgClient();
    svc = new ProductsService(db, { findAllForCategoryAsValidatorDefs: async () => [] } as never);
    builder = new PosOrderItemsBuilder(db);
  });
  beforeEach(() => resetTables(db, TABLES));
  afterAll(() => db.$disconnect());

  const product = (code: string, o: Record<string, unknown> = {}) =>
    db.product.create({ data: { code, name: `SP ${code}`, price: 29000n, ...o } as never });

  it('xoá = lưu trữ: ghi deleted_at + deleted_by; biến khỏi danh mục / xem; ?archived=true thấy lại', async () => {
    const p = await product('CF-1');
    await svc.remove(p.id, owner);
    const row = await db.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by).toBe(7);
    expect((await svc.findAll({})).map((x) => x.id)).not.toContain(p.id);
    expect((await svc.findAll({ archived: true })).map((x) => x.id)).toEqual([p.id]);
    await expect(svc.findOne(p.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('khôi phục: người xoá trong 10 phút ⇒ hiện lại; người khác 403; Quản trị được; quá hạn 410', async () => {
    const p = await product('CF-2', { deleted_at: minutesAgo(1), deleted_by: 7 });
    await expect(svc.restore(p.id, other)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.restore(p.id, owner);
    expect((await db.product.findUniqueOrThrow({ where: { id: p.id } })).deleted_at).toBeNull();

    const q = await product('CF-3', { deleted_at: minutesAgo(11), deleted_by: 7 });
    await expect(svc.restore(q.id, owner)).rejects.toBeInstanceOf(GoneException);
    await db.product.update({ where: { id: q.id }, data: { deleted_at: minutesAgo(1) } as never });
    await expect(svc.restore(q.id, admin)).resolves.toBeDefined();
  });

  it('xoá hẳn: chỉ Quản trị; đang được liên hệ dùng ⇒ 409, dòng còn nguyên; chưa dùng ⇒ xoá hẳn', async () => {
    const used = await product('CF-4', { deleted_at: new Date(), deleted_by: 1 });
    await db.contact.create({ data: { phone: '0900000001', product_id: used.id } });
    await expect(svc.purge(used.id, owner)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.purge(used.id, admin)).rejects.toBeInstanceOf(ConflictException);
    expect(await db.product.count({ where: { id: used.id } })).toBe(1);

    const unused = await product('CF-5', { deleted_at: new Date(), deleted_by: 1 });
    await expect(svc.purge(unused.id, admin)).resolves.toEqual({ id: unused.id, deleted: true });
    expect(await db.product.count({ where: { id: unused.id } })).toBe(0);
  });

  it('mã trùng sản phẩm đã lưu trữ ⇒ 409 nói rõ cách xử lý', async () => {
    await product('CF-6', { deleted_at: new Date(), deleted_by: 7 });
    await expect(svc.create({ name: 'Mới', code: 'cf-6' } as never, 7)).rejects.toThrow('đã xoá (lưu trữ)');
  });

  it('POS: không bán được sản phẩm đã lưu trữ — cả bước dựng dòng đơn lẫn khoá FOR SHARE trong transaction', async () => {
    const live = await product('CF-7')
    const gone = await product('CF-8', { deleted_at: new Date(), deleted_by: 7 });
    await expect(builder.build([{ product_id: gone.id, quantity: 1 }] as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(builder.build([{ product_id: live.id, quantity: 1 }] as never)).resolves.toHaveLength(1);
    await expect(
      db.$transaction((tx) => lockProductsForOrder(tx, [{ product_id: gone.id }] as never)),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(db.$transaction((tx) => lockProductsForOrder(tx, [{ product_id: live.id }] as never))).resolves.toBeUndefined();
  });
});
