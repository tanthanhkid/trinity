import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@trinity/prisma';
import { ScopeService, PermissionService, RbacCache, type AuthUser } from '@trinity/rbac-nest';
import { EmployeesService } from '../employees.service';
import { AuditService } from '../../audit/audit.service';

/** `AuthUser` giả cho test — mặc định giữ đủ quyền cần (view/manage all). */
function authUser(userId: number, overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId,
    email: `user-${userId}@t`,
    isAdmin: false,
    grants: { 'employees.view': 'all', 'users.manage': 'all' },
    ...overrides,
  };
}

// Helper: build a fake employee row matching the Prisma EMPLOYEE_SELECT shape
function makeEmployee(override: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: 10,
    employee_code: null,
    position: 'sales',
    department: 'KD',
    gender: null,
    education_level: null,
    recruitment_source: null,
    team_id: 1,
    salary_rule_id: null,
    job_title_id: null,
    office_id: null,
    registered_device_id: null,
    device_registered_at: null,
    status: 'active',
    deleted_at: null,
    joined_at: new Date('2026-01-01'),
    created_at: new Date('2026-01-01'),
    user: {
      id: 10,
      email: 'test@example.com',
      full_name: 'Nguyễn Văn A',
      phone: '0901234567',
      avatar_url: null,
      status: 'active',
      team_id: 1,
      manager_id: null,
      manager: null as { full_name: string } | null,
      deleted_at: null,
      user_roles: [{ role: { name: 'sales' } }],
    },
    jobTitle: null,
    office: null,
    ...override,
  };
}

describe('EmployeesService', () => {
  let service: EmployeesService;
  /** Câu SQL (đã nối) mà các hàm giai đoạn làm việc gửi qua `prisma.$executeRaw`. */
  const sqlCalls = () => prisma.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
  let audit: { write: jest.Mock };
  let scope: { ownerIds: jest.Mock };
  let permission: { grantsFor: jest.Mock };
  let rbacCache: { invalidateUsers: jest.Mock };
  let prisma: {
    employee: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
    role: { findUnique: jest.Mock };
    userRole: { deleteMany: jest.Mock; create: jest.Mock };
    jobTitle: { findUnique: jest.Mock };
    team: { findMany: jest.Mock };
    setting: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      employee: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      // Transaction kiểu callback chạy với chính mock này; kiểu mảng chờ các lệnh đã dựng.
      $transaction: jest.fn(async (arg: unknown) =>
        typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[])),
      $executeRaw: jest.fn().mockResolvedValue(0),
      setting: { findUnique: jest.fn().mockResolvedValue(null) }, // gói mặc định custom
      role: { findUnique: jest.fn() },
      userRole: { deleteMany: jest.fn(), create: jest.fn() },
      jobTitle: { findUnique: jest.fn() },
      team: { findMany: jest.fn().mockResolvedValue([]) },
    };

    audit = { write: jest.fn().mockResolvedValue(undefined) };
    // Mặc định 'all' (mirror quyền scope=all) — test scope hẹp tự override.
    scope = { ownerIds: jest.fn().mockResolvedValue('all') };
    // Mặc định target KHÔNG phải Quản trị + quyền rỗng (⊆ mọi actor) — test
    // escalation (§6 luật 3, assertNotEscalating) tự override khi cần.
    permission = {
      grantsFor: jest.fn().mockResolvedValue({ isAdmin: false, grants: {} }),
    };
    rbacCache = { invalidateUsers: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ScopeService, useValue: scope },
        { provide: PermissionService, useValue: permission },
        { provide: RbacCache, useValue: rbacCache },
      ],
    }).compile();

    service = module.get<EmployeesService>(EmployeesService);
  });

  // ─── findAll ───────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('trả danh sách phân trang mặc định 25/trang', async () => {
      const rows = [makeEmployee()];
      prisma.employee.findMany.mockResolvedValue(rows);

      const result = await service.findAll({}, authUser(1));

      expect(result.pagination.page).toBe(1);
      expect(result.pagination.page_size).toBe(25);
      expect(result.pagination.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].employee_code).toBe('NV0001');
    });

    it('filter theo department và status', async () => {
      prisma.employee.findMany.mockResolvedValue([]);

      await service.findAll({ department: 'KD', status: 'active' }, authUser(1));

      // findAll load-all qua employee.findMany (sort/paginate ở JS) — kiểm tra where.
      expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);
      const where = prisma.employee.findMany.mock.calls[0][0].where;
      // Mẫu A: where = { AND: [scopeWhere(owner, ['user_id']), filters] }.
      expect(where.AND[1].department).toBe('KD');
      expect(where.AND[1].status).toBe('active');
    });

    it("scope hẹp (employees.view khác 'all') → AND thêm điều kiện user_id IN (...)", async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      scope.ownerIds.mockResolvedValue([10, 20]);

      await service.findAll({}, authUser(10));

      const where = prisma.employee.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({ user_id: { in: [10, 20] } });
      expect(scope.ownerIds).toHaveBeenCalledWith(authUser(10), 'employees.view');
    });

    it('trang 2 tính skip đúng', async () => {
      // findAll đếm total từ số dòng tải về (load-all) → cần 50 dòng để total_pages=5.
      const rows = Array.from({ length: 50 }, (_, i) =>
        makeEmployee({ id: i + 1, user_id: i + 1 }),
      );
      prisma.employee.findMany.mockResolvedValue(rows);

      const result = await service.findAll({ page: 2, page_size: 10 }, authUser(1));

      expect(result.pagination.page).toBe(2);
      expect(result.pagination.total).toBe(50);
      expect(result.pagination.total_pages).toBe(5);
      expect(result.data).toHaveLength(10);
    });
  });

  // ─── findAllForExport ──────────────────────────────────────────────────────

  describe('findAllForExport', () => {
    it("scope theo quyền `employees.export` (KHÔNG `employees.view`) — actor scope 'own' chỉ export ĐÚNG phạm vi đó, KHÔNG company-wide", async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      scope.ownerIds.mockResolvedValue([10]);

      await service.findAllForExport(
        {},
        authUser(10, { grants: { 'employees.export': 'own' } }),
      );

      expect(scope.ownerIds).toHaveBeenCalledWith(expect.anything(), 'employees.export');
      const where = prisma.employee.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({ user_id: { in: [10] } });
    });

    it("scope 'all' → không lọc theo user_id", async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      scope.ownerIds.mockResolvedValue('all');

      await service.findAllForExport({}, authUser(1, { grants: { 'employees.export': 'all' } }));

      const where = prisma.employee.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({});
    });
  });

  // ─── findById ──────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('trả nhân viên khi tìm thấy', async () => {
      prisma.employee.findUnique.mockResolvedValue(makeEmployee());

      const result = await service.findById(1, authUser(1));

      expect(result.id).toBe(1);
      expect(result.email).toBe('test@example.com');
      expect(result.role).toBe('sales');
    });

    it('throw NotFoundException khi không tìm thấy', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.findById(999, authUser(1))).rejects.toThrow(NotFoundException);
    });

    it('ngoài phạm vi employees.view (assertInScope) → NotFoundException (404, không 403 )', async () => {
      prisma.employee.findUnique.mockResolvedValue(makeEmployee());
      scope.ownerIds.mockResolvedValue([999]); // không chứa user_id=10 của makeEmployee()

      await expect(service.findById(1, authUser(2))).rejects.toThrow(NotFoundException);
    });
  });

  // ─── lock ──────────────────────────────────────────────────────────────────

  describe('unlock — chỉ Quản trị, đảo lock', () => {
    const admin = () => authUser(1, { isAdmin: true })
    const locked = { id: 1, user_id: 10, user: { status: 'locked' } }

    it('Quản trị mở khoá ⇒ user active + employee active, xoá resigned_at, ghi audit employee_unlock', async () => {
      prisma.employee.findFirst.mockResolvedValue(locked);
      await expect(service.unlock(1, admin())).resolves.toMatchObject({ ok: true });
      // Tài khoản liên kết đã xoá hẳn ⇒ không tìm thấy (Codex #63).
      expect(prisma.employee.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1, deleted_at: null, user: { deleted_at: null } } }));
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 10 }, data: { status: 'active' } });
      expect(prisma.employee.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { status: 'active', resigned_at: null } });
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, action: 'employee_unlock', resourceId: 1 }));
    });

    it('gói đã đủ người dùng đang hoạt động ⇒ 409 của gói, KHÔNG bật lại tài khoản (Codex #63 P1)', async () => {
      prisma.employee.findFirst.mockResolvedValue(locked);
      prisma.setting.findUnique.mockResolvedValue({ value: 'ket_noi' }); // tối đa 10 người
      prisma.user.count.mockResolvedValue(10);
      await expect(service.unlock(1, admin())).rejects.toThrow('tối đa 10 người dùng');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('không phải Quản trị ⇒ 403, không đụng DB', async () => {
      await expect(service.unlock(1, authUser(1))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    });

    it('không có / đã xoá ⇒ 404; chưa bị khoá ⇒ 409; tự mở khoá chính mình ⇒ 403', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);
      await expect(service.unlock(1, admin())).rejects.toBeInstanceOf(NotFoundException);
      prisma.employee.findFirst.mockResolvedValue({ ...locked, user: { status: 'active' } });
      await expect(service.unlock(1, admin())).rejects.toBeInstanceOf(ConflictException);
      prisma.employee.findFirst.mockResolvedValue({ ...locked, user_id: 1 });
      await expect(service.unlock(1, admin())).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('lock', () => {
    it('khoá user + đánh resigned cho employee', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      const result = await service.lock(1, authUser(1));

      expect(result.ok).toBe(true);
    });

    it('ghi audit DB (employee_lock) với người thực hiện', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      await service.lock(1, authUser(1));

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, action: 'employee_lock', resource: 'employees', resourceId: 1 }),
      );
    });

    it('khoá NV → set resigned_at (giữ bất biến status=resigned ⇔ resigned_at != null)', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      await service.lock(1, authUser(1));

      // Có điều kiện: khoá lại người đã nghỉ không dời ngày nghỉ.
      expect(prisma.employee.updateMany).toHaveBeenCalledWith({
        where: { id: 1, status: { not: 'resigned' } },
        data: { status: 'resigned', resigned_at: expect.any(Date) },
      });
      // Đóng giai đoạn làm việc đang mở (employment_periods).
      expect(sqlCalls().some((q) => q.includes('UPDATE employment_periods SET ended_on'))).toBe(true);
    });

    it('throw NotFoundException khi không tìm thấy employee', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.lock(999, authUser(1))).rejects.toThrow(NotFoundException);
    });

    it('có caller → ghi audit log người thực hiện + trả ok', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      const res = await service.lock(1, authUser(7));

      expect(res.ok).toBe(true);
    });

    it('tự nghỉ việc chính mình (caller.userId === employee.user_id) → ForbiddenException', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      await expect(
        service.lock(1, authUser(10)),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ngoài phạm vi users.manage (assertInScope) → NotFoundException (404, không 403 )', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });
      scope.ownerIds.mockResolvedValue([999]); // không chứa user_id=10

      await expect(service.lock(1, authUser(2))).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('§6 luật 3 — target giữ quyền KHÔNG PHẢI tập con của caller (vd Quản trị thật) → ForbiddenException, KHÔNG khoá được dù trong scope users.manage', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });
      permission.grantsFor.mockResolvedValue({
        isAdmin: true,
        grants: { 'roles.manage': true },
      });

      await expect(service.lock(1, authUser(2))).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('caller isAdmin (Quản trị) → bỏ qua kiểm isSubset, vẫn khoá được', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      await service.lock(1, authUser(2, { isAdmin: true }));

      expect(permission.grantsFor).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('khoá thành công → invalidate cache quyền toàn cục (status đổi ảnh hưởng isAdmin hiệu lực)', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      await service.lock(1, authUser(2));

      expect(rbacCache.invalidateUsers).toHaveBeenCalledWith('*');
    });
  });

  // ─── remove ────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('ghi audit DB (employee_delete)', async () => {
      prisma.employee.findFirst.mockResolvedValue({ id: 1, user_id: 10 });
      prisma.employee.update.mockResolvedValue({});

      await service.remove(1, authUser(1));

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, action: 'employee_delete', resourceId: 1 }),
      );
    });

    it('soft-delete employees.deleted_at VÀ khoá tài khoản đăng nhập liên kết + thu hồi phiên (không xoá user)', async () => {
      // findFirst (guard deleted_at: null) trả employee còn hoạt động
      prisma.employee.findFirst.mockResolvedValue({ id: 1, user_id: 10 });
      prisma.employee.update.mockResolvedValue({});
      prisma.user.update.mockResolvedValue({});

      const result = await service.remove(1);

      expect(result.ok).toBe(true);
      expect(prisma.employee.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({ deleted_at: expect.any(Date) }),
      });
      // User bị khoá (không đặt deleted_at, không đổi email) + mốc thu hồi refresh token.
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { status: 'locked', tokens_valid_after: expect.any(Date) },
      });
      // Cả hai ghi trong MỘT transaction.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(rbacCache.invalidateUsers).toHaveBeenCalled();
    });

    it('khoá nhân viên (lock) cũng đặt tokens_valid_after để mở khoá không làm token cũ sống lại', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 1, user_id: 10 });

      await service.lock(1, authUser(1));

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { status: 'locked', tokens_valid_after: expect.any(Date) },
      });
    });

    it('throw NotFoundException khi không tìm thấy employee (hoặc đã xoá)', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);

      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });

    it('có caller → soft-delete + ghi audit log người thực hiện + trả ok', async () => {
      prisma.employee.findFirst.mockResolvedValue({ id: 1, user_id: 10 });
      prisma.employee.update.mockResolvedValue({});

      const res = await service.remove(1, authUser(7));

      expect(res.ok).toBe(true);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 10 } }),
      );
    });

    it('tự xóa chính mình (caller.userId === employee.user_id) → ForbiddenException', async () => {
      prisma.employee.findFirst.mockResolvedValue({ id: 1, user_id: 10 });

      await expect(
        service.remove(1, authUser(10)),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });
  });

  // ─── mapEmployee ───────────────────────────────────────────────────────────

  describe('mapEmployee (employee_code)', () => {
    it('tạo mã NV dạng NVxxxx', async () => {
      prisma.employee.findMany.mockResolvedValue([makeEmployee({ id: 42 })]);

      const result = await service.findAll({}, authUser(1));

      expect(result.data[0].employee_code).toBe('NV0042');
    });

    it('không có role → role=null', async () => {
      const emp = makeEmployee();
      emp.user.user_roles = [];
      prisma.employee.findMany.mockResolvedValue([emp]);

      const result = await service.findAll({}, authUser(1));

      expect(result.data[0].role).toBeNull();
    });

    it('có jobTitle → trả đủ field job_title_*', async () => {
      const emp = makeEmployee({
        job_title_id: 1,
        jobTitle: { id: 1, name: 'Nhân viên kinh doanh', category: 'Nhân viên', rank_code: 'NV', symbol: 'NVKD' },
      });
      prisma.employee.findMany.mockResolvedValue([emp]);

      const result = await service.findAll({}, authUser(1));

      expect(result.data[0].job_title_id).toBe(1);
      expect(result.data[0].job_title_name).toBe('Nhân viên kinh doanh');
      expect(result.data[0].job_title_symbol).toBe('NVKD');
    });
  });

  // ─── create — phone & job_title validation ─────────────────────────────────

  describe('create — duplicate checks', () => {
    const baseDto = {
      email: 'new@example.com',
      full_name: 'Nguyễn Thị B',
      password: 'password123',
      position: 'sales',
    };

    it('throw ConflictException khi SĐT đã tồn tại', async () => {
      prisma.user.findUnique.mockResolvedValue(null); // email ok
      prisma.user.findFirst.mockResolvedValue({ id: 99 }); // phone dup

      await expect(
        service.create({ ...baseDto, phone: '0901234567' }),
      ).rejects.toThrow('Số điện thoại đã được sử dụng');
    });

    it('throw NotFoundException khi job_title_id không tồn tại', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.jobTitle.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ ...baseDto, job_title_id: 999 }),
      ).rejects.toThrow('Chức danh #999 không tồn tại');
    });
  });

  // ─── create — phạm vi email + reuse/khôi phục ──────────────────────

  describe('create — email scope', () => {
    const baseDto = {
      email: 'dat@example.com',
      full_name: 'Nguyễn Văn A',
      position: 'sales',
    };

    // Dựng tx giả + nối vào $transaction callback
    function wireTransaction() {
      const tx = {
        user: {
          findUnique: jest.fn(),
          create: jest.fn().mockResolvedValue({ id: 100 }),
          update: jest.fn().mockResolvedValue({}),
        },
        role: { findUnique: jest.fn().mockResolvedValue({ id: 5 }) },
        userRole: { deleteMany: jest.fn().mockResolvedValue({}), create: jest.fn().mockResolvedValue({}) },
        employee: { upsert: jest.fn().mockResolvedValue(makeEmployee()), findUnique: jest.fn().mockResolvedValue(null) },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      prisma.$transaction.mockImplementation(
        async (cb: (t: typeof tx) => unknown) => cb(tx),
      );
      return tx;
    }

    it('email thuộc nhân viên ĐANG hoạt động → 409 (đúng phạm vi employees)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 5, deleted_at: null, employee: { id: 3 } });

      await expect(service.create({ ...baseDto })).rejects.toThrow(
        'Email đã được sử dụng cho một nhân viên khác',
      );
    });

    it('email mới hoàn toàn → tạo user + employee mới', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();

      await service.create({ ...baseDto });

      expect(tx.user.create).toHaveBeenCalledTimes(1);
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.employee.upsert).toHaveBeenCalledTimes(1);
      // Tạo user mới luôn set password_hash (dto.password hoặc random) → luôn ghi vết.
      expect(tx.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ password_updated_at: expect.any(Date) }),
        }),
      );
    });

    // ─── audit password_change cho đường tạo/tái dùng NV ─────────
    it('tạo user mới → ghi audit password_change (method=employee_create)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      wireTransaction();

      await service.create({ ...baseDto }, { userId: 42, isAdmin: true, grants: [] } as never);

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 42,
          action: 'password_change',
          resource: 'users',
          resourceId: 100,
          metadata: expect.objectContaining({ method: 'employee_create' }),
        }),
      );
    });

    it('email thuộc tài khoản CHƯA là nhân viên (active, KHÔNG có role) → tái dùng, KHÔNG tạo user mới', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 7, deleted_at: null, employee: null, user_roles: [] });
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();

      await service.create({ ...baseDto });

      expect(tx.user.create).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 7 } }),
      );
      expect(tx.employee.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { user_id: 7 } }),
      );
      // KHÔNG truyền dto.password → KHÔNG đụng password_hash, KHÔNG ghi audit password.
      expect(tx.user.update.mock.calls[0][0].data).not.toHaveProperty('password_hash');
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('tái dùng tài khoản + CÓ truyền dto.password → ghi đè password_hash + audit (method=employee_reuse_password_set)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 7, deleted_at: null, employee: null, user_roles: [] });
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();

      await service.create({ ...baseDto, password: 'NewPass123!' }, { userId: 9, isAdmin: true, grants: [] } as never);

      expect(tx.user.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({
          password_hash: expect.any(String),
          password_updated_at: expect.any(Date),
        }),
      );
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 9,
          action: 'password_change',
          resourceId: 7,
          metadata: expect.objectContaining({ method: 'employee_reuse_password_set' }),
        }),
      );
    });

    it('tái dùng tài khoản đang hoạt động: actor KHÔNG phủ scope users.manage của tài khoản đó → bị chặn, không ghi gì', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 7, deleted_at: null, employee: null, user_roles: [] });
      prisma.user.findFirst.mockResolvedValue(null);
      scope.ownerIds.mockResolvedValue([99]); // chỉ phủ user 99, không phủ user 7
      const tx = wireTransaction();

      await expect(
        service.create({ ...baseDto, password: 'NewPass123!' }, { userId: 9, isAdmin: false, grants: [] } as never),
      ).rejects.toThrow();

      expect(scope.ownerIds).toHaveBeenCalledWith(expect.anything(), 'users.manage');
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('email thuộc tài khoản hệ thống ĐANG hoạt động + ĐÃ có role → 409 (không âm thầm chiếm dụng)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 11,
        deleted_at: null,
        employee: null,
        user_roles: [{ id: 99 }],
      });
      const tx = wireTransaction();

      await expect(service.create({ ...baseDto })).rejects.toThrow(
        'Email đang được dùng cho một tài khoản hệ thống khác',
      );
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.user.create).not.toHaveBeenCalled();
    });

    it('email thuộc nhân viên đã XOÁ MỀM → khôi phục (clear deleted_at), KHÔNG 409', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 8,
        deleted_at: new Date('2026-01-01'),
        employee: { id: 4 },
        user_roles: [{ id: 50 }],
      });
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();

      await service.create({ ...baseDto });

      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 8 },
          data: expect.objectContaining({ deleted_at: null, status: 'active' }),
        }),
      );
      expect(tx.employee.upsert).toHaveBeenCalled();
    });

    it('khôi phục NHÂN VIÊN đã xoá mềm (tài khoản chưa xoá) KHÔNG tự mở khoá tài khoản đăng nhập', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 8,
        deleted_at: null,
        employee: { id: 4, deleted_at: new Date('2026-01-01') },
        user_roles: [],
      });
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();

      await service.create({ ...baseDto });

      const data = tx.user.update.mock.calls[0][0].data;
      expect(data.status).toBeUndefined();
      expect(tx.employee.upsert).toHaveBeenCalled();
    });

    it('khôi phục tài khoản xoá mềm còn vai trò mà quyền cao hơn actor → 403, KHÔNG update (leo thang)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 8,
        deleted_at: new Date('2026-01-01'),
        employee: { id: 4 },
        user_roles: [{ id: 50 }],
      });
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();
      const permission = (service as unknown as { permission: { grantsFor: jest.Mock } }).permission;
      permission.grantsFor.mockResolvedValue({ isAdmin: true, grants: [] });

      await expect(
        service.create({ ...baseDto }, { userId: 3, isAdmin: false, grants: [] } as never),
      ).rejects.toThrow('Không thể thao tác người có quyền cao hơn bạn');
      expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('lưu mã nhân viên nhập tay (employee_code) ở cả create lẫn update branch', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      const tx = wireTransaction();

      await service.create({ ...baseDto, employee_code: 'NV777' });

      const upsertArg = tx.employee.upsert.mock.calls[0][0];
      expect(upsertArg.create.employee_code).toBe('NV777');
      expect(upsertArg.update.employee_code).toBe('NV777');
    });

    // ─── — ĐÃ GỠ: tạo/sửa nhân viên KHÔNG còn
    // gán "Vai trò hệ thống" ở endpoint này (`role` đã bỏ khỏi DTO) — vai trò
    // luôn gán SAU qua `PUT /users/:id/roles`, nên cảnh báo "thiếu
    // role lúc tạo" không còn ý nghĩa (MỌI lần tạo đều "thiếu role" theo thiết
    // kế mới). `warnMissingRoleOnCreate` đã xoá khỏi service.
  });

  // ─── mapEmployee — ưu tiên employee_code nhập tay ──────────────────────────

  it('mapEmployee dùng employee_code DB khi có (không fallback NVxxxx)', async () => {
    prisma.employee.findMany.mockResolvedValue([
      { ...makeEmployee({ id: 9 }), employee_code: 'ABC123' },
    ]);

    const result = await service.findAll({}, authUser(1));

    expect(result.data[0].employee_code).toBe('ABC123');
  });

  // ─── mapEmployee — manager_name (Bộ phận) ────────────────────────────

  it('mapEmployee trả manager_name từ user.manager.full_name', async () => {
    const emp = makeEmployee({ id: 5 });
    emp.user.manager = { full_name: 'Trần Trưởng Nhóm' };
    prisma.employee.findMany.mockResolvedValue([emp]);

    const result = await service.findAll({}, authUser(1));

    expect(result.data[0].manager_name).toBe('Trần Trưởng Nhóm');
  });

  it('mapEmployee trả manager_name=null khi chưa gán Bộ phận', async () => {
    prisma.employee.findMany.mockResolvedValue([makeEmployee({ id: 6 })]);

    const result = await service.findAll({}, authUser(1));

    expect(result.data[0].manager_name).toBeNull();
  });

  // ─── update — Bộ phận (manager_id) validation ────────────────────────

  describe('update — Bộ phận / manager_id (không ràng buộc theo vai trò)', () => {
    // Mock employee.findUnique cho update (select hẹp: id + user_id + user{avatar_url,manager_id}).
    function mockCurrentEmployee(managerId: number | null) {
      prisma.employee.findUnique.mockResolvedValue({
        id: 1,
        user_id: 10,
        user: { avatar_url: null, manager_id: managerId },
      });
    }

    // Mock prisma.user.findUnique cho assertNoManagerCycle DFS (select.manager_id).
    function mockCycleLookup(cycleParentManagerId: number | null) {
      prisma.user.findUnique.mockResolvedValue({ manager_id: cycleParentManagerId });
    }

    function wireUpdateTx(currentStatus = 'active') {
      const tx = {
        user: { update: jest.fn().mockResolvedValue({}) },
        employee: {
          update: jest.fn().mockResolvedValue(makeEmployee()),
          findUnique: jest.fn().mockResolvedValue({ status: currentStatus }),
        },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      prisma.$transaction.mockImplementation(
        async (cb: (t: typeof tx) => unknown) => cb(tx),
      );
      return tx;
    }

    it('gán Bộ phận (manager_id) hợp lệ, KHÔNG còn ràng buộc theo vai trò → cập nhật thành công', async () => {
      mockCurrentEmployee(null);
      mockCycleLookup(null);
      const tx = wireUpdateTx();

      await service.update(1, { manager_id: 99 }, authUser(7));

      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 10 },
          data: expect.objectContaining({ manager_id: 99 }),
        }),
      );
    });

    it('trưởng nhóm lưu hồ sơ với team của chính mình → không 403, giữ nguyên manager_id', async () => {
      mockCurrentEmployee(5);
      mockCycleLookup(null);
      const tx = wireUpdateTx();
      (prisma.team as unknown as { findUnique: jest.Mock }).findUnique = jest
        .fn()
        .mockResolvedValue({ team_lead_id: 10, department: 'KD' });

      await service.update(1, { team_id: 3 }, authUser(7));

      const data = tx.user.update.mock.calls[0][0].data;
      expect(data.manager_id).toBeUndefined();
    });

    it('tự đặt mình làm quản lý (managerId === selfId) → ForbiddenException', async () => {
      mockCurrentEmployee(null);
      // managerId = user_id = 10 → chặn trước cả khi gọi assertNoManagerCycle
      wireUpdateTx();

      await expect(service.update(1, { manager_id: 10 }, authUser(7))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('chuỗi quản lý vòng lặp → BadRequestException', async () => {
      mockCurrentEmployee(null);
      // manager 99 hợp lệ nhưng chain DFS quay về chính user (10)
      mockCycleLookup(10);
      wireUpdateTx();

      await expect(service.update(1, { manager_id: 99 }, authUser(7))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('SĐT trùng tài khoản khác → ConflictException (mirror create)', async () => {
      mockCurrentEmployee(null);
      wireUpdateTx();
      prisma.user.findFirst.mockResolvedValue({ id: 99 });

      await expect(
        service.update(1, { phone: '0901234567' }, authUser(7)),
      ).rejects.toThrow('Số điện thoại đã được sử dụng');
      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: '0901234567', id: { not: 10 } } }),
      );
    });

    it('avatar_url là đường dẫn file của người khác → 400 (không được xoá nhầm ảnh người khác)', async () => {
      mockCurrentEmployee(null);
      wireUpdateTx();

      await expect(
        service.update(1, { avatar_url: '/uploads/avatars/empl_1_aaaaaaaa.jpg' }, authUser(7)),
      ).rejects.toThrow(BadRequestException);
    });

    it('sửa field khác KHÔNG đụng manager_id → KHÔNG gọi assertNoManagerCycle, lưu OK', async () => {
      mockCurrentEmployee(null);
      const tx = wireUpdateTx();

      await service.update(1, { full_name: 'Tên Mới' }, authUser(7));

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(tx.employee.update).toHaveBeenCalled();
    });

    it('ngoài phạm vi users.manage (assertInScope) → NotFoundException (404, không 403 )', async () => {
      mockCurrentEmployee(null);
      scope.ownerIds.mockResolvedValue([999]); // không chứa user_id=10

      await expect(
        service.update(1, { full_name: 'X' }, authUser(2)),
      ).rejects.toThrow(NotFoundException);
    });

    it('PATCH status="resigned" → set resigned_at (giữ bất biến)', async () => {
      mockCurrentEmployee(null);
      const tx = wireUpdateTx();

      await service.update(1, { status: 'resigned' }, authUser(7));

      expect(tx.employee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'resigned',
            resigned_at: expect.any(Date),
          }),
        }),
      );
    });

    it('PATCH status="active" (rehire) → xoá resigned_at (giữ bất biến)', async () => {
      mockCurrentEmployee(null);
      const tx = wireUpdateTx();

      await service.update(1, { status: 'active' }, authUser(7));

      expect(tx.employee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'active',
            resigned_at: null,
          }),
        }),
      );
    });

    it('PATCH status đổi vào / ra "resigned" ⇒ đóng / mở giai đoạn làm việc; đổi active ⇄ probation không chạm', async () => {
      const sqls = (tx: { $executeRaw: jest.Mock }) => tx.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
      mockCurrentEmployee(null);
      let tx = wireUpdateTx('active');
      await service.update(1, { status: 'resigned' }, authUser(7));
      expect(sqls(tx).some((q) => q.includes('UPDATE employment_periods SET ended_on'))).toBe(true);

      tx = wireUpdateTx('resigned');
      await service.update(1, { status: 'active' }, authUser(7));
      expect(sqls(tx).some((q) => q.includes('INSERT INTO employment_periods (employee_id, started_on)'))).toBe(true);

      tx = wireUpdateTx('active');
      await service.update(1, { status: 'probation' }, authUser(7));
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('PATCH status="resigned" khi ĐÃ nghỉ ⇒ giữ ngày nghỉ cũ (không ghi resigned_at), không chạm giai đoạn', async () => {
      mockCurrentEmployee(null);
      const tx = wireUpdateTx('resigned');
      await service.update(1, { status: 'resigned' }, authUser(7));
      expect(tx.employee.update.mock.calls[0][0].data).not.toHaveProperty('resigned_at');
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  // ─── getStats ──────────────────────────────────────────────────────

  describe('getStats', () => {
    const mockRaw = <T>(rows: T) => jest.fn().mockResolvedValue(rows);

    it('trả 5 nhóm thống kê đúng shape', async () => {
      const deptRows = [{ label: 'Kinh doanh', count: BigInt(5) }, { label: 'Kế toán', count: BigInt(2) }];
      const genderRows = [{ label: 'M', count: BigInt(4) }, { label: 'Chưa cập nhật', count: BigInt(3) }];
      const eduRows = [{ label: 'dai_hoc_tro_len', count: BigInt(6) }];
      const jobRows = [{ label: 'Nhân viên', count: BigInt(7) }];
      const statusRows = [{ label: 'active', count: BigInt(7) }];

      // $queryRaw được gọi 6 lần (Promise.all): 5 nhóm + 1 đếm resigned
      (prisma as unknown as Record<string, unknown>)['$queryRaw'] = jest.fn()
        .mockResolvedValueOnce(deptRows)
        .mockResolvedValueOnce(genderRows)
        .mockResolvedValueOnce(eduRows)
        .mockResolvedValueOnce(jobRows)
        .mockResolvedValueOnce(statusRows)
        .mockResolvedValueOnce([{ count: BigInt(3) }]); // resigned_total

      const result = await service.getStats({ userId: 1, grants: [] } as never);

      expect(result.by_department).toEqual([{ label: 'Kinh doanh', count: 5 }, { label: 'Kế toán', count: 2 }]);
      expect(result.by_gender).toEqual([{ label: 'M', count: 4 }, { label: 'Chưa cập nhật', count: 3 }]);
      expect(result.by_education).toEqual([{ label: 'dai_hoc_tro_len', count: 6 }]);
      expect(result.by_job_title).toEqual([{ label: 'Nhân viên', count: 7 }]);
      expect(result.by_status).toEqual([{ label: 'active', count: 7 }]);
      // Số NV đã nghỉ việc (tài khoản vô hiệu hoá) — metric riêng tách 5 query trên
      expect(result.resigned_total).toBe(3);
    });

    it('BigInt được chuyển sang number trong kết quả', async () => {
      const rows = [{ label: 'A', count: BigInt(42) }];
      (prisma as unknown as Record<string, unknown>)['$queryRaw'] = jest.fn().mockResolvedValue(rows);

      const result = await service.getStats({ userId: 1, grants: [] } as never);

      // Tất cả count phải là number, không phải BigInt
      result.by_department.forEach((r) => expect(typeof r.count).toBe('number'));
    });

    it('kết quả rỗng trả array trống mỗi nhóm', async () => {
      (prisma as unknown as Record<string, unknown>)['$queryRaw'] = jest.fn().mockResolvedValue([]);

      const result = await service.getStats({ userId: 1, grants: [] } as never);

      expect(result.by_department).toEqual([]);
      expect(result.by_gender).toEqual([]);
    });
  });

  // ─── buildWhere — employment_state ─────────────────────────────────
  // findAll gọi prisma.employee.findMany({ where, select }) trực tiếp → inspect where qua mock.
  describe('buildWhere — employment_state', () => {
    async function whereFor(dto: Record<string, unknown>) {
      prisma.employee.findMany.mockResolvedValue([]);
      await service.findAll(dto, authUser(1));
      // Mẫu A: where = { AND: [scopeWhere(owner, ['user_id']), filtersWhere] } —
      // filtersWhere (chứa `user`) là phần tử THỨ HAI của mảng AND.
      const where = prisma.employee.findMany.mock.calls[0][0].where as {
        AND: [Record<string, unknown>, { user: Record<string, unknown> }];
      };
      return where.AND[1];
    }

    it("active → user.status='active'", async () => {
      const where = await whereFor({ employment_state: 'active' });
      expect(where.user).toEqual({ deleted_at: null, status: 'active' });
    });

    it("resigned → user.status='locked'", async () => {
      const where = await whereFor({ employment_state: 'resigned' });
      expect(where.user).toEqual({ deleted_at: null, status: 'locked' });
    });

    it("all → KHÔNG lọc status (chỉ deleted_at)", async () => {
      const where = await whereFor({ employment_state: 'all' });
      expect(where.user).toEqual({ deleted_at: null });
    });

    it('vắng employment_state → backward-compat (chỉ deleted_at, không status)', async () => {
      const where = await whereFor({});
      expect(where.user).toEqual({ deleted_at: null });
    });

    it('search + active → gộp OR + status + deleted_at trong CÙNG user filter', async () => {
      const where = await whereFor({ search: 'An', employment_state: 'active' });
      expect(where.user).toMatchObject({ deleted_at: null, status: 'active' });
      expect(Array.isArray(where.user.OR)).toBe(true);
      expect((where.user.OR as unknown[]).length).toBe(3);
    });
  });
});
