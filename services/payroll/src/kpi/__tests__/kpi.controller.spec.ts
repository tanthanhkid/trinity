import { Test, TestingModule } from '@nestjs/testing'
import { NotFoundException } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import type { AuthUser } from '@trinity/rbac-nest'
import { KpiController } from '../kpi.controller'
import { KpiService } from '../kpi.service'

const mockKpiService = {
  getConfigs: jest.fn(),
  createConfig: jest.fn(),
  getByEmployee: jest.fn(),
  calculate: jest.fn(),
  closeMonth: jest.fn(),
}

const mockPrisma = {
  employee: { findUnique: jest.fn() },
}

const makeUser = (userId: number): AuthUser => ({
  userId,
  email: `u${userId}@t.vn`,
  isAdmin: false,
  grants: {},
})

describe('KpiController', () => {
  let controller: KpiController

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [KpiController],
      providers: [
        { provide: KpiService, useValue: mockKpiService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile()

    controller = module.get<KpiController>(KpiController)
    jest.clearAllMocks()
  })

  describe('GET /kpi — chỉ xem KPI của chính mình', () => {
    const query = { employee_id: 1, month: '2026-03' }

    it('cho phép xem KPI của chính mình (employee.user_id === caller)', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({ user_id: 10 })
      mockKpiService.getByEmployee.mockResolvedValue({
        employee_id: 1,
        month: '2026-03',
        metrics: {},
      })

      const result = await controller.getKpi(query, makeUser(10))

      expect(result.employee_id).toBe(1)
      expect(mockKpiService.getByEmployee).toHaveBeenCalledWith(1, '2026-03')
    })

    it('ngoài phạm vi (KPI của người khác) → 404, KHÔNG phải 403', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue({ user_id: 999 })

      await expect(controller.getKpi(query, makeUser(10))).rejects.toThrow(NotFoundException)
      expect(mockKpiService.getByEmployee).not.toHaveBeenCalled()
    })

    it('employee_id không tồn tại → 404', async () => {
      mockPrisma.employee.findUnique.mockResolvedValue(null)

      await expect(controller.getKpi(query, makeUser(10))).rejects.toThrow(NotFoundException)
    })
  })

  describe('POST /kpi/calculate', () => {
    it('should call calculate with month and employee_ids', async () => {
      mockKpiService.calculate.mockResolvedValue({
        processed: 5,
      })

      const result = await controller.calculate({
        month: '2026-03',
        employee_ids: [1, 2, 3],
      })

      expect(result.processed).toBe(5)
      expect(mockKpiService.calculate).toHaveBeenCalledWith(
        '2026-03',
        [1, 2, 3],
      )
    })

    it('should calculate all when employee_ids not provided', async () => {
      mockKpiService.calculate.mockResolvedValue({
        processed: 50,
      })

      const result = await controller.calculate({
        month: '2026-03',
      })

      expect(result.processed).toBe(50)
      expect(mockKpiService.calculate).toHaveBeenCalledWith(
        '2026-03',
        undefined,
      )
    })
  })

  describe('POST /kpi/close-month', () => {
    it('should close month successfully', async () => {
      mockKpiService.closeMonth.mockResolvedValue({
        closed: true,
        locked_count: 30,
      })

      const result = await controller.closeMonth({
        month: '2026-03',
      })

      expect(result.closed).toBe(true)
      expect(result.locked_count).toBe(30)
    })
  })
})
