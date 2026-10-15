import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanBoardsService } from '../boards/kanban-boards.service';
import { KanbanAccessContext } from '../common/kanban-rbac.helper';

function mkUser(grants: Grants = {}, userId = 1): AuthUser {
  return { userId, email: 'x@test.com', isAdmin: false, grants };
}

const emptyAccess: KanbanAccessContext = { owner: [], roleIds: [7] };

/**
 * nhãn màu mở cho MỌI người thấy board (KHÔNG riêng quyền
 * `kanban.boards` như cột/field-def) — gate DUY NHẤT là `assertBoardVisible`
 * (`loadVisibleBoardOrNotFound`). Test này khoá đúng bất biến đó: board
 * KHÔNG hiển thị với actor → 404 trước khi đụng `label_defs`.
 */
describe('KanbanBoardsService — quản lý nhãn màu', () => {
  function buildPrismaMock() {
    const prisma = {
      kanbanBoard: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    return prisma;
  }

  it('board KHÔNG hiển thị với actor (ngoài visibility_role_ids) => 404, KHÔNG tạo nhãn', async () => {
    const prisma = buildPrismaMock();
    prisma.kanbanBoard.findFirst.mockResolvedValue({
      id: 1,
      is_active: true,
      deleted_at: null,
      visibility_role_ids: [9],
    });
    const service = new KanbanBoardsService(prisma as unknown as PrismaService);
    await expect(
      service.createLabel(mkUser(), emptyAccess, 1, { name: 'Gấp', color: '#eb5a46' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('board hiển thị với actor => tạo nhãn thành công (KHÔNG cần quyền kanban.boards)', async () => {
    const prisma = buildPrismaMock();
    prisma.kanbanBoard.findFirst
      // Lượt 1: `assertBoardVisible` (loadVisibleBoardOrNotFound) chỉ cần is_active/visibility_role_ids.
      .mockResolvedValueOnce({ id: 1, is_active: true, deleted_at: null, visibility_role_ids: [] })
      // Lượt 2: `loadBoardLabelDefs` bên trong `createKanbanLabel`.
      .mockResolvedValueOnce({ label_defs: [] });
    const service = new KanbanBoardsService(prisma as unknown as PrismaService);
    const result = await service.createLabel(mkUser(), emptyAccess, 1, {
      name: 'Gấp',
      color: '#eb5a46',
    });
    expect(result.labels).toEqual([expect.objectContaining({ name: 'Gấp', color: '#eb5a46' })]);
  });
});
