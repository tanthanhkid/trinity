import type { AuthUser } from '@trinity/rbac-nest';
import { createTaskAction } from '../action-task-tool';
import { ActionUserError, type ActionDeps } from '../action-types';
import { KANBAN_POSITION_GAP } from '../../../../kanban/common/kanban.constants';

const SALE = { userId: 11, email: 'u11@x.vn', isAdmin: false, grants: { 'kanban.view': 'own', 'kanban.manage': 'own' } } as unknown as AuthUser;

describe('create_task khi chưa có bảng công việc', () => {
  it('báo lỗi kiểu người dùng (ActionUserError, không phải 404) với câu hướng dẫn rõ', async () => {
    const rbac = await import('../../../../kanban/common/kanban-rbac.helper');
    jest.spyOn(rbac, 'loadKanbanAccessContext').mockResolvedValue({} as never);
    const deps = {
      prisma: { kanbanBoard: { findMany: jest.fn().mockResolvedValue([]) }, kanbanColumn: { findFirst: jest.fn() } },
      scope: {},
    } as unknown as ActionDeps;
    const p = createTaskAction.prepare({ title: 'Gọi lại khách' }, { deps, user: SALE });
    await expect(p).rejects.toBeInstanceOf(ActionUserError);
    await expect(createTaskAction.prepare({ title: 'Gọi lại khách' }, { deps, user: SALE })).rejects.toThrow(/chưa có bảng công việc/);
  });
});

describe('seed bảng công việc mặc định (packages/prisma)', () => {
  // require (không import) để tsc của services/crm không kéo file ngoài rootDir vào.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { seedDefaultKanbanBoard, DEFAULT_KANBAN_BOARD } = require('../../../../../../../packages/prisma/prisma/seed/kanban-default.seed');

  it('chưa từng có bảng ⇒ tạo "Việc của tôi" với cột mở + cột Xong (is_done), mọi vai trò thấy', async () => {
    const prisma = { kanbanBoard: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 1 }) } };
    expect(await seedDefaultKanbanBoard(prisma, 1)).toBe(true);
    const data = prisma.kanbanBoard.create.mock.calls[0][0].data;
    expect(data.name).toBe(DEFAULT_KANBAN_BOARD.name);
    expect(data.visibility_role_ids).toBeUndefined(); // mặc định {} = mọi vai trò
    const cols = data.columns.create as { name: string; is_done: boolean; position: number }[];
    expect(cols.filter((c) => !c.is_done).length).toBeGreaterThan(0);
    expect(cols[cols.length - 1].is_done).toBe(true);
    expect(cols.map((c) => c.position)).toEqual(cols.map((_, i) => (i + 1) * KANBAN_POSITION_GAP));
  });

  it('đã có bảng (kể cả đã xoá mềm) ⇒ không tạo thêm (idempotent)', async () => {
    const prisma = { kanbanBoard: { count: jest.fn().mockResolvedValue(1), create: jest.fn() } };
    expect(await seedDefaultKanbanBoard(prisma, 1)).toBe(false);
    expect(prisma.kanbanBoard.count).toHaveBeenCalledWith();
    expect(prisma.kanbanBoard.create).not.toHaveBeenCalled();
  });
});
