import { BadRequestException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { InsuranceSettingsService } from '../insurance-settings.service'

function build(others: Array<{ effective_from: string; effective_to: string | null }> = []) {
  const prisma = {
    insuranceSetting: {
      findMany: jest.fn().mockResolvedValue(others),
      findUnique: jest.fn().mockResolvedValue({ id: 1, code: 'bhxh', effective_from: '2024-07', effective_to: null, is_active: true }),
      create: jest.fn().mockResolvedValue({ id: 2 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    },
  }
  return { prisma, service: new InsuranceSettingsService(prisma as unknown as PrismaService) }
}

const dto = { name: 'BHXH', code: 'bhxh', employee_rate: 8, effective_from: '2025-01' }

describe('InsuranceSettingsService — kỳ hiệu lực', () => {
  it('create: effective_to < effective_from → 400', async () => {
    const { prisma, service } = build()
    await expect(service.create({ ...dto, effective_to: '2024-12' })).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.insuranceSetting.create).not.toHaveBeenCalled()
  })

  it('create: chồng lấn dòng đang áp dụng cùng mã → 400', async () => {
    const { service } = build([{ effective_from: '2024-07', effective_to: null }])
    await expect(service.create(dto)).rejects.toBeInstanceOf(BadRequestException)
  })

  it('create: kỳ liền kề không chồng lấn → ghi', async () => {
    const { prisma, service } = build([{ effective_from: '2024-07', effective_to: '2024-12' }])
    await service.create(dto)
    expect(prisma.insuranceSetting.create).toHaveBeenCalled()
  })

  it('update: loại chính dòng đang sửa khỏi phép kiểm chồng lấn, dòng tắt không kiểm', async () => {
    const { prisma, service } = build()
    await service.update(1, { employee_rate: 9 })
    expect(prisma.insuranceSetting.findMany.mock.calls[0][0].where.id).toEqual({ not: 1 })
    prisma.insuranceSetting.findMany.mockClear()
    await service.update(1, { is_active: false })
    expect(prisma.insuranceSetting.findMany).not.toHaveBeenCalled()
  })
})
