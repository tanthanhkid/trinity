import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '@trinity/rbac-nest';
import { PublicWorkService } from './public-work.service';

const key = { id: 1, name: 'n8n', scopes: ['deals:create', 'tasks:create'], owner_user_id: 42 };

function setup(grants: Record<string, string>, isAdmin = false) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 42, email: 'a@x.vn', status: 'active' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 42, team_id: 3 }),
    },
    contact: { findFirst: jest.fn().mockResolvedValue(null) },
    settingOption: { findUnique: jest.fn().mockResolvedValue({ group_key: 'contact_source', is_active: true }) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    kanbanBoard: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue({ id: 1, deleted_at: null, is_active: true, visibility_role_ids: [] }), findUnique: jest.fn().mockResolvedValue({ id: 1, deleted_at: null, is_active: true, visibility_role_ids: [] }) },
    kanbanColumn: { findUnique: jest.fn().mockResolvedValue({ board_id: 1, is_archived: false }) },
    kanbanFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
  };
  const permissions = { grantsFor: jest.fn().mockResolvedValue({ grants, isAdmin }) };
  const scope = { ownerIds: jest.fn().mockResolvedValue([42]) };
  const deals = { create: jest.fn().mockResolvedValue({ id: 9, code: 'DL009' }) };
  const cards = { create: jest.fn().mockResolvedValue({ id: 3, code: 'CV003' }) };
  const contacts = { createContactInTx: jest.fn().mockResolvedValue({ id: 77 }) };
  const svc = new PublicWorkService(prisma as never, permissions as never, scope as never, deals as never, cards as never, contacts as never);
  return { svc, prisma, deals, cards, contacts, scope };
}

describe('PublicWorkService — khoá API cho Zapier/n8n', () => {
  it('tạo thương vụ dưới danh nghĩa người giữ khoá, giao cho chính người đó', async () => {
    const { svc, deals } = setup({ 'deals.manage': 'own' });
    const r = await svc.createDeal({ title: 'Đơn web #1', value: 150000 }, key);
    expect(deals.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Đơn web #1', value: 150000, assigned_to: 42, contact_id: undefined }), expect.objectContaining({ userId: 42 }));
    expect(r).toMatchObject({ deal: { id: 9 }, contact_id: null, contact_created: false });
  });

  it('người giữ khoá thiếu quyền ⇒ 403, không gọi service', async () => {
    const { svc, deals, cards } = setup({ 'contacts.view': 'own' });
    await expect(svc.createDeal({ title: 'x' }, key)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.createTask({ column_id: 1, title: 'x' }, key)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deals.create).not.toHaveBeenCalled();
    expect(cards.create).not.toHaveBeenCalled();
  });

  it('gắn khách có sẵn theo SĐT, chỉ trong phạm vi contacts.view', async () => {
    const { svc, prisma, deals, contacts } = setup({ 'deals.manage': 'own', 'contacts.view': 'own' });
    prisma.contact.findFirst.mockResolvedValue({ id: 55 });
    const r = await svc.createDeal({ title: 'x', contact_phone: '+84912345678' }, key);
    const where = prisma.contact.findFirst.mock.calls[0][0].where;
    expect(where.phone.in).toContain('0912345678');
    expect(where.OR).toEqual([{ assigned_to: { in: [42] } }, { created_by_id: { in: [42] } }]);
    expect(deals.create.mock.calls[0][0].contact_id).toBe(55);
    expect(contacts.createContactInTx).not.toHaveBeenCalled();
    expect(r.contact_created).toBe(false);
  });

  it('không thấy khách: thiếu tên ⇒ 400; có tên + quyền tạo ⇒ tạo khách mới', async () => {
    const { svc, contacts } = setup({ 'deals.manage': 'own', 'contacts.view': 'own', 'contacts.create': 'own' });
    await expect(svc.createDeal({ title: 'x', contact_phone: '0912345678' }, key)).rejects.toBeInstanceOf(BadRequestException);
    const r = await svc.createDeal({ title: 'x', contact_phone: '0912345678', contact_name: 'Anh C' }, key);
    expect(contacts.createContactInTx).toHaveBeenCalledWith({}, { phone: '0912345678', full_name: 'Anh C', source_id: null }, { id: 42, team_id: 3 }, 'public_api');
    expect(r).toMatchObject({ contact_id: 77, contact_created: true });
  });

  it('không có quyền tạo khách ⇒ không tạo khách mới', async () => {
    const { svc, contacts } = setup({ 'deals.manage': 'own', 'contacts.view': 'own' });
    await expect(svc.createDeal({ title: 'x', contact_phone: '0912345678', contact_name: 'Anh C' }, key)).rejects.toBeInstanceOf(ForbiddenException);
    expect(contacts.createContactInTx).not.toHaveBeenCalled();
  });

  it('tạo việc: thẻ Kanban giao cho người giữ khoá', async () => {
    const { svc, cards } = setup({ 'kanban.manage': 'own', 'kanban.view': 'own' });
    await svc.createTask({ column_id: 12, title: 'Gọi lại khách', due_at: '2026-10-20T09:00:00+07:00', priority: 'high' }, key);
    const [user, access, dto] = cards.create.mock.calls[0] as [AuthUser, unknown, Record<string, unknown>];
    expect(user.userId).toBe(42);
    expect(access).toMatchObject({ owner: [42], roleIds: [] });
    expect(dto).toMatchObject({ column_id: 12, title: 'Gọi lại khách', assignee_id: 42, priority: 'high', contact_id: null });
  });

  it('chủ khoá được nâng lên Quản trị sau khi cấp khoá ⇒ chặn', async () => {
    const { svc, deals } = setup({}, true);
    await expect(svc.createDeal({ title: 'x' }, key)).rejects.toBeInstanceOf(ForbiddenException);
    expect(deals.create).not.toHaveBeenCalled();
  });

  it('tạo việc: cột sai / thiếu field bắt buộc ⇒ lỗi TRƯỚC khi tạo khách mới', async () => {
    const a = setup({ 'kanban.manage': 'own', 'kanban.view': 'own', 'contacts.view': 'own', 'contacts.create': 'own' });
    a.prisma.kanbanColumn.findUnique.mockResolvedValue(null);
    await expect(a.svc.createTask({ column_id: 99, title: 'x', contact_phone: '0912345678', contact_name: 'Anh C' }, key)).rejects.toThrow('column_id');
    const b = setup({ 'kanban.manage': 'own', 'kanban.view': 'own', 'contacts.view': 'own', 'contacts.create': 'own' });
    b.prisma.kanbanFieldDef.findMany.mockResolvedValue([{ key: 'khu_vuc', label: 'Khu vực', type: 'text', options: null, required: true }]);
    await expect(b.svc.createTask({ column_id: 1, title: 'x', contact_phone: '0912345678', contact_name: 'Anh C' }, key)).rejects.toThrow();
    expect(a.contacts.createContactInTx).not.toHaveBeenCalled();
    expect(b.contacts.createContactInTx).not.toHaveBeenCalled();
    expect(b.cards.create).not.toHaveBeenCalled();
  });

  it('người giữ khoá đã nghỉ ⇒ 400', async () => {
    const { svc, prisma } = setup({ 'deals.manage': 'all' });
    prisma.user.findUnique.mockResolvedValue({ id: 42, email: 'a@x.vn', status: 'locked' });
    await expect(svc.createDeal({ title: 'x' }, key)).rejects.toBeInstanceOf(BadRequestException);
  });
});
