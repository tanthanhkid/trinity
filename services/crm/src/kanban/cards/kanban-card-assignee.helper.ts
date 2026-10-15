import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@trinity/prisma';
import { KANBAN_CARD_ASSIGNEES_MAX } from '../common/kanban.constants';

interface AssigneeDtoShape {
  assignee_id?: number | null;
  assignee_ids?: number[];
}

/**
 * Chuẩn hoá danh sách người phụ trách từ DTO — `assignee_ids`
 * (mảng, THAY THẾ toàn bộ) THẮNG `assignee_id` (đơn, tương thích ngược) khi
 * CẢ HAI cùng có mặt trong 1 request. Trả `undefined` = "không đụng tới
 * người phụ trách" (giữ nguyên hiện trạng) — PHẢI phân biệt với mảng rỗng
 * `[]` = "gỡ hết người phụ trách".
 */
export function resolveAssigneeIds(dto: AssigneeDtoShape): number[] | undefined {
  if (dto.assignee_ids !== undefined) {
    const unique = Array.from(new Set(dto.assignee_ids));
    if (unique.length > KANBAN_CARD_ASSIGNEES_MAX) {
      throw new BadRequestException(`Tối đa ${KANBAN_CARD_ASSIGNEES_MAX} người phụ trách/card`);
    }
    return unique;
  }
  if (dto.assignee_id !== undefined) {
    return dto.assignee_id != null ? [dto.assignee_id] : [];
  }
  return undefined;
}

/**
 * Mọi id phụ trách phải là user có thật, chưa bị xoá và đang active — `kanban_card_assignees.user_id`
 * không có FK nên id lạ/đã xoá/đã khoá sẽ ghi được thành dữ liệu rác. Ném 400 nếu thiếu.
 */
export async function assertAssigneesAssignable(
  db: { user: { findMany: (args: { where: { id: { in: number[] }; deleted_at: null; status: 'active' }; select: { id: true } }) => Promise<{ id: number }[]> } },
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const found = await db.user.findMany({
    where: { id: { in: ids }, deleted_at: null, status: 'active' },
    select: { id: true },
  });
  if (found.length !== new Set(ids).size) {
    throw new BadRequestException('Người phụ trách không tồn tại hoặc tài khoản không hoạt động');
  }
}

/**
 * Ghi ĐÈ toàn bộ `kanban_card_assignees` của 1 card theo danh sách mới —
 * replace-all, chạy TRONG transaction ghi
 * `assignee_id` để 2 nguồn không bao giờ lệch nhau giữa chừng.
 */
export async function syncKanbanCardAssignees(
  tx: Prisma.TransactionClient,
  cardId: number,
  assigneeIds: number[],
): Promise<void> {
  await tx.kanbanCardAssignee.deleteMany({ where: { card_id: cardId } });
  if (assigneeIds.length === 0) return;
  await tx.kanbanCardAssignee.createMany({
    data: assigneeIds.map((user_id) => ({ card_id: cardId, user_id })),
    skipDuplicates: true,
  });
}
