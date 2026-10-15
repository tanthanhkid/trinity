import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { Prisma } from '@prisma/client';
import { ScopeService, scopeWhere, assertInScope, runInBackground, type AuthUser } from '@trinity/rbac-nest';
import { TeamsService } from '../teams/teams.service';
import { CreateContractDto } from './dto/create-contract.dto';
import { UpdateContractDto } from './dto/update-contract.dto';
import { QueryContractsDto } from './dto/query-contracts.dto';
import { QueryContractStatsDto } from './dto/query-contract-stats.dto';
import { computeContractStatus, EXPIRY_WARNING_DAYS } from './contract-status.helper';
import { StorageService } from '../storage/storage.service';
import {
  decodeMultipartFilename,
  repairMojibakeText,
} from '../common/helpers/decode-multipart-filename.helper';

const CONTRACT_SELECT = {
  id: true,
  employee_id: true,
  contract_type: true,
  signed_date: true,
  end_date: true,
  file_url: true,
  notes: true,
  is_terminated: true,
  terminated_at: true,
  created_at: true,
  updated_at: true,
  employee: {
    select: {
      id: true,
      employee_code: true,
      position: true,
      department: true,
      gender: true,
      user: { select: { full_name: true, email: true, avatar_url: true } },
      jobTitle: { select: { name: true } },
    },
  },
} as const;

type ContractWithEmployee = Prisma.EmployeeContractGetPayload<{
  select: typeof CONTRACT_SELECT;
}>;

// Sắp xếp + nhóm theo team (team_lead user id): theo thứ tự team trong Cài đặt > Team,
// rồi team khác, người không team cuối. `leadIds` = các team_lead_id lấy từ bảng `teams`.
function teamRank(leadId: number | null, rankByLead: ReadonlyMap<number, number>): number {
  if (leadId == null) return 999_999;
  return rankByLead.get(leadId) ?? 500_000;
}
function deriveTeam(
  userId: number,
  ownName: string,
  managerId: number | null,
  managerName: string | null,
  leadIds?: ReadonlySet<number>,
): { team_lead_id: number | null; team_name: string | null } {
  if (leadIds?.has(userId)) return { team_lead_id: userId, team_name: ownName };
  if (managerId != null && leadIds?.has(managerId))
    return { team_lead_id: managerId, team_name: managerName };
  return { team_lead_id: null, team_name: null };
}
function compareByTeam(
  a: { team_lead_id: number | null; user_id: number; full_name: string | null },
  b: { team_lead_id: number | null; user_id: number; full_name: string | null },
  rankByLead: ReadonlyMap<number, number>,
): number {
  const ra = teamRank(a.team_lead_id, rankByLead);
  const rb = teamRank(b.team_lead_id, rankByLead);
  if (ra !== rb) return ra - rb;
  const la = a.team_lead_id ?? 0;
  const lb = b.team_lead_id ?? 0;
  if (la !== lb) return la - lb;
  const sa = a.user_id === a.team_lead_id ? 0 : 1; // team_lead đứng trước trong nhóm
  const sb = b.user_id === b.team_lead_id ? 0 : 1;
  if (sa !== sb) return sa - sb;
  return (a.full_name ?? '').localeCompare(b.full_name ?? '', 'vi');
}

// Danh sách hợp đồng liệt kê THEO NHÂN VIÊN: mỗi nhân viên + hợp đồng MỚI NHẤT (nếu có).
const EMPLOYEE_ROW_SELECT = {
  id: true,
  user_id: true,
  employee_code: true,
  position: true,
  department: true,
  gender: true,
  status: true,
  // team_id gán TRỰC TIẾP (employees.team_id, cơ chế) cần cho
  // resolveFormalTeamId() filter theo team CHÍNH THỨC (mirror employees.service).
  team_id: true,
  // user.status: NV bị khoá tài khoản (locked) = đã nghỉ việc (nguồn chuẩn
  // như Quản lý NV) → employment_status không hiển thị "Đang làm việc" sai.
  user: { select: { full_name: true, email: true, avatar_url: true, manager_id: true, status: true, manager: { select: { full_name: true } } } },
  jobTitle: { select: { name: true } },
  contracts: {
    select: {
      id: true,
      contract_type: true,
      signed_date: true,
      end_date: true,
      file_url: true,
      notes: true,
      is_terminated: true,
      terminated_at: true,
      created_at: true,
      updated_at: true,
    },
    orderBy: { signed_date: 'desc' },
    take: 1,
  },
} as const;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_ROW_SELECT }>;

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly teamsService: TeamsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Mẫu A: `contracts.view` scoped — chỉ NV (user_id) trong phạm vi actor. Giao AND với
   * where nghiệp vụ, KHÔNG spread (tránh ghi đè key trùng).
   */
  private async scopedEmployeeWhere(
    user: AuthUser,
    base: Prisma.EmployeeWhereInput,
  ): Promise<Prisma.EmployeeWhereInput> {
    const owner = await this.scope.ownerIds(user, 'contracts.view');
    return { AND: [scopeWhere(owner ?? [], ['user_id']), base] };
  }

  /** Hợp đồng ngoài phạm vi `contracts.view` → 404. */
  private async assertContractInScope(user: AuthUser, employeeId: number): Promise<void> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { user_id: true },
    });
    await assertInScope(this.scope, user, 'contracts.view', [emp?.user_id]);
  }

  async findAll(dto: QueryContractsDto, user: AuthUser) {
    const page = dto.page ?? 1;
    const pageSize = dto.page_size ?? 25;
    const skip = (page - 1) * pageSize;

    // liệt kê THEO NHÂN VIÊN — mọi nhân viên đều hiển thị, kể cả người chưa có HĐ
    // ("Chưa có hợp đồng"). Mỗi dòng đính kèm hợp đồng mới nhất (nếu có).
    const where = await this.scopedEmployeeWhere(user, this.buildEmployeeWhere(dto));

    // Lấy toàn bộ NV khớp filter (≤ vài trăm) rồi sắp xếp theo TEAM ở app-layer:
    // theo thứ tự team trong Cài đặt → team khác → không team; trong nhóm team_lead đứng
    // trước. Prisma orderBy không làm được thứ tự team tùy biến → phân trang JS sau sort.
    const all = await this.prisma.employee.findMany({
      where,
      select: EMPLOYEE_ROW_SELECT,
    });

    // Team_lead nhận diện từ bảng `teams` (Cài đặt > Team).
    const teamsFromSettings = await this.teamsService.listForFilter();
    const rankByLead = new Map<number, number>();
    teamsFromSettings.forEach((t, idx) => {
      if (t.team_lead_id != null && !rankByLead.has(t.team_lead_id)) rankByLead.set(t.team_lead_id, idx);
    });
    const leadIds = new Set(rankByLead.keys());
    const mapped = all.map((e) => this.mapEmployeeRow(e, leadIds));

    if (dto.sort_by) {
      const dir = dto.sort_dir === 'desc' ? -1 : 1;
      const field = dto.sort_by;
      mapped.sort((a, b) => {
        let av: string | number | Date | null;
        let bv: string | number | Date | null;
        switch (field) {
          case 'full_name':
            av = a.employee.full_name;
            bv = b.employee.full_name;
            break;
          case 'employee_code':
            av = a.employee.employee_code;
            bv = b.employee.employee_code;
            break;
          case 'signed_date':
            av = a.signed_date ? new Date(a.signed_date) : null;
            bv = b.signed_date ? new Date(b.signed_date) : null;
            break;
          case 'end_date':
            av = a.end_date ? new Date(a.end_date) : null;
            bv = b.end_date ? new Date(b.end_date) : null;
            break;
          case 'days_remaining':
            av = a.days_remaining;
            bv = b.days_remaining;
            break;
          case 'status':
            av = a.status;
            bv = b.status;
            break;
          case 'contract_type':
            av = a.contract_type;
            bv = b.contract_type;
            break;
          case 'department':
            av = a.employee.department;
            bv = b.employee.department;
            break;
          default:
            return 0;
        }
        // Null values pushed to end regardless of direction
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av instanceof Date && bv instanceof Date) {
          return dir * (av.getTime() - bv.getTime());
        }
        if (typeof av === 'number' && typeof bv === 'number') {
          return dir * (av - bv);
        }
        return dir * String(av).localeCompare(String(bv), 'vi');
      });
    } else {
      mapped.sort((a, b) => compareByTeam(a.employee, b.employee, rankByLead));
    }

    // Lọc theo team CHÍNH THỨC (id bảng `teams`, KHÔNG phải team_lead_id).
    // FE dropdown gửi `id` team (mirror employees.service `resolveTeam().team_id`)
    // value NÀY khác `employee.team_lead_id` dùng để SORT/HIỂN THỊ (chỉ suy từ
    // self/manager-là-lead, KHÔNG nhận diện gán TRỰC TIẾP employees.team_id, và
    // KHÔNG tồn tại cho team chưa có Người phụ trách). Resolve
    // riêng — lazy, chỉ khi có filter — để không tốn query khi không lọc team.
    let filtered = mapped;
    if (dto.team) {
      const teamCtx = await this.loadFormalTeamContext();
      const formalTeamIdByEmployeeId = new Map<number, number | null>();
      for (const e of all) {
        formalTeamIdByEmployeeId.set(e.id, this.resolveFormalTeamId(e, teamCtx));
      }
      filtered = mapped.filter(
        (m) => String(formalTeamIdByEmployeeId.get(m.employee.id) ?? '') === dto.team,
      );
    }

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

  async findById(id: number, user: AuthUser) {
    const contract = await this.prisma.employeeContract.findUnique({
      where: { id },
      select: CONTRACT_SELECT,
    });
    if (!contract) {
      throw new NotFoundException('Không tìm thấy hợp đồng');
    }
    await this.assertContractInScope(user, contract.employee_id);
    return this.mapContract(contract);
  }

  async create(dto: CreateContractDto) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: dto.employee_id },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException('Không tìm thấy nhân viên');
    }

    const isTerminated = dto.is_terminated ?? false;
    const contract = await this.prisma.employeeContract.create({
      data: {
        employee_id: dto.employee_id,
        contract_type: dto.contract_type ?? 'hdld_1',
        signed_date: new Date(dto.signed_date),
        end_date: dto.end_date ? new Date(dto.end_date) : null,
        file_url: null, // chỉ đặt qua uploadFile — khoá lưu trữ không nhận từ client
        notes: dto.notes ?? null,
        is_terminated: isTerminated,
        terminated_at: isTerminated ? new Date() : null,
      },
      select: CONTRACT_SELECT,
    });
    return this.mapContract(contract);
  }

  async update(id: number, dto: UpdateContractDto) {
    const existing = await this.prisma.employeeContract.findUnique({
      where: { id },
      select: { id: true, is_terminated: true },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy hợp đồng');
    }

    const data: Prisma.EmployeeContractUpdateInput = {};
    if (dto.contract_type !== undefined) data.contract_type = dto.contract_type;
    if (dto.signed_date !== undefined) data.signed_date = new Date(dto.signed_date);
    if (dto.end_date !== undefined) {
      data.end_date = dto.end_date ? new Date(dto.end_date) : null;
    }
    if (dto.notes !== undefined) data.notes = dto.notes ?? null;
    if (dto.is_terminated !== undefined) {
      data.is_terminated = dto.is_terminated;
      // Set/clear thời điểm chấm dứt theo chuyển trạng thái.
      if (dto.is_terminated && !existing.is_terminated) {
        data.terminated_at = new Date();
      } else if (!dto.is_terminated) {
        data.terminated_at = null;
      }
    }

    const contract = await this.prisma.employeeContract.update({
      where: { id },
      data,
      select: CONTRACT_SELECT,
    });
    return this.mapContract(contract);
  }

  async remove(id: number) {
    const existing = await this.prisma.employeeContract.findUnique({
      where: { id },
      select: { id: true, file_url: true },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy hợp đồng');
    }
    await this.prisma.employeeContract.delete({ where: { id } });
    // File hợp đồng chứa dữ liệu cá nhân: xoá luôn object (best-effort, như removeFile) để không mồ côi.
    const fileKey = existing.file_url;
    if (fileKey) {
      runInBackground(() => this.storage.delete(fileKey));
    }
    return { ok: true };
  }

  // ---- File hợp đồng (MinIO) ----

  /**
   * Tải file hợp đồng lên MinIO, lưu storage key vào `file_url`.
   * Orphan-safe: ghi DB lỗi sau khi upload → xoá file vừa upload (tránh rác MinIO).
   * Thay file cũ → xoá file cũ (best-effort) sau khi cập nhật thành công.
   */
  async uploadFile(id: number, file: Express.Multer.File) {
    const existing = await this.prisma.employeeContract.findUnique({
      where: { id },
      select: { id: true, employee_id: true, file_url: true },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy hợp đồng');
    }

    const decodedName = decodeMultipartFilename(file.originalname);
    const safeName = (decodedName || 'hop-dong').replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );
    const key = `contracts/${existing.employee_id}/${id}/${Date.now()}_${safeName}`;
    await this.storage.upload(key, file.buffer, file.mimetype);

    let contract: ContractWithEmployee;
    try {
      contract = await this.prisma.employeeContract.update({
        where: { id },
        data: { file_url: key },
        select: CONTRACT_SELECT,
      });
    } catch (err) {
      // Ghi DB lỗi sau khi upload → dọn file vừa upload (best-effort)
      runInBackground(() => this.storage.delete(key));
      throw err;
    }

    const oldKey = existing.file_url;
    if (oldKey && oldKey !== key) {
      runInBackground(() => this.storage.delete(oldKey));
    }
    return this.mapContract(contract);
  }

  /** Lấy stream file hợp đồng để backend proxy về browser (MinIO không reachable trực tiếp). */
  async streamFile(id: number, user: AuthUser) {
    const contract = await this.prisma.employeeContract.findUnique({
      where: { id },
      select: { id: true, file_url: true, employee_id: true },
    });
    if (!contract) {
      throw new NotFoundException('Không tìm thấy hợp đồng');
    }
    await this.assertContractInScope(user, contract.employee_id);
    if (!contract.file_url) {
      throw new NotFoundException('Hợp đồng chưa có file đính kèm');
    }
    const { body, contentType, contentLength } =
      await this.storage.getObjectStream(contract.file_url);
    // Tên hiển thị khi tải: bỏ tiền tố timestamp trong key
    const base = contract.file_url.split('/').pop() ?? 'hop-dong';
    const fileName = base.replace(/^\d+_/, '');
    return { body, contentType, contentLength, fileName };
  }

  /** Xoá file hợp đồng (xoá MinIO best-effort + clear file_url). */
  async removeFile(id: number) {
    const contract = await this.prisma.employeeContract.findUnique({
      where: { id },
      select: { id: true, file_url: true },
    });
    if (!contract) {
      throw new NotFoundException('Không tìm thấy hợp đồng');
    }
    const fileKey = contract.file_url;
    if (fileKey) {
      runInBackground(() => this.storage.delete(fileKey));
    }
    const updated = await this.prisma.employeeContract.update({
      where: { id },
      data: { file_url: null },
      select: CONTRACT_SELECT,
    });
    return this.mapContract(updated);
  }

  // ============================================================
  // HỒ SƠ MẪU HỢP ĐỒNG — file mẫu CHUNG, KHÔNG gắn employee
  // ============================================================

  private mapTemplate(t: {
    id: number;
    name: string;
    mime: string;
    size: number;
    uploaded_by: number | null;
    created_at: Date;
  }) {
    return {
      id: t.id,
      // Sửa mojibake cho tên file mẫu cũ (upload TRƯỚC khi có decode ở luồng upload).
      // Idempotent: tên UTF-8 đúng giữ nguyên; chỉ tên hỏng (toàn ký tự ≤0xFF) mới decode lại.
      name: repairMojibakeText(t.name),
      mime: t.mime,
      size: t.size,
      uploaded_by: t.uploaded_by,
      created_at: t.created_at,
    };
  }

  /** Danh sách hồ sơ mẫu hợp đồng (mới nhất trước). */
  async listTemplates() {
    const rows = await this.prisma.contractTemplate.findMany({
      orderBy: { created_at: 'desc' },
    });
    return rows.map((t) => this.mapTemplate(t));
  }

  /** Tải file mẫu lên MinIO + lưu metadata. Orphan-safe: ghi DB lỗi → xoá file vừa upload. */
  async uploadTemplate(
    file: Express.Multer.File,
    uploadedBy: number,
    displayName?: string,
  ) {
    const decodedName = decodeMultipartFilename(file.originalname);
    const safeName = (decodedName || 'mau-hop-dong').replace(
      /[^a-zA-Z0-9._-]/g,
      '_',
    );
    const key = `contract-templates/${Date.now()}_${safeName}`;
    await this.storage.upload(key, file.buffer, file.mimetype);

    try {
      const row = await this.prisma.contractTemplate.create({
        data: {
          name: displayName?.trim() || decodedName || safeName,
          storage_key: key,
          mime: file.mimetype,
          size: file.size,
          uploaded_by: uploadedBy,
        },
      });
      return this.mapTemplate(row);
    } catch (err) {
      runInBackground(() => this.storage.delete(key));
      throw err;
    }
  }

  /** Stream file mẫu để backend proxy về browser (MinIO không reachable trực tiếp). */
  async streamTemplate(id: number) {
    const tpl = await this.prisma.contractTemplate.findUnique({ where: { id } });
    if (!tpl) {
      throw new NotFoundException('Không tìm thấy hồ sơ mẫu');
    }
    const { body, contentType, contentLength } =
      await this.storage.getObjectStream(tpl.storage_key);
    return {
      body,
      contentType: tpl.mime || contentType,
      contentLength,
      fileName: repairMojibakeText(tpl.name),
    };
  }

  /** Xoá hồ sơ mẫu (xoá MinIO best-effort + xoá row DB). */
  async deleteTemplate(id: number) {
    const tpl = await this.prisma.contractTemplate.findUnique({ where: { id } });
    if (!tpl) {
      throw new NotFoundException('Không tìm thấy hồ sơ mẫu');
    }
    runInBackground(() => this.storage.delete(tpl.storage_key));
    await this.prisma.contractTemplate.delete({ where: { id } });
    return { ok: true, id };
  }

  // ---- helpers ----

  // Team CHÍNH THỨC (bảng `teams`) cho filter `dto.team` — mirror
  // employees.service.ts `resolveTeam()` priority: (1) gán TRỰC TIẾP
  // employees.team_id, (2) chính NV là team_lead của 1 team, (3) quản lý NV là
  // team_lead của 1 team. Tách hàm riêng (KHÔNG dùng deriveTeam —
  // hàm đó chỉ suy team_lead_id để SORT/HIỂN THỊ, không có khái niệm team.id và
  // không nhận diện gán trực tiếp) để hỗ trợ team CHƯA có Người phụ trách.
  private async loadFormalTeamContext(): Promise<{
    teamIds: Set<number>;
    teamByLeadId: Map<number, number>;
  }> {
    const teams = await this.prisma.team.findMany({
      select: { id: true, team_lead_id: true },
    });
    const teamIds = new Set(teams.map((t) => t.id));
    const teamByLeadId = new Map<number, number>();
    for (const t of teams) {
      if (t.team_lead_id != null && !teamByLeadId.has(t.team_lead_id)) {
        teamByLeadId.set(t.team_lead_id, t.id);
      }
    }
    return { teamIds, teamByLeadId };
  }

  private resolveFormalTeamId(
    e: EmployeeRow,
    ctx: { teamIds: Set<number>; teamByLeadId: Map<number, number> },
  ): number | null {
    if (e.team_id != null && ctx.teamIds.has(e.team_id)) return e.team_id;
    if (ctx.teamByLeadId.has(e.user_id)) return ctx.teamByLeadId.get(e.user_id)!;
    const managerId = e.user?.manager_id ?? null;
    if (managerId != null && ctx.teamByLeadId.has(managerId)) {
      return ctx.teamByLeadId.get(managerId)!;
    }
    return null;
  }

  // WHERE theo NHÂN VIÊN (danh sách liệt kê mọi nhân viên).
  // đồng bộ với /management/employees: loại trừ nhân viên đã xoá mềm (deleted_at IS NOT NULL).
  private buildEmployeeWhere(dto: QueryContractsDto): Prisma.EmployeeWhereInput {
    const where: Prisma.EmployeeWhereInput = {};
    const and: Prisma.EmployeeWhereInput[] = [];

    // Loại trừ nhân viên đã bị soft-delete — đồng bộ count với /management/employees
    where.deleted_at = null;

    if (dto.department) where.department = dto.department;
    if (dto.position) where.position = dto.position;

    // Tình trạng làm việc: nghỉ việc = employees.status='resigned' HOẶC
    // tài khoản khoá (user.status='locked'). Ghép qua and[] (KHÔNG set where.status
    // trực tiếp) để không đè key + khớp đúng mapEmployeeRow.
    if (dto.employment_status === 'resigned') {
      and.push({ OR: [{ status: 'resigned' }, { user: { status: 'locked' } }] });
    } else if (dto.employment_status === 'working') {
      and.push({ status: { not: 'resigned' }, user: { status: { not: 'locked' } } });
    }

    const search = dto.search?.trim();
    if (search) {
      const ors: Prisma.EmployeeWhereInput[] = [
        { employee_code: { contains: search, mode: 'insensitive' } },
        { user: { full_name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
      const asId = Number(search);
      if (Number.isInteger(asId) && asId > 0) ors.push({ id: asId });
      and.push({ OR: ors });
    }

    // Lọc theo loại hợp đồng — dùng `some` (mỗi NV thường chỉ có 1 HĐ; dòng hiển thị là HĐ mới nhất).
    // Bỏ qua khi đang lọc "chưa có hợp đồng" — `some` + `none` mâu thuẫn → luôn 0 dòng.
    if (dto.contract_type && dto.status !== 'no_contract') {
      and.push({ contracts: { some: { contract_type: dto.contract_type } } });
    }

    // Lọc theo trạng thái hợp đồng (tính từ end_date + is_terminated).
    if (dto.status === 'no_contract') {
      and.push({ contracts: { none: {} } });
    } else if (dto.status) {
      const now = new Date();
      const warnEdge = new Date(
        now.getTime() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000,
      );
      let cond: Prisma.EmployeeContractWhereInput = {};
      switch (dto.status) {
        case 'terminated':
          cond = { is_terminated: true };
          break;
        case 'active':
          cond = {
            is_terminated: false,
            OR: [{ end_date: null }, { end_date: { gt: warnEdge } }],
          };
          break;
        case 'expiring':
          cond = { is_terminated: false, end_date: { gte: now, lte: warnEdge } };
          break;
        case 'expired':
          cond = { is_terminated: false, end_date: { lt: now } };
          break;
      }
      and.push({ contracts: { some: cond } });
    }

    if (and.length > 0) where.AND = and;
    return where;
  }

  private mapContract(c: ContractWithEmployee) {
    const { status, days_remaining } = computeContractStatus(
      c.end_date,
      c.is_terminated,
    );
    return {
      id: c.id,
      contract_type: c.contract_type,
      signed_date: c.signed_date,
      end_date: c.end_date,
      file_url: c.file_url,
      notes: c.notes,
      is_terminated: c.is_terminated,
      terminated_at: c.terminated_at,
      created_at: c.created_at,
      updated_at: c.updated_at,
      status,
      days_remaining,
      employee: {
        id: c.employee.id,
        // Mã NV thống nhất với /management/employees + /payroll: mã nhập tay, fallback NV<id 4 số>
        employee_code:
          c.employee.employee_code ?? `NV${String(c.employee.id).padStart(4, '0')}`,
        full_name: c.employee.user?.full_name ?? null,
        email: c.employee.user?.email ?? null,
        avatar_url: c.employee.user?.avatar_url ?? null,
        position: c.employee.position,
        department: c.employee.department,
        gender: c.employee.gender,
        job_title_name: c.employee.jobTitle?.name ?? null,
      },
    };
  }

  // map 1 nhân viên + hợp đồng mới nhất → dòng FLAT-NULLABLE (HĐ có thể null = "Chưa có hợp đồng").
  // `teamLeadIds`: team_lead nhận diện từ bảng `teams` (Cài đặt > Team).
  private mapEmployeeRow(e: EmployeeRow, teamLeadIds?: ReadonlySet<number>) {
    const contract = e.contracts[0] ?? null;
    const { status, days_remaining } = contract
      ? computeContractStatus(contract.end_date, contract.is_terminated)
      : { status: 'no_contract' as const, days_remaining: null };
    // nghỉ việc = employees.status='resigned' HOẶC tài khoản bị khoá (user.status='locked').
    const employment_status: 'working' | 'resigned' =
      e.status === 'resigned' || e.user?.status === 'locked' ? 'resigned' : 'working';
    const team = deriveTeam(
      e.user_id,
      e.user?.full_name ?? '',
      e.user?.manager_id ?? null,
      e.user?.manager?.full_name ?? null,
      teamLeadIds,
    );
    return {
      id: contract?.id ?? null,
      contract_type: contract?.contract_type ?? null,
      signed_date: contract?.signed_date ?? null,
      end_date: contract?.end_date ?? null,
      file_url: contract?.file_url ?? null,
      notes: contract?.notes ?? null,
      is_terminated: contract?.is_terminated ?? false,
      terminated_at: contract?.terminated_at ?? null,
      created_at: contract?.created_at ?? null,
      updated_at: contract?.updated_at ?? null,
      status,
      days_remaining,
      employee: {
        id: e.id,
        user_id: e.user_id,
        // Mã NV thống nhất với /management/employees + /payroll: mã nhập tay, fallback NV<id 4 số>
        employee_code: e.employee_code ?? `NV${String(e.id).padStart(4, '0')}`,
        full_name: e.user?.full_name ?? null,
        email: e.user?.email ?? null,
        avatar_url: e.user?.avatar_url ?? null,
        position: e.position,
        department: e.department,
        gender: e.gender,
        // Team (cột "Team") self-aware + id để FE tô màu / BE sort nhóm.
        team_lead_name: team.team_name,
        team_lead_id: team.team_lead_id,
        job_title_name: e.jobTitle?.name ?? null,
        employment_status,
      },
    };
  }

  // where Prisma cho getStats(): CHỈ department + employment_status
  // (áp được ở tầng DB). team (computed field) + date_from/date_to (cần logic
  // no_contract đặc biệt) lọc SAU khi map rows — xem getStats().
  private buildStatsWhere(dto?: QueryContractStatsDto): Prisma.EmployeeWhereInput {
    const where: Prisma.EmployeeWhereInput = { deleted_at: null };
    if (dto?.department) where.department = dto.department;
    // nghỉ việc = employees.status='resigned' HOẶC user.status='locked'.
    if (dto?.employment_status === 'resigned') {
      where.OR = [{ status: 'resigned' }, { user: { status: 'locked' } }];
    } else if (dto?.employment_status === 'working') {
      where.status = { not: 'resigned' };
      where.user = { status: { not: 'locked' } };
    }
    return where;
  }

  // Thống kê hợp đồng toàn công ty (dialog "Thống kê hợp đồng"). Tái dùng
  // mapEmployeeRow để trạng thái/loại HĐ/team khớp 100% với bảng danh sách.
  // dto optional: KHÔNG truyền gì = hành vi CŨ 100% (toàn bộ NV, không lọc).
  async getStats(user: AuthUser, dto?: QueryContractStatsDto) {
    // nguồn team CHÍNH THỨC từ Cài đặt > Team (bảng `teams`). Team mới tạo/đổi tên ở
    // Cài đặt phải phản ánh NGAY trong thống kê — KHÔNG cần sửa code.
    const teamsFromSettings = await this.teamsService.listForFilter();
    const teamByLeadId = new Map(teamsFromSettings.map((t) => [t.team_lead_id, t]));
    const teamSettingsRank = new Map(
      teamsFromSettings.map((t, idx) => [t.team_lead_id, idx]),
    );
    // deriveTeam() nhận diện team_lead đã được set làm team_lead_id trong Cài đặt.
    // listForFilter() không truyền includeUnled → luôn CHỈ trả team có team_lead_id
    // (hành vi cũ); filter null chỉ để khớp type (team_lead_id giờ nullable).
    const extraTeamLeadIds = new Set(
      teamsFromSettings
        .map((t) => t.team_lead_id)
        .filter((id): id is number => id != null),
    );

    const all = await this.prisma.employee.findMany({
      where: await this.scopedEmployeeWhere(user, this.buildStatsWhere(dto)),
      select: EMPLOYEE_ROW_SELECT,
    });
    let rows = all.map((e) => this.mapEmployeeRow(e, extraTeamLeadIds));

    // lọc team (computed field, SAU khi map — mirror findAll()).
    if (dto?.team) {
      rows = rows.filter((r) => String(r.employee.team_lead_id) === dto.team);
    }

    // lọc theo signed_date CHỈ khi có date_from/date_to. Nhân viên
    // "no_contract" (signed_date=null) KHÔNG match khoảng ngày → loại khỏi kết
    // quả khi ĐANG lọc ngày (đúng ngữ nghĩa "HĐ ký trong khoảng"). KHÔNG lọc
    // ngày (mặc định) → giữ nguyên rows 100% bao gồm no_contract (hành vi cũ).
    //
    // ⚠️ signed_date lưu VN-midnight UTC (vd VN 01/06 → 2026-05-31T17:00:00Z —
    // xem convention +7h ở signed_by_month bên dưới). date_from/date_to từ FE
    // là chuỗi YYYY-MM-DD thuần (todayVn()/firstDayOfMonthVn(), KHÔNG offset) →
    // PHẢI +7h vào giá trị đã lưu trước khi so sánh với UTC-midnight của
    // date_from/date_to, nếu không HĐ ký đúng ngày date_from bị loại oan
    // (lưu 17h hôm trước < UTC-midnight date_from) và HĐ ký ngày date_to+1 lại
    // lọt vào (lưu 17h date_to < UTC-midnight cuối ngày date_to).
    if (dto?.date_from || dto?.date_to) {
      const fromMs = dto.date_from ? new Date(dto.date_from).getTime() : -Infinity;
      const toMs = dto.date_to
        ? new Date(dto.date_to).getTime() + 24 * 60 * 60 * 1000 - 1 // hết ngày date_to
        : Infinity;
      const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
      rows = rows.filter((r) => {
        if (!r.signed_date) return false;
        const vnMs = new Date(r.signed_date).getTime() + VN_OFFSET_MS;
        return vnMs >= fromMs && vnMs <= toMs;
      });
    }

    const STATUS_LABEL: Record<string, string> = {
      active: 'Đang hiệu lực',
      expiring: 'Sắp hết hạn',
      expired: 'Hết hạn',
      terminated: 'Đã chấm dứt',
      no_contract: 'Chưa có HĐ',
    };
    // 4 loại HĐLĐ hiện hành luôn hiện; 4 slug cũ chỉ hiện khi còn hồ sơ dùng (backward-compat).
    const CURRENT_TYPE_KEYS = ['hdld_vo_thoi_han', 'hdld_1', 'hdld_2', 'hdld_3'];
    const TYPE_LABEL: Record<string, string> = {
      hdld_vo_thoi_han: 'HĐLĐ vô thời hạn',
      hdld_1: 'HĐLĐ 1',
      hdld_2: 'HĐLĐ 2',
      hdld_3: 'HĐLĐ 3',
      thu_viec: 'Thử việc',
      chinh_thuc: 'Chính thức',
      co_thoi_han: 'Có thời hạn',
      khong_thoi_han: 'Không thời hạn',
    };

    const statusCount = new Map<string, number>();
    const typeCount = new Map<string, number>();
    const monthCount = new Map<string, number>();
    const teamMap = new Map<
      string,
      { team_lead_id: number | null; label: string; count: number }
    >();
    let working = 0;
    let resigned = 0;
    // Sắp hết hạn trong 3 tháng tới, nhóm theo thời gian còn lại.
    let exp1m = 0; // còn ≤ 30 ngày
    let exp2m = 0; // 31–60 ngày
    let exp3m = 0; // 61–90 ngày

    // pre-seed MỌI team chính thức (count=0) để Team mới tạo trong Cài đặt
    // xuất hiện NGAY trong thống kê kể cả khi chưa có nhân viên nào được gán.
    for (const t of teamsFromSettings) {
      teamMap.set(String(t.team_lead_id), {
        team_lead_id: t.team_lead_id,
        label: t.name,
        count: 0,
      });
    }

    for (const r of rows) {
      statusCount.set(r.status, (statusCount.get(r.status) ?? 0) + 1);
      const typeKey = r.contract_type ?? 'none';
      typeCount.set(typeKey, (typeCount.get(typeKey) ?? 0) + 1);
      if (r.employee.employment_status === 'resigned') resigned += 1;
      else working += 1;

      const tKey =
        r.employee.team_lead_id != null
          ? String(r.employee.team_lead_id)
          : 'none';
      const existing = teamMap.get(tKey);
      if (existing) existing.count += 1;
      else {
        // ưu tiên TÊN TEAM CHÍNH THỨC (bảng `teams`, đổi tên ở Cài đặt
        // phản ánh ngay); nếu team_lead_id không khớp team nào trong Cài đặt
        // (vd manager chưa được set làm team_lead) → giữ hành vi cũ (tên người
        // quản lý, hoặc "Chưa có team" khi null) — không mất dữ liệu.
        const officialTeam =
          r.employee.team_lead_id != null
            ? teamByLeadId.get(r.employee.team_lead_id)
            : undefined;
        teamMap.set(tKey, {
          team_lead_id: r.employee.team_lead_id,
          label: officialTeam?.name ?? r.employee.team_lead_name ?? 'Chưa có team',
          count: 1,
        });
      }

      if (r.signed_date) {
        // signed_date lưu VN-midnight UTC → +7h để lấy đúng tháng theo giờ VN.
        const vn = new Date(new Date(r.signed_date).getTime() + 7 * 3600 * 1000);
        const ym = `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, '0')}`;
        monthCount.set(ym, (monthCount.get(ym) ?? 0) + 1);
      }

      // Bucket sắp hết hạn (days_remaining > 0 và ≤ 90 ngày). days_remaining
      // null/≤0 cho HĐ vô thời hạn / đã hết hạn / đã chấm dứt / chưa có HĐ.
      const d = r.days_remaining;
      if (d != null && d > 0 && d <= 90) {
        if (d <= 30) exp1m += 1;
        else if (d <= 60) exp2m += 1;
        else exp3m += 1;
      }
    }

    const by_status = Object.keys(STATUS_LABEL).map((k) => ({
      key: k,
      label: STATUS_LABEL[k],
      count: statusCount.get(k) ?? 0,
    }));
    const by_type = [
      ...Object.keys(TYPE_LABEL)
        .filter((k) => CURRENT_TYPE_KEYS.includes(k) || (typeCount.get(k) ?? 0) > 0)
        .map((k) => ({
          key: k,
          label: TYPE_LABEL[k],
          count: typeCount.get(k) ?? 0,
        })),
      { key: 'none', label: 'Chưa có HĐ', count: typeCount.get('none') ?? 0 },
    ];
    const by_employment = [
      { key: 'working', label: 'Đang làm việc', count: working },
      { key: 'resigned', label: 'Đã nghỉ', count: resigned },
    ];
    // sort: team CHÍNH THỨC (theo thứ tự Cài đặt > Team, tức
    // listForFilter() = department/name asc) trước, nhóm không khớp team chính
    // thức đứng sau, "Chưa có team" luôn cuối cùng.
    const NO_TEAM_RANK = Number.MAX_SAFE_INTEGER;
    function byTeamRank(leadId: number | null): number {
      if (leadId == null) return NO_TEAM_RANK;
      const settingsRank = teamSettingsRank.get(leadId);
      if (settingsRank != null) return settingsRank;
      return 100000; // sau mọi team chính thức
    }
    const by_team = Array.from(teamMap.values())
      .sort((a, b) => byTeamRank(a.team_lead_id) - byTeamRank(b.team_lead_id))
      .map((t) => ({
        team_lead_id: t.team_lead_id,
        label: t.label,
        count: t.count,
      }));

    // 12 tháng gần nhất (theo giờ VN), gồm tháng hiện tại.
    const nowVn = new Date(Date.now() + 7 * 3600 * 1000);
    const signed_by_month: { month: string; count: number }[] = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(
        Date.UTC(nowVn.getUTCFullYear(), nowVn.getUTCMonth() - i, 1),
      );
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      signed_by_month.push({ month: ym, count: monthCount.get(ym) ?? 0 });
    }

    const expiring_3m = [
      { key: 'm1', label: 'Còn ≤ 1 tháng', count: exp1m },
      { key: 'm2', label: 'Còn 1–2 tháng', count: exp2m },
      { key: 'm3', label: 'Còn 2–3 tháng', count: exp3m },
    ];

    return {
      total: rows.length,
      by_status,
      by_type,
      by_employment,
      by_team,
      signed_by_month,
      expiring_3m,
    };
  }
}
