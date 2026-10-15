import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { KanbanCardMoveService } from '../cards/kanban-card-move.service';
import { KanbanAccessContext } from '../common/kanban-rbac.helper';

function mkUser(grants: Grants = {}, userId = 1): AuthUser {
  return { userId, email: 'x@test.com', isAdmin: false, grants };
}

function ownAccess(userId = 1): KanbanAccessContext {
  return { owner: [userId], roleIds: [] };
}

function mkScope(): ScopeService {
  return { ownerIds: jest.fn(async () => []) } as unknown as ScopeService;
}

function baseCard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    board_id: 10,
    column_id: 1,
    created_by: 1,
    assignee_id: null,
    completed_at: null,
    contact_id: null,
    board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
    column: {},
    assignees: [],
    ...overrides,
  };
}

/** Card "đầy đủ" theo `KANBAN_CARD_SELECT` — dùng làm giá trị trả
 * về của `tx.kanbanCard.update(...)` (mirror `kanban-cards.service.spec.ts`). */
function fullCardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    board_id: 10,
    column_id: 2,
    position: 1500,
    title: 'x',
    description: null,
    contact_id: null,
    assignee_id: null,
    created_by: 1,
    due_at: null,
    due_completed_at: null,
    priority: null,
    labels: [],
    attributes: {},
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    assignees: [],
    checklist_items: [],
    activities: [],
    _count: { attachments: 0 },
    ...overrides,
  };
}

function buildPrismaMock() {
  const prisma = {
    kanbanCard: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    kanbanColumn: { findFirst: jest.fn() },
    kanbanCardActivity: { create: jest.fn().mockResolvedValue({}) },
    contact: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

describe('KanbanCardMoveService.move', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let service: KanbanCardMoveService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new KanbanCardMoveService(prisma as unknown as PrismaService, mkScope());
  });

  it('card ngoài phạm vi RBAC => 404, KHÔNG mở transaction ghi', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValue(
      baseCard({ created_by: 999, assignee_id: 888 }),
    );
    await expect(
      service.move(mkUser(), ownAccess(1), 1, { column_id: 2 } as never),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('column_id đích không thuộc board của card => 400', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValue(baseCard());
    prisma.kanbanColumn.findFirst.mockResolvedValue(null);
    await expect(
      service.move(mkUser(), ownAccess(1), 1, { column_id: 999 } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('cột đích đã ẩn (archived) => 400', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValue(baseCard());
    prisma.kanbanColumn.findFirst.mockResolvedValue({
      id: 2,
      is_done: false,
      is_archived: true,
      wip_limit: null,
    });
    await expect(
      service.move(mkUser(), ownAccess(1), 1, { column_id: 2 } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('before_card_id không thuộc cột đích => 400', async () => {
    prisma.kanbanCard.findFirst
      .mockResolvedValueOnce(baseCard()) // gate load
      .mockResolvedValueOnce(null); // before_card lookup trong tx
    prisma.kanbanColumn.findFirst.mockResolvedValue({
      id: 2,
      is_done: false,
      is_archived: false,
      wip_limit: null,
    });
    await expect(
      service.move(mkUser(), ownAccess(1), 1, { column_id: 2, before_card_id: 777 } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it('chèn GIỮA 2 card láng giềng => position = trung điểm; ghi activity moved', async () => {
    prisma.kanbanCard.findFirst
      .mockResolvedValueOnce(baseCard()) // gate load
      .mockResolvedValueOnce({ position: 1000 }) // before
      .mockResolvedValueOnce({ position: 2000 }); // after
    prisma.kanbanColumn.findFirst.mockResolvedValue({
      id: 2,
      name: 'Đang làm',
      is_done: false,
      is_archived: false,
      wip_limit: null,
    });
    prisma.kanbanCard.update.mockResolvedValue(fullCardRow());

    const result = await service.move(mkUser(), ownAccess(1), 1, {
      column_id: 2,
      before_card_id: 501,
      after_card_id: 502,
    } as never);

    expect(prisma.kanbanCard.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ column_id: 2, position: 1500 }) }),
    );
    expect(prisma.kanbanCardActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'moved', card_id: 1 }),
      }),
    );
    expect(result.card.column_id).toBe(2);
    expect(result.wip_warning).toBeNull();
  });

  it('chuyển vào cột is_done=true => set completed_at; chuyển ra khỏi cột done => clear completed_at', async () => {
    prisma.kanbanCard.findFirst
      .mockResolvedValueOnce(baseCard({ completed_at: null }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.kanbanColumn.findFirst.mockResolvedValue({
      id: 2,
      name: 'Xong',
      is_done: true,
      is_archived: false,
      wip_limit: null,
    });
    prisma.kanbanCard.update.mockResolvedValue(fullCardRow());
    await service.move(mkUser(), ownAccess(1), 1, { column_id: 2 } as never);
    const data = prisma.kanbanCard.update.mock.calls[0][0].data;
    expect(data.completed_at).toBeInstanceOf(Date);
  });

  it('vượt wip_limit => trả cảnh báo, KHÔNG chặn di chuyển', async () => {
    prisma.kanbanCard.findFirst.mockResolvedValueOnce(baseCard()).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    prisma.kanbanColumn.findFirst.mockResolvedValue({
      id: 2,
      name: 'Đang làm',
      is_done: false,
      is_archived: false,
      wip_limit: 2,
    });
    prisma.kanbanCard.count.mockResolvedValue(3);
    prisma.kanbanCard.update.mockResolvedValue(fullCardRow());

    const result = await service.move(mkUser(), ownAccess(1), 1, { column_id: 2 } as never);
    expect(result.wip_warning).toContain('vượt giới hạn WIP');
  });
});
