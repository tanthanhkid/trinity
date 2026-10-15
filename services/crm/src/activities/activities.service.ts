import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';

/**
 * Fields for activity list queries.
 * `satisfies Prisma.ActivitySelect`: trường không còn trong schema là lỗi biên dịch —
 * lỗi chính tả/cột đã bỏ sẽ lọt vì select là biến và Prisma chỉ báo ở runtime.
 */
export const ACTIVITY_SELECT = {
  id: true,
  contact_id: true,
  action: true,
  details: true,
  metadata: true,
  created_by: true,
  created_at: true,
} as const satisfies Prisma.ActivitySelect;

type ActivityRow = Prisma.ActivityGetPayload<{
  select: typeof ACTIVITY_SELECT;
}>;

type ActivityWithUser = ActivityRow & {
  user: { id: number; full_name: string; email: string | null; avatar_url: string | null } | null;
};

/** Maximum page size for activities */
const MAX_LIMIT = 200;

/** Default page size for activities */
const DEFAULT_LIMIT = 20;

/** Valid activity action types */
export type ActivityAction =
  | 'stage_change'
  | 'note'
  | 'transfer'
  // Chuyển quyền phụ trách 1 contact cho người khác — chỉ hiển thị ở tab "Lịch sử" của
  // /contacts/:id (tab đó không có whitelist theo action, mọi activity có contact_id đều hiện).
  | 'contact_transfer';

export interface CreateActivityInput {
  contactId: number | null;
  action: ActivityAction;
  details: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdBy: number | null;
}

@Injectable()
export class ActivitiesService {
  private readonly logger = new Logger(ActivitiesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Gan thong tin user (full_name, avatar_url) vao moi activity dua theo
   * created_by. Thuc hien batch lookup (1 query duy nhat) de tranh N+1,
   * va khong can them FK/relation vao bang activities (50M rows).
   */
  private async attachCreators(
    activities: ActivityRow[],
  ): Promise<ActivityWithUser[]> {
    const ids = Array.from(
      new Set(
        activities
          .map((a) => a.created_by)
          .filter((id): id is number => id != null),
      ),
    );

    if (ids.length === 0) {
      return activities.map((a) => ({ ...a, user: null }));
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, full_name: true, email: true, avatar_url: true },
    });
    const userMap = new Map(
      users.map(
        (u: { id: number; full_name: string; email: string | null; avatar_url: string | null }) => [u.id, u],
      ),
    );

    return activities.map((a) => ({
      ...a,
      user: a.created_by != null ? (userMap.get(a.created_by) ?? null) : null,
    }));
  }

  /**
   * Timeline activities cua contact (cursor pagination).
   * Bang activities 50M rows: LUON filter by contact_id (indexed).
   * Newest first, cursor-based pagination.
   */
  async findByContact(
    contactId: number,
    cursor: number | undefined,
    limit: number,
  ) {
    const take = Math.min(
      Math.max(limit || DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const activities = await this.prisma.activity.findMany({
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      where: { contact_id: contactId },
      orderBy: { id: 'desc' },
      select: ACTIVITY_SELECT,
    });

    const hasMore = activities.length > take;
    const page = hasMore ? activities.slice(0, take) : activities;
    const data = await this.attachCreators(page);
    const nextCursor =
      hasMore && data.length > 0
        ? data[data.length - 1].id
        : null;

    return { data, next_cursor: nextCursor };
  }

  /**
   * Auto-log activity.
   * Used by other services when: stage_change, note, transfer, contact_transfer.
   */
  async create(input: CreateActivityInput) {
    const activity = await this.prisma.activity.create({
      data: {
        contact_id: input.contactId,
        action: input.action,
        details: input.details as Prisma.InputJsonValue,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        created_by: input.createdBy,
      },
      select: ACTIVITY_SELECT,
    });

    this.logger.debug(
      `Activity created: ${input.action} for contact=${input.contactId}`,
    );

    return activity;
  }
}
