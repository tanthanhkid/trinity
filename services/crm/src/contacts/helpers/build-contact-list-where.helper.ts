import { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { type AuthUser, ScopeService, scopeWhere } from '@trinity/rbac-nest';

/** Owner của Contact — thống nhất cho MỌI quyền. Dùng bởi `buildScopedContactListWhere`. */
const CONTACT_OWNER_FIELDS = ['assigned_to', 'created_by_id'];

/**
 * Subset filter fields dùng chung giữa `GET /contacts` (list) và
 * `GET /contacts/export` — cả 2 field-set khớp `QueryContactDto`,
 * KHÔNG gồm `page`/`limit`/`cursor`/`sort_by`/`sort_order` (những field đó chỉ
 * có ý nghĩa với list, export luôn tự sắp xếp lại theo Phòng ban → Team → NV
 * phụ trách → Khách hàng để trình bày).
 */
export interface ContactListFilters {
  source_id?: number;
  stage_id?: number;
  contact_status_id?: number;
  team_id?: number;
  assigned_to?: number;
  project_id?: number;
  team_lead_id?: number;
  dept_head_id?: number;
  creator_id?: number;
  search?: string;
  created_from?: string;
  created_to?: string;
  /** hot | warm | cold | unscored (chưa chấm). */
  lead_label?: 'hot' | 'warm' | 'cold' | 'unscored';
}

/** Số chữ số tối thiểu khi tra SĐT mà không có `contacts.phone_full` toàn công ty (chống dò từng chữ số). */
export const MIN_MASKED_PHONE_SEARCH_DIGITS = 9;

/**
 * `phoneOpen` = người xem có `contacts.phone_full` scope `all`. Không có thì chỉ khớp theo SĐT khi gõ
 * đủ ≥9 chữ số — list che SĐT theo `phone_full`, nên tra chứa bằng chuỗi ngắn là oracle lộ số đã che
 * (cùng luật với `ContactsService.search`).
 */
function buildSearchClause(search: string, phoneOpen: boolean): Prisma.ContactWhereInput {
  const searchTerm = search.trim();
  const digits = searchTerm.replace(/\D/g, '');
  const isDigitsOnly = digits.length >= 6 && digits === searchTerm;
  const phoneAllowed = phoneOpen || digits.length >= MIN_MASKED_PHONE_SEARCH_DIGITS;
  if (isDigitsOnly) {
    return phoneAllowed
      ? { phone: { contains: digits } }
      : { full_name: { contains: searchTerm, mode: 'insensitive' } };
  }
  const byName: Prisma.ContactWhereInput = { full_name: { contains: searchTerm, mode: 'insensitive' } };
  return phoneAllowed ? { OR: [{ phone: { contains: searchTerm } }, byName] } : byName;
}

function buildCreatedAtClause(
  createdFrom?: string,
  createdTo?: string,
): Prisma.ContactWhereInput | null {
  if (!createdFrom && !createdTo) return null;
  const createdAt: Prisma.DateTimeFilter = {};
  // UI luôn là giờ VN: `YYYY-MM-DD` nghĩa là cả ngày đó theo +07:00 (parse UTC sẽ lệch 7 giờ đầu/cuối ngày).
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  // Giá trị ISO có giờ dùng nguyên văn; ngày không parse được thì bỏ qua (Prisma ném lỗi với Invalid Date).
  const from = createdFrom ? new Date(dateOnly.test(createdFrom) ? `${createdFrom}T00:00:00+07:00` : createdFrom) : null;
  const to = createdTo ? new Date(dateOnly.test(createdTo) ? `${createdTo}T23:59:59.999+07:00` : createdTo) : null;
  if (from && !Number.isNaN(from.getTime())) createdAt.gte = from;
  if (to && !Number.isNaN(to.getTime())) createdAt.lte = to;
  if (createdAt.gte === undefined && createdAt.lte === undefined) return null;
  return { created_at: createdAt };
}

/** Cấp dưới trực tiếp theo `users.manager_id` (bỏ user đã xoá vĩnh viễn). */
async function directReportIds(prisma: PrismaService, managerId: number): Promise<number[]> {
  const rows = await prisma.user.findMany({
    where: { manager_id: managerId, deleted_at: null },
    select: { id: true },
  });
  return rows.map((u) => u.id);
}

/** 2 cấp cấp dưới theo `manager_id` (bộ lọc "Trưởng phòng" của UI Danh bạ). */
async function twoLevelReportIds(prisma: PrismaService, managerId: number): Promise<number[]> {
  const direct = await directReportIds(prisma, managerId);
  if (direct.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { manager_id: { in: direct }, deleted_at: null },
    select: { id: true },
  });
  return Array.from(new Set([...direct, ...rows.map((u) => u.id)]));
}

/**
 * Ghép các filter phụ (team_lead_id/dept_head_id resolve subtree) — tách riêng vì
 * cần `await` (query DB), khác các clause đồng bộ còn lại. Dùng bởi
 * `buildScopedContactListWhere`.
 */
async function buildSubtreeClauses(
  prisma: PrismaService,
  filters: ContactListFilters,
): Promise<Prisma.ContactWhereInput[]> {
  const clauses: Prisma.ContactWhereInput[] = [];
  if (filters.team_lead_id !== undefined) {
    const subIds = await directReportIds(prisma, filters.team_lead_id);
    const allowed = Array.from(new Set<number>([filters.team_lead_id, ...subIds]));
    clauses.push({ assigned_to: { in: allowed } });
  }
  if (filters.dept_head_id !== undefined) {
    const descendants = await twoLevelReportIds(prisma, filters.dept_head_id);
    const allowed = Array.from(new Set<number>([filters.dept_head_id, ...descendants]));
    clauses.push({ assigned_to: { in: allowed } });
  }
  return clauses;
}

/**
 * Where-clause DÙNG CHUNG cho `GET /contacts` (list, `ContactsService.findAll`)
 * và `GET /contacts/export` (`ContactsExportService`). Trước đây
 * export KHÔNG áp bất kỳ filter UI nào (cũ), khiến "chọn Giai
 * đoạn/Nguồn để thu hẹp rồi xuất" vẫn ra file đầy đủ, dễ dính trần
 * `EXPORT_LIMIT=20.000` oan dù phạm vi đã lọc còn lại rất ít.
 *
 * ⚠️ Compose qua `AND: [scopeWhere, deleted_at, ...uiFilters]` — TUYỆT ĐỐI
 * KHÔNG spread filter UI thẳng lên object scope (spread có thể ghi đè âm
 * thầm key trùng của phạm vi quyền — lỗi này làm lộ dữ liệu ngoài phạm vi quyền).
 *
 * RBAC quyền + phạm vi: `scopeWhere(ownerIds(user,'contacts.view'),
 * ['assigned_to','created_by_id'])` — owner CỐ ĐỊNH cho mọi người giữ
 * quyền `contacts.view`.
 */
export async function buildScopedContactListWhere(
  prisma: PrismaService,
  scope: ScopeService,
  user: AuthUser,
  filters: ContactListFilters,
): Promise<Prisma.ContactWhereInput> {
  const owner = await scope.ownerIds(user, 'contacts.view');
  const rbacFilter = scopeWhere(owner ?? [], CONTACT_OWNER_FIELDS);

  const and: Prisma.ContactWhereInput[] = [rbacFilter, { deleted_at: null }];

  if (filters.source_id) and.push({ source_id: filters.source_id });
  if (filters.stage_id) and.push({ stage_id: filters.stage_id });
  if (filters.contact_status_id) and.push({ contact_status_id: filters.contact_status_id });
  if (filters.team_id) and.push({ team_id: filters.team_id });
  if (filters.assigned_to) and.push({ assigned_to: filters.assigned_to });
  if (filters.project_id !== undefined) and.push({ project_id: filters.project_id });
  if (filters.creator_id !== undefined) and.push({ created_by_id: filters.creator_id });
  if (filters.search) {
    const phoneFullOwners = await scope.ownerIds(user, 'contacts.phone_full');
    and.push(buildSearchClause(filters.search, phoneFullOwners === 'all'));
  }
  if (filters.lead_label) {
    and.push(filters.lead_label === 'unscored' ? { lead_label: null } : { lead_label: filters.lead_label });
  }

  const createdAtClause = buildCreatedAtClause(filters.created_from, filters.created_to);
  if (createdAtClause) and.push(createdAtClause);

  and.push(...(await buildSubtreeClauses(prisma, filters)));

  return { AND: and };
}
