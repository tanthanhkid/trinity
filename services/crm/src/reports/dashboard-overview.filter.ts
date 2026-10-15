import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { can } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';

/**
 * Bộ lọc Tổng quan theo cây `users.manager_id` — CHỈ người giữ
 * `reports.overview` với phạm vi >= `team` được áp dụng ; người khác bị BỎ QUA im lặng (không 403 để FE cũ/mới
 * đều chạy). Bộ lọc luôn AND-compose BÊN TRONG phạm vi của chính người gọi.
 */
export class DashboardFilterQuery {
  @ApiPropertyOptional({ description: 'Phòng kinh doanh = id người quản lý cấp cao (gồm cả cây dưới)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  dept_head_id?: number;

  @ApiPropertyOptional({ description: 'Team = id trưởng nhóm (gồm cả thành viên trực tiếp)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  team_lead_id?: number;

  @ApiPropertyOptional({ description: 'Nhân viên / người thực hiện cụ thể (kể cả chính mình)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  user_id?: number;
}

/** `users` đã nạp: chỉ cần `id` + `manager_id` để dựng cây. */
interface PrismaUserTreeLike {
  user: {
    findMany: (args: {
      where: { deleted_at: null };
      select: { id: true; manager_id: true };
    }) => Promise<{ id: number; manager_id: number | null }[]>;
  };
}

export function canUseDashboardFilter(user: AuthUser): boolean {
  return can(user.grants, 'reports.overview', 'team');
}

/** Chuỗi ổn định cho cache key; rỗng = không lọc / không được lọc. */
export function filterCacheKey(user: AuthUser, q: DashboardFilterQuery): string {
  if (!canUseDashboardFilter(user)) return '';
  return `${q.dept_head_id ?? 0}.${q.team_lead_id ?? 0}.${q.user_id ?? 0}`;
}

function intersect(a: number[], b: number[]): number[] {
  const set = new Set(b);
  return a.filter((id) => set.has(id));
}

/** Map `manager_id` → danh sách con trực tiếp (user chưa xoá mềm). */
export async function loadChildrenMap(prisma: PrismaUserTreeLike): Promise<Map<number, number[]>> {
  const rows = await prisma.user.findMany({
    where: { deleted_at: null },
    select: { id: true, manager_id: true },
  });
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.manager_id == null) continue;
    children.set(r.manager_id, [...(children.get(r.manager_id) ?? []), r.id]);
  }
  return children;
}

/** `id` + toàn bộ cấp dưới (BFS có tập `seen` nên vòng manager không treo). */
export function subtreeIds(children: Map<number, number[]>, id: number): number[] {
  const seen = new Set<number>([id]);
  const queue = [id];
  while (queue.length > 0) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return [...seen];
}

/**
 * Tập user id sau khi lọc (AND = giao các điều kiện). `null` = KHÔNG lọc.
 * `[]` = lọc ra rỗng (0 dòng, KHÔNG nới).
 */
export async function resolveFilterUserIds(
  prisma: PrismaUserTreeLike,
  user: AuthUser,
  q: DashboardFilterQuery,
): Promise<number[] | null> {
  if (!canUseDashboardFilter(user)) return null;
  if (!q.dept_head_id && !q.team_lead_id && !q.user_id) return null;
  const children = await loadChildrenMap(prisma);
  const sets: number[][] = [];
  if (q.dept_head_id) sets.push(subtreeIds(children, q.dept_head_id));
  if (q.team_lead_id) sets.push([q.team_lead_id, ...(children.get(q.team_lead_id) ?? [])]);
  if (q.user_id) sets.push([q.user_id]);
  return sets.reduce((acc, s) => intersect(acc, s));
}

/**
 * AND-compose bộ lọc BÊN TRONG phạm vi `reports.overview`: lọc ngoài phạm vi →
 * rỗng, không leak. `owner === 'all'` + lọc = đúng tập lọc.
 */
export function composeScope(owner: number[] | 'all', filterIds: number[] | null): number[] | 'all' {
  if (filterIds === null) return owner;
  if (owner === 'all') return filterIds;
  return intersect(owner, filterIds);
}
