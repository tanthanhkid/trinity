import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanChecklistService } from '../checklist/kanban-checklist.service';
import { KanbanAccessContext } from '../common/kanban-rbac.helper';
import { KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD } from '../common/kanban.constants';

function mkUser(grants: Grants = {}, userId = 1, isAdmin = false): AuthUser {
  return { userId, email: 'x@test.com', isAdmin, grants };
}

function ownAccess(userId = 1): KanbanAccessContext {
  return { owner: [userId], roleIds: [] };
}

function scopedCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    created_by: 1,
    assignee_id: null,
    assignees: [],
    board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
    column: {},
    ...overrides,
  };
}

function buildPrismaMock() {
  const prisma = {
    kanbanCard: { findFirst: jest.fn() },
    kanbanChecklistItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    kanbanCardActivity: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

describe('KanbanChecklistService', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let service: KanbanChecklistService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new KanbanChecklistService(prisma as unknown as PrismaService);
  });

  describe('list/create — gọi lại gate card cha', () => {
    it('card ngoài phạm vi RBAC => 404, KHÔNG đọc/ghi checklist', async () => {
      prisma.kanbanCard.findFirst.mockResolvedValue(
        scopedCard({ created_by: 999, assignee_id: 888 }),
      );
      await expect(service.list(mkUser(), ownAccess(1), 1)).rejects.toThrow(NotFoundException);
      expect(prisma.kanbanChecklistItem.findMany).not.toHaveBeenCalled();
    });

    it('đạt trần KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD => 400', async () => {
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard());
      prisma.kanbanChecklistItem.count.mockResolvedValue(KANBAN_CHECKLIST_ITEMS_MAX_PER_CARD);
      await expect(
        service.create(mkUser(), ownAccess(1), 1, { text: 'x' } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('tạo thành công => ghi activity checklist_item_added', async () => {
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard());
      prisma.kanbanChecklistItem.create.mockResolvedValue({ id: 5, card_id: 1, text: 'Gọi khách' });
      await service.create(mkUser(), ownAccess(1), 1, { text: 'Gọi khách' } as never);
      expect(prisma.kanbanCardActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'checklist_item_added' }) }),
      );
    });
  });

  describe('update — toggle is_done', () => {
    it('item không tồn tại => 404', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue(null);
      await expect(
        service.update(mkUser(), ownAccess(1), 999, { is_done: true } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('item thuộc card ngoài phạm vi RBAC => 404', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue({ id: 5, card_id: 1, is_done: false, text: 'x' });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 999, assignee_id: 888 }));
      await expect(
        service.update(mkUser(), ownAccess(1), 5, { is_done: true } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('đổi is_done => ghi activity checklist_item_toggled ĐÚNG 1 lần', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue({ id: 5, card_id: 1, is_done: false, text: 'x' });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard());
      prisma.kanbanChecklistItem.update.mockResolvedValue({ id: 5, card_id: 1, is_done: true, text: 'x' });
      await service.update(mkUser(), ownAccess(1), 5, { is_done: true } as never);
      const actions = prisma.kanbanCardActivity.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { data: { action: string } }).data.action,
      );
      expect(actions).toEqual(['checklist_item_toggled']);
    });

    it('is_done gửi TRÙNG giá trị hiện tại => KHÔNG ghi activity thừa', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue({ id: 5, card_id: 1, is_done: true, text: 'x' });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard());
      prisma.kanbanChecklistItem.update.mockResolvedValue({ id: 5, card_id: 1, is_done: true, text: 'x' });
      await service.update(mkUser(), ownAccess(1), 5, { is_done: true } as never);
      expect(prisma.kanbanCardActivity.create).not.toHaveBeenCalled();
    });
  });

  describe('remove — người tạo item, chủ card, hoặc Quản trị', () => {
    it('người KHÁC (không tạo item, không chủ card, không Quản trị) => 400', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue({
        id: 5,
        card_id: 1,
        created_by: 2,
        text: 'x',
      });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 3, assignee_id: 1 }));
      await expect(service.remove(mkUser(), ownAccess(1), 5)).rejects.toThrow(BadRequestException);
    });

    it('chủ CARD xoá được item của người khác tạo', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue({
        id: 5,
        card_id: 1,
        created_by: 2,
        text: 'x',
      });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 1, assignee_id: null }));
      await expect(service.remove(mkUser(), ownAccess(1), 5)).resolves.toEqual({ deleted: true });
    });

    it('Quản trị xoá được bất kỳ item nào', async () => {
      prisma.kanbanChecklistItem.findUnique.mockResolvedValue({
        id: 5,
        card_id: 1,
        created_by: 2,
        text: 'x',
      });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 3, assignee_id: null }));
      const admin = mkUser({ 'kanban.boards': true }, 9, true);
      await expect(
        service.remove(admin, { owner: 'all', roleIds: [] }, 5),
      ).resolves.toEqual({ deleted: true });
    });
  });
});
