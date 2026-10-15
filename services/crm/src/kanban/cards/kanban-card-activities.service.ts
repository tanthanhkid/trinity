import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { KanbanAccessContext, loadScopedCardOrNotFound } from '../common/kanban-rbac.helper';
import { CreateKanbanCommentDto } from './dto/create-comment.dto';
import { RecordLinksService } from '../../custom-objects/refs/record-links.service';

/** Cap lịch sử trả về — bảng nhỏ theo card, KHÔNG cần cursor (v1). */
const ACTIVITIES_MAX_LIMIT = 200;

/**
 * Bình luận (ghi vào `kanban_card_activities` với `action='comment'`) + lịch
 * sử card — mọi endpoint con PHẢI gọi lại gate của card cha
 * (`loadScopedCardOrNotFound`) trước khi đọc/ghi, ngoài phạm vi → 404.
 */
@Injectable()
export class KanbanCardActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    /** Thẻ @ trong bình luận → "Được nhắc tới ở" của bản ghi được nhắc. Tuỳ chọn để test không phải dựng. */
    @Optional() private readonly links?: RecordLinksService,
  ) {}

  async listActivities(user: AuthUser, access: KanbanAccessContext, cardId: number) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    const actorIds = new Set<number>();
    const activities = await this.prisma.kanbanCardActivity.findMany({
      where: { card_id: cardId },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: ACTIVITIES_MAX_LIMIT,
    });
    for (const a of activities) if (a.actor_id != null) actorIds.add(a.actor_id);
    const actors = actorIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: Array.from(actorIds) } },
          select: { id: true, full_name: true },
        })
      : [];
    const nameById = new Map(actors.map((a) => [a.id, a.full_name]));
    return activities.map((a) => ({
      ...a,
      actor_name: a.actor_id != null ? nameById.get(a.actor_id) ?? null : null,
    }));
  }

  async addComment(
    user: AuthUser,
    access: KanbanAccessContext,
    cardId: number,
    dto: CreateKanbanCommentDto,
  ) {
    await loadScopedCardOrNotFound(this.prisma, user, access, cardId);
    const activity = await this.prisma.kanbanCardActivity.create({
      data: {
        card_id: cardId,
        actor_id: user.userId,
        action: 'comment',
        payload: { content: dto.content },
      },
    });
    await this.links?.syncMentions({ type: 'task', id: cardId }, `comment:${activity.id}`, dto.content, user);
    return { ...activity, actor_name: null };
  }
}
