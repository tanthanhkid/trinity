import { Test, TestingModule } from '@nestjs/testing'
import { PrismaService } from '@trinity/prisma'
import { ReportsService } from '../reports.service'

const mockPrisma = {
  payslip: {
    aggregate: jest.fn(),
    findMany: jest.fn(),
  },
}

describe('ReportsService', () => {
  let service: ReportsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()

    service = module.get<ReportsService>(ReportsService)
    jest.clearAllMocks()
  })

  describe('getSummary', () => {
    it('returns aggregated payroll summary for a month', async () => {
      mockPrisma.payslip.aggregate.mockResolvedValue({
        _sum: {
          base_salary: 100000000n,
          kpi_bonus: 20000000n,
          deductions: 1000000n,
          total: 129000000n,
        },
        _count: { id: 10 },
      })

      const result = await service.getSummary('2026-03')

      expect(result.month).toBe('2026-03')
      expect(result.total_employees).toBe(10)
      expect(result.total_base_salary).toBe('100000000')
      expect(result.total_kpi_bonus).toBe('20000000')
      expect(result.total_deductions).toBe('1000000')
      expect(result.total_payroll_cost).toBe('129000000')
      expect(mockPrisma.payslip.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { month: '2026-03', deleted_at: null } }),
      )
    })

    it('returns zeros when no payslips exist for the month', async () => {
      mockPrisma.payslip.aggregate.mockResolvedValue({
        _sum: {
          base_salary: null,
          kpi_bonus: null,
          deductions: null,
          total: null,
        },
        _count: { id: 0 },
      })

      const result = await service.getSummary('2026-01')

      expect(result.total_employees).toBe(0)
      expect(result.total_base_salary).toBe('0')
      expect(result.total_payroll_cost).toBe('0')
    })
  })

  describe('getByDepartment', () => {
    it('groups payslips by department', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([
        {
          base_salary: 10000000n,
          kpi_bonus: 2000000n,
          deductions: 100000n,
          total: 12900000n,
          employee: { department: 'KD' },
        },
        {
          base_salary: 8000000n,
          kpi_bonus: 1500000n,
          deductions: 50000n,
          total: 10150000n,
          employee: { department: 'KD' },
        },
        {
          base_salary: 12000000n,
          kpi_bonus: 0n,
          deductions: 200000n,
          total: 11800000n,
          employee: { department: 'HR' },
        },
      ])

      const result = await service.getByDepartment('2026-03')

      expect(result).toHaveLength(2)

      const kd = result.find((r) => r.department === 'KD')
      expect(kd).toBeDefined()
      expect(kd!.employee_count).toBe(2)
      expect(kd!.total_base_salary).toBe('18000000')

      const hr = result.find((r) => r.department === 'HR')
      expect(hr).toBeDefined()
      expect(hr!.employee_count).toBe(1)
    })

    it('uses "Khác" for employees without department', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([
        {
          base_salary: 5000000n,
          kpi_bonus: 0n,
          deductions: 0n,
          total: 5000000n,
          employee: { department: null },
        },
      ])

      const result = await service.getByDepartment('2026-03')

      expect(result).toHaveLength(1)
      expect(result[0].department).toBe('Khác')
    })
  })

  describe('getComparison', () => {
    it('returns month-over-month comparison', async () => {
      mockPrisma.payslip.aggregate
        .mockResolvedValueOnce({
          _sum: { total: 100000000n },
          _count: { id: 10 },
        })
        .mockResolvedValueOnce({
          _sum: { total: 120000000n },
          _count: { id: 11 },
        })
        .mockResolvedValueOnce({
          _sum: { total: 130000000n },
          _count: { id: 12 },
        })

      const result = await service.getComparison([
        '2026-01',
        '2026-02',
        '2026-03',
      ])

      expect(result).toHaveLength(3)
      expect(result[0].month).toBe('2026-01')
      expect(result[0].total_payroll_cost).toBe('100000000')
      expect(result[0].employee_count).toBe(10)
      expect(result[1].month).toBe('2026-02')
      expect(result[1].total_payroll_cost).toBe('120000000')
      expect(result[2].month).toBe('2026-03')
      expect(result[2].total_payroll_cost).toBe('130000000')
    })
  })
})
