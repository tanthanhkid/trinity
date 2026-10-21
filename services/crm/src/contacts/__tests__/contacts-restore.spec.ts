import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { ContactsService } from '../contacts.service';

describe('ContactsService — xoá ghi người xoá; restore (Hoàn tác phía máy chủ)', () => {
  const deleted = (o: Record<string, unknown> = {}) => ({
    id: 1, phone: '0900000001', full_name: 'A', assigned_to: 5, created_by_id: 5,
    deleted_at: new Date(Date.now() - 3_000), deleted_by_id: 5, ...o,
  });
  const build = (row: unknown, dupeCount = 0) => {
    const prisma = {
      contact: {
        findUnique: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(dupeCount),
        update: jest.fn().mockResolvedValue({ id: 1, full_name: 'A', phone: '0900000001' }),
      },
      integrationEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    const audit = { writeInTx: jest.fn().mockResolvedValue(undefined) };
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
    const svc = new ContactsService(prisma as never, audit as never, {} as never, scope as never, {} as never, {} as never);
    return { svc, prisma, audit };
  };
  const owner = { userId: 5, isAdmin: false, grants: { 'contacts.delete': 'all' } } as never;
  const other = { userId: 9, isAdmin: false, grants: { 'contacts.delete': 'all' } } as never;
  const admin = { userId: 1, isAdmin: true, grants: {} } as never;

  it('remove ghi deleted_by_id = người xoá', async () => {
    const { svc, prisma } = build({ id: 1, phone: '0900000001', full_name: 'A', deleted_at: null, assigned_to: 5, created_by_id: 5 });
    await svc.remove(1, owner);
    expect(prisma.contact.update).toHaveBeenCalledWith(expect.objectContaining({ data: { deleted_at: expect.any(Date), deleted_by_id: 5 } }));
  });

  it('người đã xoá khôi phục được ⇒ bỏ deleted_at, ghi nhật ký contact.restore', async () => {
    const { svc, prisma, audit } = build(deleted());
    await expect(svc.restore(1, owner)).resolves.toMatchObject({ success: true });
    expect(prisma.contact.update).toHaveBeenCalledWith(expect.objectContaining({ data: { deleted_at: null, deleted_by_id: null } }));
    expect(audit.writeInTx).toHaveBeenCalledWith(prisma, expect.objectContaining({ action: 'contact.restore', resourceId: 1 }));
  });

  it('khách đang sống / không tồn tại ⇒ 404', async () => {
    await expect(build(deleted({ deleted_at: null })).svc.restore(1, owner)).rejects.toThrow(NotFoundException);
    await expect(build(null).svc.restore(1, owner)).rejects.toThrow(NotFoundException);
  });

  it('không phải người xoá ⇒ 403; Quản trị thì được', async () => {
    await expect(build(deleted()).svc.restore(1, other)).rejects.toThrow(ForbiddenException);
    await expect(build(deleted()).svc.restore(1, admin)).resolves.toMatchObject({ success: true });
  });

  it('bản xoá cũ (deleted_by_id NULL) chỉ Quản trị khôi phục; quá 10 phút ⇒ 410', async () => {
    await expect(build(deleted({ deleted_by_id: null })).svc.restore(1, owner)).rejects.toThrow(ForbiddenException);
    await expect(build(deleted({ deleted_at: new Date(Date.now() - 11 * 60_000) })).svc.restore(1, owner)).rejects.toThrow(GoneException);
  });

  it('SĐT đã có ở khách đang sống của cùng người phụ trách ⇒ 409, không khôi phục', async () => {
    const { svc, prisma } = build(deleted(), 1);
    await expect(svc.restore(1, owner)).rejects.toThrow(ConflictException);
    expect(prisma.contact.count).toHaveBeenCalledWith({
      where: { phone: { in: ['0900000001', '84900000001', '+84900000001'] }, deleted_at: null, assigned_to: 5 },
    });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});
