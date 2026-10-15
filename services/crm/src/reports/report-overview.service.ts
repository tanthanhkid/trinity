import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { Scope } from '@trinity/rbac';
import { scopeOf } from '@trinity/rbac';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import {
  buildActivityScopeWhere,
  buildContactScopeWhere,
} from './helpers/report-scope.helper';
import {
  ReportPeriod,
  buildDeltaMetric,
  computePreviousPeriod,
  DeltaMetric,
} from './helpers/report-date-range.helper';

const SCOPE_LABEL: Record<Scope, string> = {
  own: 'Của mình',
  team: 'Nhóm',
  subtree: 'Toàn bộ cấp dưới',
  all: 'Toàn công ty',
};

export interface ReportOverviewResult {
  new_customers: DeltaMetric;
  activities: DeltaMetric;
  scope_label: string;
}

@Injectable()
export class ReportOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async getOverview(user: AuthUser, period: ReportPeriod): Promise<ReportOverviewResult> {
    const owner = await this.scope.ownerIds(user, 'reports.overview');
    const reportsScope = scopeOf(user.grants, 'reports.overview');
    // Guard `@Can('reports.overview')` đã kiểm quyền — `owner === null` không
    // xảy ra trên đường bình thường; coalesce về rỗng để fail-closed.
    const effectiveOwner = owner ?? [];
    if (effectiveOwner !== 'all' && effectiveOwner.length === 0) {
      return this.emptyResult(reportsScope);
    }
    const previous = computePreviousPeriod(period);
    const [current, prior] = await Promise.all([
      this.fetchBundle(effectiveOwner, period),
      this.fetchBundle(effectiveOwner, previous),
    ]);

    return {
      new_customers: buildDeltaMetric(current.newCustomers, prior.newCustomers),
      activities: buildDeltaMetric(current.activities, prior.activities),
      scope_label: reportsScope ? SCOPE_LABEL[reportsScope] : SCOPE_LABEL.all,
    };
  }

  private async fetchBundle(
    owner: number[] | 'all',
    period: ReportPeriod,
  ): Promise<{ newCustomers: number; activities: number }> {
    const dateFilter = { gte: period.dateFrom, lte: period.dateTo };
    const [newCustomers, activities] = await Promise.all([
      this.prisma.contact.count({
        where: buildContactScopeWhere(owner, { created_at: dateFilter }),
      }),
      this.prisma.activity.count({
        where: buildActivityScopeWhere(owner, { created_at: dateFilter }),
      }),
    ]);
    return { newCustomers, activities };
  }

  private emptyResult(reportsScope: Scope | null): ReportOverviewResult {
    const zero = buildDeltaMetric(0, 0);
    return {
      new_customers: zero,
      activities: zero,
      scope_label: reportsScope ? SCOPE_LABEL[reportsScope] : SCOPE_LABEL.all,
    };
  }
}
