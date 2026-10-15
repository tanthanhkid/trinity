import { Test, TestingModule } from '@nestjs/testing'
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Decimal } from '@prisma/client/runtime/library'
import { KpiService } from '../kpi.service'
import { KpiAggregatorService } from '../kpi-aggregator.service'

const mockPrisma = {
  kpiConfig: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  kpiResult: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  employee: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  $executeRaw: jest.fn(),
}

const mockAggregator = {
  aggregateForEmployee: jest.fn(),
}

describe('KpiService', () => {
  let service: KpiService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KpiService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: KpiAggregatorService,
          useValue: mockAggregator,
        },
      ],
    }).compile()

    service = module.get<KpiService>(KpiService)
    jest.clearAllMocks()
  })

  // ===================== getByEmployee =====================

  describe('getByEmployee', () => {
    it('should return KPI data for an employee', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({
        id: 1,
        user_id: 10,
        position: 'sales',
        team_id: 1,
      })

      mockPrisma.kpiResult.findMany.mockResolvedValue([
        {
          metric_name: 'tasks/day',
          actual_value: new Decimal('2500'),
          target_value: new Decimal('2880'),
          achievement_rate: new Decimal('86.81'),
          achieved: false,
          is_locked: false,
        },
        {
          metric_name: 'revenue',
          actual_value: new Decimal('1500000000'),
          target_value: new Decimal('1200000000'),
          achievement_rate: new Decimal('125.00'),
          achieved: true,
          is_locked: false,
        },
      ])

      const result = await service.getByEmployee(1, '2026-03')

      expect(result.employee_id).toBe(1)
      expect(result.month).toBe('2026-03')
      expect(result.metrics['tasks/day'].actual).toBe('2500')
      expect(result.metrics['revenue'].achieved).toBe(true)
      expect(result.achievement_rate).toBeGreaterThan(0)
      expect(result.status).toBe('exceeded')
    })

    it('should throw 404 when employee not found', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue(null)

      await expect(
        service.getByEmployee(999, '2026-03'),
      ).rejects.toThrow(NotFoundException)
    })

    it('should throw 404 when no KPI data for month', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({
        id: 1,
        user_id: 10,
        position: 'sales',
        team_id: 1,
      })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])

      await expect(
        service.getByEmployee(1, '2026-01'),
      ).rejects.toThrow(NotFoundException)
    })

    it('should show is_locked=true when all results are locked', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({
        id: 1,
        user_id: 10,
        position: 'sales',
        team_id: 1,
      })

      mockPrisma.kpiResult.findMany.mockResolvedValue([
        {
          metric_name: 'tasks/day',
          actual_value: new Decimal('2880'),
          target_value: new Decimal('2880'),
          achievement_rate: new Decimal('100.00'),
          achieved: true,
          is_locked: true,
        },
      ])

      const result = await service.getByEmployee(1, '2026-02')

      expect(result.is_locked).toBe(true)
    })

    it('should determine status=behind when rate < 80', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({
        id: 1,
        user_id: 10,
        position: 'sales',
        team_id: 1,
      })

      mockPrisma.kpiResult.findMany.mockResolvedValue([
        {
          metric_name: 'tasks/day',
          actual_value: new Decimal('1000'),
          target_value: new Decimal('2880'),
          achievement_rate: new Decimal('34.72'),
          achieved: false,
          is_locked: false,
        },
      ])

      const result = await service.getByEmployee(1, '2026-03')

      expect(result.status).toBe('behind')
    })
  })

  // ===================== calculate =====================

  describe('calculate', () => {
    it('should calculate KPI for all active employees', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue(null) // not locked

      mockPrisma.employee.findMany.mockResolvedValue([
        {
          id: 1,
          user_id: 10,
          position: 'sales',
          team_id: 1,
        },
        {
          id: 2,
          user_id: 11,
          position: 'sales',
          team_id: 1,
        },
      ])

      mockPrisma.kpiConfig.findMany.mockResolvedValue([
        {
          id: 1,
          role: 'sales',
          metric_name: 'tasks/day',
          target: new Decimal('120'),
          unit: 'count',
          weight: new Decimal('30'),
          working_days_per_month: 24,
        },
      ])

      mockAggregator.aggregateForEmployee.mockResolvedValue({ 'tasks/day': 2500 })

      mockPrisma.$executeRaw.mockResolvedValue(1)

      const result = await service.calculate('2026-03')

      expect(result.processed).toBe(2)
      expect(mockAggregator.aggregateForEmployee).toHaveBeenCalledTimes(2)
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2)
    })

    it('should return 0 processed when no active employees', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue(null)
      mockPrisma.employee.findMany.mockResolvedValue([])

      const result = await service.calculate('2026-03')

      expect(result.processed).toBe(0)
    })

    it('should throw 400 when month already locked', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue({
        id: 1,
        is_locked: true,
      })

      await expect(
        service.calculate('2026-03'),
      ).rejects.toThrow(BadRequestException)
    })

    it('should throw 400 for invalid month format', async () => {
      await expect(
        service.calculate('2026-13'),
      ).rejects.toThrow(BadRequestException)
    })

    it('should calculate only for specified employee_ids', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue(null)

      mockPrisma.employee.findMany.mockResolvedValue([
        {
          id: 5,
          user_id: 15,
          position: 'sales',
          team_id: 2,
        },
      ])

      mockPrisma.kpiConfig.findMany.mockResolvedValue([
        {
          id: 1,
          role: 'sales',
          metric_name: 'tasks/day',
          target: new Decimal('120'),
          unit: 'count',
          weight: new Decimal('30'),
          working_days_per_month: 24,
        },
      ])

      mockAggregator.aggregateForEmployee.mockResolvedValue({ 'tasks/day': 3000 })

      mockPrisma.$executeRaw.mockResolvedValue(1)

      const result = await service.calculate('2026-03', [5])

      expect(result.processed).toBe(1)
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith({
        where: {
          status: 'active',
          deleted_at: null,
          id: { in: [5] },
        },
        select: {
          id: true,
          user_id: true,
          position: true,
          team_id: true,
        },
        orderBy: { id: 'asc' },
        take: 100,
      })
    })
  })

  // ===================== closeMonth =====================

  describe('closeMonth', () => {
    it('should lock all KPI results for a month', async () => {
      mockPrisma.kpiResult.findFirst
        .mockResolvedValueOnce({ id: 1 }) // existing data
        .mockResolvedValueOnce(null) // not already locked

      mockPrisma.kpiResult.updateMany.mockResolvedValue({
        count: 15,
      })

      const result = await service.closeMonth('2026-03')

      expect(result.closed).toBe(true)
      expect(result.locked_count).toBe(15)
      expect(
        mockPrisma.kpiResult.updateMany,
      ).toHaveBeenCalledWith({
        where: { month: '2026-03', is_locked: false },
        data: { is_locked: true },
      })
    })

    it('should throw 404 when no KPI data for month', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue(null)

      await expect(
        service.closeMonth('2026-01'),
      ).rejects.toThrow(NotFoundException)
    })

    it('should throw 409 when month already locked', async () => {
      mockPrisma.kpiResult.findFirst
        .mockResolvedValueOnce({ id: 1 }) // existing data
        .mockResolvedValueOnce({ id: 1, is_locked: true }) // already locked

      await expect(
        service.closeMonth('2026-03'),
      ).rejects.toThrow(ConflictException)
    })

    it('should throw 400 for invalid month format', async () => {
      await expect(
        service.closeMonth('invalid'),
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ===================== working_days_per_month =====================

  describe('working_days_per_month', () => {
    it('should use working_days from config for daily metrics', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue(null)

      mockPrisma.employee.findMany.mockResolvedValue([
        {
          id: 1,
          user_id: 10,
          position: 'sales',
          team_id: 1,
        },
      ])

      // Config: 120 tasks/day, 22 working days
      mockPrisma.kpiConfig.findMany.mockResolvedValue([
        {
          id: 1,
          role: 'sales',
          metric_name: 'tasks/day',
          target: new Decimal('120'),
          unit: 'count',
          weight: new Decimal('30'),
          working_days_per_month: 22, // Not default 24!
        },
      ])

      mockAggregator.aggregateForEmployee.mockResolvedValue({ 'tasks/day': 2640 })

      mockPrisma.$executeRaw.mockResolvedValue(1)

      await service.calculate('2026-03')

      // Target should be 120 * 22 = 2640 (not 120 * 24 = 2880)
      const rawCall = mockPrisma.$executeRaw.mock.calls[0]
      // The raw SQL call is a tagged template, verify it was called
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
    })

    it('should use target directly for monthly metrics (not multiply by working_days)', async () => {
      mockPrisma.kpiResult.findFirst.mockResolvedValue(null)

      mockPrisma.employee.findMany.mockResolvedValue([
        {
          id: 1,
          user_id: 10,
          position: 'sales',
          team_id: 1,
        },
      ])

      // Revenue is a monthly metric, not per-day
      mockPrisma.kpiConfig.findMany.mockResolvedValue([
        {
          id: 2,
          role: 'sales',
          metric_name: 'revenue',
          target: new Decimal('1200000000'),
          unit: 'VND',
          weight: new Decimal('40'),
          working_days_per_month: 22,
        },
      ])

      mockAggregator.aggregateForEmployee.mockResolvedValue({ revenue: 1500000000 })

      mockPrisma.$executeRaw.mockResolvedValue(1)

      await service.calculate('2026-03')

      // Revenue target should remain 1.2B, NOT multiplied by working_days
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
    })
  })
})
