import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import {
  buildActivityScopeWhere,
  buildContactScopeWhere,
} from './helpers/report-scope.helper';
import { resolveEmployeeNames } from './helpers/report-employee-names.helper';
import { ReportPeriod } from './helpers/report-date-range.helper';

export interface EmployeePerformanceRow {
  user_id: number;
  full_name: string;
  email: string;
  new_customers: number;
  activities_count: number;
}

@Injectable()
export class ReportEmployeePerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async getPerformance(user: AuthUser, period: ReportPeriod): Promise<EmployeePerformanceRow[]> {
    const owner = (await this.scope.ownerIds(user, 'reports.staff')) ?? [];
    if (owner !== 'all' && owner.length === 0) return [];

    const dateFilter = { gte: period.dateFrom, lte: period.dateTo };
    const [byCustomer, byActivity] = await Promise.all([
      this.prisma.contact.groupBy({
        by: ['assigned_to'],
        // Nhóm theo `assigned_to`: bảng xếp hạng CHỈ được có dòng của nhân viên
        // TRONG phạm vi — `buildContactScopeWhere` còn OR cả `created_by_id`,
        // nếu không ghim thêm `assigned_to` thì contact do mình tạo nhưng giao
        // cho người ngoài phạm vi sẽ làm lộ dòng (tên + số) của người đó.
        where: buildContactScopeWhere(owner, {
          created_at: dateFilter,
          assigned_to: owner === 'all' ? { not: null } : { in: owner },
        }),
        _count: { _all: true },
      }),
      this.prisma.activity.groupBy({
        by: ['created_by'],
        where: buildActivityScopeWhere(owner, {
          created_at: dateFilter,
          created_by: { not: null },
        }),
        _count: { _all: true },
      }),
    ]);

    return this.mergeRows(byCustomer, byActivity);
  }

  private async mergeRows(
    byCustomer: { assigned_to: number | null; _count: { _all: number } }[],
    byActivity: { created_by: number | null; _count: { _all: number } }[],
  ): Promise<EmployeePerformanceRow[]> {
    const customerMap = new Map(byCustomer.map((r) => [r.assigned_to as number, r._count._all]));
    const activityMap = new Map(byActivity.map((r) => [r.created_by as number, r._count._all]));

    const allIds = new Set<number>([
      ...customerMap.keys(),
      ...activityMap.keys(),
    ]);
    const names = await resolveEmployeeNames(this.prisma, Array.from(allIds));

    return Array.from(allIds).map((id) => {
      const employee = names.get(id);
      return {
        user_id: id,
        full_name: employee?.full_name ?? `NV #${id}`,
        email: employee?.email ?? '',
        new_customers: customerMap.get(id) ?? 0,
        activities_count: activityMap.get(id) ?? 0,
      };
    });
  }
}
