import { BadRequestException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Grants } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import { KanbanCardsService } from '../cards/kanban-cards.service';
import { KanbanAccessContext } from '../common/kanban-rbac.helper';

function mkUser(grants: Grants, userId = 1, isAdmin = false): AuthUser {
  return { userId, email: 'x@test.com', isAdmin, grants };
}

function ownAccess(userId = 1): KanbanAccessContext {
  return { owner: [userId], roleIds: [] };
}

function mkScope(ownerByPerm: Record<string, number[] | 'all' | null> = {}): ScopeService {
  return {
    ownerIds: jest.fn(async (_user: AuthUser, perm: string) => ownerByPerm[perm] ?? []),
  } as unknown as ScopeService;
}

/** Card "đầy đủ" theo `KANBAN_CARD_SELECT` — dùng làm giá trị mặc
 * định cho `findUniqueOrThrow` (bước đọc lại SAU transaction ghi). Test nào
 * cần field khác override qua spread. */
function fullCardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    board_id: 10,
    column_id: 1,
    position: 1024,
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
    kanbanColumn: { findUnique: jest.fn(), findFirst: jest.fn() },
    kanbanBoard: { findFirst: jest.fn() },
    kanbanFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
    kanbanCard: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn().mockResolvedValue(fullCardRow()),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn(),
    },
    kanbanCardAssignee: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    kanbanCardActivity: { create: jest.fn().mockResolvedValue({}) },
    user: { findMany: jest.fn().mockImplementation(async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.map((id) => ({ id }))) },
    contact: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

describe('KanbanCardsService', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let scope: ScopeService;
  let service: KanbanCardsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    scope = mkScope({ 'contacts.view': [1], 'contacts.phone_full': [1] });
    service = new KanbanCardsService(prisma as unknown as PrismaService, scope);
  });

  describe('create', () => {
    it('column_id không tồn tại => 400', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue(null);
      await expect(
        service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), {
          column_id: 999,
          title: 'x',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('board của cột KHÔNG hiển thị với actor => 404 (không lộ "cột tồn tại")', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue({
        id: 1,
        board_id: 10,
        is_done: false,
        is_archived: false,
      });
      prisma.kanbanBoard.findFirst.mockResolvedValue({
        id: 10,
        is_active: true,
        deleted_at: null,
        visibility_role_ids: [999],
      });
      await expect(
        service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), {
          column_id: 1,
          title: 'x',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('cột đã ẩn (archived) => 400, không cho tạo card mới', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue({
        id: 1,
        board_id: 10,
        is_done: false,
        is_archived: true,
      });
      prisma.kanbanBoard.findFirst.mockResolvedValue({
        id: 10,
        is_active: true,
        deleted_at: null,
        visibility_role_ids: [],
      });
      await expect(
        service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), {
          column_id: 1,
          title: 'x',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('gắn contact_id ngoài phạm vi contacts.view của actor => 404', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue({
        id: 1,
        board_id: 10,
        is_done: false,
        is_archived: false,
      });
      prisma.kanbanBoard.findFirst.mockResolvedValue({
        id: 10,
        is_active: true,
        deleted_at: null,
        visibility_role_ids: [],
      });
      // Contact tồn tại nhưng gán cho user KHÁC — actor (userId=1, scope contacts.view=[1]) không tiếp cận được.
      prisma.contact.findUnique.mockResolvedValue({
        assigned_to: 999,
        created_by_id: null,
      });
      await expect(
        service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), {
          column_id: 1,
          title: 'x',
          contact_id: 55,
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('tạo thành công => ghi activity "created" + "contact_linked" khi có contact_id', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue({
        id: 1,
        board_id: 10,
        is_done: false,
        is_archived: false,
      });
      prisma.kanbanBoard.findFirst.mockResolvedValue({
        id: 10,
        is_active: true,
        deleted_at: null,
        visibility_role_ids: [],
      });
      prisma.contact.findUnique.mockResolvedValue({
        assigned_to: 1,
        created_by_id: null,
      });
      prisma.kanbanCard.create.mockResolvedValue({
        id: 100,
        board_id: 10,
        column_id: 1,
        position: 1024,
        title: 'x',
        description: null,
        contact_id: 55,
        assignee_id: null,
        created_by: 1,
        due_at: null,
        priority: null,
        labels: [],
        attributes: {},
        completed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const result = await service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), {
        column_id: 1,
        title: 'x',
        contact_id: 55,
      } as never);

      expect(result.id).toBe(100);
      const actions = prisma.kanbanCardActivity.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { data: { action: string } }).data.action,
      );
      expect(actions).toEqual(expect.arrayContaining(['created', 'contact_linked']));
    });

    it('assignee_ids chứa user không tồn tại/đã khoá => 400, không ghi card', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue({ id: 1, board_id: 10, is_done: false, is_archived: false });
      prisma.kanbanBoard.findFirst.mockResolvedValue({ id: 10, is_active: true, deleted_at: null, visibility_role_ids: [] });
      prisma.user.findMany.mockResolvedValue([{ id: 7 }]); // 999 không có
      await expect(
        service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), { column_id: 1, title: 'x', assignee_ids: [7, 999] } as never),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.kanbanCard.create).not.toHaveBeenCalled();
    });

    it('assignee_ids[] ghi assignee_id=phần tử đầu (primary) + đồng bộ kanban_card_assignees', async () => {
      prisma.kanbanColumn.findUnique.mockResolvedValue({
        id: 1,
        board_id: 10,
        is_done: false,
        is_archived: false,
      });
      prisma.kanbanBoard.findFirst.mockResolvedValue({
        id: 10,
        is_active: true,
        deleted_at: null,
        visibility_role_ids: [],
      });
      prisma.kanbanCard.create.mockResolvedValue(fullCardRow({ id: 101 }));

      await service.create(mkUser({ 'kanban.manage': 'own' }, 1), ownAccess(1), {
        column_id: 1,
        title: 'x',
        assignee_ids: [7, 8, 7],
      } as never);

      expect(prisma.kanbanCard.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assignee_id: 7 }) }),
      );
      expect(prisma.kanbanCardAssignee.deleteMany).toHaveBeenCalledWith({ where: { card_id: 101 } });
      expect(prisma.kanbanCardAssignee.createMany).toHaveBeenCalledWith({
        data: [
          { card_id: 101, user_id: 7 },
          { card_id: 101, user_id: 8 },
        ],
        skipDuplicates: true,
      });
    });
  });

  describe('update — contact_id không giữ contacts.view thì bị chặn ở CẢ gán lẫn GỠ', () => {
    function mockScopedCard() {
      prisma.kanbanCard.findFirst.mockResolvedValue({
        id: 1,
        created_by: 1,
        assignee_id: null,
        board_id: 10,
        column_id: 1,
        contact_id: 55,
        attributes: {},
        board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
        column: {},
      });
    }

    it('không giữ contacts.view: gán contact_id (số) => 404 (assertContactLinkable tự chặn)', async () => {
      mockScopedCard();
      prisma.contact.findUnique.mockResolvedValue({ id: 77, assigned_to: 999, created_by_id: null });
      const noContactScope = mkScope({});
      const noContactService = new KanbanCardsService(
        prisma as unknown as PrismaService,
        noContactScope,
      );
      await expect(
        noContactService.update(mkUser({}, 1), ownAccess(1), 1, { contact_id: 77 } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('không giữ contacts.view: GỠ contact_id (null) => 403, KHÔNG âm thầm cho qua', async () => {
      mockScopedCard();
      await expect(
        service.update(mkUser({}, 1), ownAccess(1), 1, { contact_id: null } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.kanbanCard.update).not.toHaveBeenCalled();
    });

    it('có contacts.view (dù scope own) vẫn gỡ contact_id được', async () => {
      mockScopedCard();
      prisma.kanbanCard.update.mockResolvedValue({
        id: 1,
        board_id: 10,
        column_id: 1,
        position: 1,
        title: 'x',
        description: null,
        contact_id: null,
        assignee_id: null,
        created_by: 1,
        due_at: null,
        priority: null,
        labels: [],
        attributes: {},
        completed_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      });
      await expect(
        service.update(mkUser({ 'contacts.view': 'own' }, 1), ownAccess(1), 1, {
          contact_id: null,
        } as never),
      ).resolves.toEqual(expect.objectContaining({ contact_id: null }));
    });
  });

  describe('update multi-assignee + due_completed_at', () => {
    function mockScopedCard(overrides: Record<string, unknown> = {}) {
      prisma.kanbanCard.findFirst.mockResolvedValue({
        id: 1,
        created_by: 1,
        assignee_id: 7,
        assignees: [{ user_id: 7 }],
        board_id: 10,
        column_id: 1,
        contact_id: null,
        attributes: {},
        board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
        column: {},
        ...overrides,
      });
    }

    it('assignee_ids KHÔNG đổi (cùng tập, khác thứ tự) => KHÔNG ghi activity "assigned"', async () => {
      mockScopedCard({ assignee_id: 7, assignees: [{ user_id: 7 }, { user_id: 8 }] });
      await service.update(mkUser({}, 1), ownAccess(1), 1, { assignee_ids: [8, 7] } as never);
      const actions = prisma.kanbanCardActivity.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { data: { action: string } }).data.action,
      );
      expect(actions).not.toContain('assigned');
      // Vẫn phải ghi ĐÈ bảng liên kết dù thứ tự đổi — assignee_id (primary) đổi
      // từ 7 sang 8 (phần tử đầu mới).
      expect(prisma.kanbanCardAssignee.createMany).toHaveBeenCalledWith({
        data: [
          { card_id: 1, user_id: 8 },
          { card_id: 1, user_id: 7 },
        ],
        skipDuplicates: true,
      });
    });

    it('assignee_ids: [] gỡ hết người phụ trách => assignee_id=null + ghi activity "assigned"', async () => {
      mockScopedCard();
      await service.update(mkUser({}, 1), ownAccess(1), 1, { assignee_ids: [] } as never);
      expect(prisma.kanbanCard.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ assignee_id: null }) }),
      );
      expect(prisma.kanbanCardAssignee.createMany).not.toHaveBeenCalled();
      const actions = prisma.kanbanCardActivity.create.mock.calls.map(
        (c: unknown[]) => (c[0] as { data: { action: string } }).data.action,
      );
      expect(actions).toContain('assigned');
    });

    it('KHÔNG gửi assignee_id/assignee_ids => KHÔNG đụng người phụ trách hiện có', async () => {
      mockScopedCard();
      await service.update(mkUser({}, 1), ownAccess(1), 1, { title: 'đổi tên' } as never);
      expect(prisma.kanbanCardAssignee.deleteMany).not.toHaveBeenCalled();
      const call = prisma.kanbanCard.update.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(Object.prototype.hasOwnProperty.call(call.data, 'assignee_id')).toBe(false);
    });

    it('due_completed_at: đánh dấu hoàn thành hạn rồi bỏ đánh dấu (null)', async () => {
      mockScopedCard();
      await service.update(mkUser({}, 1), ownAccess(1), 1, {
        due_completed_at: '2026-09-27T00:00:00.000Z',
      } as never);
      expect(prisma.kanbanCard.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ due_completed_at: expect.any(Date) }) }),
      );

      await service.update(mkUser({}, 1), ownAccess(1), 1, { due_completed_at: null } as never);
      expect(prisma.kanbanCard.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ due_completed_at: null }) }),
      );
    });
  });

  describe('remove — chỉ người tạo hoặc Quản trị (quyết định)', () => {
    function mockScopedCard(overrides: Partial<{ created_by: number; assignee_id: number | null }> = {}) {
      prisma.kanbanCard.findFirst.mockResolvedValue({
        id: 1,
        created_by: overrides.created_by ?? 1,
        assignee_id: overrides.assignee_id ?? null,
        board_id: 10,
        column_id: 1,
        board: { is_active: true, deleted_at: null, visibility_role_ids: [] },
        column: {},
      });
    }

    it('người tạo xoá được card của chính mình', async () => {
      mockScopedCard({ created_by: 1 });
      await expect(service.remove(mkUser({}, 1), ownAccess(1), 1)).resolves.toEqual({
        deleted: true,
      });
    });

    it('Quản trị xoá được card của người khác', async () => {
      mockScopedCard({ created_by: 999 });
      // PermissionService.grantsFor thật gán MỌI quyền cho vai trò hệ thống —
      // mô phỏng bằng cách cấp thẳng `kanban.boards` (board luôn hiển thị).
      const admin = mkUser({ 'kanban.boards': true }, 1, true);
      await expect(service.remove(admin, { owner: 'all', roleIds: [] }, 1)).resolves.toEqual({
        deleted: true,
      });
    });

    it('actor xem được card (trong scope) nhưng KHÔNG phải người tạo => 403', async () => {
      // Card thuộc scope (assignee_id nằm trong owner) nên loadScopedCardOrNotFound
      // KHÔNG throw 404 — nhưng actor không phải created_by nên bị chặn ở remove().
      mockScopedCard({ created_by: 11, assignee_id: null });
      const access: KanbanAccessContext = { owner: [5, 11], roleIds: [] };
      await expect(service.remove(mkUser({}, 5), access, 1)).rejects.toThrow(ForbiddenException);
    });

    it('card ngoài phạm vi RBAC => 404 (KHÔNG lộ tồn tại qua 403)', async () => {
      mockScopedCard({ created_by: 999, assignee_id: 888 });
      await expect(service.remove(mkUser({}, 1), ownAccess(1), 1)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
  describe('remove ghi người xoá; restore — Hoàn tác phía máy chủ', () => {
    const boardOk = { is_active: true, deleted_at: null, visibility_role_ids: [] };
    function mockDeletedCard(o: Partial<{ created_by: number; deleted_by: number | null; deleted_at: Date | null; board: object; assignee_id: number | null }> = {}) {
      prisma.kanbanCard.findFirst.mockResolvedValue({
        id: 1, board_id: 10, created_by: o.created_by ?? 1, assignee_id: o.assignee_id ?? null, assignees: [],
        deleted_by: o.deleted_by === undefined ? 1 : o.deleted_by,
        deleted_at: o.deleted_at === undefined ? new Date(Date.now() - 2_000) : o.deleted_at,
        board: o.board ?? boardOk,
      });
    }

    it('remove ghi deleted_by = người xoá', async () => {
      prisma.kanbanCard.findFirst.mockResolvedValue({ id: 1, created_by: 1, assignee_id: null, board_id: 10, column_id: 1, board: boardOk, column: {} });
      await service.remove(mkUser({}, 1), ownAccess(1), 1);
      expect(prisma.kanbanCard.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { deleted_at: expect.any(Date), deleted_by: 1 } });
    });

    it('người đã xoá khôi phục được trong cửa sổ ⇒ bỏ deleted_at + ghi lịch sử restored', async () => {
      mockDeletedCard()
      await expect(service.restore(mkUser({}, 1), ownAccess(1), 1)).resolves.toEqual({ restored: true });
      expect(prisma.kanbanCard.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { deleted_at: null, deleted_by: null } });
      expect(prisma.kanbanCardActivity.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'restored' }) }));
    });

    it('chỉ tìm card ĐÃ xoá (card đang sống ⇒ 404)', async () => {
      prisma.kanbanCard.findFirst.mockResolvedValue(null);
      await expect(service.restore(mkUser({}, 1), ownAccess(1), 1)).rejects.toThrow(NotFoundException);
      expect(prisma.kanbanCard.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1, deleted_at: { not: null } } }));
    });

    it('người khác (không phải người xoá, không Quản trị) ⇒ 403', async () => {
      mockDeletedCard({ created_by: 5, deleted_by: 5 });
      await expect(service.restore(mkUser({}, 1), { owner: [1, 5], roleIds: [] }, 1)).rejects.toThrow(ForbiddenException);
    });

    it('Quản trị khôi phục được card người khác xoá', async () => {
      mockDeletedCard({ created_by: 5, deleted_by: 5 });
      const admin = mkUser({ 'kanban.boards': true }, 1, true);
      await expect(service.restore(admin, { owner: 'all', roleIds: [] }, 1)).resolves.toEqual({ restored: true });
    });

    it('quá 10 phút ⇒ 410; bản xoá cũ không có deleted_by ⇒ 403', async () => {
      mockDeletedCard({ deleted_at: new Date(Date.now() - 11 * 60_000) });
      await expect(service.restore(mkUser({}, 1), ownAccess(1), 1)).rejects.toThrow(GoneException);
      mockDeletedCard({ deleted_by: null });
      await expect(service.restore(mkUser({}, 1), ownAccess(1), 1)).rejects.toThrow(ForbiddenException);
    });

    it('ngoài phạm vi hoặc board đã xoá ⇒ 404 (không lộ tồn tại)', async () => {
      mockDeletedCard({ created_by: 999, assignee_id: 888 });
      await expect(service.restore(mkUser({}, 1), ownAccess(1), 1)).rejects.toThrow(NotFoundException);
      mockDeletedCard({ board: { ...boardOk, deleted_at: new Date() } });
      await expect(service.restore(mkUser({}, 1), ownAccess(1), 1)).rejects.toThrow(NotFoundException);
    });
  });
});
