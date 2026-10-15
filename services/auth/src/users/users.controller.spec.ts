import { Test, TestingModule } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { RBAC_META, type AccessMeta, type AuthUser } from '@trinity/rbac-nest'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'
import { UserListExportService } from './user-list-export.service'

/**
 * Controller spec — RBAC quyền + phạm vi. Metadata `@Can(...)`
 * là điểm enforce THẬT (chạy ở `PermissionGuard` toàn cục, packages/rbac-nest)
 * — unit test ở đây chỉ verify metadata đúng + controller forward đúng
 * arg/actor xuống service. Chuỗi guard đầy đủ (403/404 theo scope) được cover
 * ở `apps/monolith/test/rbac/auth-users.e2e-spec.ts` (Postgres thật).
 */
function mkUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return { userId: 1, email: 'a@t', isAdmin: false, grants: {}, ...overrides }
}

function getMeta(handler: (...args: never[]) => unknown): AccessMeta | undefined {
  return new Reflector().get<AccessMeta>(RBAC_META, handler)
}

describe('UsersController', () => {
  let controller: UsersController
  let mockService: {
    softDeletePermanent: jest.Mock
    delete: jest.Mock
    update: jest.Mock
    resetPassword: jest.Mock
    findAll: jest.Mock
    findById: jest.Mock
    create: jest.Mock
    getPasswordHistory: jest.Mock
    assignTeam: jest.Mock
  }
  let mockExportService: { exportToExcel: jest.Mock }

  beforeEach(async () => {
    mockService = {
      softDeletePermanent: jest.fn().mockResolvedValue({
        message: 'Đã xoá vĩnh viễn tài khoản',
        reassigned: 0,
        reassigned_to: null,
      }),
      delete: jest.fn(),
      update: jest.fn(),
      resetPassword: jest.fn(),
      findAll: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 0 }),
      findById: jest.fn(),
      create: jest.fn(),
      getPasswordHistory: jest.fn(),
      assignTeam: jest.fn(),
    }
    mockExportService = {
      exportToExcel: jest.fn().mockResolvedValue(Buffer.from('xlsx')),
    }

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockService },
        { provide: UserListExportService, useValue: mockExportService },
      ],
    }).compile()

    controller = module.get<UsersController>(UsersController)
  })

  describe('metadata @Can — điểm enforce thật ở PermissionGuard toàn cục', () => {
    // Decorator gắn metadata lên PROTOTYPE lúc load module — dùng thẳng
    // prototype (không cần instance từ DI) để bảng test khai báo được ở module
    // scope, trước khi `beforeEach` chạy.
    const proto = UsersController.prototype
    it.each<[string, (...args: never[]) => unknown, string]>([
      ['findAll', proto.findAll, 'users.view'],
      ['exportUsers', proto.exportUsers, 'users.export'],
      ['findById', proto.findById, 'users.view'],
      ['create', proto.create, 'users.manage'],
      ['update', proto.update, 'users.manage'],
      ['delete', proto.delete, 'users.manage'],
      ['permanentDelete', proto.permanentDelete, 'users.manage'],
      ['resetPassword', proto.resetPassword, 'users.manage'],
      ['getPasswordHistory', proto.getPasswordHistory, 'users.manage'],
      ['assignTeam', proto.assignTeam, 'users.manage'],
    ])('%s gắn @Can đúng quyền', (_name, handler, perm) => {
      const meta = getMeta(handler)
      expect(meta).toEqual({ kind: 'can', permissions: [perm], mode: 'all' })
    })
  })

  describe('permanentDelete — forward actor xuống service (self-block nằm ở SERVICE)', () => {
    it('forward dto + actor xuống service', async () => {
      const actor = mkUser({ userId: 1 })
      const result = await controller.permanentDelete(5, { reassign_to: 7 }, actor)

      expect(mockService.softDeletePermanent).toHaveBeenCalledWith(5, 7, actor)
      expect(result.message).toBe('Đã xoá vĩnh viễn tài khoản')
    })

    it('forward reassign_to=undefined (orphan path) khi body không truyền', async () => {
      const actor = mkUser({ userId: 1 })
      await controller.permanentDelete(5, {}, actor)

      expect(mockService.softDeletePermanent).toHaveBeenCalledWith(5, undefined, actor)
    })
  })

  describe('exportUsers — forward filter + actor xuống export service, set header xlsx', () => {
    it('forward params + actor, set Content-Type xlsx', async () => {
      const res = { set: jest.fn(), end: jest.fn() } as unknown as import('express').Response
      const actor = mkUser({ userId: 88 })

      await controller.exportUsers(
        actor,
        res,
        undefined,
        undefined,
        undefined,
        undefined,
        'nguyen',
      )

      expect(mockExportService.exportToExcel).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'nguyen' }),
        actor,
      )
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      )
      expect(res.end).toHaveBeenCalled()
    })
  })

  describe('findAll — cap limit', () => {
    const actor = mkUser({ userId: 77 })

    it('limit=1000 (Settings org-tree) truyền nguyên xuống service (KHÔNG bị cap 200)', async () => {
      await controller.findAll(actor, 1, 1000)
      expect(mockService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000 }),
        actor,
      )
    })

    it('limit vượt 1000 bị clamp về 1000 (chặn abuse)', async () => {
      await controller.findAll(actor, 1, 999999)
      expect(mockService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000 }),
        actor,
      )
    })

    it('limit nhỏ (phân trang thường) giữ nguyên', async () => {
      await controller.findAll(actor, 1, 20)
      expect(mockService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 }),
        actor,
      )
    })
  })
})
