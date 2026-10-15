interface UserRow {
  id: number;
  full_name: string | null;
  manager_id: number | null;
}

interface PrismaUserFindMany {
  user: {
    findMany: (args: {
      where: { id: { in: number[] } };
      select: { id: true; full_name: true; manager_id: true };
    }) => Promise<UserRow[]>;
  };
}

/**
 * Batch nạp user theo id (bỏ qua khi rỗng → tránh IN []). Trả Map id→UserRow.
 * KHÔNG lọc `deleted_at` (khác scope helper RBAC): đây chỉ RESOLVE TÊN để đối soát —
 * giữ tên user đã xoá để KHÔNG mất attribution (row của họ đã bị scope WHERE chặn ở
 * tầng query nếu ngoài quyền).
 */
async function loadUsers(
  prisma: PrismaUserFindMany,
  ids: (number | null)[],
): Promise<Map<number, UserRow>> {
  const uniq = Array.from(new Set(ids.filter((id): id is number => id != null)));
  if (uniq.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: uniq } },
    select: { id: true, full_name: true, manager_id: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Vị trí owner trong cây tổ chức, suy từ chuỗi manager_id (không cần role). */
export interface OrgPlacement {
  deptId: number | null
  deptName: string | null
  teamId: number | null
  teamName: string | null
}

/**
 * Resolve vị trí tổ chức (Phòng KD/Team) cho 1 tập owner id — dùng khi cần cột org
 * PER-ROW (vd export Excel Danh bạ). owner không tìm thấy → không có key
 * trong Map (caller tự fallback nhãn "Không xác định").
 *
 * Logic quy chủ tổ chức THUẦN TUÝ, dùng bởi `contacts-export.service.ts`.
 */
export async function resolveOwnerPlacements(
  prisma: PrismaUserFindMany,
  ownerIds: (number | null)[],
): Promise<Map<number, OrgPlacement>> {
  const owners = await loadUsers(prisma, ownerIds)
  const teamLeads = await loadUsers(prisma, Array.from(owners.values(), (o) => o.manager_id))
  const depts = await loadUsers(prisma, Array.from(teamLeads.values(), (t) => t.manager_id))
  const map = new Map<number, OrgPlacement>()
  for (const [id, owner] of owners) map.set(id, placeOwner(owner, teamLeads, depts))
  return map
}

/**
 * Quy owner về (Phòng, Team) theo chuỗi manager_id — KHÔNG cần role:
 *  - owner có quản lý cấp 1 (mgr) và mgr còn manager: dept = mgr.manager, team = mgr.
 *  - owner có mgr mà mgr không còn manager: dept = mgr, team = owner.
 *  - owner không có manager: dept = team = owner.
 *  - owner null/không tìm thấy: bucket "Không xác định".
 * Nhờ vậy quản lý trực tiếp sở hữu khách vẫn rơi vào ĐÚNG phòng.
 */
function placeOwner(
  owner: UserRow | undefined,
  teamLeads: Map<number, UserRow>,
  depts: Map<number, UserRow>,
): OrgPlacement {
  if (!owner) return { deptId: null, deptName: null, teamId: null, teamName: null };
  const mgr = owner.manager_id != null ? teamLeads.get(owner.manager_id) : undefined;
  if (mgr && mgr.manager_id != null) {
    // owner = sale
    return {
      deptId: mgr.manager_id,
      deptName: depts.get(mgr.manager_id)?.full_name ?? null,
      teamId: mgr.id,
      teamName: mgr.full_name,
    };
  }
  if (mgr) {
    // mgr không còn manager (mgr.manager_id == null)
    return { deptId: mgr.id, deptName: mgr.full_name, teamId: owner.id, teamName: owner.full_name };
  }
  // owner không có manager
  return { deptId: owner.id, deptName: owner.full_name, teamId: owner.id, teamName: owner.full_name };
}
