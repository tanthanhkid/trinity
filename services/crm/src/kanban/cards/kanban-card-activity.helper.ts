import { Prisma } from '@trinity/prisma';
import { KanbanActivityAction } from '../common/kanban.constants';

/** Ghi 1 dòng lịch sử card — dùng NGAY TRONG transaction ghi (KHÔNG fire-and-forget,
 * đây là dữ liệu nghiệp vụ bắt buộc "lịch sử ghi đủ các lần chuyển cột"). */
export async function logKanbanCardActivity(
  tx: Prisma.TransactionClient,
  cardId: number,
  actorId: number,
  action: KanbanActivityAction,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.kanbanCardActivity.create({
    data: { card_id: cardId, actor_id: actorId, action, payload: payload as object },
  });
}
