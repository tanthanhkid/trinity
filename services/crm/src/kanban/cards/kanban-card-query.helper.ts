import { Prisma } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import {
  buildKanbanBoardVisibilityWhere,
  buildKanbanCardScopeWhere,
  KanbanAccessContext,
} from '../common/kanban-rbac.helper';
import { QueryKanbanCardsDto } from './dto/query-cards.dto';

/**
 * Where TỔNG cho list card — AND-compose RBAC (board visibility + card scope)
 * với filter UI, KHÔNG spread (filter ngoài phạm vi RBAC phải ra 0 dòng, không được
 * ghi đè điều kiện scope).
 */
export function buildKanbanCardListWhere(
  user: AuthUser,
  access: KanbanAccessContext,
  query: QueryKanbanCardsDto,
): Prisma.KanbanCardWhereInput {
  const and: Prisma.KanbanCardWhereInput[] = [
    { deleted_at: null },
    { board: buildKanbanBoardVisibilityWhere(user, access) },
    buildKanbanCardScopeWhere(access),
  ];

  if (query.board_id !== undefined) and.push({ board_id: query.board_id });
  if (query.column_id !== undefined) and.push({ column_id: query.column_id });
  if (query.contact_id !== undefined) and.push({ contact_id: query.contact_id });
  if (query.assignee_id !== undefined) and.push({ assignee_id: query.assignee_id });
  if (query.label !== undefined) and.push({ labels: { has: query.label } });
  if (query.search !== undefined && query.search.length > 0) {
    and.push({ title: { contains: query.search, mode: 'insensitive' } });
  }
  if (query.overdue === true) {
    and.push({ due_at: { lt: new Date() }, completed_at: null, due_completed_at: null });
  }

  return { AND: and };
}

/**
 * Thứ tự hiển thị: theo CỘT (`column_id` được chỉ định) dùng đúng thứ tự Kanban
 * (`position ASC`, cursor tiến); xuyên board (vd tab "Công việc" của khách
 * hàng) dùng `id DESC` (mới nhất trước — tránh bẫy "cap + ORDER BY ASC cắt mất
 * dữ liệu mới").
 */
export function resolveKanbanCardOrderBy(
  query: QueryKanbanCardsDto,
): Prisma.KanbanCardOrderByWithRelationInput[] {
  if (query.column_id !== undefined) {
    return [{ position: 'asc' }, { id: 'asc' }];
  }
  return [{ id: 'desc' }];
}
