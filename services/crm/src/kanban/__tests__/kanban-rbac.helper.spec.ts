import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import {
  buildKanbanBoardVisibilityWhere,
  buildKanbanCardScopeWhere,
  canAccessKanbanCard,
  isBoardVisibleToUser,
  KanbanAccessContext,
  loadKanbanAccessContext,
  loadScopedCardOrNotFound,
  loadVisibleBoardOrNotFound,
} from '../common/kanban-rbac.helper';

function mkUser(grants: Grants, userId = 1): AuthUser {
  return { userId, email: 'x@test.com', isAdmin: false, grants };
}

describe('kanban-rbac.helper — quyền + phạm vi', () => {
  describe('buildKanbanCardScopeWhere / canAccessKanbanCard', () => {
    it('scope all: không lọc gì (thấy tất cả)', () => {
      const access: KanbanAccessContext = { owner: 'all', roleIds: [] };
      expect(buildKanbanCardScopeWhere(access)).toEqual({});
      expect(canAccessKanbanCard(access, { created_by: 999, assignee_id: null })).toBe(true);
    });

    it('scope own: chỉ card mình TẠO hoặc ĐƯỢC GIAO (primary HOẶC multi-assignee)', () => {
      const access: KanbanAccessContext = { owner: [10], roleIds: [] };
      expect(buildKanbanCardScopeWhere(access)).toEqual({
        OR: [
          { created_by: { in: [10] } },
          { assignee_id: { in: [10] } },
          { assignees: { some: { user_id: { in: [10] } } } },
        ],
      });
      expect(canAccessKanbanCard(access, { created_by: 10, assignee_id: null })).toBe(true);
      expect(canAccessKanbanCard(access, { created_by: 999, assignee_id: 10 })).toBe(true);
      expect(canAccessKanbanCard(access, { created_by: 999, assignee_id: 888 })).toBe(false);
    });

    it('multi-assignee: người phụ trách BỔ SUNG (không phải primary, không phải người tạo) — vẫn thấy card', () => {
      const access: KanbanAccessContext = { owner: [10], roleIds: [] };
      expect(
        canAccessKanbanCard(access, { created_by: 999, assignee_id: 888, assignees: [{ user_id: 10 }] }),
      ).toBe(true);
      expect(
        canAccessKanbanCard(access, { created_by: 999, assignee_id: 888, assignees: [{ user_id: 777 }] }),
      ).toBe(false);
    });

    it('scope team/subtree: owner là danh sách nhiều id (self + cấp dưới)', () => {
      const access: KanbanAccessContext = { owner: [5, 11, 12], roleIds: [] };
      expect(buildKanbanCardScopeWhere(access)).toEqual({
        OR: [
          { created_by: { in: [5, 11, 12] } },
          { assignee_id: { in: [5, 11, 12] } },
          { assignees: { some: { user_id: { in: [5, 11, 12] } } } },
        ],
      });
      expect(canAccessKanbanCard(access, { created_by: 11, assignee_id: null })).toBe(true);
      expect(canAccessKanbanCard(access, { created_by: 999, assignee_id: 12 })).toBe(true);
      expect(canAccessKanbanCard(access, { created_by: 999, assignee_id: 888 })).toBe(false);
    });

    it('owner rỗng (subtree rỗng) => KHÔNG rò card ngoài phạm vi', () => {
      const access: KanbanAccessContext = { owner: [], roleIds: [] };
      expect(canAccessKanbanCard(access, { created_by: 6, assignee_id: null })).toBe(false);
    });
  });

  describe('buildKanbanBoardVisibilityWhere / isBoardVisibleToUser', () => {
    const activeBoard = (visibility_role_ids: number[]) => ({
      is_active: true,
      deleted_at: null,
      visibility_role_ids,
    });

    it('rỗng visibility_role_ids = mọi vai trò thấy', () => {
      const access = { roleIds: [7] };
      expect(isBoardVisibleToUser(mkUser({}), access, activeBoard([]))).toBe(true);
    });

    it('vai trò KHÔNG trong visibility_role_ids => không thấy', () => {
      expect(isBoardVisibleToUser(mkUser({}), { roleIds: [7] }, activeBoard([9]))).toBe(false);
    });

    it('vai trò TRONG visibility_role_ids => thấy', () => {
      expect(isBoardVisibleToUser(mkUser({}), { roleIds: [7] }, activeBoard([7, 9]))).toBe(true);
    });

    it('người giữ kanban.boards luôn thấy — kể cả board tắt / ngoài visibility_role_ids', () => {
      const user = mkUser({ 'kanban.boards': true });
      expect(
        isBoardVisibleToUser(user, { roleIds: [] }, { is_active: false, deleted_at: null, visibility_role_ids: [9] }),
      ).toBe(true);
    });

    it('board tắt (is_active=false) => người thường không thấy', () => {
      expect(
        isBoardVisibleToUser(mkUser({}), { roleIds: [7] }, { is_active: false, deleted_at: null, visibility_role_ids: [] }),
      ).toBe(false);
    });

    it('board đã xoá mềm => KHÔNG ai thấy, kể cả người giữ kanban.boards', () => {
      const user = mkUser({ 'kanban.boards': true });
      expect(
        isBoardVisibleToUser(user, { roleIds: [] }, { is_active: true, deleted_at: new Date(), visibility_role_ids: [] }),
      ).toBe(false);
    });

    it('buildKanbanBoardVisibilityWhere: người giữ kanban.boards => chỉ lọc deleted_at', () => {
      expect(buildKanbanBoardVisibilityWhere(mkUser({ 'kanban.boards': true }), { roleIds: [] })).toEqual({
        deleted_at: null,
      });
    });

    it('buildKanbanBoardVisibilityWhere: người thường => lọc is_active + OR visibility', () => {
      expect(buildKanbanBoardVisibilityWhere(mkUser({}), { roleIds: [7] })).toEqual({
        deleted_at: null,
        is_active: true,
        OR: [{ visibility_role_ids: { isEmpty: true } }, { visibility_role_ids: { hasSome: [7] } }],
      });
    });
  });

  describe('loadKanbanAccessContext', () => {
    it('preload owner (kanban.view) + roleIds 1 lần/request', async () => {
      const prisma = {
        userRole: { findMany: jest.fn().mockResolvedValue([{ role_id: 3 }, { role_id: 4 }]) },
      } as unknown as PrismaService;
      const scope = { ownerIds: jest.fn().mockResolvedValue([1, 2]) } as unknown as {
        ownerIds: jest.Mock;
      };
      const ctx = await loadKanbanAccessContext(prisma, scope as never, mkUser({ 'kanban.view': 'team' }));
      expect(ctx).toEqual({ owner: [1, 2], roleIds: [3, 4] });
      expect(scope.ownerIds).toHaveBeenCalledWith(mkUser({ 'kanban.view': 'team' }), 'kanban.view');
    });

    it('ownerIds trả null (không có quyền — không xảy ra trên đường bình thường) => coalesce về rỗng, fail-closed', async () => {
      const prisma = { userRole: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
      const scope = { ownerIds: jest.fn().mockResolvedValue(null) } as unknown as { ownerIds: jest.Mock };
      const ctx = await loadKanbanAccessContext(prisma, scope as never, mkUser({}));
      expect(ctx.owner).toEqual([]);
    });
  });

  describe('loadVisibleBoardOrNotFound — 404 (KHÔNG 403) ngoài phạm vi', () => {
    it('board không tồn tại => 404', async () => {
      const prisma = {
        kanbanBoard: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService;
      await expect(
        loadVisibleBoardOrNotFound(prisma, mkUser({}), { roleIds: [] }, 999),
      ).rejects.toThrow(NotFoundException);
    });

    it('board tồn tại nhưng vai trò không nằm trong visibility_role_ids => 404', async () => {
      const prisma = {
        kanbanBoard: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            is_active: true,
            deleted_at: null,
            visibility_role_ids: [9],
          }),
        },
      } as unknown as PrismaService;
      await expect(
        loadVisibleBoardOrNotFound(prisma, mkUser({}), { roleIds: [7] }, 1),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('loadScopedCardOrNotFound — endpoint con mirror gate card cha', () => {
    function mockPrismaWithCard(card: unknown) {
      return { kanbanCard: { findFirst: jest.fn().mockResolvedValue(card) } } as unknown as PrismaService;
    }
    const emptyAccess: KanbanAccessContext = { owner: [1], roleIds: [] };

    it('card không tồn tại (hoặc đã xoá mềm) => 404', async () => {
      const prisma = mockPrismaWithCard(null);
      await expect(loadScopedCardOrNotFound(prisma, mkUser({}), emptyAccess, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('card thuộc board KHÔNG hiển thị với vai trò => 404', async () => {
      const prisma = mockPrismaWithCard({
        id: 1,
        created_by: 1,
        assignee_id: null,
        board: { is_active: true, deleted_at: null, visibility_role_ids: [9] },
      });
      await expect(loadScopedCardOrNotFound(prisma, mkUser({}), emptyAccess, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('card ngoài phạm vi RBAC của actor (board thấy nhưng không phải card của mình) => 404', async () => {
      const prisma = mockPrismaWithCard({
        id: 1,
        created_by: 999,
        assignee_id: 888,
        board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
      });
      await expect(loadScopedCardOrNotFound(prisma, mkUser({}), emptyAccess, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('card trong phạm vi => trả về card', async () => {
      const card = {
        id: 1,
        created_by: 1,
        assignee_id: null,
        board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
      };
      const prisma = mockPrismaWithCard(card);
      await expect(loadScopedCardOrNotFound(prisma, mkUser({}), emptyAccess, 1)).resolves.toBe(card);
    });
  });
});
