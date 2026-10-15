import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';

/** Chuẩn hoá màu hex (#rgb / #rrggbb). Rỗng/không hợp lệ → null (FE fallback palette). */
function normalizeColor(color: string | null | undefined): string | null {
  if (color == null) return null;
  const v = color.trim();
  if (v === '') return null;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v.toLowerCase() : null;
}

export type TeamRow = {
  id: number;
  name: string;
  department: string | null;
  description: string | null;
  team_lead_id: number | null;
  team_lead_name: string | null;
  color: string | null;
  member_count: number;
};

export type TeamMemberRow = {
  user_id: number;
  full_name: string | null;
  email: string | null;
  role: string | null;
};

/**
 * 1 lựa chọn của dropdown "Team" ở bộ lọc theo cây quản lý. Giá trị filter là
 * `team_lead_id` (id user của trưởng nhóm), KHÔNG phải `teams.id`.
 */
export type TeamLeadFilterRow = {
  team_lead_id: number;
  name: string;
};

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<TeamRow[]> {
    const teams = await this.prisma.team.findMany({
      orderBy: [{ department: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        department: true,
        description: true,
        team_lead_id: true,
        color: true,
      },
    });
    if (teams.length === 0) return [];

    const leadIds = [
      ...new Set(
        teams
          .map((t) => t.team_lead_id)
          .filter((x): x is number => x != null),
      ),
    ];
    const leads = leadIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, full_name: true },
        })
      : [];
    const leadMap = new Map(leads.map((l) => [l.id, l.full_name]));

    // Đếm thành viên mỗi team: ƯU TIÊN gán TRỰC TIẾP (employees.team_id) — áp cho MỌI
    // role; nhân viên CHƯA gán team_id thì SUY RA theo cấp trên (manager_id = trưởng
    // nhóm) để sale vẫn được tính (tương thích ngược). Mỗi nhân viên chỉ tính 1 lần.
    const teamIdSet = new Set(teams.map((t) => t.id));
    const teamByLead = new Map<number, number>(); // lead user id → team id (suy theo manager)
    for (const t of teams) {
      if (t.team_lead_id != null && !teamByLead.has(t.team_lead_id)) {
        teamByLead.set(t.team_lead_id, t.id);
      }
    }

    const members = await this.prisma.employee.findMany({
      where: {
        deleted_at: null,
        OR: [
          { team_id: { in: teams.map((t) => t.id) } },
          ...(leadIds.length
            ? [
                {
                  user: {
                    deleted_at: null,
                    OR: [
                      { id: { in: leadIds } },
                      { manager_id: { in: leadIds } },
                    ],
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        team_id: true,
        user: { select: { id: true, manager_id: true, deleted_at: true } },
      },
    });

    const memberCountByTeam = new Map<number, number>();
    for (const m of members) {
      if (m.user?.deleted_at) continue;
      let teamKey: number | null = null;
      if (m.team_id != null && teamIdSet.has(m.team_id)) {
        teamKey = m.team_id; // gán trực tiếp thắng
      } else {
        const uid = m.user?.id ?? null;
        const mgr = m.user?.manager_id ?? null;
        if (uid != null && teamByLead.has(uid)) teamKey = teamByLead.get(uid)!;
        else if (mgr != null && teamByLead.has(mgr)) teamKey = teamByLead.get(mgr)!;
      }
      if (teamKey != null) {
        memberCountByTeam.set(
          teamKey,
          (memberCountByTeam.get(teamKey) ?? 0) + 1,
        );
      }
    }

    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      department: t.department,
      description: t.description,
      team_lead_id: t.team_lead_id,
      team_lead_name: t.team_lead_id
        ? (leadMap.get(t.team_lead_id) ?? null)
        : null,
      color: t.color,
      member_count: memberCountByTeam.get(t.id) ?? 0,
    }));
  }

  async findOne(id: number): Promise<TeamRow> {
    const row = (await this.findAll()).find((t) => t.id === id);
    if (!row) throw new NotFoundException('Không tìm thấy team');
    return row;
  }

  /**
   * Người phụ trách team = NHÃN tổ chức, role BẤT KỲ (không bắt buộc vai trò "Trưởng
   * nhóm"). Chỉ cần là user đang hoạt động. Một người có thể phụ trách nhiều
   * team; team tách khỏi phân quyền pipeline (manager_id riêng).
   */
  private async assertHeadValid(
    teamLeadId: number | null | undefined,
  ): Promise<void> {
    if (teamLeadId == null) return;
    const user = await this.prisma.user.findFirst({
      where: { id: teamLeadId, deleted_at: null },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        'Người phụ trách không hợp lệ (không tồn tại hoặc đã bị khoá)',
      );
    }
  }

  async create(dto: CreateTeamDto): Promise<TeamRow> {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Tên team không được rỗng');
    const dupName = await this.prisma.team.findUnique({
      where: { name },
      select: { id: true },
    });
    if (dupName) throw new ConflictException('Tên team đã tồn tại');
    await this.assertHeadValid(dto.team_lead_id ?? null);

    const created = await this.prisma.team.create({
      data: {
        name,
        department: dto.department?.trim() || null,
        description: dto.description?.trim() || null,
        team_lead_id: dto.team_lead_id ?? null,
        color: normalizeColor(dto.color),
      },
      select: { id: true },
    });
    return this.findOne(created.id);
  }

  async update(id: number, dto: UpdateTeamDto): Promise<TeamRow> {
    const existing = await this.prisma.team.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Không tìm thấy team');

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Tên team không được rỗng');
      const dupName = await this.prisma.team.findFirst({
        where: { name, id: { not: id } },
        select: { id: true },
      });
      if (dupName) throw new ConflictException('Tên team đã tồn tại');
      data.name = name;
    }
    if (dto.department !== undefined)
      data.department = dto.department?.trim() || null;
    if (dto.description !== undefined)
      data.description = dto.description?.trim() || null;
    if (dto.team_lead_id !== undefined) {
      await this.assertHeadValid(dto.team_lead_id);
      data.team_lead_id = dto.team_lead_id;
    }
    if (dto.color !== undefined) data.color = normalizeColor(dto.color);

    await this.prisma.team.update({ where: { id }, data });
    return this.findOne(id);
  }

  async remove(id: number): Promise<{ ok: true }> {
    const existing = await this.prisma.team.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Không tìm thấy team');
    // Gỡ team_id khỏi nhân viên thuộc team (GIỮ manager_id/department của họ — không
    // phá phân quyền). Team chỉ là lớp nhóm; xoá team không reset hierarchy.
    await this.prisma.employee.updateMany({
      where: { team_id: id },
      data: { team_id: null },
    });
    await this.prisma.team.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Danh sách team dùng làm nguồn dropdown bộ lọc — trả {id, name, team_lead_id}.
   * Giá trị filter dùng ở FE/BE PHẢI là `id` (PK bảng `teams`) — KHÔNG phải
   * `team_lead_id` — vì có team KHÔNG có Người phụ trách (team_lead_id=null) nhưng
   * vẫn có nhân viên gán trực tiếp (`employees.team_id`).
   * Mặc định `includeUnled=false` giữ NGUYÊN "Active" = có `team_lead_id` (hành vi cũ,
   * các consumer khác — payroll/contract-stats-dialog — vẫn lọc theo team_lead_id
   * nên KHÔNG được đổi ngầm).
   * `includeUnled=true` (dùng bởi /management/employees + /management/contracts):
   * MỞ RỘNG thêm team không có team_lead_id NHƯNG có ≥1 nhân viên gán trực
   * tiếp (vd team chưa gán Người phụ trách).
   * RBAC mở rộng: mọi role đã đăng nhập được gọi (khai báo ở controller).
   *
   * `department`: thêm vào response để dropdown "Phòng ban" ở Quản lý chấm
   * công cascade Phòng ban→Team dùng chung nguồn NÀY thay vì gọi `GET /management/teams`
   * (findAll) — endpoint đó cần quyền `org.manage` nên dropdown
   * rỗng với vai trò không có `org.manage`.
   */
  async listForFilter(
    includeUnled = false,
  ): Promise<
    { id: number; name: string; team_lead_id: number | null; department: string | null }[]
  > {
    const teams = await this.prisma.team.findMany({
      orderBy: [{ department: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, team_lead_id: true, department: true },
    });
    if (teams.length === 0) return [];

    let unledWithMembers: Set<number> = new Set();
    if (includeUnled) {
      const unledIds = teams
        .filter((t) => t.team_lead_id == null)
        .map((t) => t.id);
      if (unledIds.length > 0) {
        const rows = await this.prisma.employee.findMany({
          where: { team_id: { in: unledIds }, deleted_at: null },
          select: { team_id: true },
          distinct: ['team_id'],
        });
        unledWithMembers = new Set(rows.map((r) => r.team_id as number));
      }
    }

    return teams
      .filter((t) => t.team_lead_id != null || unledWithMembers.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        team_lead_id: t.team_lead_id,
        department: t.department,
      }));
  }

  /**
   * Dropdown "Team" cho bộ lọc theo cây quản lý (`users.manager_id`).
   *
   * KHÁC `listForFilter()` ở NGUỒN, có chủ đích: `listForFilter()` liệt kê
   * thực thể `teams` (Cài đặt > Team) và phục vụ các màn lọc theo team đó
   * (Lương/Nhân viên/HĐ/Chấm công). Còn bộ lọc theo **cây quản lý** nhận
   * `teamLeadId` và resolve subtree 1 cấp. Dùng bảng `teams` làm nguồn cho dropdown đó
   * là lệch nguồn sự thật: người quản lý có cấp dưới nhưng CHƯA được tạo dòng
   * trong `teams` sẽ biến mất khỏi bộ lọc dù dữ liệu của họ vẫn tồn tại.
   *
   * Vì vậy hàm này trả HỢP của 2 nguồn, khoá theo `team_lead_id`:
   *  - mọi `teams` có trưởng nhóm (giữ đúng nhãn tên team admin đã đặt);
   *  - CỘNG mọi user đang quản lý ≥1 người khác qua `users.manager_id` còn thiếu
   *    (nhãn = họ tên).
   *
   * 2 team cùng 1 trưởng nhóm thì chỉ giữ nhãn của team id nhỏ nhất (2 option đó vốn
   * đã cùng `value`).
   * RBAC: gate `@AuthOnly` — mọi người đã đăng nhập, mirror `for-filter`. KHÔNG scope theo
   * caller: thu hẹp sẽ làm một số vai trò thấy ÍT lựa chọn hơn. Giá trị chọn sai KHÔNG leak:
   * bộ lọc luôn AND vào scope RBAC đã tính (ra rỗng, không mở rộng).
   */
  async listTeamLeadFilter(): Promise<TeamLeadFilterRow[]> {
    const [teams, leadUsers] = await Promise.all([
      this.prisma.team.findMany({
        where: { team_lead_id: { not: null } },
        orderBy: { id: 'asc' },
        select: { name: true, team_lead_id: true },
      }),
      this.prisma.user.findMany({
        where: {
          // `status: 'active'` mirror `TeamRoleAssignmentsService` — chuẩn "danh
          // sách trưởng nhóm" của repo. Trưởng nhóm đã nghỉ/khoá chọn vào chỉ ra
          // rỗng. CHỈ lọc ở nhánh BỔ SUNG này: nhánh `teams` bên trên giữ
          // nguyên vị từ cũ nên option đang có (kể cả lead đã khoá) KHÔNG mất.
          status: 'active',
          deleted_at: null,
          // "Trưởng nhóm" = đang quản lý ≥1 người khác qua manager_id.
          managed_users: { some: { status: 'active', deleted_at: null } },
        },
        orderBy: { id: 'asc' },
        select: { id: true, full_name: true },
        // Van an toàn kỹ thuật, KHÔNG phải cap nghiệp vụ.
        take: 2000,
      }),
    ]);

    // Khoá theo team_lead_id: 2 team cùng 1 trưởng nhóm → giữ team id NHỎ NHẤT
    // (orderBy id asc + chỉ set khi chưa có) để danh sách ổn định giữa các lần gọi.
    const byLeadId = new Map<number, string>();
    for (const t of teams) {
      if (t.team_lead_id == null || byLeadId.has(t.team_lead_id)) continue;
      byLeadId.set(t.team_lead_id, t.name);
    }
    // Nhãn nhánh BỔ SUNG có thể TRÙNG chữ với 1 team đã có (vd team "X" đã đổi
    // trưởng nhóm nhưng giữ tên cũ, trong khi user tên "X" quản lý người khác mà
    // chưa có dòng `teams`) → 2
    // option chữ giống hệt, value khác nhau, user không phân biệt được. Gắn hậu
    // tố CHỈ KHI trùng để nhãn thường vẫn sạch.
    const usedLabels = new Set<string>(byLeadId.values());
    for (const u of leadUsers) {
      if (byLeadId.has(u.id)) continue;
      const trimmed = u.full_name.trim();
      const base = trimmed === '' ? `Nhân viên #${u.id}` : trimmed;
      let label = base;
      if (usedLabels.has(label)) label = `${base} (chưa có Team)`;
      if (usedLabels.has(label)) label = `${base} (chưa có Team, #${u.id})`;
      usedLabels.add(label);
      byLeadId.set(u.id, label);
    }

    const rows: TeamLeadFilterRow[] = [];
    for (const [team_lead_id, name] of byLeadId) rows.push({ team_lead_id, name });
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  /** Danh sách nhân viên đã gán TRỰC TIẾP vào team (employees.team_id). */
  async listMembers(teamId: number): Promise<TeamMemberRow[]> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) throw new NotFoundException('Không tìm thấy team');
    const rows = await this.prisma.employee.findMany({
      where: { team_id: teamId, deleted_at: null },
      orderBy: { user: { full_name: 'asc' } },
      select: {
        user_id: true,
        user: {
          select: {
            full_name: true,
            email: true,
            user_roles: { select: { role: { select: { name: true } } } },
          },
        },
      },
    });
    return rows.map((r) => ({
      user_id: r.user_id,
      full_name: r.user?.full_name ?? null,
      email: r.user?.email ?? null,
      role: r.user?.user_roles?.[0]?.role?.name ?? null,
    }));
  }

  /** Gán (thêm) nhân viên vào team — set employees.team_id. Áp cho MỌI role. */
  async addMembers(
    teamId: number,
    userIds: number[],
  ): Promise<{ added: number }> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) throw new NotFoundException('Không tìm thấy team');
    const ids = [...new Set(userIds)].filter(
      (x) => Number.isInteger(x) && x > 0,
    );
    if (ids.length === 0) return { added: 0 };
    const res = await this.prisma.employee.updateMany({
      where: { user_id: { in: ids }, deleted_at: null },
      data: { team_id: teamId },
    });
    return { added: res.count };
  }

  /** Gỡ 1 nhân viên khỏi team — chỉ khi đang thuộc đúng team này. */
  async removeMember(teamId: number, userId: number): Promise<{ ok: true }> {
    const res = await this.prisma.employee.updateMany({
      where: { user_id: userId, team_id: teamId },
      data: { team_id: null },
    });
    if (res.count === 0) {
      throw new NotFoundException('Nhân viên không thuộc team này');
    }
    return { ok: true };
  }
}
