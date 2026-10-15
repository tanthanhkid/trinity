import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { LoginWifiCheckTargetsService } from './login-wifi-check-targets.service'

const mockPrisma = {
  user: {
    findMany: jest.fn(),
  },
  loginWifiCheckTarget: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  $transaction: jest.fn(),
}

describe('LoginWifiCheckTargetsService', () => {
  let service: LoginWifiCheckTargetsService

  beforeEach(async () => {
    jest.clearAllMocks()
    // $transaction(fn) trong service này CHỈ gọi fn(tx) — dùng chung mockPrisma
    // làm `tx` vì test không cần transaction thật.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) =>
      fn(mockPrisma),
    )

    const module: TestingModule = await Test.createTestingModule({
      providers: [LoginWifiCheckTargetsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile()

    service = module.get<LoginWifiCheckTargetsService>(LoginWifiCheckTargetsService)
  })

  describe('list', () => {
    it('bảng rỗng → [] (KHÔNG gọi user.findMany — bail sớm)', async () => {
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([])
      const result = await service.list()
      expect(result).toEqual([])
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled()
    })

    it('enrich đúng tên/email + target_active theo trạng thái user thật', async () => {
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { id: 1, scope_type: 'user', target_user_id: 5 },
        { id: 2, scope_type: 'team', target_user_id: 6 },
      ])
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 5, full_name: 'Nguyễn Văn A', email: 'a@example.vn', deleted_at: null, status: 'active' },
        { id: 6, full_name: 'Trần Thị B', email: 'b@example.vn', deleted_at: new Date(), status: 'locked' },
      ])

      const result = await service.list()
      expect(result[0]).toMatchObject({ target_name: 'Nguyễn Văn A', target_active: true })
      expect(result[1]).toMatchObject({ target_name: 'Trần Thị B', target_active: false })
    })

    it('target_user_id trỏ vào id đã KHÔNG còn tồn tại → target_active=false, KHÔNG throw', async () => {
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([
        { id: 1, scope_type: 'user', target_user_id: 999 },
      ])
      mockPrisma.user.findMany.mockResolvedValue([])

      const result = await service.list()
      expect(result[0]).toMatchObject({ target_name: null, target_active: false })
    })
  })

  describe('replaceAll', () => {
    it('items rỗng → xoá sạch bảng, KHÔNG gọi createMany', async () => {
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([])
      const result = await service.replaceAll([], 1)
      expect(mockPrisma.loginWifiCheckTarget.deleteMany).toHaveBeenCalledWith({})
      expect(mockPrisma.loginWifiCheckTarget.createMany).not.toHaveBeenCalled()
      expect(result).toEqual([])
    })

    it('dedupe 2 dòng trùng scope_type+target_user_id trước khi validate/ghi', async () => {
      mockPrisma.user.findMany.mockResolvedValue([{ id: 10 }])
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([])

      await service.replaceAll(
        [
          { scope_type: 'user', target_user_id: 10 },
          { scope_type: 'user', target_user_id: 10 },
        ],
        1,
      )

      expect(mockPrisma.loginWifiCheckTarget.createMany).toHaveBeenCalledWith({
        data: [{ scope_type: 'user', target_user_id: 10, created_by: 1 }],
      })
    })

    it('department trỏ vào user KHÔNG quản lý cấp trung gian → BadRequestException, KHÔNG ghi gì', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]) // không khớp cấu trúc managed_users 2 cấp

      await expect(
        service.replaceAll([{ scope_type: 'department', target_user_id: 10 }], 1),
      ).rejects.toThrow(BadRequestException)
      expect(mockPrisma.loginWifiCheckTarget.deleteMany).not.toHaveBeenCalled()
    })

    it('team trỏ vào user KHÔNG đang quản lý ai → BadRequestException', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])

      await expect(
        service.replaceAll([{ scope_type: 'team', target_user_id: 20 }], 1),
      ).rejects.toThrow(BadRequestException)
    })

    it('user trỏ vào id đã xoá/khoá → BadRequestException', async () => {
      mockPrisma.user.findMany.mockResolvedValue([])

      await expect(
        service.replaceAll([{ scope_type: 'user', target_user_id: 30 }], 1),
      ).rejects.toThrow(BadRequestException)
    })

    it('validate ĐỦ hợp lệ (department + team + user) → ghi đủ, đúng created_by', async () => {
      mockPrisma.user.findMany
        .mockResolvedValueOnce([{ id: 60 }]) // department valid check
        .mockResolvedValueOnce([{ id: 20 }]) // team valid check
        .mockResolvedValueOnce([{ id: 30 }]) // user valid check
      mockPrisma.loginWifiCheckTarget.findMany.mockResolvedValue([])

      await service.replaceAll(
        [
          { scope_type: 'department', target_user_id: 60 },
          { scope_type: 'team', target_user_id: 20 },
          { scope_type: 'user', target_user_id: 30 },
        ],
        7,
      )

      expect(mockPrisma.loginWifiCheckTarget.createMany).toHaveBeenCalledWith({
        data: [
          { scope_type: 'department', target_user_id: 60, created_by: 7 },
          { scope_type: 'team', target_user_id: 20, created_by: 7 },
          { scope_type: 'user', target_user_id: 30, created_by: 7 },
        ],
      })
    })
  })

  describe('getRoster', () => {
    it('trả full_name/email/roles[]/manager_id, loại user đã xoá', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 1,
          full_name: 'A',
          email: 'a@x.vn',
          manager_id: null,
          user_roles: [{ role: { name: 'Quản lý nhóm' } }],
        },
      ])

      const result = await service.getRoster()
      expect(result).toEqual([
        { id: 1, full_name: 'A', email: 'a@x.vn', roles: ['Quản lý nhóm'], manager_id: null },
      ])
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deleted_at: null } }),
      )
    })
  })
})
