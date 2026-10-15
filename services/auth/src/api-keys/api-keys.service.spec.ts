import { Test, TestingModule } from '@nestjs/testing'
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { PermissionService } from '@trinity/rbac-nest'
import { ApiKeysService } from './api-keys.service'

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
  },
  apiKey: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
}

const mockPermissionService = {
  grantsFor: jest.fn(),
}

describe('ApiKeysService', () => {
  let service: ApiKeysService

  beforeEach(async () => {
    jest.clearAllMocks()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PermissionService, useValue: mockPermissionService },
      ],
    }).compile()

    service = module.get<ApiKeysService>(ApiKeysService)
  })

  describe('create — owner cần quyền contacts.create (RBAC quyền + phạm vi)', () => {
    const baseDto = {
      name: 'Test key',
      scopes: ['auth:login' as const],
      owner_user_id: 42,
    }

    it('cho phép user có quyền contacts.create làm owner', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 42, status: 'active' })
      mockPermissionService.grantsFor.mockResolvedValue({
        grants: { 'contacts.create': true },
        isAdmin: false,
      })
      mockPrisma.apiKey.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 1, ...data, created_at: new Date(), updated_at: new Date() }),
      )

      const result = await service.create(baseDto, 1)
      expect(result.plain_key).toMatch(/^trinity_live_/)
      expect(mockPrisma.apiKey.create).toHaveBeenCalled()
    })

    it('REJECT Quản trị (isAdmin) làm owner — JWT mint mang nguyên quyền owner, không giới hạn thêm', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 42, status: 'active' })
      mockPermissionService.grantsFor.mockResolvedValue({ grants: {}, isAdmin: true })

      await expect(service.create(baseDto, 1)).rejects.toThrow(BadRequestException)
      expect(mockPrisma.apiKey.create).not.toHaveBeenCalled()
    })

    it('REJECT user không active', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 42, status: 'locked' })

      await expect(service.create(baseDto, 1)).rejects.toThrow(BadRequestException)
      expect(mockPermissionService.grantsFor).not.toHaveBeenCalled()
    })

    it('REJECT user không tồn tại', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      await expect(service.create(baseDto, 1)).rejects.toThrow(BadRequestException)
    })

    it('phạm vi deals:create / tasks:create đòi deals.manage / kanban.manage', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 42, status: 'active' })
      mockPermissionService.grantsFor.mockResolvedValue({ grants: { 'contacts.create': true, 'deals.manage': true }, isAdmin: false })
      mockPrisma.apiKey.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 1, ...data, created_at: new Date(), updated_at: new Date() }),
      )
      await expect(service.create({ ...baseDto, scopes: ['deals:create'] }, 1)).resolves.toMatchObject({ plain_key: expect.stringMatching(/^trinity_live_/) })
      await expect(service.create({ ...baseDto, scopes: ['deals:create', 'tasks:create'] }, 1)).rejects.toThrow(/kanban\.manage/)
    })

    it('REJECT user không có quyền contacts.create', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 42, status: 'active' })
      mockPermissionService.grantsFor.mockResolvedValue({ grants: {}, isAdmin: false })

      await expect(service.create(baseDto, 1)).rejects.toThrow(BadRequestException)
    })
  })

  describe('validate — API key xác thực', () => {
    const validRecord = {
      id: 10,
      name: 'Partner A',
      scopes: ['auth:login', 'contacts:create'],
      owner_user_id: 42,
      revoked_at: null,
      expires_at: null,
    }

    it('trả ValidatedApiKey khi key hợp lệ + đúng scope', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(validRecord)
      mockPrisma.apiKey.update.mockResolvedValue(validRecord)

      const result = await service.validate('trinity_live_abc', 'auth:login', '1.2.3.4')
      expect(result.id).toBe(10)
      expect(result.owner_user_id).toBe(42)
    })

    it('throw Unauthorized khi thiếu key', async () => {
      await expect(service.validate('', 'auth:login', null)).rejects.toThrow(
        UnauthorizedException,
      )
    })

    it('throw Unauthorized khi key không tồn tại', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null)
      await expect(
        service.validate('trinity_live_xxx', 'auth:login', null),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('throw Unauthorized khi key đã revoked', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        ...validRecord,
        revoked_at: new Date(),
      })
      await expect(
        service.validate('trinity_live_xxx', 'auth:login', null),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('throw Unauthorized khi key đã expired', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        ...validRecord,
        expires_at: new Date(Date.now() - 1000),
      })
      await expect(
        service.validate('trinity_live_xxx', 'auth:login', null),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('throw Unauthorized khi thiếu scope yêu cầu', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        ...validRecord,
        scopes: ['auth:login'],
      })
      await expect(
        service.validate('trinity_live_xxx', 'contacts:create', null),
      ).rejects.toThrow(UnauthorizedException)
    })

    it('KHÔNG lưu plain_key — chỉ hash', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(validRecord)
      mockPrisma.apiKey.update.mockResolvedValue(validRecord)

      await service.validate('trinity_live_plain_text', 'auth:login', null)
      const call = mockPrisma.apiKey.findUnique.mock.calls[0][0]
      expect(call.where.key_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(call.where.key_hash).not.toContain('plain_text')
    })
  })

  describe('revoke — idempotent', () => {
    it('đã revoke trước đó → trả message "Đã revoke trước đó"', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 10,
        revoked_at: new Date(),
      })
      const result = await service.revoke(10, 1)
      expect(result.message).toContain('thu hồi trước đó')
      expect(mockPrisma.apiKey.update).not.toHaveBeenCalled()
    })
  })
})
