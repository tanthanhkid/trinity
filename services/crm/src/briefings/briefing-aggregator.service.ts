import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Prisma } from '@trinity/prisma';
import { scopeWhere } from '@trinity/rbac-nest';
import { buildContactScope, buildDealScope, dealStatusInRange } from '../reports/dashboard-overview.scope';
import { slotWindows, vnDayKey, type Range } from './briefing-time';
import type { BriefingData, BriefingMetrics, BriefingScopeKind, BriefingSlot, Delta, TopSeller } from './briefing.types';

type Owner = number[] | 'all';

/**
 * Tổng hợp số liệu bản tin THEO PHẠM VI QUYỀN: `owner` = kết quả `ScopeService.ownerIds(user, 'reports.overview')`.
 * `'all'` = cả công ty; mảng = nhóm/chính mình; mảng rỗng = không ai (không tự nới) → toàn số 0.
 */
@Injectable()
export class BriefingAggregatorService {
  constructor(private readonly prisma: PrismaService) {}

  async collect(owner: Owner, slot: BriefingSlot, now: Date): Promise<BriefingData> {
    const w = slotWindows(slot, now);
    const metrics = owner !== 'all' && owner.length === 0 ? this.empty() : await this.metrics(owner, w, now);
    return {
      slot,
      day: vnDayKey(now),
      periodLabel: w.periodLabel,
      reminderLabel: w.reminderLabel,
      scope: this.scopeKind(owner),
      peopleCount: owner === 'all' ? await this.prisma.user.count({ where: { status: 'active', deleted_at: null } }) : owner.length,
      metrics,
    };
  }

  private scopeKind(owner: Owner): BriefingScopeKind {
    if (owner === 'all') return 'company';
    return owner.length > 1 ? 'team' : 'self';
  }

  private empty(): BriefingMetrics {
    const z: Delta = { value: 0, prev: 0 };
    return {
      newContacts: { ...z }, stageChanges: { ...z }, dealsCreated: { ...z }, dealsWon: { ...z },
      wonValue: { ...z }, dealsLost: { ...z }, overdueTasks: 0, callbacks: 0, topSellers: [],
    };
  }

  private async metrics(owner: Owner, w: ReturnType<typeof slotWindows>, now: Date): Promise<BriefingMetrics> {
    const pair = async <T>(fn: (r: Range) => Promise<T>): Promise<[T, T]> =>
      Promise.all([fn(w.cur), fn(w.prev)]);
    const [newC, stage, created, won, lost] = await Promise.all([
      pair((r) => this.newContacts(owner, r)),
      pair((r) => this.stageChanges(owner, r)),
      pair((r) => this.dealsCreated(owner, r)),
      pair((r) => this.dealsByStatus(owner, 'won', r)),
      pair((r) => this.dealsByStatus(owner, 'lost', r)),
    ]);
    const [overdueTasks, callbacks, topSellers] = await Promise.all([
      this.overdueTasks(owner, now),
      this.callbacks(owner, w.callbacks),
      this.topSellers(owner, w.cur),
    ]);
    return {
      newContacts: { value: newC[0], prev: newC[1] },
      stageChanges: { value: stage[0], prev: stage[1] },
      dealsCreated: { value: created[0], prev: created[1] },
      dealsWon: { value: won[0].count, prev: won[1].count },
      wonValue: { value: won[0].value, prev: won[1].value },
      dealsLost: { value: lost[0].count, prev: lost[1].count },
      overdueTasks, callbacks, topSellers,
    };
  }

  private newContacts(owner: Owner, r: Range): Promise<number> {
    return this.prisma.contact.count({
      where: { AND: [buildContactScope(owner), { created_at: { gte: r.start, lt: r.end } }] },
    });
  }

  private stageChanges(owner: Owner, r: Range): Promise<number> {
    const where: Prisma.ActivityWhereInput = {
      action: 'stage_change',
      created_at: { gte: r.start, lt: r.end },
      ...(owner === 'all' ? {} : { contact: buildContactScope(owner) }),
    };
    return this.prisma.activity.count({ where });
  }

  private dealsCreated(owner: Owner, r: Range): Promise<number> {
    return this.prisma.deal.count({
      where: { AND: [buildDealScope(owner), { created_at: { gte: r.start, lt: r.end } }] },
    });
  }

  private async dealsByStatus(owner: Owner, status: 'won' | 'lost', r: Range): Promise<{ count: number; value: number }> {
    const agg = await this.prisma.deal.aggregate({
      where: { AND: [buildDealScope(owner), dealStatusInRange(status, r)] },
      _count: { _all: true },
      _sum: { value: true },
    });
    return { count: agg._count._all, value: Number(agg._sum.value ?? 0) };
  }

  private overdueTasks(owner: Owner, now: Date): Promise<number> {
    return this.prisma.kanbanCard.count({
      where: {
        AND: [
          scopeWhere(owner, ['assignee_id']) as Prisma.KanbanCardWhereInput,
          { deleted_at: null, completed_at: null, due_completed_at: null, due_at: { lt: now } },
        ],
      },
    });
  }

  private callbacks(owner: Owner, r: Range): Promise<number> {
    return this.prisma.contact.count({
      where: { AND: [buildContactScope(owner), { reminder_at: { gte: r.start, lt: r.end } }] },
    });
  }

  /** Chỉ có nghĩa khi phạm vi > 1 người; top 3 theo giá trị deal thắng trong kỳ. */
  private async topSellers(owner: Owner, r: Range): Promise<TopSeller[]> {
    if (owner !== 'all' && owner.length <= 1) return [];
    const rows = await this.prisma.deal.groupBy({
      by: ['assigned_to'],
      where: { AND: [buildDealScope(owner), dealStatusInRange('won', r)] },
      _count: { _all: true },
      _sum: { value: true },
      orderBy: { _sum: { value: 'desc' } },
      take: 3,
    });
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((x) => x.assigned_to) } },
      select: { id: true, full_name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.full_name]));
    return rows.map((x) => ({
      user_id: x.assigned_to,
      name: names.get(x.assigned_to) ?? `#${x.assigned_to}`,
      won_count: x._count._all,
      won_value: Number(x._sum.value ?? 0),
    }));
  }
}
