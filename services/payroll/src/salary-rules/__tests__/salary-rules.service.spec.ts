import { Test, TestingModule } from '@nestjs/testing'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { SalaryRulesService } from '../salary-rules.service'

const mockTx = {
  salaryRule: {
    create: jest.fn(),
    update: jest.fn(),
  },
  salaryRuleDetail: {
    create: jest.fn(),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  },
}

const mockPrisma = {
  salaryRule: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  $transaction: jest.fn((fn: (tx: typeof mockTx) => Promise<unknown>) =>
    fn(mockTx),
  ),
}

describe('SalaryRulesService', () => {
  let service: SalaryRulesService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalaryRulesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()

    service = module.get<SalaryRulesService>(SalaryRulesService)
    jest.clearAllMocks()
  })

  describe('findAll', () => {
    it('returns all salary rules with details', async () => {
      const rules = [
        {
          id: 1,
          position: 'sales',
          name: 'Sale Q1',
          description: null,
          details: [
            { id: 1, component: 'base', amount: 7000000n, formula: null, params: null, order: 0 },
          ],
        },
      ]
      mockPrisma.salaryRule.findMany.mockResolvedValue(rules)

      const result = await service.findAll()
      expect(result).toEqual(rules)
    })
  })

  describe('findById', () => {
    it('throws NotFoundException when rule not found', async () => {
      mockPrisma.salaryRule.findUnique.mockResolvedValue(null)

      await expect(service.findById(999)).rejects.toThrow(NotFoundException)
    })
  })

  describe('create', () => {
    it('creates salary rule with details in transaction', async () => {
      mockTx.salaryRule.create.mockResolvedValue({
        id: 1,
        position: 'sales',
        name: 'Sale Q1',
        description: null,
      })
      mockTx.salaryRuleDetail.create.mockResolvedValue({
        id: 1,
        salary_rule_id: 1,
        component: 'base',
        amount: 7000000n,
        formula: null,
        params: null,
        order: 0,
      })

      const result = await service.create({
        position: 'sales',
        name: 'Sale Q1',
        details: [
          { component: 'base', amount: '7000000', order: 0 },
        ],
      })

      expect(result.id).toBe(1)
      expect(result.details).toHaveLength(1)
      expect(result.details[0].amount).toBe('7000000')
    })

    it('rejects invalid formula', async () => {
      await expect(
        service.create({
          position: 'sales',
          name: 'Bad rule',
          details: [
            { component: 'kpi_bonus', formula: 'process.exit(1)' },
          ],
        }),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe('update', () => {
    it('throws NotFoundException when rule not found', async () => {
      mockPrisma.salaryRule.findUnique.mockResolvedValue(null)

      await expect(
        service.update(999, { name: 'Updated' }),
      ).rejects.toThrow(NotFoundException)
    })

    it('replaces details when provided', async () => {
      mockPrisma.salaryRule.findUnique.mockResolvedValue({ id: 1 })
      mockTx.salaryRule.update.mockResolvedValue({
        id: 1,
        position: 'sales',
        name: 'Updated',
        description: null,
      })
      mockTx.salaryRuleDetail.deleteMany.mockResolvedValue({ count: 1 })
      mockTx.salaryRuleDetail.create.mockResolvedValue({
        id: 2,
        salary_rule_id: 1,
        component: 'base',
        amount: 8000000n,
        formula: null,
        params: null,
        order: 0,
      })

      const result = await service.update(1, {
        name: 'Updated',
        details: [{ component: 'base', amount: '8000000', order: 0 }],
      })

      expect(mockTx.salaryRuleDetail.deleteMany).toHaveBeenCalledWith({
        where: { salary_rule_id: 1 },
      })
      expect(result.details[0].amount).toBe('8000000')
    })
  })
})
