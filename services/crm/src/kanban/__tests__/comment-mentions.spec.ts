import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanCardActivitiesService } from '../cards/kanban-card-activities.service';

const user = { userId: 7 } as unknown as AuthUser;

describe('bình luận công việc gắn thẻ @', () => {
  it('lưu bình luận xong ghi cạnh task → bản ghi được nhắc, trường comment:<id>', async () => {
    const calls: unknown[][] = [];
    const prisma = {
      kanbanCard: { findFirst: async () => ({ id: 5, created_by: 7, assigned_to: 7, deleted_at: null }) },
      kanbanCardActivity: { create: async () => ({ id: 91, card_id: 5, action: 'comment' }) },
    };
    const links = { syncMentions: async (...a: unknown[]) => { calls.push(a); } };
    const svc = new KanbanCardActivitiesService(prisma as never, links as never);
    // gate card cha là việc của helper khác — bỏ qua bằng cách chặn ở mức module
    jest.spyOn(await import('../common/kanban-rbac.helper'), 'loadScopedCardOrNotFound').mockResolvedValue({} as never);
    await svc.addComment(user, {} as never, 5, { content: 'Xem @KH001' });
    expect(calls).toEqual([[{ type: 'task', id: 5 }, 'comment:91', 'Xem @KH001', user]]);
  });
});

