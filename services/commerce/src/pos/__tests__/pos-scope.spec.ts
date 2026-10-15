import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { PosOrdersService } from '../pos-orders.service';
import { PosShiftsService } from '../pos-shifts.service';

/** Helper: người dùng với grants cho trước. */
const user = (userId: number, grants: Grants): AuthUser => ({ userId, email: 'u@t.vn', isAdmin: false, grants });
const scopeOf = (owner: number[] | 'all' | null): ScopeService =>
  ({ ownerIds: jest.fn().mockResolvedValue(owner) }) as unknown as ScopeService;

describe('PosOrdersService — đơn nhìn thấy theo phạm vi pos.sell', () => {
  const mk = (owner: number[] | 'all' | null) => {
    const prisma = {
      posOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    return { prisma, svc: new PosOrdersService(prisma as never, {} as never, {} as never, scopeOf(owner)) };
  };

  it("scope 'all': thấy mọi đơn (không lọc thêm)", async () => {
    const { prisma, svc } = mk('all');
    await svc.list({}, user(1, { 'pos.sell': 'all' }));
    expect(prisma.posOrder.findMany.mock.calls[0][0].where.AND[0]).toEqual({});
  });
  it('scope own: đơn mở (sàn chung) + đơn do MÌNH tạo/thu, không thấy đơn đã thu của người khác', async () => {
    const { prisma, svc } = mk([5]);
    await svc.list({}, user(5, { 'pos.sell': 'own' }));
    expect(prisma.posOrder.findMany.mock.calls[0][0].where.AND[0]).toEqual({
      OR: [{ status: 'open' }, { OR: [{ created_by: { in: [5] } }, { paid_by: { in: [5] } }] }],
    });
  });
  it('đơn ngoài phạm vi → 404 (getById/void)', async () => {
    const { svc } = mk([5]);
    await expect(svc.getById(9, user(5, { 'pos.sell': 'own' }))).rejects.toThrow(NotFoundException);
  });
  it('huỷ đơn ĐÃ THU cần pos.manage (người chỉ có pos.sell bị 403, người có pos.manage qua)', async () => {
    const { prisma, svc } = mk('all');
    prisma.posOrder.findFirst.mockResolvedValue({ status: 'paid' });
    await expect(svc.voidOrder(1, { reason: 'x' }, user(5, { 'pos.sell': 'all' }))).rejects.toThrow('pos.manage');
  });
});

describe('PosShiftsService — ca nhìn thấy theo phạm vi pos.sell', () => {
  const mk = (owner: number[] | 'all' | null) => {
    const prisma = {
      posShift: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    };
    const scope = {
      ownerIds: jest.fn().mockResolvedValue(owner),
    } as unknown as ScopeService;
    return { prisma, svc: new PosShiftsService(prisma as never, scope) };
  };

  it('list: lọc opened_by theo phạm vi (own = chỉ mình)', async () => {
    const { prisma, svc } = mk([5]);
    await svc.list({}, user(5, { 'pos.sell': 'own' }));
    expect(prisma.posShift.findMany.mock.calls[0][0].where.AND[0]).toEqual({ opened_by: { in: [5] } });
  });
  it("list: scope 'all' không lọc", async () => {
    const { prisma, svc } = mk('all');
    await svc.list({}, user(5, { 'pos.sell': 'all' }));
    expect(prisma.posShift.findMany.mock.calls[0][0].where.AND[0]).toEqual({});
  });
  it('getOwned: ca người khác ngoài phạm vi → 404, trong phạm vi → trả ca', async () => {
    const own = mk([5]);
    own.prisma.posShift.findUnique.mockResolvedValue({ id: 1, opened_by: 6 });
    await expect(own.svc.getOwned(1, user(5, { 'pos.sell': 'own' }))).rejects.toThrow(NotFoundException);
    const all = mk('all');
    all.prisma.posShift.findUnique.mockResolvedValue({ id: 1, opened_by: 6 });
    await expect(all.svc.getOwned(1, user(9, { 'pos.sell': 'all' }))).resolves.toMatchObject({ id: 1 });
  });
});
