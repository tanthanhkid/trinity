import { Prisma } from '@trinity/prisma';
import { CommerceSyncService } from '../commerce-sync.service';

function setup() {
  const prisma = {
    connectorRecord: { findUnique: jest.fn().mockResolvedValue({ contact_id: 11 }), create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
    activity: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  const tx = { $executeRaw: jest.fn(), contact: { findFirst: jest.fn().mockResolvedValue(null) }, activity: { create: jest.fn() } };
  prisma.$transaction.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
  const publicApi = { createContactInTx: jest.fn().mockResolvedValue({ id: 99 }) };
  return { prisma, tx, publicApi, svc: new CommerceSyncService(prisma as never, publicApi as never, { ownerIds: jest.fn() } as never) };
}
const order = { kind: 'invoice' as const, external_id: '77', code: 'HD0001', total: 350000, customer: { external_id: '555' }, items: [{ name: 'Cà phê', quantity: 2, price: 25000 }] };

describe('CommerceSyncService', () => {
  it('đơn MỚI của khách đã ghép ⇒ lưu bản ghi + một dòng lịch sử khách', async () => {
    const { prisma, svc } = setup();
    await expect(svc.upsertOrder('kiotviet', 'cuahang', order, { id: 3, team_id: null })).resolves.toEqual({ contact_id: 11, created: true });
    expect(prisma.connectorRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'kiotviet', account: 'cuahang', kind: 'invoice', external_id: '77', amount: 350000n, contact_id: 11 }) });
    expect(prisma.activity.create.mock.calls[0][0].data.details.description).toBe('Hoá đơn KiotViet HD0001 — 350.000đ (Cà phê ×2)');
  });

  it('webhook gửi lại cùng đơn ⇒ chỉ cập nhật, không ghi lịch sử lần hai', async () => {
    const { prisma, svc } = setup();
    prisma.connectorRecord.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(svc.upsertOrder('kiotviet', 'cuahang', order, { id: 3, team_id: null })).resolves.toEqual({ contact_id: 11, created: false });
    expect(prisma.connectorRecord.update).toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('khách có SĐT chưa có trong CRM ⇒ tạo khách (người nối connector phụ trách); không SĐT ⇒ không tạo', async () => {
    const { svc, publicApi, tx } = setup();
    await expect(svc.upsertCustomer('kiotviet', 'cuahang', { external_id: '1', name: 'An', phone: '0912 345 678' }, { id: 3, team_id: 2 })).resolves.toEqual({ contact_id: 99 });
    expect(publicApi.createContactInTx).toHaveBeenCalledWith(tx, expect.objectContaining({ phone: '0912345678', full_name: 'An' }), { id: 3, team_id: 2 }, 'connector:kiotviet');
    publicApi.createContactInTx.mockClear();
    await expect(svc.upsertCustomer('kiotviet', 'cuahang', { external_id: '2', name: 'Không số' }, { id: 3, team_id: 2 })).resolves.toEqual({ contact_id: null });
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });

  it('SĐT đã có khách ⇒ ghép vào khách cũ, không tạo mới', async () => {
    const { svc, publicApi, tx } = setup();
    tx.contact.findFirst.mockResolvedValue({ id: 5 });
    await expect(svc.contactFor('kiotviet', { phone: '+84912345678' }, { id: 3, team_id: null })).resolves.toBe(5);
    expect(publicApi.createContactInTx).not.toHaveBeenCalled();
  });
});

describe('CommerceSyncService.scopeWhere', () => {
  it('phạm vi "tất cả" ⇒ không lọc; phạm vi hẹp ⇒ chỉ bản ghi của khách mình phụ trách (chưa ghép khách thì không thấy)', async () => {
    const prisma = { contact: { findMany: jest.fn().mockResolvedValue([{ id: 5 }, { id: 6 }]) } };
    const all = new CommerceSyncService(prisma as never, {} as never, { ownerIds: jest.fn().mockResolvedValue('all') } as never);
    await expect(all.scopeWhere({ userId: 1 } as never)).resolves.toEqual({});
    const own = new CommerceSyncService(prisma as never, {} as never, { ownerIds: jest.fn().mockResolvedValue([42]) } as never);
    await expect(own.scopeWhere({ userId: 42 } as never)).resolves.toEqual({ contact_id: { in: [5, 6] } });
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { assigned_to: { in: [42] }, deleted_at: null } }));
  });
});
