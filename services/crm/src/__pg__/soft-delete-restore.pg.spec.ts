import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { describePg, pgClient, resetTables } from './pg-harness';
import { ContactsService } from '../contacts/contacts.service';
import { KanbanCardsService } from '../kanban/cards/kanban-cards.service';
import { EmployeesService } from '../employees/employees.service';

/**
 * Hoàn tác xoá phía máy chủ (#58) + mở khoá nhân viên (#63) trên Postgres THẬT: cột mới của migration 0016,
 * ghi / xoá `deleted_by`, cửa sổ 10 phút, trùng SĐT, nhật ký lịch sử card — những thứ mock không kiểm được.
 */
const TABLES = [
  'audit_logs', 'integration_events', 'kanban_card_activities', 'kanban_card_assignees', 'kanban_cards',
  'kanban_columns', 'kanban_boards', 'contacts', 'employees', 'users',
];

const admin = (userId: number): AuthUser => ({ userId, email: `a${userId}@t`, isAdmin: true, grants: { 'contacts.delete': 'all', 'kanban.boards': true } } as never);
const member = (userId: number): AuthUser => ({ userId, email: `m${userId}@t`, isAdmin: false, grants: { 'contacts.delete': 'all' } } as never);
const scopeAll = { ownerIds: async () => 'all' as const };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function user(db: PrismaService, id: number, status = 'active') {
  return db.user.create({ data: { id, email: `u${id}@example.com`, password_hash: 'x', full_name: `Người ${id}`, status } });
}

describePg('Khôi phục khách hàng vừa xoá (Postgres thật)', () => {
  let db: PrismaService;
  let svc: ContactsService;
  beforeAll(() => {
    db = pgClient();
    const audit = { writeInTx: async () => undefined, write: async () => undefined };
    svc = new ContactsService(db, audit as never, {} as never, scopeAll as never, {} as never, {} as never);
  });
  beforeEach(async () => {
    await resetTables(db, TABLES);
    await user(db, 5);
    await user(db, 9);
  });
  afterAll(() => db.$disconnect());

  const contact = (o: Record<string, unknown> = {}) =>
    db.contact.create({ data: { phone: '0900000001', full_name: 'Khách A', assigned_to: 5, created_by_id: 5, ...o } });

  it('xoá ghi deleted_by_id; khôi phục ⇒ bỏ deleted_at + deleted_by_id, phát sự kiện contact.restored', async () => {
    const c = await contact();
    await svc.remove(c.id, member(5));
    const deleted = await db.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(deleted.deleted_at).not.toBeNull();
    expect(deleted.deleted_by_id).toBe(5);

    await expect(svc.restore(c.id, member(5))).resolves.toMatchObject({ success: true });
    const back = await db.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(back.deleted_at).toBeNull();
    expect(back.deleted_by_id).toBeNull();
    expect(await db.integrationEvent.count({ where: { event_type: 'contact.restored' } })).toBe(1);
  });

  it('người khác ⇒ 403; Quản trị được; quá 10 phút ⇒ 410; khách đang sống ⇒ 404', async () => {
    const c = await contact({ deleted_at: minutesAgo(1), deleted_by_id: 5 });
    await expect(svc.restore(c.id, member(9))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.restore(c.id, admin(9))).resolves.toMatchObject({ success: true });
    await expect(svc.restore(c.id, admin(9))).rejects.toBeInstanceOf(NotFoundException);

    const old = await contact({ phone: '0900000002', deleted_at: minutesAgo(11), deleted_by_id: 5 });
    await expect(svc.restore(old.id, member(5))).rejects.toBeInstanceOf(GoneException);
  });

  it('SĐT đã có ở khách đang sống của cùng người phụ trách (khác dạng 84…) ⇒ 409, không khôi phục', async () => {
    const c = await contact({ deleted_at: minutesAgo(1), deleted_by_id: 5 });
    await contact({ phone: '84900000001' }); // cùng số, dạng quốc tế, đang sống
    await expect(svc.restore(c.id, member(5))).rejects.toBeInstanceOf(ConflictException);
    expect((await db.contact.findUniqueOrThrow({ where: { id: c.id } })).deleted_at).not.toBeNull();
  });
});

describePg('Khôi phục card Kanban vừa xoá (Postgres thật)', () => {
  let db: PrismaService;
  let svc: KanbanCardsService;
  const access = { owner: 'all' as const, roleIds: [] };
  let cardId: number;
  beforeAll(() => {
    db = pgClient();
    svc = new KanbanCardsService(db, scopeAll as never);
  });
  beforeEach(async () => {
    await resetTables(db, TABLES);
    await user(db, 5);
    await user(db, 9);
    const board = await db.kanbanBoard.create({ data: { name: 'Bán hàng', created_by: 5 } });
    const col = await db.kanbanColumn.create({ data: { board_id: board.id, name: 'Cần làm', position: 1 } });
    cardId = (await db.kanbanCard.create({ data: { board_id: board.id, column_id: col.id, position: 1, title: 'Gọi lại', created_by: 5 } })).id;
  });
  afterAll(() => db.$disconnect());

  it('xoá ghi deleted_by; khôi phục bỏ cả hai + ghi lịch sử "restored"', async () => {
    await svc.remove(member(5), access, cardId);
    expect((await db.kanbanCard.findUniqueOrThrow({ where: { id: cardId } })).deleted_by).toBe(5);
    await expect(svc.restore(member(5), access, cardId)).resolves.toEqual({ restored: true });
    const back = await db.kanbanCard.findUniqueOrThrow({ where: { id: cardId } });
    expect(back.deleted_at).toBeNull();
    expect(back.deleted_by).toBeNull();
    expect(await db.kanbanCardActivity.count({ where: { card_id: cardId, action: 'restored' } })).toBe(1);
  });

  it('người khác ⇒ 403; quá 10 phút ⇒ 410; card đang sống ⇒ 404', async () => {
    await db.kanbanCard.update({ where: { id: cardId }, data: { deleted_at: minutesAgo(1), deleted_by: 5 } });
    await expect(svc.restore(member(9), access, cardId)).rejects.toBeInstanceOf(ForbiddenException);
    await db.kanbanCard.update({ where: { id: cardId }, data: { deleted_at: minutesAgo(11) } });
    await expect(svc.restore(member(5), access, cardId)).rejects.toBeInstanceOf(GoneException);
    await db.kanbanCard.update({ where: { id: cardId }, data: { deleted_at: null, deleted_by: null } });
    await expect(svc.restore(member(5), access, cardId)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describePg('Mở khoá tài khoản nhân viên (Postgres thật)', () => {
  let db: PrismaService;
  let svc: EmployeesService;
  beforeAll(() => {
    db = pgClient();
    const audit = { write: async () => undefined };
    const rbacCache = { invalidateUsers: async () => undefined };
    svc = new EmployeesService(db, audit as never, scopeAll as never, {} as never, rbacCache as never);
  });
  beforeEach(() => resetTables(db, TABLES));
  afterAll(() => db.$disconnect());

  it('Quản trị mở khoá ⇒ users.status=active, employees.status=active, resigned_at=NULL; tokens_valid_after giữ nguyên', async () => {
    const lockedAt = minutesAgo(30);
    await user(db, 1);
    await db.user.create({ data: { id: 10, email: 'nv10@example.com', password_hash: 'x', full_name: 'NV 10', status: 'locked', tokens_valid_after: lockedAt } });
    const emp = await db.employee.create({ data: { user_id: 10, position: 'sales', status: 'resigned', resigned_at: lockedAt } });

    await expect(svc.unlock(emp.id, admin(1))).resolves.toMatchObject({ ok: true });
    const u = await db.user.findUniqueOrThrow({ where: { id: 10 } });
    const e = await db.employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(u.status).toBe('active');
    expect(u.tokens_valid_after?.getTime()).toBe(lockedAt.getTime());
    expect(e.status).toBe('active');
    expect(e.resigned_at).toBeNull();

    // Mở khoá lần nữa ⇒ 409; không phải Quản trị ⇒ 403; hồ sơ đã xoá ⇒ 404.
    await expect(svc.unlock(emp.id, admin(1))).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.unlock(emp.id, member(1))).rejects.toBeInstanceOf(ForbiddenException);
    await db.employee.update({ where: { id: emp.id }, data: { deleted_at: new Date() } });
    await expect(svc.unlock(emp.id, admin(1))).rejects.toBeInstanceOf(NotFoundException);
  });
});
