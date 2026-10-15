import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.provider';
import { scopeOf } from '@trinity/rbac';
// ScopeService PHẢI import THẬT (không type-only) — DI của NestJS cần giá trị lúc chạy.
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { buildContactScope, buildDealScope, dealStatusInRange } from './dashboard-overview.scope';
import { vnMonthLabel, vnMonthRange } from './dashboard-overview.util';
import {
  DashboardFilterQuery,
  composeScope,
  filterCacheKey,
  resolveFilterUserIds,
} from './dashboard-overview.filter';

/** Dashboard 5 phút theo quy ước cache của repo. */
export const OVERVIEW_CACHE_TTL_SEC = 300;
const CACHE_VERSION = 'v3';
const MONTHS = 6;

export interface DashboardOverviewResult {
  scope_label: 'cá nhân' | 'team' | 'phòng' | 'toàn hệ thống' | 'theo bộ lọc';
  customers: { total: number; new_this_month: number; new_last_month: number };
  opportunities: { open: number; new_this_month: number; new_last_month: number };
  /**
   * Doanh thu = tổng `value` thương vụ `won`, gán theo `updated_at` (bảng `deals`
   * KHÔNG có cột won_at). `null` = không có thương vụ thắng nào có giá trị
   * (KHÁC 0 — FE hiện "—").
   */
  revenue: { this_month: number | null; last_month: number | null };
  deal_status: { open: number; won: number; lost: number };
  months: string[];
  customers_by_month: number[];
  /** Thương vụ MỚI tạo theo tháng (cùng trục `months`). */
  opportunities_by_month: number[];
  revenue_by_month: (number | null)[];
}

@Injectable()
export class DashboardOverviewService {
  private readonly logger = new Logger(DashboardOverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getOverview(
    user: AuthUser,
    filter: DashboardFilterQuery = {},
  ): Promise<DashboardOverviewResult> {
    // Phạm vi = quyền `reports.overview` (không có → `[]` = fail-closed, không ai).
    const owner = (await this.scope.ownerIds(user, 'reports.overview')) ?? [];
    const filterIds = await resolveFilterUserIds(this.prisma, user, filter);
    // Lọc AND-compose BÊN TRONG phạm vi: ngoài phạm vi → rỗng, không leak.
    const scopeIds = composeScope(owner, filterIds);
    const scopePart = scopeIds === 'all' ? 'all' : [...scopeIds].sort((a, b) => a - b).join('-');
    const fKey = filterCacheKey(user, filter);
    const key = `dashboard:overview:${CACHE_VERSION}:${user.userId}:${fKey}:${scopePart}`;
    try {
      const raw = await this.redis.get(key);
      if (raw) return JSON.parse(raw) as DashboardOverviewResult;
    } catch (err) {
      this.logger.warn(`Redis get failed (${key}): ${err instanceof Error ? err.message : err}`);
    }
    const result = await this.compute(user, scopeIds, filterIds !== null);
    try {
      await this.redis.set(key, JSON.stringify(result), 'EX', OVERVIEW_CACHE_TTL_SEC);
    } catch (err) {
      this.logger.warn(`Redis set failed (${key}): ${err instanceof Error ? err.message : err}`);
    }
    return result;
  }

  private scopeLabel(user: AuthUser, filtered = false): DashboardOverviewResult['scope_label'] {
    if (filtered) return 'theo bộ lọc';
    switch (scopeOf(user.grants, 'reports.overview')) {
      case 'own':
        return 'cá nhân';
      case 'team':
        return 'team';
      case 'subtree':
        return 'phòng';
      default:
        return 'toàn hệ thống';
    }
  }

  private async compute(
    user: AuthUser,
    scopeIds: number[] | 'all',
    filtered: boolean,
  ): Promise<DashboardOverviewResult> {
    const empty = scopeIds !== 'all' && scopeIds.length === 0;
    const offsets = Array.from({ length: MONTHS }, (_, i) => MONTHS - 1 - i); // cũ → mới
    const contactScope = buildContactScope(scopeIds);
    const dealScope = buildDealScope(scopeIds);
    const noneMonths = offsets.map((o) => vnMonthLabel(o));
    if (empty) return this.emptyResult(user, noneMonths, filtered);

    const customersByMonth = await Promise.all(
      offsets.map((o) => {
        const r = vnMonthRange(o);
        return this.prisma.contact.count({
          where: { AND: [contactScope, { created_at: { gte: r.start, lt: r.end } }] },
        });
      }),
    );
    const [total, statusGroups, wonDeals] = await Promise.all([
      this.prisma.contact.count({ where: contactScope }),
      this.prisma.deal.groupBy({ by: ['status'], where: dealScope, _count: { _all: true } }),
      this.prisma.deal.findMany({
        // Thương vụ thắng trong cửa sổ 6 tháng — số dòng nhỏ (bảng `deals`).
        where: { AND: [dealScope, dealStatusInRange('won', { start: vnMonthRange(MONTHS - 1).start })] },
        select: { value: true, updated_at: true, won_at: true },
      }),
    ]);
    const newDeals = await Promise.all(
      offsets.map((o) => {
        const r = vnMonthRange(o);
        return this.prisma.deal.count({
          where: { AND: [dealScope, { created_at: { gte: r.start, lt: r.end } }] },
        });
      }),
    );
    const status = { open: 0, won: 0, lost: 0 };
    for (const g of statusGroups) {
      if (g.status in status) status[g.status as keyof typeof status] = g._count._all;
    }
    const revenueByMonth = offsets.map((o) => {
      const r = vnMonthRange(o);
      let sum: number | null = null;
      for (const d of wonDeals) {
        const wonOn = d.won_at ?? d.updated_at; // deal thắng từ trước khi có won_at: dùng updated_at
        if (d.value === null || wonOn < r.start || wonOn >= r.end) continue;
        sum = (sum ?? 0) + Number(d.value);
      }
      return sum;
    });
    const last = MONTHS - 1;
    return {
      scope_label: this.scopeLabel(user, filtered),
      customers: {
        total,
        new_this_month: customersByMonth[last],
        new_last_month: customersByMonth[last - 1],
      },
      opportunities: {
        open: status.open,
        new_this_month: newDeals[last],
        new_last_month: newDeals[last - 1],
      },
      revenue: { this_month: revenueByMonth[last], last_month: revenueByMonth[last - 1] },
      deal_status: status,
      months: noneMonths,
      customers_by_month: customersByMonth,
      opportunities_by_month: newDeals,
      revenue_by_month: revenueByMonth,
    };
  }

  private emptyResult(user: AuthUser, months: string[], filtered: boolean): DashboardOverviewResult {
    return {
      scope_label: this.scopeLabel(user, filtered),
      customers: { total: 0, new_this_month: 0, new_last_month: 0 },
      opportunities: { open: 0, new_this_month: 0, new_last_month: 0 },
      revenue: { this_month: null, last_month: null },
      deal_status: { open: 0, won: 0, lost: 0 },
      months,
      customers_by_month: months.map(() => 0),
      opportunities_by_month: months.map(() => 0),
      revenue_by_month: months.map(() => null),
    };
  }
}
