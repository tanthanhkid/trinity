import 'reflect-metadata';
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest';
import { CreateOrderDto, PayOrderDto } from '../dto/order.dto';
import { PosCatalogController } from '../pos-catalog.controller';
import { PosLayoutController } from '../pos-layout.controller';
import { PosOrdersController } from '../pos-orders.controller';
import { PosShiftsController } from '../pos-shifts.controller';

// Cấu hình pipe strict như `ServiceAwareValidationPipe` của monolith.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype }) as ArgumentMetadata;

describe('DTO đơn POS', () => {
  const valid = { items: [{ product_id: 1, quantity: 2 }] };
  it('client KHÔNG được gửi giá/tổng (forbidNonWhitelisted)', async () => {
    await expect(pipe.transform({ ...valid, total: 1 }, meta(CreateOrderDto))).rejects.toThrow();
    await expect(pipe.transform({ items: [{ product_id: 1, quantity: 1, price: 1 }] }, meta(CreateOrderDto))).rejects.toThrow();
  });
  it('đơn rỗng / số lượng ngoài khoảng / discount_type lạ bị từ chối', async () => {
    await expect(pipe.transform({ items: [] }, meta(CreateOrderDto))).rejects.toThrow();
    await expect(pipe.transform({ items: [{ product_id: 1, quantity: 0 }] }, meta(CreateOrderDto))).rejects.toThrow();
    await expect(pipe.transform({ items: [{ product_id: 1, quantity: 1000 }] }, meta(CreateOrderDto))).rejects.toThrow();
    await expect(pipe.transform({ ...valid, discount_type: 'coupon' }, meta(CreateOrderDto))).rejects.toThrow();
    await expect(pipe.transform({ items: [{ product_id: 99999999999, quantity: 1 }] }, meta(CreateOrderDto))).rejects.toThrow();
  });
  it('hợp lệ đi qua; thanh toán chỉ nhận cash/bank_transfer', async () => {
    await expect(pipe.transform(valid, meta(CreateOrderDto))).resolves.toBeDefined();
    await expect(pipe.transform({ payments: [{ method: 'card', amount: 1 }] }, meta(PayOrderDto))).rejects.toThrow();
    await expect(pipe.transform({ payments: [{ method: 'cash', amount: 1000, tendered: 2000 }] }, meta(PayOrderDto))).resolves.toBeDefined();
  });
});

describe('RBAC POS (@Can — quyền + phạm vi)', () => {
  const reflector = new Reflector();
  /** Mirror `PermissionGuard`: `getAllAndOverride([handler, class])`. */
  const metaOf = (cls: new (...a: never[]) => unknown, handler: string): AccessMeta | undefined =>
    reflector.getAllAndOverride<AccessMeta | undefined>(RBAC_META, [
      (cls.prototype as Record<string, () => void>)[handler],
      cls,
    ]);
  const can = (...permissions: string[]) => ({ kind: 'can', permissions, mode: 'all' });

  it('mọi route POS đều có metadata quyền (không route nào mở/thiếu — deny-by-default)', () => {
    const routes: [new (...a: never[]) => unknown, string[]][] = [
      [PosCatalogController, ['settings', 'updateSettings', 'menu']],
      [PosLayoutController, ['areas', 'createArea', 'updateArea', 'tables', 'createTable', 'updateTable', 'modifiers', 'createModifier', 'updateModifier']],
      [PosOrdersController, ['create', 'list', 'get', 'update', 'pay', 'void', 'qrCode']],
      [PosShiftsController, ['open', 'current', 'list', 'summary', 'close', 'daily']],
    ];
    for (const [cls, handlers] of routes) for (const h of handlers) expect(metaOf(cls, h)).toBeDefined();
  });
  it('đọc/bán hàng = pos.sell (cấp class)', () => {
    expect(metaOf(PosOrdersController, 'create')).toEqual(can('pos.sell'));
    expect(metaOf(PosOrdersController, 'void')).toEqual(can('pos.sell')); // đơn đã thu cần thêm pos.manage ở service
    expect(metaOf(PosCatalogController, 'menu')).toEqual(can('pos.sell'));
    expect(metaOf(PosShiftsController, 'open')).toEqual(can('pos.sell'));
  });
  it('ghi cấu hình = pos.manage; báo cáo ngày = pos.report', () => {
    expect(metaOf(PosCatalogController, 'updateSettings')).toEqual(can('pos.manage'));
    expect(metaOf(PosLayoutController, 'createTable')).toEqual(can('pos.manage'));
    expect(metaOf(PosLayoutController, 'updateModifier')).toEqual(can('pos.manage'));
    expect(metaOf(PosShiftsController, 'daily')).toEqual(can('pos.report'));
  });
});
