/**
 * DB THẬT: (1) đổi giai đoạn khách ghi activity `stage_change` (ContactsService.update, cùng transaction);
 * (2) MCP create_task chạy được trên bản cài mới nhờ bảng Kanban mặc định do seed dựng, và báo lỗi rõ khi chưa có bảng nào.
 * Chỉ chạy khi có TEST_DATABASE_URL (DB đã migrate), vd:
 *   TEST_DATABASE_URL=postgresql://localhost:5432/trinity_e2e_fix pnpm --filter @trinity/crm test stage-task.db
 */
import { PrismaClient } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { ContactsService } from '../../../contacts/contacts.service';
import { KanbanCardsService } from '../../../kanban/cards/kanban-cards.service';
import { createTaskAction } from '../actions/action-task-tool';
import { ActionUserError, type ActionDeps } from '../actions/action-types';
import { useDbSpecLock } from '../../../test-utils/db-spec-lock';

// require (không import) để tsc của services/crm không kéo file ngoài rootDir vào.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { seedDefaultKanbanBoard, DEFAULT_KANBAN_BOARD } = require('../../../../../../packages/prisma/prisma/seed/kanban-default.seed');

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const GRANTS = { 'contacts.view': 'all', 'contacts.update': 'all', 'kanban.view': 'all', 'kanban.manage': 'all' } as unknown as Grants;

d('Đổi giai đoạn khách + create_task — DB thật', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let scope: ScopeService;
  let user: AuthUser;
  let deps: ActionDeps;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    scope = new ScopeService(prisma as never, {} as never);
    const cards = new KanbanCardsService(prisma as never, scope);
    deps = { prisma, scope, cards } as unknown as ActionDeps;
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE kanban_boards, activities, contacts, setting_options, integration_events, users RESTART IDENTITY CASCADE');
    const u = await prisma.user.create({ data: { email: 'admin@t.vn', password_hash: 'x', full_name: 'Admin' } });
    user = { userId: u.id, email: u.email, isAdmin: true, grants: GRANTS };
  });

  describe('contact stage_change activity', () => {
    const contacts = (): ContactsService => new ContactsService(prisma as never, {} as never, {} as never, scope, {} as never, {} as never);
    const setup = async () => {
      const [a, b] = await Promise.all(['moi', 'dang_tu_van'].map((value, i) =>
        prisma.settingOption.create({ data: { group_key: 'contact_stage', value, label: i ? 'Đang tư vấn' : 'Mới', sort_order: i } })));
      const c = await prisma.contact.create({ data: { phone: '0900000001', full_name: 'Khách A', stage_id: a.id, assigned_to: user.userId, created_by_id: user.userId } });
      return { a, b, c };
    };

    it('đổi giai đoạn ⇒ đúng một activity stage_change "Mới → Đang tư vấn"', async () => {
      const { a, b, c } = await setup();
      await contacts().update(c.id, { stage_id: b.id } as never, user);
      const acts = await prisma.activity.findMany({ where: { contact_id: c.id, action: 'stage_change' } });
      expect(acts).toHaveLength(1);
      expect(acts[0].created_by).toBe(user.userId);
      expect(acts[0].details).toMatchObject({ from_stage_id: a.id, to_stage_id: b.id, from_label: 'Mới', to_label: 'Đang tư vấn', description: 'Đổi giai đoạn: Mới → Đang tư vấn' });
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).stage_id).toBe(b.id);
    });

    it('giai đoạn không đổi (gửi lại cùng giá trị, hoặc sửa trường khác) ⇒ không thêm activity', async () => {
      const { a, c } = await setup();
      await contacts().update(c.id, { stage_id: a.id } as never, user);
      await contacts().update(c.id, { company_name: 'Công ty X' } as never, user);
      expect(await prisma.activity.count({ where: { contact_id: c.id, action: 'stage_change' } })).toBe(0);
    });
  });

  describe('create_task + bảng Kanban mặc định', () => {
    it('chưa có bảng nào ⇒ ActionUserError với câu hướng dẫn rõ', async () => {
      await expect(createTaskAction.prepare({ title: 'Gọi lại khách' }, { deps, user })).rejects.toBeInstanceOf(ActionUserError);
    });

    it('seed dựng bảng mặc định (idempotent) ⇒ create_task tạo thẻ vào cột đầu "Cần làm"', async () => {
      expect(await seedDefaultKanbanBoard(prisma, user.userId)).toBe(true);
      expect(await seedDefaultKanbanBoard(prisma, user.userId)).toBe(false);
      expect(await prisma.kanbanBoard.count()).toBe(1);
      const cols = await prisma.kanbanColumn.findMany({ orderBy: { position: 'asc' } });
      expect(cols.map((c) => c.name)).toEqual(DEFAULT_KANBAN_BOARD.columns.map((c: { name: string }) => c.name));

      const prepared = await createTaskAction.prepare({ title: 'Gọi lại khách', priority: 'high' }, { deps, user });
      expect(prepared.params.column_id).toBe(cols[0].id);
      const out = await createTaskAction.execute(prepared.params, { deps, user }, 1);
      const card = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: out.card_id as number } });
      expect(card).toMatchObject({ title: 'Gọi lại khách', column_id: cols[0].id, assignee_id: user.userId });
    });

    it('bảng đã bị xoá mềm hết thì seed KHÔNG dựng lại sau lưng quản trị', async () => {
      await seedDefaultKanbanBoard(prisma, user.userId);
      await prisma.kanbanBoard.updateMany({ data: { deleted_at: new Date() } });
      expect(await seedDefaultKanbanBoard(prisma, user.userId)).toBe(false);
      await expect(createTaskAction.prepare({ title: 'x' }, { deps, user })).rejects.toBeInstanceOf(ActionUserError);
    });
  });
});
