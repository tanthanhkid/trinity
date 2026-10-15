import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import { buildContactScopeWhere } from './helpers/report-scope.helper';
import { ReportPeriod } from './helpers/report-date-range.helper';
import {
  buildReportBuckets,
  pickBucketGranularity,
  ReportBucket,
} from './helpers/report-time-buckets.helper';
import { resolveEmployeeNames } from './helpers/report-employee-names.helper';

export interface ReportBucketPoint {
  label: string;
  count: number;
}

export interface ReportBreakdownItem {
  id: number | null;
  label: string;
  count: number;
}

export interface ReportCustomersOverviewResult {
  trend: ReportBucketPoint[];
  by_source: ReportBreakdownItem[];
  by_status: ReportBreakdownItem[];
  by_assignee: ReportBreakdownItem[];
}

@Injectable()
export class ReportCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async getOverview(
    user: AuthUser,
    period: ReportPeriod,
  ): Promise<ReportCustomersOverviewResult> {
    const owner = (await this.scope.ownerIds(user, 'reports.customers')) ?? [];
    const where = buildContactScopeWhere(owner);
    const scopedWhere = {
      AND: [where, { created_at: { gte: period.dateFrom, lte: period.dateTo } }],
    };

    const [trend, bySource, byStatus, byAssignee] = await Promise.all([
      this.getTrend(scopedWhere, period),
      this.getBySource(scopedWhere),
      this.getByStatus(scopedWhere),
      this.getByAssignee(scopedWhere),
    ]);

    return { trend, by_source: bySource, by_status: byStatus, by_assignee: byAssignee };
  }

  /** Đếm theo bucket qua nhiều COUNT (mỗi bucket = 1 aggregate SQL thật, KHÔNG kéo rows). */
  private async getTrend(
    scopedWhere: Record<string, unknown>,
    period: ReportPeriod,
  ): Promise<ReportBucketPoint[]> {
    const granularity = pickBucketGranularity(period.dateFrom, period.dateTo);
    const buckets = buildReportBuckets(period.dateFrom, period.dateTo, granularity);
    const counts = await Promise.all(
      buckets.map((b: ReportBucket) =>
        this.prisma.contact.count({
          where: { AND: [scopedWhere, { created_at: { gte: b.start, lt: b.end } }] },
        }),
      ),
    );
    return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
  }

  private async getBySource(
    scopedWhere: Record<string, unknown>,
  ): Promise<ReportBreakdownItem[]> {
    const rows = await this.prisma.contact.groupBy({
      by: ['source_id'],
      where: scopedWhere,
      _count: { _all: true },
    });
    const ids = rows.map((r) => r.source_id).filter((id): id is number => id != null);
    const labels = await this.resolveSettingOptionLabels(ids);
    return rows
      .map((r) => ({
        id: r.source_id,
        label: r.source_id != null ? (labels.get(r.source_id) ?? `#${r.source_id}`) : 'Chưa xác định',
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  }

  private async getByStatus(
    scopedWhere: Record<string, unknown>,
  ): Promise<ReportBreakdownItem[]> {
    const rows = await this.prisma.contact.groupBy({
      by: ['contact_status_id'],
      where: scopedWhere,
      _count: { _all: true },
    });
    const ids = rows.map((r) => r.contact_status_id).filter((id): id is number => id != null);
    const labels = await this.resolveSettingOptionLabels(ids);
    return rows
      .map((r) => ({
        id: r.contact_status_id,
        label:
          r.contact_status_id != null
            ? (labels.get(r.contact_status_id) ?? `#${r.contact_status_id}`)
            : 'Chưa xác định',
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  }

  private async getByAssignee(
    scopedWhere: Record<string, unknown>,
  ): Promise<ReportBreakdownItem[]> {
    const rows = await this.prisma.contact.groupBy({
      by: ['assigned_to'],
      where: scopedWhere,
      _count: { _all: true },
    });
    const ids = rows.map((r) => r.assigned_to).filter((id): id is number => id != null);
    const names = await resolveEmployeeNames(this.prisma, ids);
    return rows
      .map((r) => ({
        id: r.assigned_to,
        label: r.assigned_to != null ? (names.get(r.assigned_to)?.full_name ?? `NV #${r.assigned_to}`) : 'Chưa gán',
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count);
  }

  private async resolveSettingOptionLabels(ids: number[]): Promise<Map<number, string>> {
    const distinct = Array.from(new Set(ids));
    if (distinct.length === 0) return new Map();
    const options = await this.prisma.settingOption.findMany({
      where: { id: { in: distinct } },
      select: { id: true, label: true },
    });
    return new Map(options.map((o) => [o.id, o.label]));
  }
}
