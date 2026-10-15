import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException, ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '@trinity/prisma'
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest'
import { SalaryComponentsService } from '../salary-components.service'
import { SalaryComponentsController } from '../salary-components.controller'

function grantedPerms(handler: (...args: never[]) => unknown): string[] {
  const meta = Reflect.getMetadata(RBAC_META, handler) as AccessMeta | undefined
  return meta?.kind === 'can' ? meta.permissions : []
}

const mockPrisma = {
  salaryComponent: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}

describe('SalaryComponentsService', () => {
  let service: SalaryComponentsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalaryComponentsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()
    service = module.get(SalaryComponentsService)
    jest.clearAllMocks()
  })

  describe('create — chuẩn hoá calc fields', () => {
    it('fixed → set fixed_amount (BigInt), percent_value = null', async () => {
      mockPrisma.salaryComponent.create.mockResolvedValue({ id: 1 })
      await service.create({
        name: 'Phụ cấp điện thoại', code: 'allowance_phone',
        component_type: 'allowance', calc_method: 'fixed',
        fixed_amount: 300000, effective_from: '2026-07',
      })
      const data = mockPrisma.salaryComponent.create.mock.calls[0][0].data
      expect(data.fixed_amount).toBe(BigInt(300000))
      expect(data.percent_value).toBeNull()
      expect(data.applies_to).toBe('all')
    })

    it('percent_base → set percent_value, fixed_amount = null', async () => {
      mockPrisma.salaryComponent.create.mockResolvedValue({ id: 2 })
      await service.create({
        name: 'BHXH', code: 'deduction_bhxh',
        component_type: 'deduction', calc_method: 'percent_base',
        percent_value: 8, effective_from: '2026-07',
      })
      const data = mockPrisma.salaryComponent.create.mock.calls[0][0].data
      expect(data.percent_value).toBe(8)
      expect(data.fixed_amount).toBeNull()
    })

    it('is_taxable: mặc định true, nhận false (khoản miễn thuế)', async () => {
      mockPrisma.salaryComponent.create.mockResolvedValue({ id: 3 })
      const base = { name: 'Ăn trưa', code: 'allowance_lunch', component_type: 'allowance' as const, fixed_amount: 1, effective_from: '2026-07' }
      await service.create(base)
      expect(mockPrisma.salaryComponent.create.mock.calls[0][0].data.is_taxable).toBe(true)
      await service.create({ ...base, is_taxable: false })
      expect(mockPrisma.salaryComponent.create.mock.calls[1][0].data.is_taxable).toBe(false)
    })

    it('P2002 → ConflictException (mã trùng)', async () => {
      mockPrisma.salaryComponent.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6' }),
      )
      await expect(
        service.create({
          name: 'X', code: 'dup_code', component_type: 'bonus',
          calc_method: 'fixed', fixed_amount: 1, effective_from: '2026-07',
        }),
      ).rejects.toBeInstanceOf(ConflictException)
    })
  })

  describe('update', () => {
    it('throw NotFound khi id không tồn tại', async () => {
      mockPrisma.salaryComponent.findUnique.mockResolvedValue(null)
      await expect(service.update(99, { name: 'X' })).rejects.toBeInstanceOf(NotFoundException)
    })

    it('đổi sang percent_base → clear fixed_amount', async () => {
      mockPrisma.salaryComponent.findUnique.mockResolvedValue({ id: 1, calc_method: 'fixed' })
      mockPrisma.salaryComponent.update.mockResolvedValue({ id: 1 })
      await service.update(1, { calc_method: 'percent_base', percent_value: 1.5 })
      const data = mockPrisma.salaryComponent.update.mock.calls[0][0].data
      expect(data.calc_method).toBe('percent_base')
      expect(data.percent_value).toBe(1.5)
      expect(data.fixed_amount).toBeNull()
    })

    it('PATCH chỉ percent_value (không gửi calc_method) trên record fixed → method hiệu lực = fixed, clear percent_value (chống inconsistent)', async () => {
      mockPrisma.salaryComponent.findUnique.mockResolvedValue({ id: 1, calc_method: 'fixed' })
      mockPrisma.salaryComponent.update.mockResolvedValue({ id: 1 })
      await service.update(1, { percent_value: 5 })
      const data = mockPrisma.salaryComponent.update.mock.calls[0][0].data
      expect(data.calc_method).toBe('fixed') // giữ method hiện tại
      expect(data.percent_value).toBeNull() // field đối lập LUÔN bị clear
      expect(data.fixed_amount).toBeUndefined() // không gửi → không đụng
    })
  })

  describe('remove', () => {
    it('throw NotFound khi id không tồn tại', async () => {
      mockPrisma.salaryComponent.findUnique.mockResolvedValue(null)
      await expect(service.remove(99)).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})

describe('SalaryComponentsController — RBAC (quyền + phạm vi)', () => {
  it('GET = payroll.manage', () => {
    expect(grantedPerms(SalaryComponentsController.prototype.findAll)).toEqual(['payroll.manage'])
  })

  it('POST = payroll.manage', () => {
    expect(grantedPerms(SalaryComponentsController.prototype.create)).toEqual(['payroll.manage'])
  })

  it('PATCH = payroll.manage', () => {
    expect(grantedPerms(SalaryComponentsController.prototype.update)).toEqual(['payroll.manage'])
  })

  it('DELETE = payroll.manage', () => {
    expect(grantedPerms(SalaryComponentsController.prototype.remove)).toEqual(['payroll.manage'])
  })
})
