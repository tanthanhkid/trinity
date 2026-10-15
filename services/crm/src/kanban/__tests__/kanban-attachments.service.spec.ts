import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanAttachmentsService } from '../attachments/kanban-attachments.service';
import { KanbanAccessContext } from '../common/kanban-rbac.helper';
import { KANBAN_ATTACHMENTS_MAX_PER_CARD } from '../common/kanban.constants';

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
    kanbanCardAttachment: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    kanbanCardActivity: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

describe('KanbanAttachmentsService', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let service: KanbanAttachmentsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new KanbanAttachmentsService(prisma as unknown as PrismaService);
  });

  it('card ngoài phạm vi RBAC => 404, KHÔNG đọc/ghi đính kèm', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 999, assignee_id: 888 }));
    await expect(service.list(mkUser(), ownAccess(1), 1)).rejects.toThrow(NotFoundException);
    expect(prisma.kanbanCardAttachment.findMany).not.toHaveBeenCalled();
  });

  it('đạt trần KANBAN_ATTACHMENTS_MAX_PER_CARD => 400', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard());
    prisma.kanbanCardAttachment.count.mockResolvedValue(KANBAN_ATTACHMENTS_MAX_PER_CARD);
    await expect(
      service.create(mkUser(), ownAccess(1), 1, { url: 'https://x.com' } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('tạo thành công => ghi activity attachment_added', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard());
    prisma.kanbanCardAttachment.create.mockResolvedValue({
      id: 9,
      card_id: 1,
      url: 'https://x.com',
      title: null,
    });
    await service.create(mkUser(), ownAccess(1), 1, { url: 'https://x.com' } as never);
    expect(prisma.kanbanCardActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'attachment_added' }) }),
    );
  });

  describe('remove — người đính kèm, chủ card, hoặc Quản trị', () => {
    function mockAttachment(overrides: Record<string, unknown> = {}) {
      prisma.kanbanCardAttachment.findUnique.mockResolvedValue({
        id: 9,
        card_id: 1,
        url: 'https://x.com',
        title: null,
        created_by: 2,
        ...overrides,
      });
    }

    it('đính kèm không tồn tại => 404', async () => {
      prisma.kanbanCardAttachment.findUnique.mockResolvedValue(null);
      await expect(service.remove(mkUser(), ownAccess(1), 999)).rejects.toThrow(NotFoundException);
    });

    it('người KHÁC (không đính kèm, không chủ card, không Quản trị) => 403', async () => {
      mockAttachment({ created_by: 2 });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 3, assignee_id: 1 }));
      await expect(service.remove(mkUser(), ownAccess(1), 9)).rejects.toThrow(ForbiddenException);
    });

    it('người đính kèm tự xoá được', async () => {
      mockAttachment({ created_by: 1 });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 3, assignee_id: 1 }));
      await expect(service.remove(mkUser(), ownAccess(1), 9)).resolves.toEqual({ deleted: true });
    });

    it('chủ card xoá được đính kèm của người khác', async () => {
      mockAttachment({ created_by: 2 });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 1, assignee_id: null }));
      await expect(service.remove(mkUser(), ownAccess(1), 9)).resolves.toEqual({ deleted: true });
    });

    it('Quản trị xoá được bất kỳ đính kèm nào', async () => {
      mockAttachment({ created_by: 2 });
      prisma.kanbanCard.findFirst.mockResolvedValue(scopedCard({ created_by: 3, assignee_id: null }));
      const admin = mkUser({ 'kanban.boards': true }, 9, true);
      await expect(
        service.remove(admin, { owner: 'all', roleIds: [] }, 9),
      ).resolves.toEqual({ deleted: true });
    });
  });
});
