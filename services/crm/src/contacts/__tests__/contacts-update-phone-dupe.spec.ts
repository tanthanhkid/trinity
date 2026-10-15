import { ConflictException } from '@nestjs/common';
import { ContactsService } from '../contacts.service';

describe('ContactsService.update — trùng SĐT theo người phụ trách (cùng luật với create)', () => {
  const existing = { id: 1, assigned_to: 5, created_by_id: 5, team_id: null, full_name: 'A', source_id: 1, source_locked: false, phone: '0900000001', stage_id: 1 };
  const build = (dupeCount: number) => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: 8, status: 'active', deleted_at: null, team_id: null }) }, contact: { findFirst: jest.fn().mockResolvedValue(existing), count: jest.fn().mockResolvedValue(dupeCount) } };
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
    const svc = new ContactsService(prisma as never, {} as never, {} as never, scope as never, {} as never, {} as never);
    return { svc, prisma };
  };
  const admin = { userId: 5, isAdmin: true, grants: {} } as never;

  it('chỉ đếm khách khác CÙNG assigned_to, và báo 409 khi có', async () => {
    const { svc, prisma } = build(1);
    await expect(svc.update(1, { phone: '0900000002' } as never, admin)).rejects.toThrow(ConflictException);
    expect(prisma.contact.count).toHaveBeenCalledWith({
      where: { phone: { in: ['0900000002', '84900000002', '+84900000002'] }, deleted_at: null, id: { not: 1 }, assigned_to: 5 },
    });
  });

  it('đổi người phụ trách (không đổi SĐT) vẫn kiểm trùng với danh sách của người nhận', async () => {
    const { svc, prisma } = build(1);
    await expect(svc.update(1, { assigned_to: 8 } as never, admin)).rejects.toThrow(ConflictException);
    expect(prisma.contact.count).toHaveBeenCalledWith({
      where: { phone: { in: ['0900000001', '84900000001', '+84900000001'] }, deleted_at: null, id: { not: 1 }, assigned_to: 8 },
    });
  });
});
