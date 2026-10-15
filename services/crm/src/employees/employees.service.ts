import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as path from 'path';
import { createUploadsStore, type UploadsStore } from '@trinity/storage';
import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { QueryEmployeesDto } from './dto/query-employees.dto';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { HrStatsQueryDto, BirthdayListQueryDto } from './dto/employees-stats.dto';
import { AuditService } from '../audit/audit.service';
import {
  ScopeService,
  PermissionService,
  RbacCache,
  scopeWhere,
  assertInScope,
  runInBackground,
  type AuthUser,
  assertUserSlotAvailable,
} from '@trinity/rbac-nest';
import { isSubset } from '@trinity/rbac';

// Ảnh đại diện: KHÔNG lưu base64 vào DB (users.avatar_url được SELECT ở list nhân viên,
// Settings Users và /auth/me — base64 ~2.7MB/ảnh × 25 dòng/trang = payload bomb).
// Base64 từ FE được chuyển thành file JPEG 200×200 đặt trong uploads/avatars của service AUTH
// (nơi serve /uploads qua useStaticAssets + web proxy /uploads/[...path]) — DB chỉ giữ đường dẫn.
const AVATAR_URL_PREFIX = '/uploads/avatars/';
const AVATAR_DIR =
  process.env.EMPLOYEE_AVATAR_DIR ??
  path.resolve(process.cwd(), '..', 'auth', 'uploads', 'avatars');
// Nhánh đĩa giữ đúng thư mục cũ (`EMPLOYEE_AVATAR_DIR`); `STORAGE_DRIVER=vercel-blob` → Blob.
const avatarStore = (): UploadsStore => createUploadsStore({ localRoot: path.dirname(AVATAR_DIR) });
const AVATAR_DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,/;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

// ── Team CHÍNH THỨC (bảng `teams`) ──
// Resolve team cho nhân viên theo ĐÚNG thứ tự teams.service.findAll member-count:
//   1) Employee.team_id gán trực tiếp → thắng
//   2) chính NV là trưởng nhóm (user_id ∈ team.team_lead_id) → team mình
//   3) quản lý NV là trưởng nhóm (manager_id ∈ team.team_lead_id) → team đó
//   4) không khớp → null ("Chưa có team")
// → Đồng nhất với Settings → Team + filter, hết cảnh "bên nhiều team bên ít team".
type TeamInfo = {
  team_id: number;
  team_name: string;
  team_color: string | null;
  team_lead_id: number | null;
  order_index: number;
};
type TeamContext = {
  teamById: Map<number, TeamInfo>;
  teamByLeadId: Map<number, number>; // lead user id → team id
};

function resolveTeam(
  userId: number,
  managerId: number | null,
  teamId: number | null,
  ctx: TeamContext,
): {
  team_id: number | null;
  team_name: string | null;
  team_color: string | null;
  team_lead_id: number | null;
} {
  let tid: number | null = null;
  if (teamId != null && ctx.teamById.has(teamId)) tid = teamId;
  else if (ctx.teamByLeadId.has(userId)) tid = ctx.teamByLeadId.get(userId) ?? null;
  else if (managerId != null && ctx.teamByLeadId.has(managerId))
    tid = ctx.teamByLeadId.get(managerId) ?? null;
  if (tid == null)
    return { team_id: null, team_name: null, team_color: null, team_lead_id: null };
  const info = ctx.teamById.get(tid);
  return {
    team_id: tid,
    team_name: info?.team_name ?? null,
    team_color: info?.team_color ?? null,
    team_lead_id: info?.team_lead_id ?? null,
  };
}

/** Thứ tự hiển thị team (theo orderBy department+name của teams table); null = "Chưa có team" cuối. */
function teamOrderIndex(teamId: number | null, ctx: TeamContext): number {
  if (teamId == null) return 9999;
  return ctx.teamById.get(teamId)?.order_index ?? 9998;
}

// Thứ hạng thâm niên chức vụ (cao → thấp) cho sắp xếp mặc định danh sách + xuất Excel:
// Trưởng nhóm (4) → Chuyên viên chính (3) → Chuyên viên (2) → Nhân viên (1) → khác (0).
// Đồng bộ apps/web/src/lib/job-title-rank.ts (jobTitleSeniorityRank).
export function jobTitleSeniorityRank(name: string | null | undefined): number {
  if (!name) return 0;
  const n = name.toLowerCase().trim();
  if (n.includes('trưởng nhóm') || n.includes('team lead') || n.includes('trưởng'))
    return 4;
  if (n.includes('chuyên viên chính') || (n.includes('chuyên viên') && n.includes('chính')))
    return 3;
  if (n.includes('chuyên viên')) return 2;
  if (n.includes('nhân viên')) return 1;
  return 0;
}

// Sắp xếp mặc định (yêu cầu nghiệp vụ): theo Team CHÍNH THỨC (thứ tự teams
// table), trong mỗi team trưởng nhóm đứng đầu, rồi theo thâm niên chức vụ giảm dần
// (Trưởng nhóm chính → Chuyên viên chính → Chuyên viên → ...), cuối cùng theo tên A→Z.
function compareByTeamThenSeniority(
  a: {
    team_id: number | null;
    team_lead_id: number | null;
    user_id: number;
    full_name: string | null;
    job_title_name: string | null;
    position: string;
  },
  b: {
    team_id: number | null;
    team_lead_id: number | null;
    user_id: number;
    full_name: string | null;
    job_title_name: string | null;
    position: string;
  },
  ctx: TeamContext,
): number {
  const ra = teamOrderIndex(a.team_id, ctx);
  const rb = teamOrderIndex(b.team_id, ctx);
  if (ra !== rb) return ra - rb;
  // Trưởng nhóm (user_id === team_lead_id của team) đứng đầu trong nhóm.
  const sa = a.team_lead_id != null && a.user_id === a.team_lead_id ? 0 : 1;
  const sb = b.team_lead_id != null && b.user_id === b.team_lead_id ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const ja = jobTitleSeniorityRank(a.job_title_name ?? a.position);
  const jb = jobTitleSeniorityRank(b.job_title_name ?? b.position);
  if (ja !== jb) return jb - ja; // chức vụ cao hơn lên trước
  return (a.full_name ?? '').localeCompare(b.full_name ?? '', 'vi');
}

// ── Helpers cho dashboard "Thống kê nhân viên" (Team + Sinh nhật) ──

/** 4 nhóm trạng thái hiển thị + "other" gom phần còn lại (waiting/unclassified/...). */
export type StatusBucket = 'active' | 'probation' | 'on_leave' | 'resigned' | 'other';
function statusBucket(status: string | null): StatusBucket {
  switch (status) {
    case 'active':
      return 'active';
    case 'probation':
      return 'probation';
    case 'on_leave':
      return 'on_leave';
    case 'resigned':
      return 'resigned';
    default:
      return 'other';
  }
}

/**
 * Trích tháng/ngày sinh theo GIỜ VN (Asia/Ho_Chi_Minh) — birth_date lưu dạng
 * VN-midnight UTC nên đọc theo UTC sẽ lệch ngày. Dùng Intl với
 * timeZone VN để lấy đúng ngày/tháng người dùng nhập.
 */
export function vnMonthDay(d: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
  }).formatToParts(d);
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  return { month, day };
}

/** Tháng hiện tại (1-12) theo giờ VN — mặc định khi DS sinh nhật không truyền month. */
export function currentVnMonth(): number {
  const m = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    month: '2-digit',
  }).format(new Date());
  return Number(m);
}

/** Làm tròn 1 chữ số thập phân (tỷ lệ %). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** NV "đã nghỉ việc" = tài khoản bị vô hiệu hoá (users.status='locked'). Nguồn sự thật
 * duy nhất cho trạng thái nghỉ việc (Auth /settings/users lẫn CRM /:id/lock đều set
 * users.status='locked'). KHÁC employees.status='resigned' (trục HR riêng). . */
function isResignedAccount(userStatus: string | null | undefined): boolean {
  return userStatus === 'locked';
}

/** Gom danh sách nhãn → [{label, count}] sort count giảm dần. */
function groupCountByLabel(labels: string[]): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
  return [...m.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** Gom theo Team (team_id formal; null = "Chưa có team") giữ thứ tự teams table. */
function buildTeamCounts(
  items: { team_id: number | null; team_name: string | null }[],
  ctx: TeamContext,
): {
  team_id: number | null;
  team_lead_id: number | null;
  team_name: string;
  count: number;
}[] {
  const m = new Map<
    string,
    {
      team_id: number | null;
      team_lead_id: number | null;
      team_name: string;
      count: number;
    }
  >();
  for (const e of items) {
    const key = e.team_id == null ? 'none' : String(e.team_id);
    let bucket = m.get(key);
    if (!bucket) {
      bucket = {
        team_id: e.team_id,
        team_lead_id:
          e.team_id != null
            ? (ctx.teamById.get(e.team_id)?.team_lead_id ?? null)
            : null,
        team_name: e.team_name ?? 'Chưa có team',
        count: 0,
      };
      m.set(key, bucket);
    }
    bucket.count++;
  }
  return [...m.values()]
    .sort((a, b) => teamOrderIndex(a.team_id, ctx) - teamOrderIndex(b.team_id, ctx))
    .map(({ team_id, team_lead_id, team_name, count }) => ({
      team_id,
      team_lead_id,
      team_name,
      count,
    }));
}

const EMPLOYEE_USER_SELECT = {
  id: true,
  email: true,
  full_name: true,
  phone: true,
  avatar_url: true,
  status: true,
  team_id: true,
  manager_id: true,
  // Tên người quản lý trực tiếp — phục vụ cột/ô "Bộ phận" (quản lý phụ trách).
  manager: {
    select: { full_name: true },
  },
  deleted_at: true,
  user_roles: {
    select: {
      role: {
        select: { name: true },
      },
    },
  },
} as const;

const EMPLOYEE_SELECT = {
  id: true,
  user_id: true,
  employee_code: true,
  position: true,
  department: true,
  gender: true,
  education_level: true,
  recruitment_source: true,
  team_id: true,
  salary_rule_id: true,
  insurance_salary: true,
  job_title_id: true,
  office_id: true,
  registered_device_id: true,
  device_registered_at: true,
  birth_date: true,
  id_card_number: true,
  id_card_issued_date: true,
  id_card_issued_place: true,
  permanent_address: true,
  current_address: true,
  bank_account_number: true,
  bank_name: true,
  bank_account_holder: true,
  status: true,
  joined_at: true,
  created_at: true,
  user: {
    select: EMPLOYEE_USER_SELECT,
  },
  jobTitle: {
    select: {
      id: true,
      name: true,
      category: true,
      rank_code: true,
      symbol: true,
    },
  },
  office: {
    select: {
      id: true,
      name: true,
    },
  },
} as const;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  // Độ sâu tối đa của chain manager_id (chống loop vô hạn khi DB dirty). Mirror Auth.
  private static readonly MAX_MANAGER_CHAIN_DEPTH = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    private readonly permission: PermissionService,
    private readonly rbacCache: RbacCache,
  ) {}

  /**
   * Sửa/khoá tài khoản user liên kết
   * PHẢI kiểm CẢ scope `users.manage` (đã làm ở call site qua `assertInScope`)
   * LẪN "quyền hiện có của target ⊆ quyền actor" (`isSubset`), nếu không một
   * actor giữ `users.manage` phạm vi rộng (vd `all`) nhưng KHÔNG phải Quản trị
   * có thể khoá/sửa một tài khoản Quản trị thật hoặc bất kỳ ai nắm quyền cao
   * hơn mình — mirror `assertCanManageUser` của service auth (CRM là service riêng, không
   * import được trực tiếp → replicate logic).
   */
  private async assertNotEscalating(
    actor: AuthUser,
    targetUserId: number,
  ): Promise<void> {
    if (actor.isAdmin) return;
    const target = await this.permission.grantsFor(targetUserId);
    if (target.isAdmin || !isSubset(target.grants, actor.grants)) {
      throw new ForbiddenException(
        'Không thể thao tác người có quyền cao hơn bạn',
      );
    }
  }

  /**
   * Lấy toàn bộ NV khớp filter → map → sắp xếp → lọc team (app-layer). KHÔNG phân
   * trang. Dùng chung cho findAll (cắt trang) và findAllForExport (xuất toàn bộ) để
   * danh sách hiển thị và file Excel LUÔN ĐỒNG BỘ thứ tự.
   *
   * Sắp xếp: có sort_by → theo cột; mặc định → theo Team + thâm niên chức vụ
   * (Trưởng nhóm → Chuyên viên chính → Chuyên viên → ...). Prisma orderBy không làm
   * được thứ tự team tùy biến → fetch toàn bộ (≤ vài trăm NV) rồi sort ở app-layer.
   */
  private async listSorted(
    dto: QueryEmployeesDto,
    user?: AuthUser,
    permission: 'employees.view' | 'employees.export' = 'employees.view',
  ) {
    let where = this.buildWhere(dto);
    // Mẫu A: scope theo quyền trên chủ sở hữu = user_id của
    // nhân viên. Cả `employees.view` (findAll/findById) lẫn `employees.export`
    // (findAllForExport) đều `scoped: true` trong danh mục — scope PHẢI áp cho
    // CẢ HAI, không chỉ view (tránh export toàn công ty bất kể scope
    // của actor).
    if (user) {
      const owner = await this.scope.ownerIds(user, permission);
      where = { AND: [scopeWhere(owner ?? [], ['user_id']), where] };
    }
    const all = await this.prisma.employee.findMany({
      where,
      select: EMPLOYEE_SELECT,
    });

    // resolve team CHÍNH THỨC (bảng teams) per-row — gán trực tiếp / tự làm
    // lead / quản lý là lead.
    const teamCtx = await this.loadTeamContext();
    const mapped = all.map((e) => this.mapEmployee(e, teamCtx));

    if (dto.sort_by) {
      const dir = dto.sort_dir === 'desc' ? -1 : 1;
      const field = dto.sort_by;
      mapped.sort((a, b) => {
        let av: string | number | Date | null;
        let bv: string | number | Date | null;
        switch (field) {
          case 'full_name': av = a.full_name; bv = b.full_name; break;
          case 'employee_code': av = a.employee_code; bv = b.employee_code; break;
          case 'position': av = a.position; bv = b.position; break;
          case 'department': av = a.department; bv = b.department; break;
          case 'status': av = a.status; bv = b.status; break;
          case 'joined_at':
            av = a.joined_at ? new Date(a.joined_at) : null;
            bv = b.joined_at ? new Date(b.joined_at) : null;
            break;
          default: return 0;
        }
        if (av == null && bv == null) return 0;
        if (av == null) return 1; // null luôn xuống cuối
        if (bv == null) return -1;
        if (av instanceof Date && bv instanceof Date) return dir * (av.getTime() - bv.getTime());
        if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
        return dir * String(av).localeCompare(String(bv), 'vi');
      });
    } else {
      mapped.sort((a, b) => compareByTeamThenSeniority(a, b, teamCtx));
    }

    // Lọc theo team CHÍNH THỨC (team_id resolve per-row). 'none' = chưa có team.
    return dto.team
      ? dto.team === 'none'
        ? mapped.filter((e) => e.team_id == null)
        : mapped.filter((e) => String(e.team_id) === dto.team)
      : mapped;
  }

  async findAll(dto: QueryEmployeesDto, user: AuthUser) {
    const page = dto.page ?? 1;
    const pageSize = dto.page_size ?? 25;
    const skip = (page - 1) * pageSize;

    const filtered = await this.listSorted(dto, user);

    const total = filtered.length;
    return {
      data: filtered.slice(skip, skip + pageSize),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * Toàn bộ NV khớp filter + sort (KHÔNG phân trang) — phục vụ xuất Excel.
   * Tái dùng listSorted để file khớp 100% với danh sách đang hiển thị.
   * Scope theo quyền `employees.export` (catalog: `scoped: true`) — actor chỉ
   * được cấp scope `own`/`team`/`subtree` xuất ĐÚNG phạm vi đó, KHÔNG company-wide
   * (bản gốc bỏ qua scope hoàn toàn — user có `employees.export` scope `own`
   * vẫn tải được Excel TOÀN BỘ nhân viên, ngược nguyên tắc least-privilege).
   */
  async findAllForExport(dto: QueryEmployeesDto, user: AuthUser) {
    return this.listSorted(dto, user, 'employees.export');
  }

  async findById(id: number, user: AuthUser) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: EMPLOYEE_SELECT,
    });

    if (!employee) {
      throw new NotFoundException('Không tìm thấy nhân viên');
    }
    await assertInScope(this.scope, user, 'employees.view', [employee.user_id]);

    const teamCtx = await this.loadTeamContext();
    return this.mapEmployee(employee, teamCtx);
  }

  /**
   * Thống kê nhân viên theo phòng ban, giới tính, học vấn, chức danh, trạng thái.
   * Chỉ tính nhân viên chưa bị xoá mềm (deleted_at IS NULL) + user chưa bị xoá.
   * Dùng cho popup "Thống kê" ở trang /management/employees.
   */
  async getStats(user: AuthUser) {
    // Mẫu A: số liệu tổng hợp cũng chỉ tính trong phạm vi `employees.view` của actor.
    const owner = await this.scope.ownerIds(user, 'employees.view');
    const scopeSql =
      owner === 'all'
        ? Prisma.empty
        : (owner ?? []).length === 0
          ? Prisma.sql`AND FALSE`
          : Prisma.sql`AND e.user_id IN (${Prisma.join(owner as number[])})`;
    // GROUP BY trong Prisma 6 không hỗ trợ nullable text groupBy → dùng raw SQL để tránh
    // "Cannot return null for non-nullable field" Prisma bug với nullable columns.
    const [byDepartment, byGender, byEducation, byJobTitle, byStatus, resignedRows] =
      await Promise.all([
      // Phòng ban
      // ORDER BY 2 DESC dùng ordinal thay vì alias "count" (reserved word trong PostgreSQL)
      this.prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT COALESCE(e.department, 'Chưa phân loại') AS label, COUNT(*)::bigint AS count
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL ${scopeSql}
        GROUP BY COALESCE(e.department, 'Chưa phân loại')
        ORDER BY 2 DESC
      `,
      // Giới tính
      this.prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT COALESCE(e.gender, 'Chưa cập nhật') AS label, COUNT(*)::bigint AS count
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL ${scopeSql}
        GROUP BY COALESCE(e.gender, 'Chưa cập nhật')
        ORDER BY 2 DESC
      `,
      // Trình độ học vấn
      this.prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT COALESCE(e.education_level, 'Chưa cập nhật') AS label, COUNT(*)::bigint AS count
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL ${scopeSql}
        GROUP BY COALESCE(e.education_level, 'Chưa cập nhật')
        ORDER BY 2 DESC
      `,
      // Chức danh
      this.prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT COALESCE(jt.name, 'Chưa gán') AS label, COUNT(*)::bigint AS count
        FROM employees e
        JOIN users u ON u.id = e.user_id
        LEFT JOIN job_titles jt ON jt.id = e.job_title_id
        WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL ${scopeSql}
        GROUP BY COALESCE(jt.name, 'Chưa gán')
        ORDER BY 2 DESC
      `,
      // Trạng thái
      this.prisma.$queryRaw<{ label: string; count: bigint }[]>`
        SELECT COALESCE(e.status, 'Chưa phân loại') AS label, COUNT(*)::bigint AS count
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL ${scopeSql}
        GROUP BY COALESCE(e.status, 'Chưa phân loại')
        ORDER BY 2 DESC
      `,
      // NV "đã nghỉ việc" = tài khoản vô hiệu hoá (users.status='locked'). Trục RIÊNG
      // với by_status (employees.status) — đếm tách biệt, KHÔNG đụng 5 query trên.
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.deleted_at IS NULL AND u.deleted_at IS NULL ${scopeSql} AND u.status = 'locked'
      `,
      ]);

    // BigInt serialize thủ công (JSON.stringify không handle BigInt)
    const toRows = (rows: { label: string; count: bigint }[]) =>
      rows.map((r) => ({ label: r.label, count: Number(r.count) }));

    return {
      by_department: toRows(byDepartment),
      by_gender: toRows(byGender),
      by_education: toRows(byEducation),
      by_job_title: toRows(byJobTitle),
      by_status: toRows(byStatus),
      // Số NV đã nghỉ việc (tài khoản vô hiệu hoá) — metric mới tách biệt.
      resigned_total: Number(resignedRows[0]?.count ?? 0),
    };
  }

  /**
   * Tải toàn bộ nhân viên (chưa xoá) khớp 4 filter scope rồi map.
   * Bảng employees nhỏ (vài trăm dòng) → load-all an toàn; Team suy ở app-layer
   * nên KHÔNG GROUP BY team bằng SQL được. Lọc `team` ở JS.
   */
  private async loadEmployeesForStats(
    filters: HrStatsQueryDto,
    user: AuthUser,
    permission: 'employees.view' | 'employees.export' = 'employees.view',
  ) {
    const owner = await this.scope.ownerIds(user, permission);
    const where: Prisma.EmployeeWhereInput = {
      AND: [
        scopeWhere(owner ?? [], ['user_id']),
        { deleted_at: null, user: { deleted_at: null } },
      ],
    };
    const extra: Prisma.EmployeeWhereInput = {};
    if (filters.office_id != null) extra.office_id = filters.office_id;
    if (filters.department) extra.department = filters.department;
    if (filters.job_title_id != null) extra.job_title_id = filters.job_title_id;
    (where.AND as Prisma.EmployeeWhereInput[]).push(extra);

    const rows = await this.prisma.employee.findMany({
      where,
      select: EMPLOYEE_SELECT,
    });
    const teamCtx = await this.loadTeamContext();
    let mapped = rows.map((r) => this.mapEmployee(r, teamCtx));

    // Lọc theo team CHÍNH THỨC (team_id). FE gửi team = team_id; 'none' = chưa có team.
    if (filters.team) {
      mapped =
        filters.team === 'none'
          ? mapped.filter((e) => e.team_id == null)
          : mapped.filter((e) => String(e.team_id) === filters.team);
    }
    return mapped;
  }

  /**
   * Thống kê dashboard nhân sự: cơ cấu Team (donut), trạng thái theo Team (stacked),
   * phân bố sinh nhật 12 tháng. Tất cả trong 1 lần tải để vẽ 3 vùng biểu đồ.
   */
  async getHrStats(filters: HrStatsQueryDto, user: AuthUser) {
    const all = await this.loadEmployeesForStats(filters, user);
    // Phân hoạch: NV đã nghỉ việc = tài khoản vô hiệu hoá (user_status='locked').
    // total/by_team/by_team_status/sinh nhật tính trên NV ĐANG LÀM (active) — người
    // đã nghỉ KHÔNG còn ảnh hưởng số liệu team; thống kê resigned tách riêng.
    const resignedList = all.filter((e) => isResignedAccount(e.user_status));
    const mapped = all.filter((e) => !isResignedAccount(e.user_status));
    const total = mapped.length;

    // Gom theo Team CHÍNH THỨC: build từ DANH SÁCH teams (kể cả team 0 NV)
    // theo thứ tự teams table + bucket "Chưa có team". Nhờ vậy team mới tạo (vd
    // "Team Alpha") LUÔN hiện ở thống kê — đồng nhất Settings → Team + filter.
    const teamCtx = await this.loadTeamContext();
    const membersByTeam = new Map<number | null, typeof mapped>();
    for (const e of mapped) {
      const key = e.team_id; // team_id formal đã resolve (number | null)
      const arr = membersByTeam.get(key);
      if (arr) arr.push(e);
      else membersByTeam.set(key, [e]);
    }
    const orderedTeams = [...teamCtx.teamById.values()].sort(
      (a, b) => a.order_index - b.order_index,
    );

    type TeamBucket = {
      team_id: number | null;
      team_lead_id: number | null;
      team_name: string;
      color: string | null;
      members: typeof mapped;
    };
    const teamEntries: TeamBucket[] = orderedTeams.map((t) => ({
      team_id: t.team_id,
      team_lead_id: t.team_lead_id,
      team_name: t.team_name,
      color: t.team_color,
      members: membersByTeam.get(t.team_id) ?? [],
    }));
    const noTeamMembers = membersByTeam.get(null) ?? [];
    if (noTeamMembers.length > 0) {
      teamEntries.push({
        team_id: null,
        team_lead_id: null,
        team_name: 'Chưa có team',
        color: null,
        members: noTeamMembers,
      });
    }

    const by_team = teamEntries.map((t) => ({
      team_id: t.team_id,
      team_lead_id: t.team_lead_id,
      team_name: t.team_name,
      color: t.color,
      count: t.members.length,
      percent: total ? round1((t.members.length / total) * 100) : 0,
    }));

    const by_team_status = teamEntries.map((t) => {
      const s = { active: 0, probation: 0, on_leave: 0, resigned: 0, other: 0 };
      for (const m of t.members) s[statusBucket(m.status)]++;
      return {
        team_id: t.team_id,
        team_lead_id: t.team_lead_id,
        team_name: t.team_name,
        color: t.color,
        ...s,
      };
    });

    // Phân bố sinh nhật theo tháng (giờ VN). NV không có birth_date bị loại.
    const monthCounts = new Array<number>(12).fill(0);
    for (const e of mapped) {
      if (!e.birth_date) continue;
      const { month } = vnMonthDay(new Date(e.birth_date));
      if (month >= 1 && month <= 12) monthCounts[month - 1]++;
    }
    const birthdays_by_month = monthCounts.map((count, i) => ({
      month: i + 1,
      count,
      percent: total ? round1((count / total) * 100) : 0,
    }));

    // Thống kê NV đã nghỉ việc — chia theo team cũ / phòng ban / chức vụ.
    // resigned_by_team quy theo manager_id HIỆN TẠI (design giữ manager_id làm liên
    // kết lịch sử) → phản ánh trạng thái hiện tại, không snapshot lúc nghỉ.
    const resigned_total = resignedList.length;
    const resigned_by_team = buildTeamCounts(resignedList, teamCtx);
    const resigned_by_department = groupCountByLabel(
      resignedList.map((e) => e.department ?? 'Chưa phân loại'),
    );
    const resigned_by_job_title = groupCountByLabel(
      resignedList.map((e) => e.job_title_name ?? 'Chưa gán'),
    );

    return {
      total,
      by_team,
      by_team_status,
      birthdays_by_month,
      resigned_total,
      resigned_by_team,
      resigned_by_department,
      resigned_by_job_title,
    };
  }

  /**
   * Danh sách nhân viên có sinh nhật trong THÁNG đã chọn (mặc định tháng hiện tại VN),
   * sắp theo ngày-trong-tháng tăng dần. Dùng cho bảng + xuất Excel.
   */
  async getBirthdayList(
    filters: BirthdayListQueryDto,
    user: AuthUser,
    permission: 'employees.view' | 'employees.export' = 'employees.view',
  ) {
    const month = filters.month ?? currentVnMonth();
    const mapped = await this.loadEmployeesForStats(filters, user, permission);

    const items = mapped
      .filter((e) => e.birth_date != null)
      .map((e) => {
        const { month: m, day } = vnMonthDay(new Date(e.birth_date!));
        return { e, m, day };
      })
      .filter((x) => x.m === month)
      .map(({ e, day }) => ({
        id: e.id,
        employee_code: e.employee_code,
        full_name: e.full_name,
        birth_date: e.birth_date,
        day,
        position: e.position,
        job_title_name: e.job_title_name,
        team_name: e.team_name ?? 'Chưa có team',
        department: e.department,
        email: e.email,
        phone: e.phone,
      }))
      .sort(
        (a, b) =>
          a.day - b.day ||
          (a.full_name ?? '').localeCompare(b.full_name ?? '', 'vi'),
      );

    return { month, items };
  }

  /**
   * Chặn tự xóa/tự nghỉ việc trên chính tài khoản mình (tránh tự khóa — kế toán nay có
   * quyền nghỉ việc/xoá). caller vắng (test/internal) → bỏ qua (không có ngữ cảnh tự-thao-tác).
   */
  private assertNotSelf(
    caller: AuthUser | undefined,
    targetUserId: number,
  ): void {
    if (caller?.userId != null && caller.userId === targetUserId) {
      throw new ForbiddenException(
        'Không thể thực hiện thao tác này trên tài khoản của chính mình',
      );
    }
  }

  /**
   * Chặn vòng lặp trong chain manager_id. DFS từ `newManagerId` đi ngược theo
   * manager_id; nếu gặp `userId` → throw. Vượt MAX_MANAGER_CHAIN_DEPTH (DB dirty)
   * → throw để tránh loop vô hạn. Mirror VERBATIM Auth `assertNoManagerCycle`
   * (CRM là service riêng, KHÔNG import được — replicate để giữ invariant hierarchy).
   * Bất biến an toàn dữ liệu này ĐỘC LẬP với RBAC — org chart gán
   * manager TỰ DO (không ràng buộc theo tên vai trò), nhưng vòng lặp quản lý vẫn phải chặn
   * bất kể ai được chọn làm quản lý của ai.
   */
  private async assertNoManagerCycle(
    userId: number,
    newManagerId: number,
  ): Promise<void> {
    if (newManagerId === userId) {
      throw new BadRequestException('Phát hiện vòng lặp trong cấu trúc quản lý');
    }
    let cursor: number | null = newManagerId;
    const visited = new Set<number>();
    for (let depth = 0; depth < EmployeesService.MAX_MANAGER_CHAIN_DEPTH; depth++) {
      if (cursor == null) return;
      if (cursor === userId) {
        throw new BadRequestException('Phát hiện vòng lặp trong cấu trúc quản lý');
      }
      if (visited.has(cursor)) {
        throw new BadRequestException(
          'Phát hiện vòng lặp trong cấu trúc quản lý (DB dirty)',
        );
      }
      visited.add(cursor);
      const parent: { manager_id: number | null } | null =
        await this.prisma.user.findUnique({
          where: { id: cursor },
          select: { manager_id: true },
        });
      if (!parent) return;
      cursor = parent.manager_id;
    }
    throw new BadRequestException(
      'Chain quản lý vượt quá độ sâu cho phép (có thể có vòng lặp)',
    );
  }

  /**
   * Gán theo Team: nếu `dto.team_id` được chọn → suy ra trưởng nhóm
   * (`manager_id = team.team_lead_id`) + phòng ban (`department = team.department`).
   * Một thao tác chọn Team tự đồng bộ phân quyền (manager_id) + phòng ban.
   */
  private async applyTeamAssignment(dto: {
    team_id?: number | null;
    manager_id?: number | null;
    department?: string | null;
  }, selfUserId?: number): Promise<void> {
    if (dto.team_id == null) return;
    const team = await this.prisma.team.findUnique({
      where: { id: dto.team_id },
      select: { team_lead_id: true, department: true },
    });
    if (!team) {
      throw new NotFoundException(`Team #${dto.team_id} không tồn tại`);
    }
    // Chính trưởng nhóm được lưu hồ sơ trong team của mình: giữ nguyên quản lý hiện tại,
    // không tự đặt mình làm quản lý của chính mình.
    if (selfUserId !== undefined && team.team_lead_id === selfUserId) {
      dto.manager_id = undefined;
    } else {
      dto.manager_id = team.team_lead_id;
    }
    dto.department = team.department;
  }

  async create(dto: CreateEmployeeDto, actor?: AuthUser) {
    const actorUserId = actor?.userId;
    // Chọn Team → tự set manager_id + department theo team (trước khi sync team_id).
    const teamDriven = dto.team_id != null;
    await this.applyTeamAssignment(dto);


    // 1. Trùng email — CHỈ check trong PHẠM VI NHÂN VIÊN, không phải toàn bộ bảng users.
    //    Chỉ chặn khi email thuộc 1 nhân viên ĐANG hoạt động. Nếu email thuộc 1 tài khoản chưa-là-nhân-viên
    //    hoặc nhân viên đã xoá mềm → cho phép gắn/khôi phục thông tin nhân sự vào chính tài khoản đó
    //    (tránh vỡ ràng buộc UNIQUE users.email khi tạo user mới trùng email).
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        deleted_at: true,
        employee: { select: { id: true, deleted_at: true } },
        user_roles: { select: { id: true }, take: 1 },
      },
    });
    if (existingUser?.employee && existingUser.employee.deleted_at == null && existingUser.deleted_at == null) {
      throw new ConflictException('Email đã được sử dụng cho một nhân viên khác');
    }
    // An toàn: KHÔNG âm thầm chiếm dụng/đổi vai trò một tài khoản hệ thống ĐANG hoạt động
    // (gõ nhầm email của tài khoản khác → reuse sẽ ghi đè tên/SĐT/manager + thay role).
    // Chỉ cho reuse khi: tài khoản đã xoá mềm (khôi phục) HOẶC tài khoản chưa có vai trò nào (orphan).
    // Nhân viên đã xoá mềm khôi phục lại chính tài khoản của mình thì không phải "tài khoản khác" (vẫn qua assertNotEscalating/assertInScope bên dưới).
    const restoringSoftDeletedEmployee = existingUser?.employee?.deleted_at != null;
    if (
      existingUser &&
      existingUser.deleted_at == null &&
      existingUser.user_roles.length > 0 &&
      !restoringSoftDeletedEmployee
    ) {
      throw new ConflictException(
        'Email đang được dùng cho một tài khoản hệ thống khác — vui lòng kiểm tra lại email.',
      );
    }

    // Khôi phục tài khoản đã xoá mềm vẫn GIỮ vai trò cũ (có thể là Quản trị): actor
    // `employees.manage` không được khôi phục + đặt mật khẩu cho người có quyền cao
    // hơn mình (leo thang, §6 luật 3) — cùng guard với `update`/`lock`.
    if (actor && existingUser && existingUser.user_roles.length > 0) {
      await this.assertNotEscalating(actor, existingUser.id);
    }

    // Tái dùng tài khoản (đang hoạt động chưa có vai trò, HOẶC đã xoá mềm được khôi phục) ghi đè full_name/phone/team/
    // manager/mật khẩu của tài khoản đó — cùng quyền với `update`, nên phải kiểm cả scope `users.manage`.
    if (actor && existingUser) {
      await assertInScope(this.scope, actor, 'users.manage', [existingUser.id]);
    }

    // 1b. Trùng SĐT (loại trừ chính tài khoản sắp được tái sử dụng)
    if (dto.phone) {
      const phoneOwner = await this.prisma.user.findFirst({
        where: {
          phone: dto.phone,
          ...(existingUser ? { id: { not: existingUser.id } } : {}),
        },
        select: { id: true },
      });
      if (phoneOwner) {
        throw new ConflictException('Số điện thoại đã được sử dụng');
      }
    }

    // 1c. Kiểm tra job_title tồn tại (nếu có)
    let jobTitleName: string | null = null;
    if (dto.job_title_id != null) {
      const jobTitle = await this.prisma.jobTitle.findUnique({
        where: { id: dto.job_title_id },
        select: { id: true, name: true },
      });
      if (!jobTitle) {
        throw new NotFoundException(`Chức danh #${dto.job_title_id} không tồn tại`);
      }
      jobTitleName = jobTitle.name;
    }

    // Gói dịch vụ: tạo user mới hoặc khôi phục user đã xoá mềm đều chiếm 1 chỗ trong max_users.
    if (!existingUser || existingUser.deleted_at != null) {
      await assertUserSlotAvailable(this.prisma);
    }

    // 2. Tạo/tái dùng User + Employee trong cùng 1 transaction (CRM và Auth dùng chung DB)
    const passwordHash = await bcrypt.hash(dto.password || randomBytes(16).toString('hex'), 10);
    const avatarUrl = (await this.resolveAvatarInput(dto.avatar_url)) ?? null;

    // ghi audit password_change CHỈ SAU KHI transaction commit thành
    // công (tránh ghi oan khi rollback). Dùng object holder (KHÔNG `let` primitive)
    // biến `let` gán bên trong closure $transaction bị TS control-flow analysis
    // narrow nhầm về `never` khi đọc lại ở ngoài closure.
    const passwordSetHolder: {
      value: { userId: number; method: 'employee_create' | 'employee_reuse_password_set' } | null;
    } = { value: null };

    const employee = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // team_id/manager_id nay CHỈ theo lựa chọn Team tường minh (applyTeamAssignment ở
      // trên) hoặc dto.manager_id — KHÔNG suy theo tên vai trò.
      const syncedTeamId = dto.team_id ?? null;

      let userId: number;
      if (existingUser) {
        // Tài khoản đã tồn tại nhưng CHƯA là nhân viên (hoặc đã xoá mềm) → gắn/khôi phục thông tin nhân sự.
        const userUpdate: Record<string, unknown> = {
          full_name: dto.full_name,
          phone: dto.phone ?? null,
          team_id: syncedTeamId,
          manager_id: dto.manager_id ?? null,
        };
        if (avatarUrl !== null) userUpdate['avatar_url'] = avatarUrl;
        // Chỉ đổi mật khẩu khi caller cung cấp — KHÔNG phá login của tài khoản đang hoạt động.
        if (dto.password) {
          userUpdate['password_hash'] = passwordHash;
          userUpdate['password_updated_at'] = new Date();
          userUpdate['tokens_valid_after'] = new Date();
          passwordSetHolder.value = { userId: existingUser.id, method: 'employee_reuse_password_set' };
        }
        // Khôi phục tài khoản đã xoá mềm
        if (existingUser.deleted_at != null) {
          userUpdate['deleted_at'] = null;
          userUpdate['status'] = 'active';
        }
        await tx.user.update({ where: { id: existingUser.id }, data: userUpdate });
        userId = existingUser.id;
      } else {
        const user = await tx.user.create({
          data: {
            email: dto.email,
            full_name: dto.full_name,
            password_hash: passwordHash,
            password_updated_at: new Date(),
            phone: dto.phone ?? null,
            team_id: syncedTeamId,
            manager_id: dto.manager_id ?? null,
            avatar_url: avatarUrl,
          },
          select: { id: true },
        });
        passwordSetHolder.value = { userId: user.id, method: 'employee_create' };
        userId = user.id;
      }

      // Employee upsert theo user_id (@unique): create cho tài khoản mới / chưa có nhân sự,
      // update khi khôi phục nhân viên đã xoá mềm (employee record cũ còn tồn tại).
      const employeeData = {
        employee_code: dto.employee_code?.trim() || null,
        position: dto.position?.trim() || jobTitleName || 'Chưa phân loại',
        department: dto.department ?? null,
        gender: dto.gender ?? null,
        team_id: syncedTeamId,
        salary_rule_id: dto.salary_rule_id ?? null,
        insurance_salary: dto.insurance_salary != null ? BigInt(dto.insurance_salary) : null,
        job_title_id: dto.job_title_id ?? null,
        status: dto.status ?? 'active',
        // Khôi phục nhân viên đã xoá mềm (nhánh update của upsert) phải bỏ dấu xoá.
        deleted_at: null,
        // Giữ bất biến: employees.status='resigned' ⇔ resigned_at != null.
        // Reactivate NV đã nghỉ (status→active) tự xoá mốc ngày nghỉ cũ.
        resigned_at: (dto.status ?? 'active') === 'resigned' ? new Date() : null,
        joined_at: dto.joined_at ? new Date(dto.joined_at) : new Date(),
        birth_date: dto.birth_date ? new Date(dto.birth_date) : null,
        id_card_number: dto.id_card_number?.trim() || null,
        id_card_issued_date: dto.id_card_issued_date ? new Date(dto.id_card_issued_date) : null,
        id_card_issued_place: dto.id_card_issued_place?.trim() || null,
        permanent_address: dto.permanent_address?.trim() || null,
        current_address: dto.current_address?.trim() || null,
        bank_account_number: dto.bank_account_number?.trim() || null,
        bank_name: dto.bank_name?.trim() || null,
        bank_account_holder: dto.bank_account_holder?.trim() || null,
      };
      return tx.employee.upsert({
        where: { user_id: userId },
        create: { user_id: userId, ...employeeData },
        update: employeeData,
        select: EMPLOYEE_SELECT,
      });
    }).catch((e: unknown) => {
      // TOCTOU: 2 request tạo cùng email đồng thời (existingUser đọc ngoài transaction)
      // → P2002 trên users.email → map 409 thân thiện thay vì 500 thô.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email hoặc số điện thoại đã tồn tại — vui lòng thử lại.');
      }
      throw e;
    });

    // ghi audit password_change — best-effort (AuditService.write() không
    // throw), CHỈ SAU KHI transaction commit thành công (không ghi oan khi rollback).
    if (passwordSetHolder.value) {
      const { userId, method } = passwordSetHolder.value;
      await this.audit.write({
        userId: actorUserId ?? null,
        action: 'password_change',
        resource: 'users',
        resourceId: userId,
        metadata: { method, target_user_id: userId },
      });
    }

    // User mới có thể mang sẵn manager_id (chọn Team lúc tạo) → scope subtree
    // của người quản lý đổi ngay, mirror Auth `UsersService.create()`.
    await this.rbacCache.invalidateUsers('*');

    const teamCtx = await this.loadTeamContext();
    return this.mapEmployee(employee, teamCtx);
  }

  async update(id: number, dto: UpdateEmployeeDto, actor: AuthUser) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        user_id: true,
        user: { select: { avatar_url: true, manager_id: true } },
      },
    });

    if (!employee) {
      throw new NotFoundException('Không tìm thấy nhân viên');
    }
    // Sửa hồ sơ nhân viên LUÔN chạm tới tài khoản liên kết (users.full_name/phone/
    // manager_id/avatar_url) — cần thêm quyền `users.manage` phủ đúng người này,
    // KHÔNG chỉ `employees.manage`.
    await assertInScope(this.scope, actor, 'users.manage', [employee.user_id]);
    // Target đang giữ quyền KHÔNG PHẢI tập con của actor (vd Quản
    // trị thật, hoặc ai đó nắm quyền cao hơn) → chặn, dù đã lọt qua scope check.
    await this.assertNotEscalating(actor, employee.user_id);

    // Trùng SĐT với tài khoản khác (mirror create() bước 1b) — loại trừ chính user này.
    if (dto.phone) {
      const phoneOwner = await this.prisma.user.findFirst({
        where: { phone: dto.phone, id: { not: employee.user_id } },
        select: { id: true },
      });
      if (phoneOwner) {
        throw new ConflictException('Số điện thoại đã được sử dụng');
      }
    }

    // Chọn Team → tự set manager_id + department theo team.
    await this.applyTeamAssignment(dto, employee.user_id);

    // Chặn vòng lặp trong chain manager_id — bất biến cấu trúc, ĐỘC LẬP với RBAC/vai
    // trò (org chart nay gán manager TỰ DO, không còn ràng buộc theo tên vai trò).
    if (dto.manager_id !== undefined && dto.manager_id !== null) {
      if (dto.manager_id === employee.user_id) {
        throw new ForbiddenException('Không thể tự đặt làm quản lý của chính mình');
      }
      await this.assertNoManagerCycle(employee.user_id, dto.manager_id);
    }

    // team_id nay CHỈ theo lựa chọn Team tường minh — KHÔNG suy theo tên vai trò.
    const syncedTeamId = dto.team_id;

    // Cập nhật user fields (full_name, phone, team_id, manager_id, avatar_url)
    const userUpdateData: Record<string, unknown> = {};
    if (dto.full_name !== undefined) userUpdateData['full_name'] = dto.full_name;
    if (dto.phone !== undefined) userUpdateData['phone'] = dto.phone;
    if (syncedTeamId !== undefined) userUpdateData['team_id'] = syncedTeamId;
    if (dto.manager_id !== undefined) userUpdateData['manager_id'] = dto.manager_id;
    const resolvedAvatar = await this.resolveAvatarInput(dto.avatar_url, employee.user.avatar_url);
    if (resolvedAvatar !== undefined) userUpdateData['avatar_url'] = resolvedAvatar;

    // Cập nhật employee fields
    const employeeUpdateData: Record<string, unknown> = {};
    if (dto.employee_code !== undefined)
      employeeUpdateData['employee_code'] = dto.employee_code?.trim() || null;
    if (dto.position !== undefined) employeeUpdateData['position'] = dto.position;
    if (dto.department !== undefined) employeeUpdateData['department'] = dto.department;
    if (dto.gender !== undefined) employeeUpdateData['gender'] = dto.gender;
    if (dto.education_level !== undefined) employeeUpdateData['education_level'] = dto.education_level;
    if (dto.recruitment_source !== undefined) employeeUpdateData['recruitment_source'] = dto.recruitment_source;
    if (dto.status !== undefined) {
      employeeUpdateData['status'] = dto.status;
      // Đồng bộ mốc ngày nghỉ việc theo status: →resigned set now(), →khác xoá null.
      employeeUpdateData['resigned_at'] = dto.status === 'resigned' ? new Date() : null;
    }
    if (dto.joined_at !== undefined) employeeUpdateData['joined_at'] = new Date(dto.joined_at);
    if (dto.salary_rule_id !== undefined) employeeUpdateData['salary_rule_id'] = dto.salary_rule_id;
    if (dto.insurance_salary !== undefined)
      employeeUpdateData['insurance_salary'] =
        dto.insurance_salary === null ? null : BigInt(dto.insurance_salary);
    if (dto.job_title_id !== undefined) {
      if (dto.job_title_id != null) {
        const jobTitle = await this.prisma.jobTitle.findUnique({
          where: { id: dto.job_title_id },
          select: { id: true },
        });
        if (!jobTitle) {
          throw new NotFoundException(`Chức danh #${dto.job_title_id} không tồn tại`);
        }
      }
      employeeUpdateData['job_title_id'] = dto.job_title_id;
    }
    if (dto.office_id !== undefined) employeeUpdateData['office_id'] = dto.office_id;
    // Hồ sơ nhân sự cá nhân (mở rộng 2026-06-17) — FE gửi "" để xoá → quy về null
    if (dto.birth_date !== undefined)
      employeeUpdateData['birth_date'] = dto.birth_date ? new Date(dto.birth_date) : null;
    if (dto.id_card_number !== undefined)
      employeeUpdateData['id_card_number'] = dto.id_card_number?.trim() || null;
    if (dto.id_card_issued_date !== undefined)
      employeeUpdateData['id_card_issued_date'] = dto.id_card_issued_date ? new Date(dto.id_card_issued_date) : null;
    if (dto.id_card_issued_place !== undefined)
      employeeUpdateData['id_card_issued_place'] = dto.id_card_issued_place?.trim() || null;
    if (dto.permanent_address !== undefined)
      employeeUpdateData['permanent_address'] = dto.permanent_address?.trim() || null;
    if (dto.current_address !== undefined)
      employeeUpdateData['current_address'] = dto.current_address?.trim() || null;
    if (dto.bank_account_number !== undefined)
      employeeUpdateData['bank_account_number'] = dto.bank_account_number?.trim() || null;
    if (dto.bank_name !== undefined)
      employeeUpdateData['bank_name'] = dto.bank_name?.trim() || null;
    if (dto.bank_account_holder !== undefined)
      employeeUpdateData['bank_account_holder'] = dto.bank_account_holder?.trim() || null;
    // Sync team_id vào bảng employees (đồng bộ với user — đã gate qua syncedTeamId ở trên).
    if (syncedTeamId !== undefined) employeeUpdateData['team_id'] = syncedTeamId;

    const updatedEmployee = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (Object.keys(userUpdateData).length > 0) {
        await tx.user.update({
          where: { id: employee.user_id },
          data: userUpdateData,
        });
      }

      // Vai trò hệ thống KHÔNG sửa qua endpoint này — gán/gỡ vai trò đi qua
      // `PUT /users/:id/roles` (quyền `users.manage`).

      const updated = await tx.employee.update({
        where: { id },
        data: Object.keys(employeeUpdateData).length > 0
          ? (employeeUpdateData as Prisma.EmployeeUpdateInput)
          : {},
        select: EMPLOYEE_SELECT,
      });

      return updated;
    });

    // Avatar đổi/bỏ → xoá file cũ (best-effort, sau khi transaction thành công)
    if (resolvedAvatar !== undefined && resolvedAvatar !== employee.user.avatar_url) {
      runInBackground(() => this.deleteAvatarFile(employee.user.avatar_url));
    }

    // manager_id đổi ⇒ cây scope (own|team|subtree) của MỌI user liên quan có
    // thể đổi ngay — mirror Auth `UsersService.update()`: mọi lần sửa
    // tài khoản chạm `manager_id`/status PHẢI `invalidateUsers('*')` để cache
    // quyền/scope phản ánh NGAY, không đợi TTL 60s.
    if (Object.keys(userUpdateData).length > 0) {
      await this.rbacCache.invalidateUsers('*');
    }

    const teamCtx = await this.loadTeamContext();
    return this.mapEmployee(updatedEmployee, teamCtx);
  }

  /**
   * Chuẩn hoá input avatar_url từ FE:
   * - undefined → không đổi; null/rỗng → xoá avatar
   * - đường dẫn /uploads/avatars/... CHỈ được giữ nguyên khi đúng bằng avatar hiện tại của chính user
   *   (edit không đổi ảnh); đường dẫn khác bị từ chối — nếu không, đổi/xoá avatar sau đó sẽ xoá file của người khác
   * - base64 data-URL (JPG/PNG/WebP) → sharp resize 200×200 JPEG q80 → lưu file, trả đường dẫn
   */
  private async resolveAvatarInput(
    input: string | null | undefined,
    currentAvatar?: string | null,
  ): Promise<string | null | undefined> {
    if (input === undefined) return undefined;
    if (input === null || input.trim() === '') return null;
    if (input.startsWith(AVATAR_URL_PREFIX)) {
      if (currentAvatar && input === currentAvatar) return input;
      throw new BadRequestException('Ảnh đại diện không hợp lệ');
    }
    if (!AVATAR_DATA_URL_RE.test(input)) {
      throw new BadRequestException(
        'Ảnh đại diện không hợp lệ — chỉ chấp nhận JPG, PNG, WebP',
      );
    }
    const buffer = Buffer.from(input.slice(input.indexOf(',') + 1), 'base64');
    if (buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) {
      throw new BadRequestException('Ảnh đại diện quá lớn — tối đa 5MB');
    }
    const fileName = `empl_${Date.now()}_${randomBytes(4).toString('hex')}.jpg`;
    try {
      const jpeg = await sharp(buffer)
        .resize(200, 200, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toBuffer();
      await avatarStore().save(`avatars/${fileName}`, jpeg, 'image/jpeg');
    } catch (err) {
      this.logger.warn(`Không xử lý được ảnh avatar: ${(err as Error).message}`);
      throw new BadRequestException(
        'Không đọc được file ảnh — vui lòng chọn ảnh JPG, PNG hoặc WebP hợp lệ',
      );
    }
    return AVATAR_URL_PREFIX + fileName;
  }

  /** Xoá file avatar đã lưu (best-effort — file có thể không tồn tại). */
  private async deleteAvatarFile(avatarUrl: string | null | undefined): Promise<void> {
    if (!avatarUrl || !avatarUrl.startsWith(AVATAR_URL_PREFIX)) return;
    // best-effort — file có thể không tồn tại
    await avatarStore().remove(`avatars/${path.basename(avatarUrl)}`);
  }

  async lock(id: number, caller: AuthUser) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: { id: true, user_id: true },
    });

    if (!employee) {
      throw new NotFoundException('Không tìm thấy nhân viên');
    }

    this.assertNotSelf(caller, employee.user_id);
    // Khoá = ghi users.status — chạm tài khoản liên kết, cần quyền `users.manage`
    // phủ đúng người này.
    await assertInScope(this.scope, caller, 'users.manage', [employee.user_id]);
    // §6 luật 3 — không cho khoá tài khoản của người giữ quyền cao hơn mình
    // (vd Quản trị thật) chỉ vì scope `users.manage` của caller đủ rộng.
    await this.assertNotEscalating(caller, employee.user_id);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: employee.user_id },
        data: { status: 'locked', tokens_valid_after: new Date() },
      }),
      this.prisma.employee.update({
        where: { id },
        // resigned_at = mốc ngày nghỉ việc — dùng để loại NV khỏi chấm công KỂ TỪ ngày này.
        data: { status: 'resigned', resigned_at: new Date() },
      }),
    ]);

    // Khoá tài khoản đổi trạng thái quyền hiệu lực (isAdmin có thể mất khi role
    // gắn với account bị khoá không còn nghĩa) — invalidate ngay, mirror update().
    await this.rbacCache.invalidateUsers('*');

    // Audit: ai cho nhân viên nghỉ việc (yêu cầu "ghi nhận log người thực hiện").
    this.logger.log(
      `[employee-resign] actor=${caller.userId} employee_id=${id} user_id=${employee.user_id}`,
    );
    await this.audit.write({
      userId: caller.userId,
      action: 'employee_lock',
      resource: 'employees',
      resourceId: id,
      metadata: { target_user_id: employee.user_id },
    });
    return { ok: true, message: 'Đã khoá tài khoản nhân viên' };
  }

  async remove(id: number, caller?: AuthUser) {
    // Chỉ tìm nhân viên chưa bị xoá (tránh double-soft-delete trả 404 rõ ràng)
    const employee = await this.prisma.employee.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, user_id: true },
    });

    if (!employee) {
      throw new NotFoundException('Không tìm thấy nhân viên');
    }

    this.assertNotSelf(caller, employee.user_id);
    // §6 luật 3 — không xoá hồ sơ nhân sự của người giữ quyền cao hơn mình.
    if (caller) await this.assertNotEscalating(caller, employee.user_id);

    // Soft delete: đánh dấu deleted_at trên employees VÀ khoá tài khoản đăng nhập liên kết
    // (thu hồi mọi refresh token cũ). Khôi phục nhân viên KHÔNG tự mở khoá — mở khoá là thao tác riêng.
    await this.prisma.$transaction([
      this.prisma.employee.update({
        where: { id },
        data: { deleted_at: new Date() },
      }),
      this.prisma.user.update({
        where: { id: employee.user_id },
        data: { status: 'locked', tokens_valid_after: new Date() },
      }),
    ]);
    await this.rbacCache.invalidateUsers('*');

    // Audit: ai xoá (xoá mềm) nhân viên (yêu cầu "ghi nhận log người thực hiện").
    this.logger.log(
      `[employee-delete] actor=${caller?.userId ?? 'unknown'} employee_id=${id} user_id=${employee.user_id}`,
    );
    await this.audit.write({
      userId: caller?.userId ?? null,
      action: 'employee_delete',
      resource: 'employees',
      resourceId: id,
      metadata: { target_user_id: employee.user_id },
    });
    return { ok: true, message: 'Đã xoá nhân viên' };
  }

  private buildWhere(dto: QueryEmployeesDto) {
    const where: Record<string, unknown> = {};

    // Luôn loại trừ nhân viên đã bị xóa mềm
    where['deleted_at'] = null;

    if (dto.status) {
      where['status'] = dto.status;
    }

    if (dto.position) {
      where['position'] = dto.position;
    }

    if (dto.department) {
      where['department'] = dto.department;
    }

    // Lọc theo tình trạng tài khoản (employment_state):
    //  - 'active'   → users.status='active' (đang làm việc)
    //  - 'resigned' → users.status='locked' (đã nghỉ việc / vô hiệu hoá)
    //  - 'all'/absent → KHÔNG lọc status (backward-compat: useAllEmployees/payroll/contacts)
    const userWhere: Record<string, unknown> = { deleted_at: null };
    if (dto.employment_state === 'active') {
      userWhere['status'] = 'active';
    } else if (dto.employment_state === 'resigned') {
      userWhere['status'] = 'locked';
    }

    if (dto.search?.trim()) {
      const term = dto.search.trim();
      userWhere['OR'] = [
        { full_name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
      ];
    }

    where['user'] = userWhere;

    return where;
  }

  /**
   * Tải bảng `teams` (nhỏ ~10 dòng) → context resolve team cho nhân viên.
   * Mỗi entry-method gọi 1 lần rồi truyền xuống mapEmployee — KHÔNG N+1.
   */
  private async loadTeamContext(): Promise<TeamContext> {
    const teams = await this.prisma.team.findMany({
      orderBy: [{ department: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, color: true, team_lead_id: true },
    });
    const teamById = new Map<number, TeamInfo>();
    const teamByLeadId = new Map<number, number>();
    teams.forEach((t, i) => {
      teamById.set(t.id, {
        team_id: t.id,
        team_name: t.name,
        team_color: t.color,
        team_lead_id: t.team_lead_id,
        order_index: i,
      });
      if (t.team_lead_id != null && !teamByLeadId.has(t.team_lead_id)) {
        teamByLeadId.set(t.team_lead_id, t.id);
      }
    });
    return { teamById, teamByLeadId };
  }

  private mapEmployee(e: {
    id: number;
    user_id: number;
    employee_code: string | null;
    position: string;
    department: string | null;
    gender: string | null;
    education_level: string | null;
    recruitment_source: string | null;
    team_id: number | null;
    salary_rule_id: number | null;
    insurance_salary: bigint | null;
    job_title_id: number | null;
    office_id: number | null;
    registered_device_id: string | null;
    device_registered_at: Date | null;
    birth_date: Date | null;
    id_card_number: string | null;
    id_card_issued_date: Date | null;
    id_card_issued_place: string | null;
    permanent_address: string | null;
    current_address: string | null;
    bank_account_number: string | null;
    bank_name: string | null;
    bank_account_holder: string | null;
    status: string;
    joined_at: Date;
    created_at: Date;
    user: {
      id: number;
      email: string;
      full_name: string;
      phone: string | null;
      avatar_url: string | null;
      status: string;
      team_id: number | null;
      manager_id: number | null;
      manager: { full_name: string | null } | null;
      deleted_at: Date | null;
      user_roles: Array<{ role: { name: string } }>;
    };
    jobTitle: {
      id: number;
      name: string;
      category: string;
      rank_code: string;
      symbol: string;
    } | null;
    office: { id: number; name: string } | null;
  }, teamCtx: TeamContext) {
    return {
      id: e.id,
      user_id: e.user_id,
      // Mã nhân viên — ưu tiên mã nhập tay; fallback NV + id 4 chữ số (tương thích data cũ null)
      employee_code: e.employee_code ?? `NV${String(e.id).padStart(4, '0')}`,
      full_name: e.user.full_name,
      email: e.user.email,
      phone: e.user.phone,
      avatar_url: e.user.avatar_url,
      position: e.position,
      department: e.department,
      gender: e.gender,
      education_level: e.education_level,
      recruitment_source: e.recruitment_source,
      status: e.status,
      user_status: e.user.status,
      manager_id: e.user.manager_id,
      // Tên Bộ phận (quản lý phụ trách) — null khi chưa gán.
      manager_name: e.user.manager?.full_name ?? null,
      // Team CHÍNH THỨC: team_id/team_name/team_color/team_lead_id resolve từ
      // bảng `teams` (gán trực tiếp Employee.team_id → tự làm lead → quản lý là lead).
      // team_id ở đây = id team formal (KHÔNG phải raw Employee.team_id) → filter + stats.
      ...resolveTeam(e.user_id, e.user.manager_id, e.team_id, teamCtx),
      salary_rule_id: e.salary_rule_id,
      // Mức lương đóng BHXH (nhập tay) — null = dùng lương cơ bản khi tính bảo hiểm.
      insurance_salary: e.insurance_salary != null ? Number(e.insurance_salary) : null,
      job_title_id: e.job_title_id,
      job_title_name: e.jobTitle?.name ?? null,
      job_title_category: e.jobTitle?.category ?? null,
      job_title_rank_code: e.jobTitle?.rank_code ?? null,
      job_title_symbol: e.jobTitle?.symbol ?? null,
      office_id: e.office_id,
      office_name: e.office?.name ?? null,
      registered_device_id: e.registered_device_id,
      device_registered_at: e.device_registered_at,
      birth_date: e.birth_date,
      id_card_number: e.id_card_number,
      id_card_issued_date: e.id_card_issued_date,
      id_card_issued_place: e.id_card_issued_place,
      permanent_address: e.permanent_address,
      current_address: e.current_address,
      bank_account_number: e.bank_account_number,
      bank_name: e.bank_name,
      bank_account_holder: e.bank_account_holder,
      joined_at: e.joined_at,
      created_at: e.created_at,
      role: e.user.user_roles[0]?.role?.name ?? null,
    };
  }
}
