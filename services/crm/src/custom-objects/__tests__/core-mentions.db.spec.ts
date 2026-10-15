/**
 * Thẻ @ trong bình luận công việc — DB THẬT. Chỉ chạy khi có TEST_DATABASE_URL (DB đã `prisma migrate deploy`), vd:
 * TEST_DATABASE_URL=postgresql://user@localhost:5432/crm_test pnpm --filter @trinity/crm test core-mentions.db
 */
import { PrismaClient } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { KanbanCardActivitiesService } from '../../kanban/cards/kanban-card-activities.service';
import * as rbacHelper from '../../kanban/common/kanban-rbac.helper';
import { RecordLinksService } from '../refs/record-links.service';
import { RecordRefsService } from '../refs/record-refs.service';
import { useDbSpecLock } from '../../test-utils/db-spec-lock';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const ALL = { 'custom_records.view': 'all', 'contacts.view': 'all', 'kanban.view': 'all' } as unknown as Grants;

d('Thẻ @ trong bình luận công việc — DB thật', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let links: RecordLinksService;
  let admin: AuthUser;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    links = new RecordLinksService(prisma as never, new RecordRefsService(prisma as never, new ScopeService(prisma as never, {} as never)));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE record_links, kanban_card_activities, kanban_cards, kanban_columns, kanban_boards, activities, contacts, users RESTART IDENTITY CASCADE');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE contacts_code_seq RESTART WITH 1');
    const a = await prisma.user.create({ data: { email: 'admin@t.vn', password_hash: 'x', full_name: 'Admin' } });
    admin = { userId: a.id, email: a.email, isAdmin: true, grants: ALL };
  });

  it('bình luận công việc @KH001 → "Được nhắc tới ở" của KH001 có công việc, nhãn Bình luận', async () => {
    const kh = await prisma.contact.create({ data: { phone: '0900000001', full_name: 'Khách A' } });
    const board = await prisma.kanbanBoard.create({ data: { name: 'B', created_by: admin.userId } as never });
    const col = await prisma.kanbanColumn.create({ data: { board_id: board.id, name: 'C', position: 1 } });
    const card = await prisma.kanbanCard.create({ data: { board_id: board.id, column_id: col.id, position: 1, title: 'Gọi khách', created_by: admin.userId } });
    jest.spyOn(rbacHelper, 'loadScopedCardOrNotFound').mockResolvedValue({} as never);
    const svc = new KanbanCardActivitiesService(prisma as never, links);

    await svc.addComment(admin, {} as never, card.id, { content: `Xem @${kh.code} giúp` });
    let back = await links.backlinks(admin, { type: 'contact', id: kh.id });
    expect(back).toHaveLength(1);
    expect(back[0].source.type).toBe('task');
    expect(back[0].fields).toEqual(['Bình luận']);

    // bình luận không có @ không tạo cạnh; xoá cạnh khi nội dung không còn @ (đường syncMentions)
    await svc.addComment(admin, {} as never, card.id, { content: 'không thẻ' });
    expect(await links.backlinks(admin, { type: 'contact', id: kh.id })).toHaveLength(1);
    const act = await prisma.kanbanCardActivity.findFirstOrThrow({ where: { card_id: card.id, action: 'comment' }, orderBy: { id: 'asc' } });
    await links.syncMentions({ type: 'task', id: card.id }, `comment:${act.id}`, 'đã bỏ thẻ', admin);
    back = await links.backlinks(admin, { type: 'contact', id: kh.id });
    expect(back).toHaveLength(0);
  });
});
