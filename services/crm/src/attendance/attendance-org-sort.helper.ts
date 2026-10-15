import type { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';

/**
 * Sắp xếp "Lịch sử chấm công" + xuất Excel theo sơ đồ tổ chức:
 * nhóm Phòng ban → Team → cấp chức danh (job_titles.sort_order DESC) → tên.
 *
 * Team CHÍNH THỨC resolve theo CÙNG quy tắc 3 tầng của `RESOLVED_TEAM_ID_SQL`
 * (attendance.service.ts, dùng cho filter/thống kê Team): (1) `employees.team_id`
 * trực tiếp → (2) NV là trưởng nhóm (`teams.team_lead_id = user.id`) → (3) quản lý
 * của NV là trưởng nhóm (`teams.team_lead_id = user.manager_id`, backward-compat).
 *
 * DÙNG CHUNG cho `attendance.service.ts::listRecords` (UI) và
 * `attendance-export.service.ts::exportToExcel` (Excel) — đảm bảo 2 nơi
 * KHÔNG BAO GIỜ lệch thứ tự.
 */

export interface TeamLite {
  id: number;
  team_lead_id: number | null;
}

export interface TeamOrgLookup {
  /** id trưởng nhóm → id team (đầu tiên theo id tăng dần, khớp `ORDER BY id LIMIT 1`). */
  teamIdByLeadId: Map<number, number>;
  teamNameById: Map<number, string>;
}

/** Tải toàn bộ team (bảng nhỏ, <10K dòng) 1 lần/request để resolve Team CHÍNH THỨC. */
export async function loadTeamOrgLookup(prisma: PrismaService): Promise<TeamOrgLookup> {
  const teams = (await prisma.team.findMany({
    select: { id: true, name: true, team_lead_id: true },
  })) as Array<{ id: number; name: string; team_lead_id: number | null }>;
  const sorted = [...teams].sort((a, b) => a.id - b.id);
  const teamIdByLeadId = new Map<number, number>();
  for (const t of sorted) {
    if (t.team_lead_id != null && !teamIdByLeadId.has(t.team_lead_id)) {
      teamIdByLeadId.set(t.team_lead_id, t.id);
    }
  }
  return {
    teamIdByLeadId,
    teamNameById: new Map(teams.map((t) => [t.id, t.name])),
  };
}

/** Thông tin tối thiểu 1 user cần để resolve Team + rank chức danh. */
export interface OrgUserLite {
  id: number;
  manager_id: number | null;
  full_name: string | null;
  employee: {
    team_id: number | null;
    department: string | null;
    jobTitle: { sort_order: number } | null;
  } | null;
}

/** Resolve tên Team CHÍNH THỨC của 1 NV — mirror `RESOLVED_TEAM_ID_SQL`. */
export function resolveTeamName(
  user: OrgUserLite | null | undefined,
  lookup: TeamOrgLookup,
): string | null {
  if (!user) return null;
  const directTeamId = user.employee?.team_id ?? null;
  const resolvedId =
    directTeamId ??
    lookup.teamIdByLeadId.get(user.id) ??
    (user.manager_id != null ? lookup.teamIdByLeadId.get(user.manager_id) : undefined) ??
    null;
  return resolvedId != null ? (lookup.teamNameById.get(resolvedId) ?? null) : null;
}

/**
 * SQL fragment resolve Team CHÍNH THỨC của 1 NV — 3 tầng (mirror
 * `resolveTeamName` ở trên): (1) `employees.team_id` gán trực tiếp → (2) NV là
 * trưởng nhóm (`teams.team_lead_id = u.id`) → (3) quản lý NV là trưởng nhóm
 * (`teams.team_lead_id = u.manager_id`). Yêu cầu alias `e` (employees) + `u`
 * (users) trong FROM/JOIN của câu query dùng fragment này.
 *
 * NGUỒN DUY NHẤT — dùng ở CẢ filter thống kê (`buildStatsEmpFilter`) LẪN
 * filter 4 tab chấm công (`resolveTeamMemberUserIds`) để tránh 2
 * nơi lệch nhau (không so trực tiếp cột thô `employees.team_id` — đa số NV có team qua
 * tầng 2/3, không gán trực tiếp).
 */
export const RESOLVED_TEAM_ID_SQL = Prisma.sql`COALESCE(
  e.team_id,
  (SELECT tl.id FROM teams tl WHERE tl.team_lead_id = u.id ORDER BY tl.id LIMIT 1),
  (SELECT tm.id FROM teams tm WHERE tm.team_lead_id = u.manager_id ORDER BY tm.id LIMIT 1)
)`;

/**
 * Danh sách `user_id` của mọi NV có Team CHÍNH THỨC (resolve 3 tầng) = `teamId`
 * dùng để lọc `listRecords`/`getWorkdaysMatrix`/`listRequests` theo Team qua
 * `where.user_id = { in: [...] }` (KHÔNG lọc trực tiếp `employees.team_id`, xem
 * JSDoc `RESOLVED_TEAM_ID_SQL`). Bảng `employees` nhỏ (~150-300 dòng) → 1 query
 * raw SQL rẻ, không cần cache.
 */
export async function resolveTeamMemberUserIds(
  prisma: PrismaService,
  teamId: number,
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ user_id: number }>>`
    SELECT e.user_id
    FROM employees e
    JOIN users u ON u.id = e.user_id
    WHERE ${RESOLVED_TEAM_ID_SQL} = ${teamId}
  `;
  return rows.map((r) => r.user_id);
}

/**
 * Giao (AND) 1 điều kiện `user_id` Prisma đã có (nếu có) với danh sách
 * `allowedIds` (vd Team filter resolve 3 tầng) — tránh 1 filter ghi đè âm thầm
 * filter kia khi nhiều điều kiện cùng nhắm cột `user_id` (Team +
 * IDOR self-scope + `dto.user_id` có thể cùng áp dụng). Hỗ trợ 3 dạng
 * `where.user_id` hiện có trong `attendance.service.ts`: `undefined`, số đơn,
 * hoặc `{ in: number[] }`. Không tìm thấy union nào khớp (result rỗng) → dùng
 * sentinel `-1` (user id luôn dương) để trả 0 dòng an toàn, KHÔNG throw.
 */
export function intersectUserIdFilter(
  existing: unknown,
  allowedIds: number[],
): number | { in: number[] } {
  const allowedSet = new Set(allowedIds);
  if (existing === undefined) return { in: allowedIds };
  if (typeof existing === 'number') {
    return allowedSet.has(existing) ? existing : -1;
  }
  if (existing && typeof existing === 'object' && 'in' in (existing as Record<string, unknown>)) {
    const ids = (existing as { in: number[] }).in;
    return { in: ids.filter((id) => allowedSet.has(id)) };
  }
  return { in: allowedIds };
}

/** 1 dòng rút gọn để so sánh theo sơ đồ tổ chức. */
export interface OrgSortRow {
  department: string | null;
  team_name: string | null;
  job_title_sort_order: number | null;
  full_name: string | null;
}

export function toOrgSortRow(
  user: OrgUserLite | null | undefined,
  teamName: string | null,
): OrgSortRow {
  return {
    department: user?.employee?.department ?? null,
    team_name: teamName,
    job_title_sort_order: user?.employee?.jobTitle?.sort_order ?? null,
    full_name: user?.full_name ?? null,
  };
}

/**
 * So sánh 2 dòng theo sơ đồ tổ chức: Phòng ban (A→Z, thiếu xếp CUỐI) → Team (A→Z,
 * thiếu xếp CUỐI) → cấp chức danh (`job_titles.sort_order` DESC — Trưởng nhóm chính(60)
 * → Chuyên viên chính(30) → Chuyên viên(20) → Nhân viên(10); NULL xếp dưới cùng) → tên (A→Z).
 * KHÔNG hardcode tên chức danh — tự đúng khi HR thêm chức danh mới qua sort_order.
 */
export function compareByOrgOrder(a: OrgSortRow, b: OrgSortRow): number {
  const deptA = a.department?.trim() || null;
  const deptB = b.department?.trim() || null;
  if (deptA !== deptB) {
    if (deptA === null) return 1;
    if (deptB === null) return -1;
    return deptA.localeCompare(deptB, 'vi');
  }

  const teamA = a.team_name?.trim() || null;
  const teamB = b.team_name?.trim() || null;
  if (teamA !== teamB) {
    if (teamA === null) return 1;
    if (teamB === null) return -1;
    return teamA.localeCompare(teamB, 'vi');
  }

  const rankA = a.job_title_sort_order ?? -1;
  const rankB = b.job_title_sort_order ?? -1;
  if (rankA !== rankB) return rankB - rankA; // DESC — cấp cao hơn lên trước

  return (a.full_name ?? '').localeCompare(b.full_name ?? '', 'vi');
}
