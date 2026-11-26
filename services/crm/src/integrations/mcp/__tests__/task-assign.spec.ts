import type { AuthUser } from '@trinity/rbac-nest';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError, type ActionDeps } from '../actions/action-types';

const me: AuthUser = { userId: 11, email: 'sale@x.vn', isAdmin: false, grants: { 'kanban.manage': 'team', 'kanban.view': 'team', 'deals.view': 'all' } as never };
const createTask = actionToolByName('create_task')!;

function taskDeps(scope: number[] | 'all' = [11, 12, 13]) {
  const people = [
    { id: 12, full_name: 'Nguyễn Văn Nam', email: 'nam@x.vn' },
    { id: 13, full_name: 'Trần Thị Nam Phương', email: 'phuong@x.vn' },
    { id: 20, full_name: 'Lê Nam Ngoài', email: 'ngoai@x.vn' },
  ];
  const inScope = (id: number) => scope === 'all' || scope.includes(id);
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ full_name: 'Sale Một' })),
      findFirst: jest.fn(async ({ where }: any) => people.find((p) => p.email === String(where.email.equals).toLowerCase() && inScope(p.id)) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        people.filter((p) => (where.full_name.equals ? p.full_name.toLowerCase() === String(where.full_name.equals).toLowerCase() : p.full_name.toLowerCase().includes(String(where.full_name.contains).toLowerCase())) && (!where.id || where.id.in.includes(p.id))),
      ),
    },
    kanbanColumn: { findUnique: jest.fn(async () => ({ name: 'Cần làm', board_id: 1, is_archived: false })) },
    kanbanBoard: { findMany: jest.fn(async () => []) },
  };
  const cards = { create: jest.fn(async (_u: unknown, _a: unknown, dto: any) => ({ id: 9, title: dto.title })) };
  return { prisma, scope: { ownerIds: jest.fn(async () => scope) }, cards } as unknown as ActionDeps & { cards: typeof cards };
}

beforeEach(async () => {
  const rbac = await import('../../../kanban/common/kanban-rbac.helper');
  jest.spyOn(rbac, 'loadKanbanAccessContext').mockResolvedValue({ owner: [11], roleIds: [] } as never);
  jest.spyOn(rbac, 'loadVisibleBoardOrNotFound').mockResolvedValue({ id: 1, name: 'Việc' } as never);
});
afterEach(() => jest.restoreAllMocks());

describe('create_task — giao việc cho người khác trong phạm vi quyền', () => {
  it('bỏ trống assignee ⇒ giao cho chính người dùng', async () => {
    const d = taskDeps();
    const r = await createTask.prepare({ title: 'Gọi khách', column_id: 6 }, { deps: d, user: me });
    expect(r.params).toMatchObject({ assignee_id: 11 });
    expect(r.summary).toMatch(/giao cho bạn/);
  });

  it('email đúng người trong phạm vi ⇒ giao cho người đó; tên khớp một người ⇒ cũng được', async () => {
    const d = taskDeps();
    expect((await createTask.prepare({ title: 'T', column_id: 6, assignee: 'NAM@x.vn' }, { deps: d, user: me })).params).toMatchObject({ assignee_id: 12 });
    const r = await createTask.prepare({ title: 'T', column_id: 6, assignee: 'Nguyễn Văn Nam' }, { deps: d, user: me });
    expect(r.params).toMatchObject({ assignee_id: 12 });
    expect(r.summary).toMatch(/giao cho Nguyễn Văn Nam/);
  });

  it('nhiều người trùng tên ⇒ hỏi lại; ngoài phạm vi ⇒ không tìm thấy', async () => {
    const d = taskDeps();
    await expect(createTask.prepare({ title: 'T', column_id: 6, assignee: 'Nam' }, { deps: d, user: me })).rejects.toThrow(/Có nhiều người khớp/);
    await expect(createTask.prepare({ title: 'T', column_id: 6, assignee: 'ngoai@x.vn' }, { deps: d, user: me })).rejects.toBeInstanceOf(ActionUserError);
    await expect(createTask.prepare({ title: 'T', column_id: 6, assignee: 'Lê Nam Ngoài' }, { deps: d, user: me })).rejects.toThrow(/Không tìm thấy/);
  });

  it('lúc chạy kiểm lại phạm vi: người đã ra ngoài phạm vi ⇒ từ chối; trong phạm vi ⇒ thẻ giao đúng người', async () => {
    const d = taskDeps();
    await createTask.execute({ title: 'T', column_id: 6, assignee_id: 12 }, { deps: d, user: me }, 1);
    expect(d.cards.create.mock.calls[0][2]).toMatchObject({ assignee_ids: [12] });
    const narrowed = taskDeps([11]);
    await expect(createTask.execute({ title: 'T', column_id: 6, assignee_id: 12 }, { deps: narrowed, user: me }, 1)).rejects.toThrow(/không còn trong phạm vi/);
  });
});
