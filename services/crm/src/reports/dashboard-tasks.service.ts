import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
// ScopeService PHẢI import THẬT (không type-only) — DI của NestJS cần giá trị lúc chạy.
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { buildKanbanBoardVisibilityWhere, getUserRoleIds } from '../kanban/common/kanban-rbac.helper';
import { buildContactScope } from './dashboard-overview.scope';
import { vnTodayRange } from './dashboard-overview.util';
import { DashboardFilterQuery, composeScope, resolveFilterUserIds } from './dashboard-overview.filter';

const MAX_ITEMS = 8;
const CALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DashboardTaskItem {
  key: string;
  kind: 'kanban' | 'reminder';
  /** kanban: card id · reminder: contact id (0 nếu khách ngoài phạm vi xem của người gọi) */
  id: number;
  title: string;
  contact_id: number | null;
  contact_name: string | null;
  due_at: string;
  priority: string | null;
  overdue: boolean;
}

export interface DashboardTasksResult {
  /** Tổng việc chưa xong đến hạn hôm nay hoặc quá hạn. */
  total: number;
  due_today: number;
  overdue: number;
  items: DashboardTaskItem[];
}

/**
 * "Việc cần làm hôm nay" — mặc định CHỈ việc của CHÍNH user (least privilege, không lộ
 * việc cross-team kể cả quản lý): card Kanban được giao cho mình và
 * lịch hẹn nhắc (`contacts.reminder_at`) của contact giao cho mình.
 * Ngoại lệ: người giữ `reports.overview` phạm vi >= team lọc xem việc của
 * người khác TRONG phạm vi của mình (giao với bộ lọc, không nới).
 * Không cache: danh sách nhỏ, có index (`assignee_id`, `assigned_to`) và user
 * tick hoàn thành phải thấy ngay.
 */
@Injectable()
export class DashboardTasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async getTasks(user: AuthUser, filter: DashboardFilterQuery = {}): Promise<DashboardTasksResult> {
    const { start, end } = vnTodayRange();
    // Mặc định CHỈ việc của chính mình; bộ lọc (chỉ phạm vi >= team) đổi người thực hiện,
    // luôn giao với phạm vi `reports.overview` của người gọi (không leak ngoài phạm vi).
    const assigneeIds = await this.resolveAssignees(user, filter);
    const cardWhere = await this.cardWhere(user, end, assigneeIds);
    const reminderWhere = {
      assigned_to: { in: assigneeIds },
      deleted_at: null,
      reminder_at: { gte: new Date(start.getTime() - CALLBACK_LOOKBACK_MS), lt: end },
    };
    const [cards, cardTotal, cardToday, reminders, reminderTotal, reminderToday] = await Promise.all([
      this.prisma.kanbanCard.findMany({
        where: cardWhere,
        orderBy: { due_at: 'asc' },
        take: MAX_ITEMS,
        select: { id: true, title: true, contact_id: true, due_at: true, priority: true },
      }),
      this.prisma.kanbanCard.count({ where: cardWhere }),
      this.prisma.kanbanCard.count({ where: { AND: [cardWhere, { due_at: { gte: start } }] } }),
      this.prisma.contact.findMany({
        where: reminderWhere,
        orderBy: { reminder_at: 'asc' },
        take: MAX_ITEMS,
        select: { id: true, full_name: true, reminder_notes: true, reminder_at: true },
      }),
      this.prisma.contact.count({ where: reminderWhere }),
      this.prisma.contact.count({
        where: { ...reminderWhere, reminder_at: { gte: start, lt: end } },
      }),
    ]);
    const names = await this.contactNames(user, [...cards.map((c) => c.contact_id), ...reminders.map((c) => c.id)]);
    const items: DashboardTaskItem[] = [
      ...cards.map((c) => ({
        key: `k${c.id}`,
        kind: 'kanban' as const,
        id: c.id,
        title: c.title,
        contact_id: c.contact_id,
        contact_name: c.contact_id ? (names.get(c.contact_id) ?? null) : null,
        due_at: c.due_at!.toISOString(),
        priority: c.priority,
        overdue: c.due_at! < start,
      })),
      ...reminders.map((c, i) => {
        // Khách ngoài phạm vi contacts.view: không lộ ghi chú nhắc hẹn lẫn id khách.
        const visible = names.has(c.id);
        return {
          // Khách ngoài phạm vi: không đưa id khách vào key/id (chỉ số thứ tự để key vẫn duy nhất).
          key: visible ? `c${c.id}` : `c-hidden-${i}`,
          kind: 'reminder' as const,
          id: visible ? c.id : 0,
          title: (visible && c.reminder_notes?.trim()) || 'Nhắc liên hệ lại',
          contact_id: visible ? c.id : null,
          contact_name: names.get(c.id) ?? null,
          due_at: c.reminder_at!.toISOString(),
          priority: null,
          overdue: c.reminder_at! < start,
        };
      }),
    ]
      .sort((a, b) => a.due_at.localeCompare(b.due_at))
      .slice(0, MAX_ITEMS);
    const total = cardTotal + reminderTotal;
    const dueToday = cardToday + reminderToday;
    return { total, due_today: dueToday, overdue: total - dueToday, items };
  }

  private async resolveAssignees(user: AuthUser, filter: DashboardFilterQuery): Promise<number[]> {
    const filterIds = await resolveFilterUserIds(this.prisma, user, filter);
    if (filterIds === null) return [user.userId];
    const owner = (await this.scope.ownerIds(user, 'reports.overview')) ?? [];
    const ids = composeScope(owner, filterIds);
    return ids === 'all' ? filterIds : ids;
  }

  /** Card chưa xong, đến hạn ≤ hết hôm nay, của người thực hiện đã chọn, board hiển thị với vai trò của user. */
  private async cardWhere(user: AuthUser, endOfToday: Date, assigneeIds: number[]) {
    const roleIds = await getUserRoleIds(this.prisma, user.userId);
    return {
      deleted_at: null,
      due_at: { not: null, lt: endOfToday },
      due_completed_at: null,
      completed_at: null,
      // Chỉ board ĐANG BẬT (kể cả người giữ `kanban.boards`) + hiển thị theo vai trò (AND, không spread).
      board: { AND: [{ is_active: true }, buildKanbanBoardVisibilityWhere(user, { roleIds })] },
      column: { is_archived: false, is_done: false },
      OR: [{ assignee_id: { in: assigneeIds } }, { assignees: { some: { user_id: { in: assigneeIds } } } }],
    };
  }

  /** Chỉ hiện tên khách nằm trong phạm vi RBAC của user (không lộ khách ngoài phạm vi). */
  private async contactNames(user: AuthUser, ids: (number | null)[]) {
    const wanted = Array.from(new Set(ids.filter((i): i is number => i !== null)));
    const map = new Map<number, string | null>();
    if (wanted.length === 0) return map;
    // Phạm vi `contacts.view` = đúng cái người này mở được ở Danh bạ (không `reports.overview`).
    const owner = (await this.scope.ownerIds(user, 'contacts.view')) ?? [];
    const rows = await this.prisma.contact.findMany({
      // AND-compose (không spread).
      where: { AND: [buildContactScope(owner), { id: { in: wanted } }] },
      select: { id: true, full_name: true },
    });
    for (const r of rows) map.set(r.id, r.full_name);
    return map;
  }
}
