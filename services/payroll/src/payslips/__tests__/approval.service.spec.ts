import { Test, TestingModule } from '@nestjs/testing'
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { ScopeService, adminGrants, type AuthUser } from '@trinity/rbac-nest'
import { PayslipsService } from '../payslips.service'
import { PAYROLL_PAYSLIP_NOTIFY_PORT } from '../payslip-notify.port'
import { SalaryComponentsEngine } from '../../salary-components/salary-components-engine.service'
import { InsuranceEngine } from '../../insurance/insurance.engine'
import { TaxEngine } from '../../tax/tax.engine'
import { ApprovalAction } from '../dto/approve-payslip.dto'

const mockSalaryEngine = {
  computeForEmployee: jest.fn().mockResolvedValue({
    allowances: BigInt(0), bonuses: BigInt(0), deductions: BigInt(0), taxableEarnings: BigInt(0), snapshot: [],
  }),
}
const mockInsuranceEngine = {
  compute: jest.fn().mockResolvedValue({ total: BigInt(0), snapshot: [] }),
}
const mockTaxEngine = {
  compute: jest.fn().mockResolvedValue({ tax: BigInt(0), snapshot: null }),
}
// publishApprovedEvent gọi port thông báo in-process.
const mockNotify = { onPayslipApproved: jest.fn() }

function makePayslip(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    employee_id: 10,
    month: '2026-03',
    base_salary: BigInt(10000000),
    kpi_bonus: BigInt(2000000),
    deductions: BigInt(0),
    total: BigInt(14000000),
    status: 'draft',
    tl_approved_by: null,
    tl_approved_at: null,
    approved_by: null,
    approved_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    employee: {
      id: 10,
      user_id: 100,
      position: 'sales',
      team_id: 1,
      user: { full_name: 'Nguyen Van Test', email: 'test@example.net' },
    },
    ...overrides,
  }
}

// team_lead giữ `payroll.approve_team` scope 'team' — phạm vi thật do
// mockScope.ownerIds quyết định per-test (mirror ScopeService.ownerIds thật).
const teamLeadUser: AuthUser = {
  userId: 50,
  email: 'tl@example.net',
  isAdmin: false,
  grants: { 'payroll.approve_team': 'team' },
}

const otherTeamLeadUser: AuthUser = {
  userId: 55,
  email: 'tl2@example.net',
  isAdmin: false,
  grants: { 'payroll.approve_team': 'team' },
}

const accountantUser: AuthUser = {
  userId: 60,
  email: 'kt@example.net',
  isAdmin: false,
  grants: { 'payroll.approve_final': true },
}

const superAdminUser: AuthUser = {
  userId: 1,
  email: 'admin@example.net',
  isAdmin: true,
  grants: adminGrants(),
}

const mockPrisma = {
  payslip: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
}

const mockScope = {
  ownerIds: jest.fn(),
}

describe('PayslipsService - Approval Workflow (quyền + phạm vi)', () => {
  let service: PayslipsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayslipsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PAYROLL_PAYSLIP_NOTIFY_PORT, useValue: mockNotify },
        { provide: SalaryComponentsEngine, useValue: mockSalaryEngine },
        { provide: InsuranceEngine, useValue: mockInsuranceEngine },
        { provide: TaxEngine, useValue: mockTaxEngine },
        { provide: ScopeService, useValue: mockScope },
      ],
    }).compile()

    service = module.get<PayslipsService>(PayslipsService)
    jest.clearAllMocks()
    mockNotify.onPayslipApproved.mockReset()
    mockNotify.onPayslipApproved.mockResolvedValue(undefined)
    // Default: team_lead userId=50 quản lý user_id=100 (chủ phiếu) + user_id=11.
    mockScope.ownerIds.mockResolvedValue([50, 100, 11])
  })

  describe('Full approval flow: draft -> pending_accountant -> approved', () => {
    it('bước 1 (payroll.approve_team, trong phạm vi): draft -> pending_accountant', async () => {
      const payslip = makePayslip({ status: 'draft' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({
        ...payslip,
        status: 'pending_accountant',
      })

      const result = await service.approve(
        1,
        { action: ApprovalAction.APPROVE },
        teamLeadUser,
      )

      expect(result.status).toBe('pending_accountant')
      expect(mockScope.ownerIds).toHaveBeenCalledWith(teamLeadUser, 'payroll.approve_team')
      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'pending_accountant',
          tl_approved_by: teamLeadUser.userId,
          tl_approved_at: expect.any(Date),
        }),
      })
    })

    it('bước 2 (payroll.approve_final): pending_accountant -> approved + publishes event', async () => {
      const payslip = makePayslip({ status: 'pending_accountant' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({
        ...payslip,
        status: 'approved',
      })
      const result = await service.approve(
        1,
        { action: ApprovalAction.APPROVE },
        accountantUser,
      )

      expect(result.status).toBe('approved')
      expect(result.message).toContain('duyệt')
      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'approved',
          approved_by: accountantUser.userId,
          approved_at: expect.any(Date),
        }),
      })

      expect(mockNotify.onPayslipApproved).toHaveBeenCalledTimes(1)
      expect(mockNotify.onPayslipApproved).toHaveBeenCalledWith(
        expect.objectContaining({
          payslipId: 1,
          employeeId: 10,
          userId: 100,
          month: '2026-03',
          baseSalary: 10000000,
          kpiBonus: 2000000,
          totalAmount: 14000000,
          approvedBy: accountantUser.userId,
        }),
      )
    })

    it('thông báo lỗi KHÔNG làm hỏng mutation duyệt, nhưng log ERROR kèm id phiếu', async () => {
      const payslip = makePayslip({ status: 'pending_accountant' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({ ...payslip, status: 'approved' })
      mockNotify.onPayslipApproved.mockRejectedValue(new Error('template boom'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorSpy = jest.spyOn((service as any).logger, 'error')

      const result = await service.approve(
        1,
        { action: ApprovalAction.APPROVE },
        accountantUser,
      )

      expect(result.status).toBe('approved')
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('#1: template boom'),
      )
      errorSpy.mockRestore()
    })

    it('port chưa được nối: duyệt vẫn thành công, log ERROR (không im lặng)', async () => {
      const module = await Test.createTestingModule({
        providers: [
          PayslipsService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: SalaryComponentsEngine, useValue: mockSalaryEngine },
          { provide: InsuranceEngine, useValue: mockInsuranceEngine },
          { provide: TaxEngine, useValue: mockTaxEngine },
          { provide: ScopeService, useValue: mockScope },
        ],
      }).compile()
      const bare = module.get(PayslipsService)
      const payslip = makePayslip({ status: 'pending_accountant' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({ ...payslip, status: 'approved' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorSpy = jest.spyOn((bare as any).logger, 'error')

      const result = await bare.approve(
        1,
        { action: ApprovalAction.APPROVE },
        accountantUser,
      )

      expect(result.status).toBe('approved')
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('PAYROLL_PAYSLIP_NOTIFY_PORT chưa được nối'),
      )
      errorSpy.mockRestore()
    })
  })

  describe('Reject flow', () => {
    it('bước 1 (payroll.approve_team): pending_tl -> draft', async () => {
      const payslip = makePayslip({ status: 'pending_tl' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({
        ...payslip,
        status: 'draft',
      })

      const result = await service.approve(
        1,
        { action: ApprovalAction.REJECT },
        teamLeadUser,
      )

      expect(result.status).toBe('draft')
      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'draft',
          tl_approved_by: null,
          tl_approved_at: null,
          approved_by: null,
          approved_at: null,
        }),
      })
    })

    it('bước 2 (payroll.approve_final): pending_accountant -> draft', async () => {
      const payslip = makePayslip({ status: 'pending_accountant' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({
        ...payslip,
        status: 'draft',
      })

      const result = await service.approve(
        1,
        { action: ApprovalAction.REJECT },
        accountantUser,
      )

      expect(result.status).toBe('draft')
    })

    it('reject ở draft (không phải bước đang chờ) → 409', async () => {
      const payslip = makePayslip({ status: 'draft' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      await expect(
        service.approve(1, { action: ApprovalAction.REJECT }, teamLeadUser),
      ).rejects.toThrow(ConflictException)
    })
  })

  describe('Bước 1 ngoài phạm vi (payroll.approve_team scope) → 404, KHÔNG phải 403', () => {
    it('approve: nhân viên của phiếu ngoài phạm vi team_lead → 404', async () => {
      const payslip = makePayslip({
        status: 'draft',
        employee: { id: 10, user_id: 100, team_id: 1 },
      })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      // otherTeamLeadUser không quản lý user_id=100
      mockScope.ownerIds.mockResolvedValue([55])

      await expect(
        service.approve(
          1,
          { action: ApprovalAction.APPROVE },
          otherTeamLeadUser,
        ),
      ).rejects.toThrow(NotFoundException)
    })

    it('reject: nhân viên của phiếu ngoài phạm vi team_lead → 404', async () => {
      const payslip = makePayslip({
        status: 'pending_tl',
        employee: { id: 10, user_id: 100, team_id: 1 },
      })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockScope.ownerIds.mockResolvedValue([55])

      await expect(
        service.approve(
          1,
          { action: ApprovalAction.REJECT },
          otherTeamLeadUser,
        ),
      ).rejects.toThrow(NotFoundException)
    })
  })

  describe('Payslip not found', () => {
    it('throws NotFoundException for non-existent payslip', async () => {
      mockPrisma.payslip.findUnique.mockResolvedValue(null)

      await expect(
        service.approve(
          999,
          { action: ApprovalAction.APPROVE },
          teamLeadUser,
        ),
      ).rejects.toThrow(NotFoundException)
    })
  })

  describe('Phiếu đã xoá mềm', () => {
    it('duyệt phiếu đã loại khỏi kỳ lương → 404', async () => {
      mockPrisma.payslip.findUnique.mockResolvedValue(makePayslip({ deleted_at: new Date() }))
      await expect(
        service.approve(1, { action: ApprovalAction.APPROVE }, accountantUser),
      ).rejects.toThrow(NotFoundException)
    })
  })

  describe('Invalid state transitions → 409', () => {
    it('approving already approved payslip → 409', async () => {
      const payslip = makePayslip({ status: 'approved' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      await expect(
        service.approve(
          1,
          { action: ApprovalAction.APPROVE },
          accountantUser,
        ),
      ).rejects.toThrow(ConflictException)
    })
  })

  describe('Bước 2 thiếu quyền → 403 (accountantUser không giữ approve_team)', () => {
    it('accountant (chỉ approve_final) thử bước 1 → 403', async () => {
      const payslip = makePayslip({ status: 'draft' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      await expect(
        service.approve(
          1,
          { action: ApprovalAction.APPROVE },
          accountantUser,
        ),
      ).rejects.toThrow(ForbiddenException)
    })

    it('team_lead (chỉ approve_team) thử bước 2 → 403', async () => {
      const payslip = makePayslip({ status: 'pending_accountant' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      await expect(
        service.approve(
          1,
          { action: ApprovalAction.APPROVE },
          teamLeadUser,
        ),
      ).rejects.toThrow(ForbiddenException)
    })
  })

  describe('Quản trị (isAdmin — grants đủ mọi quyền scope all)', () => {
    it('super_admin can approve step 1', async () => {
      const payslip = makePayslip({ status: 'draft' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({
        ...payslip,
        status: 'pending_accountant',
      })

      const result = await service.approve(
        1,
        { action: ApprovalAction.APPROVE },
        superAdminUser,
      )

      expect(result.status).toBe('pending_accountant')
    })

    it('super_admin can approve step 2 and publishes event', async () => {
      const payslip = makePayslip({ status: 'pending_accountant' })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)
      mockPrisma.payslip.update.mockResolvedValue({
        ...payslip,
        status: 'approved',
      })
      const result = await service.approve(
        1,
        { action: ApprovalAction.APPROVE },
        superAdminUser,
      )

      expect(result.status).toBe('approved')
      expect(mockNotify.onPayslipApproved).toHaveBeenCalled()
    })
  })
})
