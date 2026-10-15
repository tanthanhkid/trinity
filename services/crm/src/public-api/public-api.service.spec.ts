import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { PublicApiService } from './public-api.service'

const mockPrisma = {
  user: { findUnique: jest.fn() },
  project: { findUnique: jest.fn() },
  settingOption: { findUnique: jest.fn() },
  pipelineStage: { findUnique: jest.fn() },
  contact: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  activity: { create: jest.fn() },
  integrationEvent: { create: jest.fn() },
  $transaction: jest.fn(),
}

const validKey = {
  id: 10,
  name: 'Partner A',
  scopes: ['contacts:create'],
  owner_user_id: 42,
}

describe('PublicApiService', () => {
  let service: PublicApiService

  beforeEach(async () => {
    jest.clearAllMocks()
    // createContact ghi khách + outbox trong 1 $transaction — tx dùng chung mock với prisma.
    mockPrisma.$transaction.mockImplementation((fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicApiService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()

    service = module.get<PublicApiService>(PublicApiService)
  })

  describe('createContact', () => {
    const baseDto = {
      phone: '0901234567',
      full_name: 'Nguyen Van A',
      source_id: 1,
    }

    beforeEach(() => {
      mockPrisma.settingOption.findUnique.mockResolvedValue({
        id: 1,
        group_key: 'contact_source',
        is_active: true,
      })
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 42,
        status: 'active',
        team_id: 3,
      })
    })

    it('dùng findFirst (không COUNT) để check duplicate', async () => {
      mockPrisma.contact.findFirst.mockResolvedValue(null)
      mockPrisma.contact.create.mockResolvedValue({
        id: 100,
        phone: baseDto.phone,
        full_name: baseDto.full_name,
        source_id: 1,
        assigned_to: 42,
        created_at: new Date(),
      })

      const result = await service.createContact(baseDto as never, validKey)
      expect(result.warning).toBeNull()
      expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith({
        where: { phone: { in: expect.arrayContaining([baseDto.phone]) }, deleted_at: null, assigned_to: 42 },
        select: { id: true },
      })
      expect(mockPrisma.contact.count).not.toHaveBeenCalled()
    })

    it('SĐT dạng +84 được chuẩn hoá về 0… khi kiểm trùng', async () => {
      mockPrisma.contact.findFirst.mockResolvedValue(null)
      mockPrisma.contact.create.mockResolvedValue({
        id: 101, phone: '0900000001', full_name: baseDto.full_name, source_id: 1, assigned_to: 42, created_at: new Date(),
      })
      await service.createContact({ ...baseDto, phone: '+84900000001' } as never, validKey)
      expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith({
        where: { phone: { in: ['0900000001', '84900000001', '+84900000001'] }, deleted_at: null, assigned_to: 42 },
        select: { id: true },
      })
    })

    it('tạo contact mới khi SDT trùng với contact đã soft-delete', async () => {
      // contact.findFirst với deleted_at:null trả null (contact bị xoá mềm bị bỏ qua)
      mockPrisma.contact.findFirst.mockResolvedValue(null)
      mockPrisma.contact.create.mockResolvedValue({
        id: 102,
        phone: baseDto.phone,
        full_name: baseDto.full_name,
        source_id: 1,
        assigned_to: 42,
        created_at: new Date(),
      })

      const result = await service.createContact(baseDto as never, validKey)
      expect(result.contact.id).toBe(102)
      expect(result.warning).toBeNull()
      // Đảm bảo query có filter deleted_at:null
      expect(mockPrisma.contact.create).toHaveBeenCalledTimes(1)
    })

    it('trả warning khi SĐT đã tồn tại', async () => {
      mockPrisma.contact.findFirst.mockResolvedValue({ id: 99 })
      mockPrisma.contact.create.mockResolvedValue({
        id: 101,
        phone: baseDto.phone,
        full_name: baseDto.full_name,
        source_id: 1,
        assigned_to: 42,
        created_at: new Date(),
      })

      const result = await service.createContact(baseDto as never, validKey)
      expect(result.warning).toContain('đã tồn tại')
    })

    it(' ghi outbox contact.created TRONG cùng transaction; response không lộ trường snapshot', async () => {
      mockPrisma.contact.findFirst.mockResolvedValue(null)
      mockPrisma.contact.create.mockResolvedValue({
        id: 103,
        phone: baseDto.phone,
        full_name: baseDto.full_name,
        source_id: 1,
        assigned_to: 42,
        created_at: new Date(),
        email: 'a@b.vn',
        team_id: 3,
        created_by_id: null,
      })

      const result = await service.createContact(baseDto as never, validKey)
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
      const arg = mockPrisma.integrationEvent.create.mock.calls[0][0]
      expect(arg.data).toMatchObject({ event_type: 'contact.created', resource: 'contact', resource_id: '103' })
      expect(arg.data.payload).toMatchObject({ origin: 'public_api', contact: { id: 103, assigned_to: 42 } })
      expect(Object.keys(result.contact).sort()).toEqual(
        ['assigned_to', 'created_at', 'full_name', 'id', 'phone', 'source_id'],
      )
    })

    it(' lỗi ghi outbox → createContact lỗi (cùng transaction, không nuốt)', async () => {
      mockPrisma.contact.findFirst.mockResolvedValue(null)
      mockPrisma.contact.create.mockResolvedValue({ id: 104, phone: baseDto.phone, assigned_to: 42 })
      mockPrisma.integrationEvent.create.mockRejectedValue(new Error('outbox down'))
      await expect(service.createContact(baseDto as never, validKey)).rejects.toThrow('outbox down')
    })

    it('REJECT khi source_id không thuộc group contact_source', async () => {
      mockPrisma.settingOption.findUnique.mockResolvedValue({
        id: 1,
        group_key: 'other_group',
        is_active: true,
      })
      await expect(service.createContact(baseDto as never, validKey)).rejects.toThrow(
        BadRequestException,
      )
    })

    it('REJECT khi owner user bị khoá', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 42,
        status: 'locked',
        team_id: 3,
      })
      await expect(service.createContact(baseDto as never, validKey)).rejects.toThrow(
        BadRequestException,
      )
    })
  })
})
