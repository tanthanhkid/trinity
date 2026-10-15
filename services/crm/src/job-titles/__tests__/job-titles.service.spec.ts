import { Test, TestingModule } from '@nestjs/testing'
import { ConflictException, NotFoundException } from '@nestjs/common'
import { JobTitlesService } from '../job-titles.service'
import { PrismaService } from '@trinity/prisma'

const MOCK_ROW = {
  id: 1,
  category: 'Nhân viên',
  rank_code: 'NV',
  name: 'Nhân viên',
  symbol: 'NV',
  base_salary: BigInt(0),
  standard_target: BigInt(0),
  default_insurance_salary: null,
  review_cycle_months: 3,
  is_active: true,
  sort_order: 10,
  created_at: new Date('2026-06-13T00:00:00Z'),
  updated_at: new Date('2026-06-13T00:00:00Z'),
}

const prismaMock = {
  jobTitle: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}

describe('JobTitlesService', () => {
  let service: JobTitlesService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobTitlesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile()

    service = module.get<JobTitlesService>(JobTitlesService)
    jest.clearAllMocks()
  })

  describe('findAll', () => {
    it('trả về danh sách chức danh khi không có filter', async () => {
      prismaMock.jobTitle.findMany.mockResolvedValueOnce([MOCK_ROW])
      const result = await service.findAll({})
      expect(result).toHaveLength(1)
      expect(result[0].rank_code).toBe('NV')
      expect(result[0].base_salary).toBe('0') // BigInt → string
    })

    it('lọc theo category khi truyền vào', async () => {
      prismaMock.jobTitle.findMany.mockResolvedValueOnce([MOCK_ROW])
      await service.findAll({ category: 'Nhân viên' })
      expect(prismaMock.jobTitle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ category: 'Nhân viên' }),
        }),
      )
    })

    it('lọc theo is_active khi truyền vào', async () => {
      prismaMock.jobTitle.findMany.mockResolvedValueOnce([])
      await service.findAll({ is_active: false })
      expect(prismaMock.jobTitle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ is_active: false }),
        }),
      )
    })
  })

  describe('findOne', () => {
    it('trả về chức danh khi tìm thấy', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(MOCK_ROW)
      const result = await service.findOne(1)
      expect(result.id).toBe(1)
    })

    it('ném NotFoundException khi không tìm thấy', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(null)
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException)
    })
  })

  describe('create', () => {
    const createDto = {
      category: 'Nhân viên',
      rank_code: 'NV',
      name: 'Nhân viên',
      symbol: 'NV',
      review_cycle_months: 3,
    }

    it('tạo chức danh thành công khi rank_code chưa tồn tại', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(null)
      prismaMock.jobTitle.create.mockResolvedValueOnce(MOCK_ROW)
      const result = await service.create(createDto)
      expect(result.rank_code).toBe('NV')
    })

    it('ném ConflictException khi rank_code đã tồn tại', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce({ id: 1 })
      await expect(service.create(createDto)).rejects.toThrow(ConflictException)
    })

    it('truyền default_insurance_salary vào data khi tạo + map BigInt→string', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(null)
      prismaMock.jobTitle.create.mockResolvedValueOnce({
        ...MOCK_ROW,
        default_insurance_salary: BigInt(4_500_000),
      })
      const result = await service.create({
        ...createDto,
        default_insurance_salary: 4_500_000,
      })
      expect(prismaMock.jobTitle.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ default_insurance_salary: 4_500_000 }),
        }),
      )
      expect(result.default_insurance_salary).toBe('4500000')
    })

    it('default_insurance_salary null khi không truyền (fallback lương cơ bản)', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(null)
      prismaMock.jobTitle.create.mockResolvedValueOnce(MOCK_ROW)
      const result = await service.create(createDto)
      expect(prismaMock.jobTitle.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ default_insurance_salary: null }),
        }),
      )
      expect(result.default_insurance_salary).toBeNull()
    })
  })

  describe('update', () => {
    it('cập nhật thành công khi chức danh tồn tại', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(MOCK_ROW) // findOne check
      const updated = { ...MOCK_ROW, name: 'Nhân viên (đã sửa)' }
      prismaMock.jobTitle.update.mockResolvedValueOnce(updated)
      const result = await service.update(1, { name: 'Nhân viên (đã sửa)' })
      expect(result.name).toBe('Nhân viên (đã sửa)')
    })

    it('ném NotFoundException khi chức danh không tồn tại', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(null)
      await expect(service.update(999, { name: 'x' })).rejects.toThrow(NotFoundException)
    })
  })

  describe('remove', () => {
    it('xoá thành công khi chức danh tồn tại', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(MOCK_ROW)
      prismaMock.jobTitle.delete.mockResolvedValueOnce(MOCK_ROW)
      const result = await service.remove(1)
      expect(result).toEqual({ ok: true })
    })

    it('ném NotFoundException khi chức danh không tồn tại', async () => {
      prismaMock.jobTitle.findUnique.mockResolvedValueOnce(null)
      await expect(service.remove(999)).rejects.toThrow(NotFoundException)
    })
  })
})
