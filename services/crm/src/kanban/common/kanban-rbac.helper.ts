import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';

/**
 * RBAC Kanban (quyền + phạm vi).
 *
 * "Của tôi" cho card = tạo HOẶC được giao (kể cả multi-assignee) — KHÔNG phải
 * 1 FK đơn, nên dùng where TỰ VIẾT (không phải `scopeWhere()` dùng chung của
 * `@trinity/rbac-nest`, hàm đó chỉ xử lý field phẳng).
 *
 * Cấu hình board (tạo/sửa board, cột, field def) là quyền RIÊNG `kanban.boards`
 * người giữ quyền này thấy MỌI board (kể cả tắt/ngoài `visibility_role_ids`),
 * để còn cấu hình lại.
 */

/** Preload 1 lần/request — dùng cho CẢ board lẫn card RBAC trong 1 request. */
export interface KanbanAccessContext {
  /** owner id hợp lệ cho `kanban.view` — `'all'` = không giới hạn. */
  owner: number[] | 'all';
  /** id vai trò (bảng `roles`) mà user đang giữ — dùng lọc `visibility_role_ids`. */
  roleIds: number[];
}

export async function getUserRoleIds(prisma: PrismaService, userId: number): Promise<number[]> {
  const rows = await prisma.userRole.findMany({
    where: { user_id: userId },
    select: { role_id: true },
  });
  return rows.map((r) => r.role_id);
}

export async function loadKanbanAccessContext(
  prisma: PrismaService,
  scope: ScopeService,
  user: AuthUser,
): Promise<KanbanAccessContext> {
  const [owner, roleIds] = await Promise.all([
    scope.ownerIds(user, 'kanban.view'),
    getUserRoleIds(prisma, user.userId),
  ]);
  // `owner === null` (không có quyền `kanban.view`) không xảy ra trên đường đi
  // bình thường — mọi route gọi hàm này đã qua `@Can('kanban.view')`. Coalesce
  // về `[]` (rỗng, KHÔNG ai) để fail-closed nếu lỡ gọi sai chỗ.
  return { owner: owner ?? [], roleIds };
}

/**
 * Prisma WHERE fragment cho phạm vi CARD được actor xem — AND-compose với where
 * khác (KHÔNG spread).
 *
 * OR thêm nhánh `assignees.some` (bảng `kanban_card_assignees`,
 * multi-assignee) CẠNH `assignee_id` (primary, giữ nguyên cho tương thích
 * ngược) — người phụ trách BỔ SUNG (không phải primary) cũng phải xem được
 * card, không chỉ người đứng đầu danh sách.
 */
export function buildKanbanCardScopeWhere(access: KanbanAccessContext): Prisma.KanbanCardWhereInput {
  if (access.owner === 'all') return {};
  const ids = access.owner;
  return {
    OR: [
      { created_by: { in: ids } },
      { assignee_id: { in: ids } },
      { assignees: { some: { user_id: { in: ids } } } },
    ],
  };
}

export interface KanbanCardAccessShape {
  created_by: number;
  assignee_id: number | null;
  assignees?: { user_id: number }[];
}

/** `true` nếu actor xem được 1 card cụ thể (đã biết `created_by`/`assignee_id`/`assignees`). */
export function canAccessKanbanCard(
  access: KanbanAccessContext,
  card: KanbanCardAccessShape,
): boolean {
  if (access.owner === 'all') return true;
  const ids = access.owner;
  if (ids.includes(card.created_by)) return true;
  if (card.assignee_id != null && ids.includes(card.assignee_id)) return true;
  return (card.assignees ?? []).some((a) => ids.includes(a.user_id));
}

/**
 * Prisma WHERE fragment cho phạm vi BOARD hiển thị (`visibility_role_ids` rỗng
 * = mọi vai trò; người giữ `kanban.boards` luôn thấy, kể cả board tắt/board mà
 * vai trò mình không nằm trong `visibility_role_ids`, để còn cấu hình lại).
 */
export function buildKanbanBoardVisibilityWhere(
  user: AuthUser,
  access: Pick<KanbanAccessContext, 'roleIds'>,
): Prisma.KanbanBoardWhereInput {
  if (can(user.grants, 'kanban.boards')) return { deleted_at: null };
  return {
    deleted_at: null,
    is_active: true,
    OR: [
      { visibility_role_ids: { isEmpty: true } },
      { visibility_role_ids: { hasSome: access.roleIds } },
    ],
  };
}

export function isBoardVisibleToUser(
  user: AuthUser,
  access: Pick<KanbanAccessContext, 'roleIds'>,
  board: { is_active: boolean; deleted_at: Date | null; visibility_role_ids: number[] },
): boolean {
  if (board.deleted_at) return false;
  if (can(user.grants, 'kanban.boards')) return true;
  if (!board.is_active) return false;
  return (
    board.visibility_role_ids.length === 0 ||
    board.visibility_role_ids.some((id) => access.roleIds.includes(id))
  );
}

/**
 * Load 1 board + assert actor xem được — 404 (KHÔNG 403) nếu
 * ngoài phạm vi hoặc không tồn tại/đã xoá.
 */
export async function loadVisibleBoardOrNotFound(
  prisma: PrismaService,
  user: AuthUser,
  access: Pick<KanbanAccessContext, 'roleIds'>,
  boardId: number,
) {
  const board = await prisma.kanbanBoard.findFirst({
    where: { id: boardId, deleted_at: null },
  });
  if (!board || !isBoardVisibleToUser(user, access, board)) {
    throw new NotFoundException(`Không tìm thấy board ID ${boardId}`);
  }
  return board;
}

/**
 * Load 1 card + assert actor xem được (board hiển thị VÀ trong phạm vi RBAC
 * card) — 404 ở MỌI nhánh ngoài phạm vi (endpoint con phải mirror
 * gate của resource cha, id ngoài phạm vi → 404 không phải 403).
 */
export async function loadScopedCardOrNotFound(
  prisma: PrismaService,
  user: AuthUser,
  access: KanbanAccessContext,
  cardId: number,
) {
  const card = await prisma.kanbanCard.findFirst({
    where: { id: cardId, deleted_at: null },
    include: { board: true, column: true, assignees: { select: { user_id: true } } },
  });
  if (!card || !isBoardVisibleToUser(user, access, card.board)) {
    throw new NotFoundException(`Không tìm thấy card ID ${cardId}`);
  }
  if (!canAccessKanbanCard(access, card)) {
    throw new NotFoundException(`Không tìm thấy card ID ${cardId}`);
  }
  return card;
}
