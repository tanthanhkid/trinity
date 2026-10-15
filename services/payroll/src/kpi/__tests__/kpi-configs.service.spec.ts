import { Test, TestingModule } from '@nestjs/testing'
import { ConflictException } from '@nestjs/common'
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

describe('KpiService — KPI Configs', () => {
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

  describe('createConfig', () => {
    it('should create KPI config for a role', async () => {
      mockPrisma.kpiConfig.findFirst.mockResolvedValue(null)
      mockPrisma.kpiConfig.create.mockResolvedValue({
        id: 1,
        role: 'sales',
        metric_name: 'tasks/day',
        target: new Decimal('120'),
        unit: 'count',
        weight: new Decimal('25'),
        working_days_per_month: 24,
      })

      const result = await service.createConfig({
        role: 'sales',
        metric_name: 'tasks/day',
        target: 120,
        unit: 'count',
        weight: 25,
      })

      expect(result.id).toBe(1)
      expect(result.role).toBe('sales')
      expect(result.metric_name).toBe('tasks/day')
      expect(result.target).toBe('120')
      expect(result.weight).toBe('25')
      expect(result.working_days_per_month).toBe(24)
    })

    it('should set default working_days_per_month to 24', async () => {
      mockPrisma.kpiConfig.findFirst.mockResolvedValue(null)
      mockPrisma.kpiConfig.create.mockResolvedValue({
        id: 2,
        role: 'marketing',
        metric_name: 'leads/day',
        target: new Decimal('1000'),
        unit: 'count',
        weight: null,
        working_days_per_month: 24,
      })

      await service.createConfig({
        role: 'marketing',
        metric_name: 'leads/day',
        target: 1000,
        unit: 'count',
      })

      expect(mockPrisma.kpiConfig.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          working_days_per_month: 24,
        }),
      })
    })

    it('should return 409 when duplicate role+metric exists', async () => {
      mockPrisma.kpiConfig.findFirst.mockResolvedValue({
        id: 1,
        role: 'sales',
        metric_name: 'tasks/day',
      })

      await expect(
        service.createConfig({
          role: 'sales',
          metric_name: 'tasks/day',
          target: 120,
        }),
      ).rejects.toThrow(ConflictException)
    })

    it('should create config with null weight and unit', async () => {
      mockPrisma.kpiConfig.findFirst.mockResolvedValue(null)
      mockPrisma.kpiConfig.create.mockResolvedValue({
        id: 3,
        role: 'operations',
        metric_name: 'docs processed',
        target: new Decimal('50'),
        unit: null,
        weight: null,
        working_days_per_month: 24,
      })

      const result = await service.createConfig({
        role: 'operations',
        metric_name: 'docs processed',
        target: 50,
      })

      expect(result.unit).toBeNull()
      expect(result.weight).toBeNull()
    })
  })

  describe('getConfigs', () => {
    const configs = [
      {
        id: 1,
        role: 'sales',
        metric_name: 'tasks/day',
        target: new Decimal('120'),
        unit: 'count',
        weight: new Decimal('25'),
        working_days_per_month: 24,
      },
      {
        id: 2,
        role: 'sales',
        metric_name: 'training_hours',
        target: new Decimal('120'),
        unit: 'minutes',
        weight: new Decimal('25'),
        working_days_per_month: 24,
      },
    ]

    it('should list all KPI configs', async () => {
      mockPrisma.kpiConfig.findMany.mockResolvedValue(configs)

      const result = await service.getConfigs()

      expect(result).toHaveLength(2)
      expect(result[0].target).toBe('120')
      expect(mockPrisma.kpiConfig.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ role: 'asc' }, { id: 'asc' }],
        take: 100,
      })
    })

    it('should filter by role', async () => {
      mockPrisma.kpiConfig.findMany.mockResolvedValue(configs)

      await service.getConfigs('sales')

      expect(mockPrisma.kpiConfig.findMany).toHaveBeenCalledWith({
        where: { role: 'sales' },
        orderBy: [{ role: 'asc' }, { id: 'asc' }],
        take: 100,
      })
    })

    it('should return empty array when no configs', async () => {
      mockPrisma.kpiConfig.findMany.mockResolvedValue([])

      const result = await service.getConfigs('team_lead')

      expect(result).toEqual([])
    })

    it('should define different metrics per role', async () => {
      const multiRoleConfigs = [
        { id: 1, role: 'sales', metric_name: 'tasks/day', target: new Decimal('120'), unit: 'count', weight: new Decimal('30'), working_days_per_month: 24 },
        { id: 2, role: 'sales', metric_name: 'training_hours', target: new Decimal('120'), unit: 'minutes', weight: new Decimal('20'), working_days_per_month: 24 },
        { id: 3, role: 'team_lead', metric_name: 'team revenue', target: new Decimal('20000000000'), unit: 'VND', weight: new Decimal('50'), working_days_per_month: 24 },
        { id: 4, role: 'marketing', metric_name: 'leads from campaigns', target: new Decimal('1000'), unit: 'count', weight: new Decimal('40'), working_days_per_month: 24 },
      ]
      mockPrisma.kpiConfig.findMany.mockResolvedValue(multiRoleConfigs)

      const result = await service.getConfigs()

      const saleMetrics = result.filter((c) => c.role === 'sales')
      const teamLeadMetrics = result.filter((c) => c.role === 'team_lead')
      const marketingMetrics = result.filter((c) => c.role === 'marketing')

      expect(saleMetrics).toHaveLength(2)
      expect(teamLeadMetrics).toHaveLength(1)
      expect(marketingMetrics).toHaveLength(1)
      expect(teamLeadMetrics[0].target).toBe('20000000000')
    })
  })
})
