import { TeamsService } from '../teams.service';

function makePrisma() {
  return {
    team: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    employee: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

describe('TeamsService.findAll — đếm thành viên theo cấp trên (manager_id)', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: TeamsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new TeamsService(prisma as never);
  });

  it('đếm trưởng nhóm + người báo cáo trực tiếp; team chưa gán trưởng nhóm = 0', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 10, name: 'Team Alpha', department: 'Kinh doanh', description: null, team_lead_id: 83 },
      { id: 11, name: 'Team A', department: 'Kinh doanh', description: null, team_lead_id: null },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 83, full_name: 'Nguyễn Văn A' }]);
    // Trưởng nhóm 83 (có cấp trên 200) + 2 nhân viên báo cáo cho 83.
    prisma.employee.findMany.mockResolvedValue([
      { user: { id: 83, manager_id: 200 } },
      { user: { id: 101, manager_id: 83 } },
      { user: { id: 102, manager_id: 83 } },
    ]);

    const rows = await service.findAll();

    const alpha = rows.find((r) => r.id === 10)!;
    const teamA = rows.find((r) => r.id === 11)!;
    expect(alpha.member_count).toBe(3); // trưởng nhóm + 2 NV
    expect(alpha.team_lead_name).toBe('Nguyễn Văn A');
    expect(teamA.member_count).toBe(0); // chưa gán trưởng nhóm
    expect(teamA.team_lead_name).toBeNull();

    // member_count GỘP: gán trực tiếp (team_id) + suy theo manager → WHERE có OR 2 nhánh.
    const employeeWhere = prisma.employee.findMany.mock.calls[0][0].where;
    expect(employeeWhere.OR).toEqual([
      { team_id: { in: [10, 11] } },
      {
        user: {
          deleted_at: null,
          OR: [{ id: { in: [83] } }, { manager_id: { in: [83] } }],
        },
      },
    ]);
  });

  it('trưởng nhóm con (báo cáo cho trưởng nhóm khác) tính vào team CỦA CHÍNH MÌNH', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 10, name: 'Team Alpha', department: 'KD', description: null, team_lead_id: 83 },
      { id: 12, name: 'Team Beta', department: 'KD', description: null, team_lead_id: 79 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 83, full_name: 'Nguyễn Văn A' },
      { id: 79, full_name: 'Đặng Văn C' },
    ]);
    prisma.employee.findMany.mockResolvedValue([
      { user: { id: 83, manager_id: 200 } }, // trưởng nhóm 83
      { user: { id: 79, manager_id: 83 } }, // trưởng nhóm 79, báo cáo cho 83
      { user: { id: 101, manager_id: 79 } }, // NV của 79
    ]);

    const rows = await service.findAll();

    expect(rows.find((r) => r.id === 10)!.member_count).toBe(1); // chỉ mình 83 (79 thuộc team riêng)
    expect(rows.find((r) => r.id === 12)!.member_count).toBe(2); // 79 + NV 101
  });

  it('không có team nào → trả mảng rỗng, không query nhân viên', async () => {
    prisma.team.findMany.mockResolvedValue([]);

    const rows = await service.findAll();

    expect(rows).toEqual([]);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it('gán trực tiếp employees.team_id (mọi role) được đếm — kể cả team KHÔNG có trưởng nhóm', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 20, name: 'Admin vận hành', department: 'HR', description: null, team_lead_id: null },
    ]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.employee.findMany.mockResolvedValue([
      { team_id: 20, user: { id: 300, manager_id: null } },
      { team_id: 20, user: { id: 301, manager_id: null } },
    ]);

    const rows = await service.findAll();
    expect(rows.find((r) => r.id === 20)!.member_count).toBe(2);
  });

  it('gán trực tiếp team_id THẮNG suy-theo-manager (mỗi NV đếm 1 lần)', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 10, name: 'Team Alpha', department: 'KD', description: null, team_lead_id: 83 },
      { id: 20, name: 'Admin', department: 'HR', description: null, team_lead_id: null },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 83, full_name: 'Nguyễn Văn A' }]);
    prisma.employee.findMany.mockResolvedValue([
      { team_id: null, user: { id: 83, manager_id: 200 } },
      { team_id: 20, user: { id: 101, manager_id: 83 } }, // báo cáo 83 nhưng gán trực tiếp team 20
    ]);

    const rows = await service.findAll();
    expect(rows.find((r) => r.id === 10)!.member_count).toBe(1);
    expect(rows.find((r) => r.id === 20)!.member_count).toBe(1);
  });
});

describe('TeamsService — người phụ trách role bất kỳ + quản lý thành viên', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: TeamsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new TeamsService(prisma as never);
  });

  it('assertHeadValid chấp nhận user role BẤT KỲ (không bắt buộc team_lead)', async () => {
    prisma.team.findUnique.mockResolvedValue(null); // dup-name check pass
    prisma.user.findFirst.mockResolvedValue({ id: 500 });
    prisma.team.create.mockResolvedValue({ id: 99 });
    prisma.team.findMany.mockResolvedValue([
      { id: 99, name: 'HR', department: 'HR', description: null, team_lead_id: 500 },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 500, full_name: 'Nguyễn Văn E' }]);
    prisma.employee.findMany.mockResolvedValue([]);

    const row = await service.create({
      name: 'HR',
      department: 'HR',
      team_lead_id: 500,
    } as never);
    expect(row.team_lead_name).toBe('Nguyễn Văn E');
    // KHÔNG kiểm tra role team_lead trong where của head.
    const headWhere = prisma.user.findFirst.mock.calls[0][0].where;
    expect(headWhere.user_roles).toBeUndefined();
  });

  it('addMembers set team_id cho user_ids (dedupe + bỏ id ≤ 0)', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 20 });
    prisma.employee.updateMany.mockResolvedValue({ count: 2 });
    const res = await service.addMembers(20, [300, 300, 301, -1, 0]);
    expect(res).toEqual({ added: 2 });
    const args = prisma.employee.updateMany.mock.calls[0][0];
    expect(args.where.user_id.in).toEqual([300, 301]);
    expect(args.data).toEqual({ team_id: 20 });
  });

  it('addMembers team không tồn tại → throw', async () => {
    prisma.team.findUnique.mockResolvedValue(null);
    await expect(service.addMembers(999, [1])).rejects.toThrow();
  });

  it('removeMember gỡ team_id; không thuộc team → throw', async () => {
    prisma.employee.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.removeMember(20, 300)).resolves.toEqual({ ok: true });
    expect(prisma.employee.updateMany.mock.calls[0][0]).toEqual({
      where: { user_id: 300, team_id: 20 },
      data: { team_id: null },
    });

    prisma.employee.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.removeMember(20, 999)).rejects.toThrow();
  });
});

// dropdown bộ lọc Team bỏ sót team chưa gán Người phụ trách dù có NV
// (team "Team Gamma" có thành viên trực tiếp nhưng team_lead_id=null).
describe('TeamsService.listForFilter includeUnled', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: TeamsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new TeamsService(prisma as never);
  });

  it('mặc định (includeUnled=false) — CHỈ trả team có team_lead_id, giữ hành vi cũ', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 10, name: 'Team Gamma', team_lead_id: null },
      { id: 16, name: 'Trần Thị B', team_lead_id: 234 },
    ]);

    const rows = await service.listForFilter();

    expect(rows).toEqual([{ id: 16, name: 'Trần Thị B', team_lead_id: 234 }]);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it('includeUnled=true — thêm team KHÔNG có team_lead_id nhưng có NV gán trực tiếp', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 10, name: 'Team Gamma', team_lead_id: null },
      { id: 16, name: 'Trần Thị B', team_lead_id: 234 },
      { id: 21, name: 'Team rỗng chưa có ai', team_lead_id: null },
    ]);
    prisma.employee.findMany.mockResolvedValue([{ team_id: 10 }]);

    const rows = await service.listForFilter(true);

    expect(rows).toEqual([
      { id: 10, name: 'Team Gamma', team_lead_id: null },
      { id: 16, name: 'Trần Thị B', team_lead_id: 234 },
    ]);
    // team 21 (không lead + không NV) vẫn bị loại — KHÔNG mở tràn lan mọi team rỗng.
    const empWhere = prisma.employee.findMany.mock.calls[0][0].where;
    expect(empWhere.team_id.in.sort()).toEqual([10, 21]);
  });

  it('không có team nào chưa gán lead → không query employee thừa', async () => {
    prisma.team.findMany.mockResolvedValue([
      { id: 16, name: 'Trần Thị B', team_lead_id: 234 },
    ]);

    const rows = await service.listForFilter(true);

    expect(rows).toEqual([{ id: 16, name: 'Trần Thị B', team_lead_id: 234 }]);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });
});

/**
 * Dropdown "Team" phải lấy HỢP của bảng `teams` và người đang quản lý ≥1 người khác qua
 * `manager_id`: trưởng nhóm có cấp dưới mà chưa được tạo dòng `teams` vẫn phải hiện trong
 * bộ lọc. Nhánh BỔ SUNG dùng `managed_users: { some: {...} }` (không dò tên vai trò).
 */
describe('TeamsService.listTeamLeadFilter — hợp teams ∪ người có cấp dưới qua manager_id', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: TeamsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new TeamsService(prisma as never);
  });

  it('thêm trưởng nhóm CHƯA có dòng teams, giữ nguyên mọi lựa chọn cũ (siêu tập)', async () => {
    prisma.team.findMany.mockResolvedValue([
      { name: 'Nguyễn Văn A', team_lead_id: 83 },
      // Trưởng nhóm của team không thuộc nhánh bán hàng — vẫn phải giữ.
      { name: 'Lê Văn C', team_lead_id: 274 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 83, full_name: 'Nguyễn Văn A' },
      { id: 352, full_name: 'Phạm Văn D' },
    ]);

    const rows = await service.listTeamLeadFilter();

    expect(rows.map((r) => r.team_lead_id).sort((a, b) => a - b)).toEqual([83, 274, 352]);
    expect(rows.find((r) => r.team_lead_id === 352)?.name).toBe('Phạm Văn D');
    // Chỉ lấy team CÓ trưởng nhóm + user chưa xoá đang quản lý ≥1 người.
    expect(prisma.team.findMany.mock.calls[0][0].where).toEqual({
      team_lead_id: { not: null },
    });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      status: 'active',
      deleted_at: null,
      managed_users: { some: { status: 'active', deleted_at: null } },
    });
  });

  it('nhãn của teams THẮNG họ tên user khi trùng team_lead_id; sắp xếp theo tên', async () => {
    prisma.team.findMany.mockResolvedValue([
      { name: 'Team B (nhãn admin đặt)', team_lead_id: 83 },
      // 2 team cùng 1 trưởng nhóm → giữ team id nhỏ nhất (đến trước, orderBy id asc).
      { name: 'Team B cũ', team_lead_id: 83 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 83, full_name: 'Nguyễn Văn A' },
      // `users.full_name` là NOT NULL trong schema → ca "không có tên" thật sự
      // xảy ra được là chuỗi TRẮNG, không phải null.
      { id: 9, full_name: '   ' },
    ]);

    const rows = await service.listTeamLeadFilter();

    expect(rows).toEqual([
      { team_lead_id: 9, name: 'Nhân viên #9' },
      { team_lead_id: 83, name: 'Team B (nhãn admin đặt)' },
    ]);
  });

  it('nhãn user TRÙNG chữ với 1 team đã có → gắn hậu tố để phân biệt', async () => {
    // Team "Nguyễn Văn A" nay do người khác (id 90) phụ trách, còn user tên
    // "Nguyễn Văn A" (id 83) vẫn là team_lead nhưng chưa có dòng `teams`.
    prisma.team.findMany.mockResolvedValue([{ name: 'Nguyễn Văn A', team_lead_id: 90 }]);
    prisma.user.findMany.mockResolvedValue([{ id: 83, full_name: 'Nguyễn Văn A' }]);

    const rows = await service.listTeamLeadFilter();

    expect(rows).toEqual([
      { team_lead_id: 90, name: 'Nguyễn Văn A' },
      { team_lead_id: 83, name: 'Nguyễn Văn A (chưa có Team)' },
    ]);
  });

  it('không có team lẫn trưởng nhóm nào → mảng rỗng, không throw', async () => {
    prisma.team.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);

    await expect(service.listTeamLeadFilter()).resolves.toEqual([]);
  });
});
