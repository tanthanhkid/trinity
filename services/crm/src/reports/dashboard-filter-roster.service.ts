import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
// ScopeService PHẢI import THẬT (không type-only) — DI của NestJS cần giá trị lúc chạy.
import { ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { canUseDashboardFilter } from './dashboard-overview.filter';

export interface DashboardFilterRosterItem {
  id: number;
  full_name: string;
  /** Cha trực tiếp trong cây `manager_id` — FE dùng để lọc phụ thuộc (cascade). */
  manager_id: number | null;
}

export interface DashboardFilterRoster {
  dept_heads: DashboardFilterRosterItem[];
  team_leads: DashboardFilterRosterItem[];
  sales: DashboardFilterRosterItem[];
}

/**
 * Roster cho dropdown lọc Tổng quan — lấy từ cây `users.manager_id` (đúng nguồn BE lọc).
 *
 * KHÔNG còn phân theo TÊN vai trò (vai trò do admin tự tạo). Cấp bậc suy từ
 * CHIỀU CAO trong cây: lá (không cấp dưới) = `sales`; có cấp dưới toàn lá = `team_leads`;
 * cao hơn = `dept_heads` (quản lý cấp cao). Chỉ trả người TRONG phạm vi `reports.overview` của người gọi
 * (không leak), và chỉ scope >= team được gọi (kiểm ở service).
 */
@Injectable()
export class DashboardFilterRosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async getRoster(user: AuthUser): Promise<DashboardFilterRoster> {
    if (!canUseDashboardFilter(user)) {
      throw new ForbiddenException('Không có quyền dùng bộ lọc Tổng quan');
    }
    const owner = (await this.scope.ownerIds(user, 'reports.overview')) ?? [];
    const rows = await this.prisma.user.findMany({
      where: { deleted_at: null, status: 'active' },
      orderBy: { full_name: 'asc' },
      select: { id: true, full_name: true, manager_id: true },
    });
    const height = this.heights(rows);
    const visible = rows.filter((r) => owner === 'all' || owner.includes(r.id));
    const pick = (match: (h: number) => boolean): DashboardFilterRosterItem[] =>
      visible
        .filter((r) => match(height.get(r.id) ?? 0))
        .map((r) => ({ id: r.id, full_name: r.full_name, manager_id: r.manager_id }));
    return {
      dept_heads: pick((h) => h >= 2),
      team_leads: pick((h) => h === 1),
      sales: pick((h) => h === 0),
    };
  }

  /** Chiều cao cây con của từng user (0 = lá). Chống vòng manager bằng tập đang duyệt. */
  private heights(rows: { id: number; manager_id: number | null }[]): Map<number, number> {
    const children = new Map<number, number[]>();
    for (const r of rows) {
      if (r.manager_id != null) children.set(r.manager_id, [...(children.get(r.manager_id) ?? []), r.id]);
    }
    const memo = new Map<number, number>();
    const walk = (id: number, path: Set<number>): number => {
      const hit = memo.get(id);
      if (hit !== undefined) return hit;
      let h = 0;
      path.add(id);
      for (const c of children.get(id) ?? []) if (!path.has(c)) h = Math.max(h, 1 + walk(c, path));
      path.delete(id);
      memo.set(id, h);
      return h;
    };
    for (const r of rows) walk(r.id, new Set());
    return memo;
  }
}
