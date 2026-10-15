import { BadRequestException } from '@nestjs/common';
import { ContactsService } from '../contacts.service';

describe('ContactsService.update — Nguồn: người thường chỉ điền khi trống, Quản trị đổi được để sửa sai', () => {
  const build = (existing: Record<string, unknown>) => {
    const prisma = {
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 1, assigned_to: 5, created_by_id: 5, team_id: null, full_name: 'A', phone: '', stage_id: null, ...existing }), update: jest.fn().mockRejectedValue(new Error('stop')) },
      settingOption: { findUnique: jest.fn().mockResolvedValue({ id: 9, group_key: 'contact_source', is_active: true, value: 'facebook' }) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const scope = { ownerIds: jest.fn().mockResolvedValue('all') };
    const svc = new ContactsService(prisma as never, {} as never, {} as never, scope as never, {} as never, {} as never);
    const written = () => prisma.contact.update.mock.calls[0][0].data;
    return { svc, written };
  };
  const admin = { userId: 1, isAdmin: true, grants: {} } as never;
  const sale = { userId: 5, isAdmin: false, grants: {} } as never;

  it('Quản trị đổi nguồn đã có', async () => {
    const { svc, written } = build({ source_id: 1, source_locked: false });
    await expect(svc.update(1, { source_id: 9 } as never, admin)).rejects.toThrow('stop');
    expect(written().source).toEqual({ connect: { id: 9 } });
  });

  it('Quản trị đổi cả nguồn đã khoá', async () => {
    const { svc, written } = build({ source_id: 1, source_locked: true });
    await expect(svc.update(1, { source_id: 9 } as never, admin)).rejects.toThrow('stop');
    expect(written().source).toEqual({ connect: { id: 9 } });
  });

  it('người thường: nguồn đã có ⇒ bỏ qua; nguồn đã khoá ⇒ 400', async () => {
    const a = build({ source_id: 1, source_locked: false });
    await expect(a.svc.update(1, { source_id: 9 } as never, sale)).rejects.toThrow('stop');
    expect(a.written().source).toBeUndefined();
    const b = build({ source_id: 1, source_locked: true });
    await expect(b.svc.update(1, { source_id: 9 } as never, sale)).rejects.toThrow(BadRequestException);
  });

  it('người thường điền được nguồn khi đang trống', async () => {
    const { svc, written } = build({ source_id: null, source_locked: false });
    await expect(svc.update(1, { source_id: 9 } as never, sale)).rejects.toThrow('stop');
    expect(written().source).toEqual({ connect: { id: 9 } });
  });
});
