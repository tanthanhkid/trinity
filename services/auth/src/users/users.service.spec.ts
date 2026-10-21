import { Test, TestingModule } from '@nestjs/testing'
import {
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { UsersService } from './users.service'
import { TokenBlacklistService, RbacCache, ScopeService, PermissionService } from '@trinity/rbac-nest'
import type { AuthUser } from '@trinity/rbac-nest'
import { AuditLogService } from '../auth/services/audit-log.service'
import { PrismaService } from '@trinity/prisma'

jest.mock('bcryptjs')

interface MockPrisma {
  user: {
    findMany: jest.Mock
    findUnique: jest.Mock
    count: jest.Mock
    create: jest.Mock
    update: jest.Mock
    updateMany: jest.Mock
    findFirst: jest.Mock
  }
  team: { findUnique: jest.Mock }
  setting: { findUnique: jest.Mock }
  employee: { upsert: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock }
  auditLog: { findMany: jest.Mock }
  $transaction: jest.Mock
  $executeRaw: jest.Mock
}

const mockPrisma: MockPrisma = {
  user: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
  },
  team: {
    findUnique: jest.fn(),
  },
  setting: { findUnique: jest.fn().mockResolvedValue(null) }, // gói mặc định
  employee: {
    upsert: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn(),
  },
  // $transaction helper: invoke callback với mockPrisma làm tx client để
  // test logic trong softDeletePermanent. Production tx isolation ko test
  // được trong unit test; để integration/E2E test cover.
  $transaction: jest.fn(),
  // advisory lock Quản trị cuối (`lockAdminMutation`) — no-op trong unit test.
  $executeRaw: jest.fn().mockResolvedValue(0),
}
mockPrisma.$transaction.mockImplementation(
  async (cb: (tx: MockPrisma) => unknown) => cb(mockPrisma),
)

const mockUserResponse = {
  id: 1,
  email: 'test@example.vn',
  full_name: 'Test User',
  phone: null,
  team_id: 1,
  manager_id: null,
  status: 'active',
  deleted_at: null,
  created_at: new Date(),
  team: { name: 'Team A' },
  manager: null,
  user_roles: [{ role: { id: 4, name: 'Sale', is_system: false } }],
}

/** Actor mặc định — grants rỗng, isAdmin=false; test tự override khi cần. */
function mkActor(userId: number, overrides: Partial<AuthUser> = {}): AuthUser {
  return { userId, email: `u${userId}@t`, isAdmin: false, grants: {}, ...overrides }
}

describe('UsersService', () => {
  let service: UsersService
  let tokenBlacklist: TokenBlacklistService
  let auditLog: { logPasswordChange: jest.Mock; logLogin: jest.Mock }
  let mockScope: { ownerIds: jest.Mock }
  let mockPermissionService: { grantsFor: jest.Mock }

  beforeEach(async () => {
    jest.clearAllMocks()
    auditLog = {
      logPasswordChange: jest.fn().mockResolvedValue(undefined),
      logLogin: jest.fn().mockResolvedValue(undefined),
    }

    // Re-arm $transaction sau clearAllMocks để giữ behavior callback-pass-through.
    mockPrisma.$transaction.mockImplementation(
      async (cb: (tx: MockPrisma) => unknown) => cb(mockPrisma),
    )
    // Default: không có số kịch bản nào để giải phóng (test riêng override).
    // Default: auto-provision employees row khi create user.
    mockPrisma.employee.upsert.mockResolvedValue({})
    // Default: đồng bộ nghỉ việc — không có employee row liên kết cũng OK (updateMany).
    mockPrisma.employee.updateMany.mockResolvedValue({ count: 0 })
    mockPrisma.employee.findUnique.mockResolvedValue(null)
    mockPrisma.employee.update.mockResolvedValue({})

    // Mặc định permissive: target trong scope ('all') + target.grants={} (⊆
    // MỌI actor.grants — isSubset rỗng luôn true) → `assertCanManageUser` pass
    // cho MỌI actor. Test escalation tự override qua `mockScope`/`mockPermissionService`.
    mockScope = { ownerIds: jest.fn().mockResolvedValue('all') }
    mockPermissionService = {
      grantsFor: jest.fn().mockResolvedValue({ grants: {}, isAdmin: false }),
    }

    tokenBlacklist = new TokenBlacklistService()
    const rbacCache = { invalidateUsers: jest.fn().mockResolvedValue(undefined) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TokenBlacklistService, useValue: tokenBlacklist },
        { provide: AuditLogService, useValue: auditLog },
        { provide: RbacCache, useValue: rbacCache },
        { provide: ScopeService, useValue: mockScope },
        { provide: PermissionService, useValue: mockPermissionService },
      ],
    }).compile()

    service = module.get<UsersService>(UsersService)
  })

  describe('findAll — Mẫu A (owner = chính user), scope theo users.view', () => {
    it('scope all → không filter theo id', async () => {
      mockPrisma.user.findMany.mockResolvedValue([mockUserResponse])
      mockPrisma.user.count.mockResolvedValue(1)

      const result = await service.findAll({ page: 1, limit: 20 }, mkActor(1, { isAdmin: true }))

      expect(result.data).toHaveLength(1)
      expect(result.data[0].roles).toEqual(['Sale'])
      expect(result.total).toBe(1)
      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[0]).toEqual({})
    })

    it('scope own ([42]) → filter id IN [42]', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)
      mockScope.ownerIds.mockResolvedValue([42])

      await service.findAll({ page: 1, limit: 20 }, mkActor(42, { grants: { 'users.view': 'own' } }))

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[0]).toEqual({ id: { in: [42] } })
    })

    it('scope team ([5,10,11]) → filter id IN tập subtree', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)
      mockScope.ownerIds.mockResolvedValue([5, 10, 11])

      await service.findAll({ page: 1, limit: 20 }, mkActor(5, { grants: { 'users.view': 'team' } }))

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[0]).toEqual({ id: { in: [5, 10, 11] } })
    })

    it('apply filter by team_id (compose AND cùng scope + deleted_at)', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)

      await service.findAll(
        { page: 1, limit: 20, teamId: 1 },
        mkActor(1, { isAdmin: true }),
      )

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[1]).toEqual(expect.objectContaining({ team_id: 1 }))
      expect(where.AND[2]).toEqual({ deleted_at: null })
    })

    it('managerId=null → filter WHERE manager_id IS NULL (user chưa có quản lý)', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)

      await service.findAll(
        { page: 1, limit: 20, managerId: null },
        mkActor(1, { isAdmin: true }),
      )

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[1]).toEqual(expect.objectContaining({ manager_id: null }))
    })

    it('managerId=number → filter exact manager_id', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)

      await service.findAll(
        { page: 1, limit: 20, managerId: 42 },
        mkActor(1, { isAdmin: true }),
      )

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[1]).toEqual(expect.objectContaining({ manager_id: 42 }))
    })

    it('luôn force where.deleted_at = null', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)

      await service.findAll({ page: 1, limit: 20 }, mkActor(1, { isAdmin: true }))

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[2]).toEqual({ deleted_at: null })
    })

    it('Mẫu C — users.phone_full scope hẹp → mask SĐT của dòng ngoài scope', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { ...mockUserResponse, id: 1, phone: '0912345678' },
        { ...mockUserResponse, id: 2, phone: '0987654321' },
      ])
      mockPrisma.user.count.mockResolvedValue(2)
      // users.view → 'all' (thấy hết); users.phone_full → chỉ [1].
      mockScope.ownerIds.mockImplementation(async (_u: unknown, perm: string) =>
        perm === 'users.phone_full' ? [1] : 'all',
      )

      const result = await service.findAll({ page: 1, limit: 20 }, mkActor(1))

      expect(result.data.find((u) => u.id === 1)?.phone).toBe('0912345678')
      expect(result.data.find((u) => u.id === 2)?.phone).toBe('***321')
    })
  })

  describe('findAllForExport', () => {
    it('trả về data đã map (không bọc { data, total })', async () => {
      mockPrisma.user.findMany.mockResolvedValue([mockUserResponse])
      mockPrisma.user.count.mockResolvedValue(1)

      const rows = await service.findAllForExport({ page: 1, limit: 20 }, mkActor(1, { isAdmin: true }))

      expect(Array.isArray(rows)).toBe(true)
      expect(rows).toHaveLength(1)
      expect(rows[0].roles).toEqual(['Sale'])
      expect(rows[0].full_name).toBe('Test User')
      expect(rows[0].status).toBe('active')
    })

    it('mặc định sắp xếp theo full_name asc + lấy limit lớn (không phân trang)', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)

      await service.findAllForExport({ page: 1, limit: 20 }, mkActor(1, { isAdmin: true }))

      const call = mockPrisma.user.findMany.mock.calls[0][0]
      expect(call.orderBy).toEqual({ full_name: 'asc' })
      expect(call.take).toBeGreaterThan(1000)
    })

    it('giữ nguyên RBAC scope — own chỉ export chính mình', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])
      mockPrisma.user.count.mockResolvedValue(0)
      mockScope.ownerIds.mockResolvedValue([77])

      await service.findAllForExport(
        { page: 1, limit: 20 },
        mkActor(77, { grants: { 'users.view': 'own' } }),
      )

      const where = mockPrisma.user.findMany.mock.calls[0][0].where
      expect(where.AND[0]).toEqual({ id: { in: [77] } })
    })
  })

  describe('findById', () => {
    it('trả chi tiết user + roles[] khi trong scope', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse,
        avatar_url: null,
        updated_at: new Date(),
      })

      const result = await service.findById(1, mkActor(1, { isAdmin: true }))

      expect(result.id).toBe(1)
      expect(result.roles).toEqual(['Sale'])
    })

    it('ngoài scope users.view → 404, KHÔNG đọc DB', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(service.findById(1, mkActor(1, { grants: { 'users.view': 'own' } }))).rejects.toThrow(
        NotFoundException,
      )
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('throw 404 khi không tồn tại', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(service.findById(999, mkActor(1, { isAdmin: true }))).rejects.toThrow(NotFoundException)
    })

    it('throw 404 khi user.deleted_at != null (ẩn user đã xoá vĩnh viễn)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse,
        avatar_url: null,
        updated_at: new Date(),
        deleted_at: new Date(),
      })

      await expect(service.findById(1, mkActor(1, { isAdmin: true }))).rejects.toThrow(NotFoundException)
    })

    it('mask SĐT khi ngoài scope users.phone_full', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse,
        phone: '0912345678',
        avatar_url: null,
        updated_at: new Date(),
      })
      mockScope.ownerIds.mockImplementation(async (_u: unknown, perm: string) =>
        perm === 'users.phone_full' ? [999] : 'all',
      )

      const result = await service.findById(1, mkActor(1))

      expect(result.phone).toBe('***678')
    })
  })

  describe('create', () => {
    it('tạo user KHÔNG cần role (gán vai trò tách riêng)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed')
      mockPrisma.user.create.mockResolvedValue({
        id: 2,
        email: 'new@example.vn',
        full_name: 'New User',
        team_id: null,
        manager_id: null,
        status: 'active',
      })

      const result = await service.create({
        email: 'new@example.vn',
        full_name: 'New User',
        password: 'password123',
      })

      expect(result.id).toBe(2)
      expect(mockPrisma.employee.upsert).toHaveBeenCalled()
    })

    // tạo user PHẢI ghi vết ai tạo + set password_updated_at.
    it('ghi audit password_change (method=user_create) + set password_updated_at', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed')
      mockPrisma.user.create.mockResolvedValue({
        id: 2,
        email: 'new@example.vn',
        full_name: 'New User',
        team_id: null,
        manager_id: null,
        status: 'active',
      })

      await service.create(
        { email: 'new@example.vn', full_name: 'New User', password: 'password123' },
        mkActor(7),
      )

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ password_updated_at: expect.any(Date) }),
        }),
      )
      expect(auditLog.logPasswordChange).toHaveBeenCalledWith({
        actorUserId: 7,
        targetUserId: 2,
        method: 'user_create',
      })
    })

    it('manager_id hợp lệ (active) → tạo thành công, giữ nguyên manager_id', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      mockPrisma.user.findUnique.mockResolvedValue({ status: 'active', deleted_at: null })
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed')
      mockPrisma.user.create.mockResolvedValue({
        id: 200,
        email: 'nv200@example.net',
        full_name: 'NV 200',
        team_id: null,
        manager_id: 55,
        status: 'active',
      })

      const result = await service.create({
        email: 'nv200@example.net',
        full_name: 'NV 200',
        password: 'password123',
        manager_id: 55,
      })

      expect(result.manager_id).toBe(55)
      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ manager_id: 55 }) }),
      )
    })

    it('manager_id không active → 400 BadRequest', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      mockPrisma.user.findUnique.mockResolvedValue({ status: 'locked', deleted_at: null })

      await expect(
        service.create({
          email: 'x@example.net',
          full_name: 'X',
          password: 'password123',
          manager_id: 55,
        }),
      ).rejects.toThrow(BadRequestException)
      expect(mockPrisma.user.create).not.toHaveBeenCalled()
    })

    it('manager_id không tồn tại → 404', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(
        service.create({
          email: 'x2@example.net',
          full_name: 'X2',
          password: 'password123',
          manager_id: 999,
        }),
      ).rejects.toThrow(NotFoundException)
    })

    it('should throw 409 on duplicate email', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(mockUserResponse)

      await expect(
        service.create({ email: 'test@example.vn', full_name: 'Dup', password: 'password123' }),
      ).rejects.toThrow(ConflictException)
    })

    // check trùng email PHẢI case-insensitive.
    it('409 khi email trùng CHỈ KHÁC hoa/thường với user đang hoạt động (đóng lỗ hổng case-collision)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: 1, deleted_at: null })

      await expect(
        service.create({
          email: 'CAROL@example.com',
          full_name: 'Case Variant',
          password: 'password123',
        }),
      ).rejects.toThrow(ConflictException)

      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'carol@example.com', mode: 'insensitive' } },
        }),
      )
    })

    // email MỚI luôn ghi lowercase.
    it('chuẩn hoá email về lowercase khi TẠO mới, kể cả input viết hoa/có khoảng trắng', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed')
      mockPrisma.user.create.mockResolvedValue({
        id: 500,
        email: 'newhire@example.vn',
        full_name: 'New Hire',
        team_id: null,
        manager_id: null,
        status: 'active',
      })

      await service.create({
        email: '  NewHire@Example.VN  ',
        full_name: 'New Hire',
        password: 'password123',
      })

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'newhire@example.vn' }) }),
      )
    })

    it('rename email của user soft-delete để giải phóng slot cho user mới', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 88, deleted_at: new Date() })
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 88 })
      mockPrisma.user.update.mockResolvedValueOnce({})
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed')
      mockPrisma.user.create.mockResolvedValue({
        id: 99,
        email: 'reuse@example.net',
        full_name: 'Reused',
        team_id: null,
        manager_id: null,
        status: 'active',
      })

      const result = await service.create({
        email: 'reuse@example.net',
        full_name: 'Reused',
        password: 'password123',
      })

      expect(result.id).toBe(99)
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 88 },
          data: expect.objectContaining({
            email: expect.stringMatching(/^deleted_88_\d+@removed\.invalid$/),
          }),
        }),
      )
    })

    it('throw 409 khi email vẫn thuộc user active (deleted_at null)', async () => {
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 1, deleted_at: null })

      await expect(
        service.create({ email: 'test@example.vn', full_name: 'Dup', password: 'password123' }),
      ).rejects.toThrow(ConflictException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('rbacCache.invalidateUsers("*") được gọi sau khi tạo user thành công', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null)
      ;(bcrypt.hash as jest.Mock).mockResolvedValue('hashed')
      mockPrisma.user.create.mockResolvedValue({
        id: 3, email: 'z@example.net', full_name: 'Z', team_id: null, manager_id: null, status: 'active',
      })

      await service.create({ email: 'z@example.net', full_name: 'Z', password: 'password123' })

      const rbacCache = (service as unknown as { rbacCache: { invalidateUsers: jest.Mock } }).rbacCache
      expect(rbacCache.invalidateUsers).toHaveBeenCalledWith('*')
    })
  })

  describe('update', () => {
    it('tự sửa chính mình → 403 ngay, KHÔNG đọc DB', async () => {
      await expect(
        service.update(1, { full_name: 'x' }, mkActor(1)),
      ).rejects.toThrow(ForbiddenException)
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('target ngoài scope users.manage → 404 (assertCanManageUser)', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(
        service.update(5, { full_name: 'x' }, mkActor(1, { grants: { 'users.manage': 'own' } })),
      ).rejects.toThrow(NotFoundException)
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('target có quyền KHÔNG ⊆ quyền actor → 403 (assertCanManageUser)', async () => {
      mockPermissionService.grantsFor.mockResolvedValue({
        grants: { 'payroll.manage': true },
        isAdmin: false,
      })

      await expect(
        service.update(5, { full_name: 'x' }, mkActor(1, { grants: { 'users.manage': 'all' } })),
      ).rejects.toThrow(ForbiddenException)
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled()
    })

    it('should update user info', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null })
      mockPrisma.user.update.mockResolvedValue({
        id: 5, email: 'test@example.vn', full_name: 'Updated Name', team_id: 1, status: 'active',
      })

      const result = await service.update(5, { full_name: 'Updated Name' }, mkActor(1, { isAdmin: true }))

      expect(result.full_name).toBe('Updated Name')
    })

    it('should throw 404 when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(
        service.update(999, { full_name: 'x' }, mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(NotFoundException)
    })

    it('manager_id mới hợp lệ (active) → cập nhật thành công', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ ...mockUserResponse, id: 100, manager_id: null })
      // assertManagerActive
      mockPrisma.user.findUnique.mockResolvedValueOnce({ status: 'active', deleted_at: null })
      // assertNoManagerCycle DFS
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: null })

      mockPrisma.user.update.mockResolvedValue({
        id: 100, email: 'x@example.net', full_name: 'X', phone: null, team_id: null, manager_id: 55, status: 'active',
      })

      await service.update(100, { manager_id: 55 }, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ manager_id: 55 }) }),
      )
    })

    it('manager_id mới KHÔNG active → 400, KHÔNG update', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ ...mockUserResponse, id: 100, manager_id: null })
      mockPrisma.user.findUnique.mockResolvedValueOnce({ status: 'locked', deleted_at: null })

      await expect(
        service.update(100, { manager_id: 55 }, mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(BadRequestException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('khoá (PATCH status=locked) KHÔNG ghi đè email, thu hồi token cũ; mở khoá dùng lại được ngay', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null })
      mockPrisma.user.count.mockResolvedValue(0)
      mockPrisma.user.update.mockResolvedValue({
        id: 5, email: 'deleted_5_123@removed.invalid', full_name: 'Test', team_id: 1, status: 'locked',
      })

      await service.update(5, { status: 'locked' }, mkActor(99, { isAdmin: true }))

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'locked', tokens_valid_after: expect.any(Date) }),
        }),
      )
      const lockData = mockPrisma.user.update.mock.calls[0][0].data
      expect(lockData.email).toBeUndefined() // email giữ nguyên
      expect(tokenBlacklist.isBlacklisted(5)).toBe(true)

      // Mở khoá: không đụng email, không đặt lại mốc thu hồi.
      mockPrisma.user.update.mockClear()
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null, status: 'locked' })
      mockPrisma.user.update.mockResolvedValue({ id: 5, email: 'a@b.vn', status: 'active' })
      await service.update(5, { status: 'active' }, mkActor(99, { isAdmin: true }))
      const unlockData = mockPrisma.user.update.mock.calls[0][0].data
      expect(unlockData.email).toBeUndefined()
      expect(unlockData.tokens_valid_after).toBeUndefined()
      expect(unlockData.status).toBe('active')
    })

    it('khoá / mở khoá có hồ sơ nhân viên ⇒ đóng / mở giai đoạn làm việc; khoá lại người đã nghỉ không dời ngày nghỉ', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({ id: 42 })
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null })
      mockPrisma.user.count.mockResolvedValue(0)
      mockPrisma.user.update.mockResolvedValue({ id: 5, email: 'a@b.vn', status: 'locked' })
      await service.update(5, { status: 'locked' }, mkActor(99, { isAdmin: true }))
      const sqlOf = () => mockPrisma.$executeRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'))
      expect(sqlOf().some((q) => q.includes('UPDATE employment_periods SET ended_on'))).toBe(true)
      expect(mockPrisma.employee.updateMany).toHaveBeenCalledWith({
        where: { id: 42, status: { not: 'resigned' } },
        data: { status: 'resigned', resigned_at: expect.any(Date) },
      })

      mockPrisma.$executeRaw.mockClear()
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null, status: 'locked' })
      mockPrisma.user.update.mockResolvedValue({ id: 5, email: 'a@b.vn', status: 'active' })
      await service.update(5, { status: 'active' }, mkActor(99, { isAdmin: true }))
      expect(sqlOf().some((q) => q.includes('INSERT INTO employment_periods (employee_id, started_on)'))).toBe(true)
      expect(mockPrisma.employee.update).toHaveBeenCalledWith({ where: { id: 42 }, data: { status: 'active', resigned_at: null } })
    })

    it('không anonymize email nếu user đã ở trạng thái locked (idempotent)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse, manager_id: null, status: 'locked',
      })
      mockPrisma.user.update.mockResolvedValue({
        id: 5, email: 'test@example.vn', full_name: 'Test', team_id: 1, status: 'locked',
      })

      await service.update(5, { status: 'locked' }, mkActor(99, { isAdmin: true }))

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: undefined }) }),
      )
    })

    // case-collision check.
    it('409 khi đổi email sang giá trị CHỈ KHÁC hoa/thường với user KHÁC đang hoạt động', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse, id: 5, email: 'sale1@example.vn', manager_id: null,
      })
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 9, deleted_at: null })

      await expect(
        service.update(5, { email: 'SALE2@example.vn' }, mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(ConflictException)

      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'SALE2@example.vn', mode: 'insensitive' }, NOT: { id: 5 } },
        }),
      )
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('KHÔNG 409 khi admin gõ lại CHÍNH email hiện tại với casing khác (self-collision phải được loại trừ)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse, id: 11, email: 'Alice@example.com', manager_id: null,
      })
      mockPrisma.user.update.mockResolvedValue({
        id: 11, email: 'alice@example.com', full_name: 'Alice', team_id: null, status: 'active',
      })

      await service.update(11, { email: 'alice@example.com' }, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled()
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'alice@example.com' }) }),
      )
    })

    it('KHÔNG đổi/ghi email khi PATCH field khác (vd full_name) mà KHÔNG kèm email — casing cũ giữ nguyên', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...mockUserResponse, id: 12, email: 'Bob@example.com', manager_id: null,
      })
      mockPrisma.user.update.mockResolvedValue({
        id: 12, email: 'Bob@example.com', full_name: 'Đổi tên', team_id: null, status: 'active',
      })

      await service.update(12, { full_name: 'Đổi tên' }, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled()
      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: undefined, full_name: 'Đổi tên' }) }),
      )
    })

    it('rbacCache.invalidateUsers("*") được gọi sau update thành công', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null })
      mockPrisma.user.update.mockResolvedValue({
        id: 5, email: 'test@example.vn', full_name: 'X', team_id: 1, status: 'active',
      })

      await service.update(5, { full_name: 'X' }, mkActor(1, { isAdmin: true }))

      const rbacCache = (service as unknown as { rbacCache: { invalidateUsers: jest.Mock } }).rbacCache
      expect(rbacCache.invalidateUsers).toHaveBeenCalledWith('*')
    })
  })

  describe('update — manager cycle detection', () => {
    it('should throw BadRequest when setting C as manager of A creates A->B->C->A cycle', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 1, email: 'a@example.net' })
      // assertManagerActive(3)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ status: 'active', deleted_at: null })
      // assertNoManagerCycle DFS: cursor=3 → parent.manager_id=2
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: 2 })
      // cursor=2 → parent.manager_id=1 (self) → throw
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: 1 })

      await expect(
        service.update(1, { manager_id: 3 }, mkActor(99, { isAdmin: true })),
      ).rejects.toThrow(BadRequestException)
    })

    it('should pass cycle check when chain terminates cleanly', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 1, email: 'a@example.net', team_id: 5 })
      mockPrisma.user.findUnique.mockResolvedValueOnce({ status: 'active', deleted_at: null })
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: null })
      mockPrisma.user.update.mockResolvedValue({
        id: 1, email: 'a@example.net', full_name: 'A', phone: null, team_id: 5, manager_id: 2, status: 'active',
      })

      const result = await service.update(1, { manager_id: 2 }, mkActor(99, { isAdmin: true }))
      expect(result.manager_id).toBe(2)
    })
  })

  describe('delete', () => {
    it('tự khoá chính mình → 403', async () => {
      await expect(service.delete(1, undefined, mkActor(1))).rejects.toThrow(ForbiddenException)
    })

    it('target ngoài scope users.manage → 404', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(
        service.delete(5, undefined, mkActor(1, { grants: { 'users.manage': 'own' } })),
      ).rejects.toThrow(NotFoundException)
    })

    it('should soft delete and blacklist user (no managed_users)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.user.count.mockResolvedValue(0)
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.delete(5, undefined, mkActor(1, { isAdmin: true }))

      expect(result.message).toBe('Đã khoá tài khoản')
      expect(result.reassigned).toBe(0)
      expect(tokenBlacklist.isBlacklisted(5)).toBe(true)
      expect(mockPrisma.user.updateMany).not.toHaveBeenCalled()
    })

    it('khoá Quản trị CUỐI CÙNG → 409, không update', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 5 })
      mockPrisma.user.count.mockResolvedValueOnce(0)

      await expect(service.delete(5, undefined, mkActor(1, { isAdmin: true }))).rejects.toThrow(
        ConflictException,
      )
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('PATCH status=locked lên Quản trị CUỐI CÙNG → 409, không update', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, manager_id: null, status: 'active' })
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 5 })
      mockPrisma.user.count.mockResolvedValueOnce(0)

      await expect(
        service.update(5, { status: 'locked' }, mkActor(99, { isAdmin: true })),
      ).rejects.toThrow(ConflictException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('should throw 404 when not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(service.delete(999, undefined, mkActor(1, { isAdmin: true }))).rejects.toThrow(
        NotFoundException,
      )
    })

    it('should cascade reassign managed_users to reassign_to', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUserResponse)
      mockPrisma.user.count.mockResolvedValueOnce(3)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 77, status: 'active', deleted_at: null, manager_id: null })
      mockPrisma.user.updateMany.mockResolvedValue({ count: 3 })
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.delete(5, 77, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { manager_id: 5, id: { not: 77 } },
        data: { manager_id: 77 },
      })
      expect(result.reassigned).toBe(3)
      expect(result.reassigned_to).toBe(77)
    })

    it('reassign_to là cấp dưới của user bị khoá: không tự quản lý chính mình, được nâng lên cấp trên', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUserResponse)
      mockPrisma.user.count.mockResolvedValueOnce(2)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 77, status: 'active', deleted_at: null, manager_id: 5 })
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: 9 })
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 })
      mockPrisma.user.update.mockResolvedValue({})

      await service.delete(5, 77, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { manager_id: 9 } })
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { manager_id: 5, id: { not: 77 } },
        data: { manager_id: 77 },
      })
    })

    it('reassign_to là cháu (cấp dưới gián tiếp) của user bị khoá: nâng lên cấp trên, không tạo vòng', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUserResponse)
      mockPrisma.user.count.mockResolvedValueOnce(2)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 77, status: 'active', deleted_at: null, manager_id: 60 })
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: 5 }) // 60 -> 5 (user bị khoá)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ manager_id: 9 }) // cấp trên của user bị khoá
      mockPrisma.user.updateMany.mockResolvedValue({ count: 1 })
      mockPrisma.user.update.mockResolvedValue({})

      await service.delete(5, 77, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 77 }, data: { manager_id: 9 } })
    })

    it('should orphan managed_users (null) when reassign_to missing', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUserResponse)
      mockPrisma.user.count.mockResolvedValueOnce(2)
      mockPrisma.user.updateMany.mockResolvedValue({ count: 2 })
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.delete(5, undefined, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { manager_id: 5 },
        data: { manager_id: null },
      })
      expect(result.reassigned).toBe(2)
      expect(result.reassigned_to).toBeNull()
    })

    it('should reject reassign_to === self (target đang bị khoá)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUserResponse)
      mockPrisma.user.count.mockResolvedValueOnce(1)

      await expect(service.delete(5, 5, mkActor(1, { isAdmin: true }))).rejects.toThrow(
        BadRequestException,
      )
    })

    it('should reject reassign_to that is not active', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(mockUserResponse)
      mockPrisma.user.count.mockResolvedValueOnce(1)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 77, status: 'locked', deleted_at: null })

      await expect(service.delete(5, 77, mkActor(1, { isAdmin: true }))).rejects.toThrow(
        BadRequestException,
      )
    })

    it('khoá qua delete KHÔNG ghi đè email, thu hồi token cũ', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.user.count.mockResolvedValue(0)
      mockPrisma.user.update.mockResolvedValue({})

      await service.delete(5, undefined, mkActor(1, { isAdmin: true }))

      const data = mockPrisma.user.update.mock.calls[0][0].data
      expect(data).toMatchObject({ status: 'locked', tokens_valid_after: expect.any(Date) })
      expect(data.email).toBeUndefined()
    })
  })

  describe('resetPassword', () => {
    it('tự reset mật khẩu của chính mình → 403', async () => {
      await expect(
        service.resetPassword(1, 'ValidPass123', mkActor(1)),
      ).rejects.toThrow(ForbiddenException)
    })

    it('target ngoài scope users.manage → 404', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(
        service.resetPassword(5, 'ValidPass123', mkActor(1, { grants: { 'users.manage': 'own' } })),
      ).rejects.toThrow(NotFoundException)
    })

    it('target có quyền cao hơn actor → 403 (escalation THẮNG trước check password)', async () => {
      mockPermissionService.grantsFor.mockResolvedValue({ grants: { 'roles.manage': true }, isAdmin: false })

      await expect(
        service.resetPassword(5, undefined, mkActor(1, { grants: { 'users.manage': 'all' } })),
      ).rejects.toThrow(ForbiddenException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('thiếu password (undefined) → BadRequestException, KHÔNG update/audit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)

      await expect(
        service.resetPassword(5, undefined, mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(BadRequestException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
      expect(auditLog.logPasswordChange).not.toHaveBeenCalled()
    })

    it('password chuỗi rỗng/toàn khoảng trắng → BadRequestException', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)

      await expect(
        service.resetPassword(5, '   ', mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(BadRequestException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('reset thành công → KHÔNG trả password/hash trong response', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.resetPassword(5, 'ValidPass123', mkActor(99, { isAdmin: true }))

      expect(result).toEqual({ message: 'Đã reset mật khẩu thành công' })
      expect(result).not.toHaveProperty('password')
      expect(result).not.toHaveProperty('password_hash')
    })

    it('admin reset thu hồi MỌI refresh token cũ (tokens_valid_after = now)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.user.update.mockResolvedValue({})

      await service.resetPassword(5, 'ValidPass123', mkActor(99, { isAdmin: true }))

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: expect.objectContaining({ password_updated_at: expect.any(Date), tokens_valid_after: expect.any(Date) }),
      })
    })

    it('ghi audit_logs (DB) qua AuditLogService.logPasswordChange, method=admin_reset', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.user.update.mockResolvedValue({})

      await service.resetPassword(5, 'ValidPass123', mkActor(99, { isAdmin: true }))

      expect(auditLog.logPasswordChange).toHaveBeenCalledWith({
        actorUserId: 99,
        targetUserId: 5,
        method: 'admin_reset',
      })
    })

    it('throw 404 khi user không tồn tại', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(
        service.resetPassword(999, 'ValidPass123', mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(NotFoundException)
    })
  })

  describe('getPasswordHistory', () => {
    it('ngoài scope users.manage → 404', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(
        service.getPasswordHistory(255, mkActor(1, { grants: { 'users.manage': 'own' } })),
      ).rejects.toThrow(NotFoundException)
      expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled()
    })

    it('trả danh sách audit password_change đã resolve tên/email actor, KHÔNG lộ mật khẩu', async () => {
      const created = new Date('2026-08-04T14:07:06.791Z')
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { id: 10, user_id: 3, metadata: { method: 'admin_reset' }, ip_address: '10.0.0.1', created_at: created },
      ])
      mockPrisma.user.findMany.mockResolvedValue([{ id: 3, email: 'admin@trinity.local', full_name: 'Quản trị' }])

      const result = await service.getPasswordHistory(255, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { action: 'password_change', resource: 'users', resource_id: 255 },
        }),
      )
      expect(result).toEqual([
        {
          id: 10,
          created_at: created,
          method: 'admin_reset',
          actor_id: 3,
          actor_email: 'admin@trinity.local',
          actor_full_name: 'Quản trị',
          ip_address: '10.0.0.1',
        },
      ])
      expect(JSON.stringify(result)).not.toMatch(/hash|\$2[aby]\$/)
    })

    it('rỗng khi không có log nào', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([])

      const result = await service.getPasswordHistory(999, mkActor(1, { isAdmin: true }))

      expect(result).toEqual([])
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled()
    })
  })

  describe('softDeletePermanent', () => {
    it('reject self-delete (ForbiddenException) trước khi vào assertCanManageUser/tx', async () => {
      await expect(service.softDeletePermanent(42, null, mkActor(42))).rejects.toThrow(
        ForbiddenException,
      )
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    })

    it('target ngoài scope users.manage → 404', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(
        service.softDeletePermanent(5, null, mkActor(1, { grants: { 'users.manage': 'own' } })),
      ).rejects.toThrow(NotFoundException)
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    })

    it('set deleted_at + status=locked, blacklist token, không có managed_users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, deleted_at: null })
      mockPrisma.user.count.mockResolvedValue(0)
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.softDeletePermanent(5, null, mkActor(1, { isAdmin: true }))

      expect(result.message).toBe('Đã xoá vĩnh viễn tài khoản')
      expect(result.reassigned).toBe(0)
      expect(tokenBlacklist.isBlacklisted(5)).toBe(true)
      expect(mockPrisma.$transaction).toHaveBeenCalled()
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: expect.objectContaining({ status: 'locked', deleted_at: expect.any(Date), tokens_valid_after: expect.any(Date) }),
      })
      // Chỉ xoá VĨNH VIỄN mới giải phóng email (khoá thì không).
      expect(mockPrisma.user.update.mock.calls[0][0].data.email).toMatch(/^deleted_5_\d+@removed\.invalid$/)
    })

    it('throw 404 khi user không tồn tại', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(
        service.softDeletePermanent(999, null, mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(NotFoundException)
    })

    it('throw 404 khi user đã bị xoá vĩnh viễn rồi (deleted_at != null)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUserResponse, deleted_at: new Date() })

      await expect(
        service.softDeletePermanent(5, null, mkActor(1, { isAdmin: true })),
      ).rejects.toThrow(NotFoundException)
    })

    it('cascade reassign managed_users sang reassign_to khi có subordinates', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ ...mockUserResponse, deleted_at: null })
      mockPrisma.user.count.mockResolvedValueOnce(2)
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 88, status: 'active', deleted_at: null })
      mockPrisma.user.updateMany.mockResolvedValue({ count: 2 })
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.softDeletePermanent(5, 88, mkActor(1, { isAdmin: true }))

      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { manager_id: 5, id: { not: 88 } },
        data: { manager_id: 88 },
      })
      expect(result.reassigned).toBe(2)
      expect(result.reassigned_to).toBe(88)
    })

    it('reject xoá Quản trị (is_system) CUỐI CÙNG (409 ConflictException)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        ...mockUserResponse,
        id: 5,
        deleted_at: null,
        user_roles: [{ role: { id: 1, name: 'Quản trị', is_system: true } }],
      })
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 5 })
      mockPrisma.user.count.mockResolvedValueOnce(0)

      await expect(
        service.softDeletePermanent(5, null, mkActor(99, { isAdmin: true })),
      ).rejects.toThrow(ConflictException)
      expect(mockPrisma.user.update).not.toHaveBeenCalled()
    })

    it('cho phép xoá Quản trị khi vẫn còn Quản trị khác đang hoạt động', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        ...mockUserResponse,
        id: 5,
        deleted_at: null,
        user_roles: [{ role: { id: 1, name: 'Quản trị', is_system: true } }],
      })
      mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 5 })
      mockPrisma.user.count.mockResolvedValueOnce(2)
      mockPrisma.user.count.mockResolvedValueOnce(0)
      mockPrisma.user.update.mockResolvedValue({})

      const result = await service.softDeletePermanent(5, null, mkActor(99, { isAdmin: true }))

      expect(result.message).toBe('Đã xoá vĩnh viễn tài khoản')
    })

    it('rollback khi user.update fail trong transaction (atomic)', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ ...mockUserResponse, deleted_at: null })
      mockPrisma.user.count.mockResolvedValueOnce(0)
      mockPrisma.user.update.mockRejectedValueOnce(new Error('PG conflict'))

      await expect(service.softDeletePermanent(5, null, mkActor(1, { isAdmin: true }))).rejects.toThrow(
        'PG conflict',
      )
      expect(tokenBlacklist.isBlacklisted(5)).toBe(false)
    })
  })

  describe('assignTeam', () => {
    it('ngoài scope users.manage → 404', async () => {
      mockScope.ownerIds.mockResolvedValue([999])

      await expect(
        service.assignTeam(5, 2, mkActor(1, { grants: { 'users.manage': 'own' } })),
      ).rejects.toThrow(NotFoundException)
    })

    it('should assign team and blacklist user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.team.findUnique.mockResolvedValue({ id: 2, name: 'Team B' })
      mockPrisma.user.update.mockResolvedValue({
        id: 5, email: 'test@example.vn', full_name: 'Test User', team_id: 2,
      })

      const result = await service.assignTeam(5, 2, mkActor(1, { isAdmin: true }))

      expect(result.team_id).toBe(2)
      expect(tokenBlacklist.isBlacklisted(5)).toBe(true)
    })

    it('should throw 404 when team not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUserResponse)
      mockPrisma.team.findUnique.mockResolvedValue(null)

      await expect(service.assignTeam(5, 999, mkActor(1, { isAdmin: true }))).rejects.toThrow(
        NotFoundException,
      )
    })
  })
})
