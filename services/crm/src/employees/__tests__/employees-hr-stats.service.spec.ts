import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, PermissionService, RbacCache } from '@trinity/rbac-nest';
import { EmployeesService } from '../employees.service';
import { AuditService } from '../../audit/audit.service';

/**
 * Row khớp EMPLOYEE_SELECT (đủ field mapEmployee đọc cho dashboard Team + Sinh nhật).
 * birth_date dùng instant VN-midnight (`...T00:00:00+07:00`) để vnMonthDay trả đúng
 * ngày/tháng người dùng nhập (không lệch timezone).
 */
function makeEmp(o: {
  id: number;
  user_id: number;
  full_name: string;
  manager_id?: number | null;
  manager_name?: string | null;
  status?: string;
  department?: string | null;
  birth_date?: string | null;
  user_status?: string; // users.status: 'active' | 'locked' (đã nghỉ việc)
}) {
  return {
    id: o.id,
    user_id: o.user_id,
    employee_code: null,
    position: 'sales',
    department: o.department ?? 'KD',
    gender: null,
    education_level: null,
    recruitment_source: null,
    team_id: null,
    salary_rule_id: null,
    insurance_salary: null,
    job_title_id: null,
    office_id: null,
    registered_device_id: null,
    device_registered_at: null,
    birth_date: o.birth_date ? new Date(o.birth_date) : null,
    id_card_number: null,
    id_card_issued_date: null,
    id_card_issued_place: null,
    permanent_address: null,
    current_address: null,
    bank_account_number: null,
    bank_name: null,
    bank_account_holder: null,
    status: o.status ?? 'active',
    joined_at: new Date('2026-01-01'),
    created_at: new Date('2026-01-01'),
    user: {
      id: o.user_id,
      email: `u${o.user_id}@example.com`,
      full_name: o.full_name,
      phone: '0901234567',
      avatar_url: null,
      status: o.user_status ?? 'active',
      team_id: null,
      manager_id: o.manager_id ?? null,
      manager: o.manager_name ? { full_name: o.manager_name } : null,
      deleted_at: null,
      user_roles: [{ role: { name: 'sales' } }],
    },
    jobTitle: null,
    office: null,
  };
}

// userId 83 là team_lead_id của "Team Alpha" (bảng `teams`); nhân viên có manager 83 thuộc team đó.
const TEAM = [
  makeEmp({ id: 1, user_id: 83, full_name: 'Khang', status: 'active', birth_date: '1990-06-15T00:00:00+07:00' }), // lead
  makeEmp({ id: 2, user_id: 200, full_name: 'An', manager_id: 83, manager_name: 'Khang', status: 'probation', birth_date: '1995-06-03T00:00:00+07:00' }),
  makeEmp({ id: 3, user_id: 300, full_name: 'Bình', manager_id: null, status: 'resigned', birth_date: '1992-12-20T00:00:00+07:00' }), // không team
];

const ACTOR = { userId: 1, grants: [] } as never;

describe('EmployeesService — dashboard Thống kê nhân viên', () => {
  let service: EmployeesService;
  let prisma: { employee: { findMany: jest.Mock }; team: { findMany: jest.Mock } };

  beforeEach(async () => {
    // `team.findMany`: `getHrStats`/`getBirthdayList` gọi `loadTeamContext()` (→ `prisma.team.findMany`).
    prisma = { employee: { findMany: jest.fn() }, team: { findMany: jest.fn().mockResolvedValue([{ id: 1, name: 'Team Alpha', color: null, team_lead_id: 83 }]) } };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { write: jest.fn().mockResolvedValue(undefined) } },
        { provide: ScopeService, useValue: { ownerIds: jest.fn().mockResolvedValue('all') } },
        { provide: PermissionService, useValue: { grantsFor: jest.fn() } },
        { provide: RbacCache, useValue: { invalidateUsers: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(EmployeesService);
  });

  describe('scope employees.view (Mẫu A)', () => {
    it('getHrStats/getBirthdayList với scope team → where giao AND scopeWhere, KHÔNG company-wide', async () => {
      const scope = (service as unknown as { scope: { ownerIds: jest.Mock } }).scope;
      scope.ownerIds.mockResolvedValue([83, 200]);
      prisma.employee.findMany.mockResolvedValue([]);
      await service.getHrStats({} as never, ACTOR);
      await service.getBirthdayList({} as never, ACTOR, 'employees.export');
      expect(scope.ownerIds).toHaveBeenCalledWith(ACTOR, 'employees.view');
      expect(scope.ownerIds).toHaveBeenCalledWith(ACTOR, 'employees.export');
      const where = prisma.employee.findMany.mock.calls[0][0].where as { AND: unknown[] };
      expect(JSON.stringify(where.AND[0])).toContain('200');
    });

    it('getStats scope team → mọi câu raw SQL có điều kiện user_id', async () => {
      const scope = (service as unknown as { scope: { ownerIds: jest.Mock } }).scope;
      scope.ownerIds.mockResolvedValue([83]);
      const q = jest.fn().mockResolvedValue([]);
      (prisma as unknown as Record<string, unknown>)['$queryRaw'] = q;
      await service.getStats(ACTOR);
      expect(q).toHaveBeenCalledTimes(6);
      for (const c of q.mock.calls) expect(JSON.stringify(c.slice(1))).toContain('e.user_id IN');
    });
  });

  describe('getHrStats', () => {
    it('gom theo Team (bảng `teams`) + "Chưa có team", tính %', async () => {
      prisma.employee.findMany.mockResolvedValue(TEAM);
      const res = await service.getHrStats({}, ACTOR);

      expect(res.total).toBe(3);
      // Team Alpha (lead 83) đứng trước, "Chưa có team" cuối.
      expect(res.by_team).toHaveLength(2);
      expect(res.by_team[0]).toMatchObject({ team_lead_id: 83, team_name: 'Team Alpha', count: 2 });
      expect(res.by_team[0].percent).toBeCloseTo(66.7, 1);
      expect(res.by_team[1]).toMatchObject({ team_lead_id: null, team_name: 'Chưa có team', count: 1 });
    });

    it('trạng thái theo Team gom đúng bucket (probation/resigned/other)', async () => {
      prisma.employee.findMany.mockResolvedValue(TEAM);
      const res = await service.getHrStats({}, ACTOR);

      const ky = res.by_team_status.find((t) => t.team_lead_id === 83)!;
      expect(ky).toMatchObject({ active: 1, probation: 1, on_leave: 0, resigned: 0, other: 0 });
      const none = res.by_team_status.find((t) => t.team_lead_id === null)!;
      expect(none).toMatchObject({ active: 0, resigned: 1 });
    });

    it('bucket sinh nhật theo tháng VN (June=2, Dec=1)', async () => {
      prisma.employee.findMany.mockResolvedValue(TEAM);
      const res = await service.getHrStats({}, ACTOR);

      expect(res.birthdays_by_month).toHaveLength(12);
      expect(res.birthdays_by_month[5]).toMatchObject({ month: 6, count: 2 }); // June
      expect(res.birthdays_by_month[11]).toMatchObject({ month: 12, count: 1 }); // Dec
      expect(res.birthdays_by_month[0].count).toBe(0); // Jan
    });

    it('filter team="none" chỉ giữ NV không thuộc team', async () => {
      prisma.employee.findMany.mockResolvedValue(TEAM);
      const res = await service.getHrStats({ team: 'none' }, ACTOR);

      expect(res.total).toBe(1);
      // by_team liệt kê cả team 0 NV (Team Alpha) → chỉ bucket "Chưa có team" có người.
      expect(res.by_team.filter((t) => t.count > 0)).toHaveLength(1);
      expect(res.by_team.find((t) => t.count > 0)?.team_lead_id).toBeNull();
    });

    it('filter office_id/department/job_title_id đưa vào WHERE (deleted_at null)', async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      await service.getHrStats({ office_id: 5, department: 'KD', job_title_id: 7 }, ACTOR);

      expect(prisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { deleted_at: null, user: { deleted_at: null } },
              { office_id: 5, department: 'KD', job_title_id: 7 },
            ]),
          },
        }),
      );
    });
  });

  describe('getHrStats — NV đã nghỉ việc (user_status=locked)', () => {
    // Khang(active lead) + An(active, team Alpha) + Bình(LOCKED, team Alpha) + Cường(LOCKED, chưa team)
    const MIX = [
      makeEmp({ id: 1, user_id: 83, full_name: 'Khang' }),
      makeEmp({ id: 2, user_id: 200, full_name: 'An', manager_id: 83, manager_name: 'Khang' }),
      makeEmp({ id: 3, user_id: 300, full_name: 'Bình', manager_id: 83, manager_name: 'Khang', user_status: 'locked', department: 'KD' }),
      makeEmp({ id: 4, user_id: 400, full_name: 'Cường', manager_id: null, user_status: 'locked', department: 'KT' }),
    ];

    it('loại NV locked khỏi total + by_team (active partition)', async () => {
      prisma.employee.findMany.mockResolvedValue(MIX);
      const res = await service.getHrStats({}, ACTOR);
      expect(res.total).toBe(2); // chỉ Khang + An
      expect(res.by_team.find((t) => t.team_lead_id === 83)?.count).toBe(2);
      // Cường locked (chưa team) đã loại → KHÔNG có nhóm "Chưa có team" trong active
      expect(res.by_team.find((t) => t.team_lead_id === null)).toBeUndefined();
    });

    it('resigned_total đếm đúng số NV locked', async () => {
      prisma.employee.findMany.mockResolvedValue(MIX);
      const res = await service.getHrStats({}, ACTOR);
      expect(res.resigned_total).toBe(2);
    });

    it('resigned_by_team / by_department / by_job_title gom đúng', async () => {
      prisma.employee.findMany.mockResolvedValue(MIX);
      const res = await service.getHrStats({}, ACTOR);
      expect(res.resigned_by_team.find((t) => t.team_lead_id === 83)?.count).toBe(1); // Bình
      expect(res.resigned_by_team.find((t) => t.team_lead_id === null)?.count).toBe(1); // Cường
      expect(res.resigned_by_department).toEqual(
        expect.arrayContaining([{ label: 'KD', count: 1 }, { label: 'KT', count: 1 }]),
      );
      expect(res.resigned_by_job_title).toEqual([{ label: 'Chưa gán', count: 2 }]);
    });

    it('employees.status=resigned nhưng user còn active → KHÔNG vào resigned_total (trục HR riêng)', async () => {
      const rows = [
        makeEmp({ id: 1, user_id: 83, full_name: 'Khang' }),
        makeEmp({ id: 5, user_id: 500, full_name: 'HR', manager_id: 83, manager_name: 'Khang', status: 'resigned' }),
      ];
      prisma.employee.findMany.mockResolvedValue(rows);
      const res = await service.getHrStats({}, ACTOR);
      expect(res.resigned_total).toBe(0); // không có account locked
      expect(res.total).toBe(2); // cả 2 ở active partition
      const ky = res.by_team_status.find((t) => t.team_lead_id === 83)!;
      expect(ky.resigned).toBe(1); // employees.status='resigned' → bucket HR (trục khác)
    });
  });

  describe('getBirthdayList', () => {
    it('lọc đúng tháng + sắp theo ngày tăng dần', async () => {
      prisma.employee.findMany.mockResolvedValue(TEAM);
      const res = await service.getBirthdayList({ month: 6 }, ACTOR);

      expect(res.month).toBe(6);
      expect(res.items.map((i) => i.full_name)).toEqual(['An', 'Khang']); // day 3 trước day 15
      expect(res.items[0]).toMatchObject({ day: 3, email: 'u200@example.com' });
    });

    it('tháng không có ai sinh nhật → rỗng', async () => {
      prisma.employee.findMany.mockResolvedValue(TEAM);
      const res = await service.getBirthdayList({ month: 3 }, ACTOR);
      expect(res.items).toHaveLength(0);
    });
  });
});
