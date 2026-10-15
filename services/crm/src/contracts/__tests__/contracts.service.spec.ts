import { ContractsService } from '../contracts.service';

const ACTOR = { userId: 1, grants: [] } as never;
const scopeAll = () => ({ ownerIds: jest.fn().mockResolvedValue('all') });

// danh sách hợp đồng liệt kê THEO NHÂN VIÊN (mọi NV, kể cả chưa có HĐ).
function makePrisma() {
  const employee = {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    employee,
    // $transaction nhận mảng promise (như code thật) → Promise.all
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma, employee };
}

describe('ContractsService.findAll (liệt kê theo nhân viên)', () => {
  it('nhân viên CHƯA có hợp đồng → status="no_contract", id=null, mã NV fallback', async () => {
    const { prisma, employee } = makePrisma();
    employee.count.mockResolvedValue(1);
    employee.findMany.mockResolvedValue([
      {
        id: 7,
        employee_code: null,
        position: 'sales',
        department: 'Kinh doanh',
        gender: 'M',
        status: 'active',
        user: { full_name: 'Nguyễn Văn A', email: 'a@example.net', avatar_url: null },
        jobTitle: { name: 'Nhân viên' },
        contracts: [],
      },
    ]);

    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    const res = await service.findAll({}, ACTOR);

    expect(res.data).toHaveLength(1);
    const row = res.data[0];
    expect(row.status).toBe('no_contract');
    expect(row.id).toBeNull();
    expect(row.signed_date).toBeNull();
    expect(row.days_remaining).toBeNull();
    expect(row.employee.employee_code).toBe('NV0007');
    expect(row.employee.employment_status).toBe('working');
    // Tổng đếm theo NHÂN VIÊN (findAll = findMany-all + phân trang JS, KHÔNG dùng employee.count).
    expect(employee.findMany).toHaveBeenCalledTimes(1);
    expect(res.pagination.total).toBe(1);
  });

  it('nhân viên CÓ hợp đồng còn hạn → status từ computeContractStatus, id non-null, resigned', async () => {
    const { prisma, employee } = makePrisma();
    const far = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    employee.count.mockResolvedValue(1);
    employee.findMany.mockResolvedValue([
      {
        id: 3,
        employee_code: 'NV003',
        position: 'sales',
        department: null,
        gender: null,
        status: 'resigned',
        user: { full_name: null, email: 'b@example.net', avatar_url: null },
        jobTitle: null,
        contracts: [
          {
            id: 99,
            contract_type: 'chinh_thuc',
            signed_date: new Date('2026-01-01'),
            end_date: far,
            file_url: null,
            notes: null,
            is_terminated: false,
            terminated_at: null,
            created_at: new Date('2026-01-01'),
            updated_at: new Date('2026-01-01'),
          },
        ],
      },
    ]);

    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    const res = await service.findAll({}, ACTOR);
    const row = res.data[0];
    expect(row.id).toBe(99);
    expect(row.status).toBe('active');
    expect(row.contract_type).toBe('chinh_thuc');
    expect(row.employee.employee_code).toBe('NV003'); // mã nhập tay được giữ
    expect(row.employee.employment_status).toBe('resigned');
  });

  it(' — tài khoản bị khoá (user.status=locked) dù employees.status=active → employment_status=resigned', async () => {
    const { prisma, employee } = makePrisma();
    employee.count.mockResolvedValue(1);
    employee.findMany.mockResolvedValue([
      {
        id: 11,
        employee_code: 'NV011',
        position: 'sales',
        department: null,
        gender: null,
        status: 'active', // employees.status CHƯA đồng bộ nhưng tài khoản đã khoá
        user: { full_name: 'NV nghỉ', email: 'z@example.net', avatar_url: null, status: 'locked' },
        jobTitle: null,
        contracts: [],
      },
    ]);

    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    const res = await service.findAll({}, ACTOR);
    expect(res.data[0].employee.employment_status).toBe('resigned');
  });

  it('search khớp EMAIL + employment_status=resigned → WHERE đúng + count/findMany cùng where', async () => {
    const { prisma, employee } = makePrisma();
    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    await service.findAll({ search: 'abc@x.vn', employment_status: 'resigned' }, ACTOR);

    // where = { AND: [scopeWhere, whereNghiệpVụ] } (Mẫu A) → lấy phần nghiệp vụ.
    const whereArg = employee.findMany.mock.calls[0][0].where.AND[1];
    const andArr: Array<Record<string, unknown>> = whereArg.AND ?? [];
    // resigned = employees.status='resigned' HOẶC user.status='locked' (ghép trong AND, KHÔNG where.status trực tiếp).
    const hasResignedOr = andArr.some((c) => {
      const or = (c as { OR?: Array<Record<string, unknown>> }).OR ?? [];
      return (
        or.some((o) => (o as { status?: string }).status === 'resigned') &&
        or.some(
          (o) => (o as { user?: { status?: string } }).user?.status === 'locked',
        )
      );
    });
    expect(hasResignedOr).toBe(true);
    // search email vẫn khớp trong 1 nhánh AND khác.
    const hasEmail = andArr.some((c) => {
      const or = (c as { OR?: Array<{ user?: { email?: { contains?: string } } }> }).OR ?? [];
      return or.some((o) => o.user?.email?.contains === 'abc@x.vn');
    });
    expect(hasEmail).toBe(true);
  });

  it('status=no_contract → lọc contracts.none', async () => {
    const { prisma, employee } = makePrisma();
    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    await service.findAll({ status: 'no_contract' }, ACTOR);

    // where = { AND: [scopeWhere, whereNghiệpVụ] } (Mẫu A) → lấy phần nghiệp vụ.
    const whereArg = employee.findMany.mock.calls[0][0].where.AND[1];
    const hasNone = (whereArg.AND ?? []).some(
      (c: { contracts?: { none?: unknown } }) => c.contracts?.none !== undefined,
    );
    expect(hasNone).toBe(true);
  });

  it('status=no_contract + contract_type → CHỈ contracts.none, KHÔNG some (mâu thuẫn → luôn 0 dòng)', async () => {
    const { prisma, employee } = makePrisma();
    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    await service.findAll({ status: 'no_contract', contract_type: 'chinh_thuc' }, ACTOR);

    const and = employee.findMany.mock.calls[0][0].where.AND[1].AND ?? [];
    const hasNone = and.some(
      (c: { contracts?: { none?: unknown } }) => c.contracts?.none !== undefined,
    );
    const hasSome = and.some(
      (c: { contracts?: { some?: unknown } }) => c.contracts?.some !== undefined,
    );
    expect(hasNone).toBe(true);
    expect(hasSome).toBe(false);
  });

  // filter `team` PHẢI so theo id CHÍNH THỨC bảng `teams` (resolveFormalTeamId),
  // KHÔNG phải team_lead_id derived (deriveTeam) — lọc theo
  // team có team_lead_id ≠ id (mọi team thật) phải vẫn ra đúng NV.
  it('lọc team bằng id CHÍNH THỨC (team_lead_id ≠ id) → vẫn khớp đúng NV', async () => {
    const { prisma, employee } = makePrisma();
    (prisma as unknown as { team: { findMany: jest.Mock } }).team = {
      findMany: jest.fn().mockResolvedValue([{ id: 16, team_lead_id: 234 }]),
    };
    employee.findMany.mockResolvedValue([
      {
        id: 1,
        user_id: 234,
        employee_code: 'NV0001',
        position: 'team_lead',
        department: null,
        gender: null,
        status: 'active',
        team_id: null,
        user: { full_name: 'Trần Thị B', email: 'a@example.net', avatar_url: null, manager_id: null, manager: null },
        jobTitle: null,
        contracts: [],
      },
      {
        id: 2,
        user_id: 235,
        employee_code: 'NV0002',
        position: 'sales',
        department: null,
        gender: null,
        status: 'active',
        team_id: null,
        // NV khác team (không match id=16) — KHÔNG được lọt vào kết quả.
        user: { full_name: 'Người khác team', email: 'b@example.net', avatar_url: null, manager_id: null, manager: null },
        jobTitle: null,
        contracts: [],
      },
    ]);

    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    const res = await service.findAll({ team: '16' }, ACTOR);

    expect(res.data).toHaveLength(1);
    expect(res.data[0].employee.full_name).toBe('Trần Thị B');
  });

  // team CHƯA có Người phụ trách (team_lead_id=null) nhưng có NV gán TRỰC
  // TIẾP employees.team_id (vd "Team Beta") vẫn phải lọc được.
  it('lọc team KHÔNG có team_lead_id (gán trực tiếp employees.team_id)', async () => {
    const { prisma, employee } = makePrisma();
    (prisma as unknown as { team: { findMany: jest.Mock } }).team = {
      findMany: jest.fn().mockResolvedValue([{ id: 10, team_lead_id: null }]),
    };
    employee.findMany.mockResolvedValue([
      {
        id: 5,
        user_id: 300,
        employee_code: 'NV0005',
        position: 'nhan_vien',
        department: null,
        gender: null,
        status: 'active',
        team_id: 10,
        user: { full_name: 'Thành viên team HR', email: 'c@example.net', avatar_url: null, manager_id: null, manager: null },
        jobTitle: null,
        contracts: [],
      },
    ]);

    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    const res = await service.findAll({ team: '10' }, ACTOR);

    expect(res.data).toHaveLength(1);
    expect(res.data[0].employee.full_name).toBe('Thành viên team HR');
  });
});

describe('ContractsService — Hồ sơ mẫu hợp đồng', () => {
  function makeTemplateMocks() {
    const contractTemplate = {
      findMany: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    };
    const prisma = { contractTemplate };
    const storage = {
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
    };
    const service = new ContractsService(prisma as never, storage as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scopeAll() as never);
    return { service, contractTemplate, storage };
  }

  it('listTemplates: map an toàn, KHÔNG lộ storage_key, sort mới nhất trước', async () => {
    const { service, contractTemplate } = makeTemplateMocks();
    contractTemplate.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'HĐLĐ mẫu.docx',
        storage_key: 'contract-templates/x',
        mime: 'application/pdf',
        size: 10,
        uploaded_by: 5,
        created_at: new Date(),
      },
    ]);
    const res = await service.listTemplates();
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe('HĐLĐ mẫu.docx');
    expect((res[0] as Record<string, unknown>).storage_key).toBeUndefined();
    expect(contractTemplate.findMany).toHaveBeenCalledWith({
      orderBy: { created_at: 'desc' },
    });
  });

  it('uploadTemplate orphan-safe: ghi DB lỗi → xoá file MinIO vừa upload', async () => {
    const { service, contractTemplate, storage } = makeTemplateMocks();
    contractTemplate.create.mockRejectedValue(new Error('db fail'));
    const file = {
      originalname: 'a.docx',
      buffer: Buffer.from('x'),
      mimetype: 'application/pdf',
      size: 3,
    } as never;
    await expect(service.uploadTemplate(file, 5)).rejects.toThrow('db fail');
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('deleteTemplate: xoá MinIO + xoá row DB', async () => {
    const { service, contractTemplate, storage } = makeTemplateMocks();
    contractTemplate.findUnique.mockResolvedValue({ id: 2, storage_key: 'kk' });
    contractTemplate.delete.mockResolvedValue({});
    const res = await service.deleteTemplate(2);
    expect(storage.delete).toHaveBeenCalledWith('kk');
    expect(contractTemplate.delete).toHaveBeenCalledWith({ where: { id: 2 } });
    expect(res).toEqual({ ok: true, id: 2 });
  });
});

// getStats() by_team đọc TÊN TEAM CHÍNH THỨC từ bảng `teams` (Cài đặt >
// Team).
describe('ContractsService.getStats — by_team đồng bộ bảng teams', () => {
  function makeEmployeeRow(overrides: {
    id: number;
    userId: number;
    managerId: number | null;
    managerName: string | null;
  }) {
    return {
      id: overrides.id,
      user_id: overrides.userId,
      employee_code: `NV${String(overrides.id).padStart(4, '0')}`,
      position: 'sales',
      department: 'Kinh doanh',
      gender: 'M',
      status: 'active',
      user: {
        full_name: `NV ${overrides.id}`,
        email: `u${overrides.id}@example.net`,
        avatar_url: null,
        manager_id: overrides.managerId,
        manager: overrides.managerName ? { full_name: overrides.managerName } : null,
      },
      jobTitle: { name: 'Nhân viên' },
      contracts: [],
    };
  }

  it('team MỚI tạo trong Cài đặt → xuất hiện đúng tên team thật', async () => {
    const employee = {
      findMany: jest.fn().mockResolvedValue([
        // NV báo cáo cho manager 999 — user 999 đã được set làm team_lead_id của 1 Team
        // trong Cài đặt.
        makeEmployeeRow({ id: 1, userId: 1, managerId: 999, managerName: 'Trưởng nhóm Mới' }),
      ]),
    };
    const prisma = { employee };
    const teamsService = {
      listForFilter: jest.fn().mockResolvedValue([
        { id: 50, name: 'Team Hoa Mai', team_lead_id: 999 },
      ]),
    };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR);

    const entry = stats.by_team.find((t) => t.team_lead_id === 999);
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Team Hoa Mai'); // tên TEAM thật, KHÔNG phải tên người
    expect(entry?.count).toBe(1);
  });

  it('Team mới tạo chưa có ai báo cáo → vẫn xuất hiện với count=0', async () => {
    const employee = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = { employee };
    const teamsService = {
      listForFilter: jest.fn().mockResolvedValue([
        { id: 51, name: 'Team Rỗng', team_lead_id: 777 },
      ]),
    };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR);

    const entry = stats.by_team.find((t) => t.team_lead_id === 777);
    expect(entry).toBeDefined();
    expect(entry?.label).toBe('Team Rỗng');
    expect(entry?.count).toBe(0);
  });
});

// bộ lọc getStats(department/date_from/date_to/team/employment_status).
describe('ContractsService.getStats — bộ lọc', () => {
  function makeEmployeeRow(overrides: {
    id: number;
    department: string | null;
    status: string;
    signedDate: string | null;
  }) {
    return {
      id: overrides.id,
      user_id: overrides.id,
      employee_code: `NV${String(overrides.id).padStart(4, '0')}`,
      position: 'sales',
      department: overrides.department,
      gender: 'M',
      status: overrides.status,
      user: {
        full_name: `NV ${overrides.id}`,
        email: `u${overrides.id}@example.net`,
        avatar_url: null,
        manager_id: null,
        manager: null,
      },
      jobTitle: { name: 'Nhân viên' },
      contracts: overrides.signedDate
        ? [
            {
              id: overrides.id * 10,
              contract_type: 'chinh_thuc',
              signed_date: new Date(overrides.signedDate),
              end_date: null,
              file_url: null,
              notes: null,
              is_terminated: false,
              terminated_at: null,
              created_at: new Date(overrides.signedDate),
              updated_at: new Date(overrides.signedDate),
            },
          ]
        : [],
    };
  }

  it('lọc department → chỉ áp ở Prisma where, KHÔNG lọc thêm ở JS', async () => {
    const employee = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = { employee };
    const teamsService = { listForFilter: jest.fn().mockResolvedValue([]) };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    await service.getStats(ACTOR, { department: 'Kinh doanh' });

    expect(employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: expect.arrayContaining([
            expect.objectContaining({ department: 'Kinh doanh', deleted_at: null }),
          ]),
        },
      }),
    );
  });

  it('by_type: gom đúng loại HĐLĐ hiện hành (hdld_*), slug cũ chỉ hiện khi còn hồ sơ', async () => {
    const row = makeEmployeeRow({ id: 1, department: 'Kinh doanh', status: 'active', signedDate: '2026-06-15' });
    row.contracts[0].contract_type = 'hdld_2';
    const employee = { findMany: jest.fn().mockResolvedValue([row]) };
    const teamsService = { listForFilter: jest.fn().mockResolvedValue([]) };
    const service = new ContractsService({ employee } as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR);

    expect(stats.by_type.find((t) => t.key === 'hdld_2')?.count).toBe(1);
    expect(stats.by_type.find((t) => t.key === 'hdld_1')?.count).toBe(0);
    expect(stats.by_type.find((t) => t.key === 'chinh_thuc')).toBeUndefined();
    expect(stats.by_type.reduce((s, t) => s + t.count, 0)).toBe(stats.total);
  });

  it('lọc date_from/date_to → LOẠI nhân viên no_contract (signed_date=null) khỏi kết quả', async () => {
    const employee = {
      findMany: jest.fn().mockResolvedValue([
        makeEmployeeRow({ id: 1, department: 'Kinh doanh', status: 'active', signedDate: '2026-06-15' }),
        makeEmployeeRow({ id: 2, department: 'Kinh doanh', status: 'active', signedDate: null }), // no_contract
        makeEmployeeRow({ id: 3, department: 'Kinh doanh', status: 'active', signedDate: '2026-01-01' }), // ngoài khoảng
      ]),
    };
    const prisma = { employee };
    const teamsService = { listForFilter: jest.fn().mockResolvedValue([]) };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR, { date_from: '2026-06-01', date_to: '2026-06-30' });

    expect(stats.total).toBe(1); // chỉ NV id=1 khớp khoảng ngày
    expect(stats.by_status.find((s) => s.key === 'no_contract')?.count).toBe(0);
  });

  it('lọc date_from đúng biên VN — HĐ ký ĐÚNG NGÀY date_from KHÔNG bị loại oan (signed_date lưu VN-midnight UTC = 17h hôm trước)', async () => {
    const employee = {
      findMany: jest.fn().mockResolvedValue([
        {
          ...makeEmployeeRow({ id: 1, department: 'Kinh doanh', status: 'active', signedDate: null }),
          contracts: [
            {
              id: 10,
              contract_type: 'chinh_thuc',
              // VN 01/06 00:00 → lưu UTC 2026-05-31T17:00:00Z (giống FE vnDateToIso).
              signed_date: new Date('2026-06-01T00:00:00+07:00'),
              end_date: null,
              file_url: null,
              notes: null,
              is_terminated: false,
              terminated_at: null,
              created_at: new Date('2026-06-01T00:00:00+07:00'),
              updated_at: new Date('2026-06-01T00:00:00+07:00'),
            },
          ],
        },
      ]),
    };
    const prisma = { employee };
    const teamsService = { listForFilter: jest.fn().mockResolvedValue([]) };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR, { date_from: '2026-06-01', date_to: '2026-06-30' });

    // Trước fix: 2026-05-31T17:00:00Z < UTC-midnight date_from (2026-06-01T00:00:00Z)
    // → bị loại oan mặc dù NV ký ĐÚNG NGÀY date_from theo giờ VN.
    expect(stats.total).toBe(1);
  });

  it('KHÔNG truyền date_from/date_to → giữ nguyên hành vi cũ (bao gồm no_contract)', async () => {
    const employee = {
      findMany: jest.fn().mockResolvedValue([
        makeEmployeeRow({ id: 1, department: 'Kinh doanh', status: 'active', signedDate: '2026-06-15' }),
        makeEmployeeRow({ id: 2, department: 'Kinh doanh', status: 'active', signedDate: null }),
      ]),
    };
    const prisma = { employee };
    const teamsService = { listForFilter: jest.fn().mockResolvedValue([]) };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR);

    expect(stats.total).toBe(2); // KHÔNG loại no_contract khi không lọc ngày
  });

  it('lọc team → dùng team_lead_id computed sau khi map (mirror findAll)', async () => {
    const employee = {
      findMany: jest.fn().mockResolvedValue([
        {
          ...makeEmployeeRow({ id: 1, department: null, status: 'active', signedDate: null }),
          user: {
            full_name: 'NV 1',
            email: 'u1@example.net',
            avatar_url: null,
            manager_id: 999,
            manager: { full_name: 'Trưởng nhóm X' },
          },
        },
        makeEmployeeRow({ id: 2, department: null, status: 'active', signedDate: null }),
      ]),
    };
    const prisma = { employee };
    const teamsService = {
      listForFilter: jest.fn().mockResolvedValue([{ id: 1, name: 'Team X', team_lead_id: 999 }]),
    };
    const service = new ContractsService(prisma as never, {} as never, teamsService as never, scopeAll() as never);
    const stats = await service.getStats(ACTOR, { team: '999' });

    expect(stats.total).toBe(1);
  });
});

describe('ContractsService — scope contracts.view (Mẫu A)', () => {
  it('findAll scope team → where giao AND với scopeWhere của actor', async () => {
    const { prisma, employee } = makePrisma();
    const scope = { ownerIds: jest.fn().mockResolvedValue([5, 6]) };
    const service = new ContractsService(prisma as never, {} as never, { listForFilter: jest.fn().mockResolvedValue([]) } as never, scope as never);
    await service.findAll({}, ACTOR);
    expect(scope.ownerIds).toHaveBeenCalledWith(ACTOR, 'contracts.view');
    const where = employee.findMany.mock.calls[0][0].where as { AND: unknown[] };
    expect(JSON.stringify(where.AND[0])).toContain('5');
  });

  it('findById/streamFile hợp đồng của NV ngoài phạm vi → 404', async () => {
    const prisma = {
      employeeContract: { findUnique: jest.fn().mockResolvedValue({ id: 1, employee_id: 9, file_url: 'k' }) },
      employee: { findUnique: jest.fn().mockResolvedValue({ user_id: 99 }) },
    };
    const scope = { ownerIds: jest.fn().mockResolvedValue([5]) };
    const service = new ContractsService(prisma as never, {} as never, {} as never, scope as never);
    await expect(service.findById(1, ACTOR)).rejects.toThrow('Không tìm thấy');
    await expect(service.streamFile(1, ACTOR)).rejects.toThrow('Không tìm thấy');
  });
});
