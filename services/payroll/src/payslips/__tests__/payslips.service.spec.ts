import { Test, TestingModule } from '@nestjs/testing'
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common'
import * as ExcelJS from 'exceljs'
import { PrismaService } from '@trinity/prisma'
import { ScopeService, adminGrants, type AuthUser } from '@trinity/rbac-nest'
import { PayslipsService, computeBonusSuggestion } from '../payslips.service'
import { SalaryComponentsEngine } from '../../salary-components/salary-components-engine.service'
import { InsuranceEngine } from '../../insurance/insurance.engine'
import { TaxEngine } from '../../tax/tax.engine'

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

const mockPrisma = {
  payslip: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  employee: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  salaryRuleDetail: {
    findMany: jest.fn(),
  },
  kpiResult: {
    findMany: jest.fn(),
  },
  attendanceRecord: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  user: {
    findMany: jest.fn().mockResolvedValue([]),
  },
}

// processImportRows bọc update trong $transaction; mock chạy callback với
// chính mockPrisma (tx === this.prisma trong test) để mock update/findMany sẵn có tái dùng được.
;(mockPrisma as { $transaction?: unknown }).$transaction = jest.fn(async (arg: unknown) => {
  if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(mockPrisma)
  return Promise.all(arg as Promise<unknown>[])
})

const mockScope = { ownerIds: jest.fn() }

const adminUser: AuthUser = {
  userId: 1,
  email: 'admin@example.net',
  isAdmin: true,
  grants: adminGrants(),
}

const saleUser: AuthUser = {
  userId: 10,
  email: 'sale@example.net',
  isAdmin: false,
  grants: { 'payroll.view': 'own', 'payroll.export': 'own' },
}

const teamLeadUser: AuthUser = {
  userId: 5,
  email: 'tl@example.net',
  isAdmin: false,
  grants: { 'payroll.view': 'team', 'payroll.export': 'team' },
}

const accountantUser: AuthUser = {
  userId: 20,
  email: 'kt@example.net',
  isAdmin: false,
  grants: {
    'payroll.view': 'all',
    'payroll.export': 'all',
    'payroll.manage': true,
    'payroll.approve_final': true,
  },
}

function makePayslip(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    employee_id: 1,
    month: '2026-03',
    base_salary: BigInt(7_000_000),
    kpi_bonus: BigInt(1_500_000),
    deductions: BigInt(0),
    total: BigInt(8_500_000),
    insurance_base: BigInt(0), // mức đóng BHXH (0 = chưa cấu hình → không tách phụ cấp)
    // --- 12 cột mẫu (DB luôn có default sau migration) ---
    working_days: null,
    standard_working_days: 26,
    base_salary_actual: BigInt(7_000_000),
    training_days: null,
    training_salary: BigInt(0),
    probation_allowance: BigInt(0),
    sales_personal: BigInt(0),
    bonus_rate: null,
    kpi_percent: null,
    bonus_sales_personal: BigInt(0),
    sales_team: BigInt(0),
    bonus_cskh_team: BigInt(0),
    bonus_milestone: BigInt(0),
    bonus_referral: BigInt(0),
    holiday_bonus: BigInt(0),
    advances: BigInt(0),
    personal_income_tax: BigInt(0),
    notes: null,
    status: 'draft',
    tl_approved_by: null,
    tl_approved_at: null,
    approved_by: null,
    approved_at: null,
    created_at: new Date('2026-03-31'),
    updated_at: new Date('2026-03-31'),
    employee: {
      id: 1,
      user_id: 10,
      position: 'sales',
      team_id: 1,
      user: { full_name: 'Nguyen Van A', email: 'a@example.net' },
      bank_account_number: null,
      bank_name: null,
      // enrich phân khúc (office/jobTitle relation; standard_target BigInt).
      department: 'KD',
      office_id: 5,
      office: { id: 5, name: 'VP Gò Vấp' },
      jobTitle: { category: 'Nhân viên', name: 'Chuyên viên', standard_target: BigInt(1_200_000_000) },
    },
    ...overrides,
  }
}

describe('PayslipsService', () => {
  let service: PayslipsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayslipsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SalaryComponentsEngine, useValue: mockSalaryEngine },
        { provide: InsuranceEngine, useValue: mockInsuranceEngine },
        { provide: TaxEngine, useValue: mockTaxEngine },
        { provide: ScopeService, useValue: mockScope },
      ],
    }).compile()

    service = module.get<PayslipsService>(PayslipsService)
    jest.clearAllMocks()
    // Mặc định: scope theo grant own → [self] (khớp ScopeService thật khi chưa
    // cần mock riêng subtree/team cho từng test).
    mockScope.ownerIds.mockImplementation(async (user: AuthUser, perm: string) => {
      const g = user.grants[perm as keyof typeof user.grants]
      if (g === undefined) return null
      if (g === true || g === 'all') return 'all'
      if (g === 'own') return [user.userId]
      return [user.userId] // team/subtree — test ghi đè riêng khi cần subordinates
    })
  })

  describe('findAll', () => {
    it('returns payslips with BigInt serialized as string', async () => {
      const payslip = makePayslip()
      mockPrisma.payslip.findMany.mockResolvedValue([payslip])

      const result = await service.findAll('2026-03', adminUser)

      expect(result).toHaveLength(1)
      expect(result[0].base_salary).toBe('7000000')
      expect(result[0].total).toBe('8500000')
      expect(result[0].employee.user.full_name).toBe('Nguyen Van A')
    })

    it('serialize enrich phân khúc + chỉ tiêu (standard_target BigInt → string)', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([makePayslip()])
      const result = await service.findAll('2026-03', adminUser)
      const emp = result[0].employee as Record<string, unknown>
      // office/jobTitle relation flatten thành field phẳng; standard_target stringify (KHÔNG BigInt raw).
      expect(emp.office_name).toBe('VP Gò Vấp')
      expect(emp.office_id).toBe(5)
      expect(emp.department).toBe('KD')
      expect(emp.job_title_category).toBe('Nhân viên')
      // cột "Vị trí" hiển thị TÊN chức danh chính thức (job_titles.name).
      expect(emp.job_title_name).toBe('Chuyên viên')
      expect(emp.standard_target).toBe('1200000000')
      // KHÔNG để lọt relation object thô (jobTitle.standard_target BigInt sẽ crash JSON).
      expect(emp.jobTitle).toBeUndefined()
      expect(emp.office).toBeUndefined()
      // field cũ giữ nguyên (không regress).
      expect(emp.user_id).toBe(10)
      expect(emp.bank_name).toBeNull()
    })

    it('sale user can only see own payslips (user_id scope)', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([])

      await service.findAll('2026-03', saleUser)

      expect(mockPrisma.payslip.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            employee: { user_id: { in: [10] } },
          }),
        }),
      )
    })

    it('team_lead sees subordinates via manager_id subtree', async () => {
      mockScope.ownerIds.mockResolvedValue([5, 11, 12])
      mockPrisma.payslip.findMany.mockResolvedValue([])

      await service.findAll('2026-03', teamLeadUser)

      expect(mockPrisma.payslip.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            employee: { user_id: { in: [5, 11, 12] } },
          }),
        }),
      )
    })

    it('filters by status when provided', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([])

      await service.findAll('2026-03', adminUser, undefined, 'approved')

      expect(mockPrisma.payslip.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'approved' }),
        }),
      )
    })
  })

  describe('findById', () => {
    it('returns payslip detail with serialized BigInt', async () => {
      const payslip = makePayslip()
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      const result = await service.findById(1, adminUser)

      expect(result.id).toBe(1)
      expect(result.base_salary).toBe('7000000')
      expect(result.kpi_bonus).toBe('1500000')
      expect(result.total).toBe('8500000')
    })

    it('throws NotFoundException for non-existent payslip', async () => {
      mockPrisma.payslip.findUnique.mockResolvedValue(null)

      await expect(service.findById(999, adminUser)).rejects.toThrow(
        NotFoundException,
      )
    })

    it('chỉ tìm phiếu chưa bị loại khỏi kỳ (deleted_at: null) — phiếu đã loại → 404', async () => {
      mockPrisma.payslip.findUnique.mockResolvedValue(null)

      await expect(service.findById(5, adminUser)).rejects.toThrow(NotFoundException)
      expect(mockPrisma.payslip.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 5, deleted_at: null } }),
      )
    })

    it('sale user cannot view another employees payslip → 404 (KHÔNG 403)', async () => {
      const payslip = makePayslip({
        employee: {
          id: 1,
          user_id: 99, // Different from saleUser.userId (10)
          position: 'sales',
          team_id: 1,
          user: { full_name: 'Other', email: 'other@example.net' },
        },
      })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      await expect(service.findById(1, saleUser)).rejects.toThrow(
        NotFoundException,
      )
    })

    it('team_lead cannot view payslip outside manager_id subtree → 404 (KHÔNG 403)', async () => {
      // team_lead has no subordinates -> allowed = [5]; payslip.user_id=99 blocked
      mockScope.ownerIds.mockResolvedValue([5])
      const payslip = makePayslip({
        employee: {
          id: 1,
          user_id: 99,
          position: 'sales',
          team_id: 2,
          user: { full_name: 'Other Team', email: 'ot@example.net' },
        },
      })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      await expect(service.findById(1, teamLeadUser)).rejects.toThrow(
        NotFoundException,
      )
    })

    it('accountant can view any payslip', async () => {
      const payslip = makePayslip()
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      const result = await service.findById(1, accountantUser)
      expect(result.id).toBe(1)
    })
  })

  describe('generate', () => {
    const activeEmployees = [
      { id: 1, salary_rule_id: 1, position: 'sales' },
      { id: 2, salary_rule_id: 1, position: 'sales' },
    ]

    beforeEach(() => {
      mockPrisma.salaryRuleDetail.findMany.mockResolvedValue([
        { component: 'base', amount: BigInt(7_000_000), formula: null },
      ])
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
    })

    it('generates payslips for all active employees', async () => {
      mockPrisma.employee.findMany.mockResolvedValue(activeEmployees)
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })

      const result = await service.generate('2026-03')

      expect(result.generated).toBe(2)
      expect(result.skipped).toBe(0)
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'active', deleted_at: null },
        }),
      )
    })

    it('generates payslips for specific employee_ids', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })

      const result = await service.generate('2026-03', [1])

      expect(result.generated).toBe(1)
      expect(mockPrisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'active', deleted_at: null, id: { in: [1] } },
        }),
      )
    })

    it('skips non-draft existing payslips', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue({
        id: 1,
        status: 'approved',
      })

      const result = await service.generate('2026-03')

      expect(result.generated).toBe(0)
      expect(result.skipped).toBe(1)
      expect(mockPrisma.payslip.create).not.toHaveBeenCalled()
    })

    it('updates existing draft payslips', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue({
        id: 1,
        status: 'draft',
        // DB row đầy đủ cột mẫu (default sau migration)
        working_days: null,
        standard_working_days: 26,
        base_salary: BigInt(7_000_000),
        training_days: null,
        training_salary: BigInt(0),
        probation_allowance: BigInt(0),
        sales_personal: BigInt(0),
        bonus_rate: null,
        kpi_percent: null,
        bonus_sales_personal: BigInt(0),
        sales_team: BigInt(0),
        bonus_cskh_team: BigInt(0),
        bonus_milestone: BigInt(0),
        bonus_referral: BigInt(0),
        holiday_bonus: BigInt(0),
        advances: BigInt(0),
        personal_income_tax: BigInt(0),
        notes: null,
      })
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })

      const result = await service.generate('2026-03')

      expect(result.generated).toBe(1)
      expect(mockPrisma.payslip.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
        }),
      )
    })

    it('calculates total from base + kpi bonus', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([
        { achieved: true, achievement_rate: 120 },
        { achieved: true, achievement_rate: 100 },
        { achieved: false, achievement_rate: 50 },
      ])

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          base_salary: BigInt(7_000_000),
          kpi_bonus: BigInt(1_000_000), // 2 achieved * 500,000
          total: BigInt(8_000_000), // 7M + 1M
        }),
      })
    })

    it('tự cộng phụ cấp + thưởng − khấu trừ từ Thành phần lương + lưu components_json', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockSalaryEngine.computeForEmployee.mockResolvedValueOnce({
        allowances: BigInt(300_000),
        bonuses: BigInt(500_000),
        deductions: BigInt(100_000),
        taxableEarnings: BigInt(800_000),
        snapshot: [
          { code: 'allowance_phone', name: 'PC ĐT', component_type: 'allowance', calc_method: 'fixed', amount: 300000 },
        ],
      })

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          total: BigInt(7_700_000), // 7M base + 300k + 500k − 100k
          deductions: BigInt(100_000),
          components_json: expect.arrayContaining([
            expect.objectContaining({ code: 'allowance_phone' }),
          ]),
        }),
      })
    })

    it('bảo hiểm BHXH/BHYT/BHTN trừ vào total + lưu insurance_json', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockInsuranceEngine.compute.mockResolvedValueOnce({
        total: BigInt(735_000), // base 7M × 10.5%
        snapshot: [{ code: 'bhxh', name: 'BHXH', rate: 8, base: 7000000, amount: 560000 }],
      })

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          total: BigInt(6_265_000), // 7M base − 735k bảo hiểm
          deductions: BigInt(735_000),
          insurance_json: expect.arrayContaining([
            expect.objectContaining({ code: 'bhxh' }),
          ]),
        }),
      })
    })

    it('BHXH tính trên mức cố định theo chức vụ (default_insurance_salary), KHÔNG lương cơ bản', async () => {
      // jobTitle.default = 4.5M < base 7M → insuranceBase phải = 4.5M (mức đóng BHXH theo chức vụ)
      mockPrisma.employee.findMany.mockResolvedValue([
        {
          ...activeEmployees[0],
          insurance_salary: null,
          jobTitle: { base_salary: BigInt(7_000_000), rank_code: null, default_insurance_salary: BigInt(4_500_000) },
        },
      ])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockInsuranceEngine.compute.mockResolvedValueOnce({ total: BigInt(472_500), snapshot: [] })

      await service.generate('2026-03')

      // compute() nhận mức đóng cố định 4.5M (KHÔNG phải 7M)
      expect(mockInsuranceEngine.compute).toHaveBeenCalledWith(BigInt(4_500_000), '2026-03')
      // insurance_base lưu authoritative = 4.5M
      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ insurance_base: BigInt(4_500_000) }),
      })
    })

    it('override cá nhân insurance_salary THẮNG mức chức vụ', async () => {
      // insurance_salary = 8M (override) > jobTitle.default 4.5M → insuranceBase = 8M
      mockPrisma.employee.findMany.mockResolvedValue([
        {
          ...activeEmployees[0],
          insurance_salary: BigInt(8_000_000),
          jobTitle: { base_salary: BigInt(7_000_000), rank_code: null, default_insurance_salary: BigInt(4_500_000) },
        },
      ])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockInsuranceEngine.compute.mockResolvedValueOnce({ total: BigInt(840_000), snapshot: [] })

      await service.generate('2026-03')

      expect(mockInsuranceEngine.compute).toHaveBeenCalledWith(BigInt(8_000_000), '2026-03')
    })

    it('chưa cấu hình mức chức vụ (null) → BHXH trên lương cơ bản (backward-safe)', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([
        {
          ...activeEmployees[0],
          insurance_salary: null,
          jobTitle: { base_salary: BigInt(7_000_000), rank_code: null, default_insurance_salary: null },
        },
      ])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockInsuranceEngine.compute.mockResolvedValueOnce({ total: BigInt(735_000), snapshot: [] })

      await service.generate('2026-03')

      // null default → fallback lương cơ bản 7M (như trước)
      expect(mockInsuranceEngine.compute).toHaveBeenCalledWith(BigInt(7_000_000), '2026-03')
    })

    it('thuế TNCN trừ vào total + lưu tax_json', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockTaxEngine.compute.mockResolvedValueOnce({
        tax: BigInt(250_000),
        snapshot: { taxable_income: 5_000_000, tax: 250_000, brackets: [{ rate: 5, portion: 5000000, tax: 250000 }] },
      })

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          total: BigInt(6_750_000), // 7M base − 250k thuế
          deductions: BigInt(250_000),
          tax_json: expect.objectContaining({ tax: 250_000 }),
        }),
      })
    })

    it('clamp total về 0 khi khấu trừ > thu nhập (chống phát lương âm)', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([activeEmployees[0]])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockSalaryEngine.computeForEmployee.mockResolvedValueOnce({
        allowances: BigInt(0),
        bonuses: BigInt(0),
        deductions: BigInt(50_000_000), // > 7M base
        taxableEarnings: BigInt(0),
        snapshot: [
          { code: 'deduction_big', name: 'Tạm ứng', component_type: 'deduction', calc_method: 'fixed', amount: 50000000 },
        ],
      })

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          total: BigInt(0), // 7M − 50M < 0 → clamp 0
          deductions: BigInt(50_000_000),
          // snapshot VẪN lưu dù total clamp → kế toán thấy lý do qua "Chi tiết" khi duyệt
          components_json: expect.arrayContaining([
            expect.objectContaining({ code: 'deduction_big' }),
          ]),
        }),
      })
    })
  })

  describe('mẫu prorate ngày công + điền sẵn + edit', () => {
    const emp = { id: 1, salary_rule_id: 1, position: 'sales' }

    beforeEach(() => {
      mockPrisma.salaryRuleDetail.findMany.mockResolvedValue([
        { component: 'base', amount: BigInt(7_000_000), formula: null },
      ])
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockPrisma.employee.findUnique.mockResolvedValue({ user_id: 10 })
    })

    it('thực lĩnh LCB prorate theo ngày công (12/24 → nửa lương)', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([emp])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.attendanceRecord.findMany.mockResolvedValueOnce(
        Array.from({ length: 12 }, () => ({ status: 'on_time' })),
      )

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          working_days: 12,
          base_salary: BigInt(7_000_000),
          base_salary_actual: BigInt(3_500_000), // 7M × 12/24 (chuẩn 24 ngày)
          total: BigInt(3_500_000), // chỉ thực lĩnh LCB (không thưởng/giảm trừ)
        }),
      })
    })

    it('KPI đạt → điền sẵn Thưởng mốc', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([emp])
      mockPrisma.payslip.findUnique.mockResolvedValue(null)
      mockPrisma.payslip.create.mockResolvedValue({ id: 1 })
      mockPrisma.kpiResult.findMany.mockResolvedValue([
        { achieved: true, achievement_rate: 100 },
      ])

      await service.generate('2026-03')

      expect(mockPrisma.payslip.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bonus_sales_personal: BigInt(0),
          bonus_milestone: BigInt(500_000), // 1 KPI đạt × 500k
          total: BigInt(7_500_000), // 7M base + 500k
        }),
      })
    })

    it('PATCH thêm thưởng giới thiệu → tổng tăng + lưu DB', async () => {
      const draftRow = {
        id: 1,
        month: '2026-03',
        status: 'draft',
        working_days: null,
        standard_working_days: 26,
        base_salary: BigInt(7_000_000),
        training_days: null,
        training_salary: BigInt(0),
        probation_allowance: BigInt(0),
        sales_personal: BigInt(0),
        bonus_rate: null,
        kpi_percent: null,
        bonus_sales_personal: BigInt(0),
        sales_team: BigInt(0),
        bonus_cskh_team: BigInt(0),
        bonus_milestone: BigInt(0),
        bonus_referral: BigInt(0),
        holiday_bonus: BigInt(0),
        advances: BigInt(0),
        personal_income_tax: BigInt(0),
        notes: null,
        employee: {
          id: 1,
          user_id: 10,
          salary_rule_id: 1,
          position: 'sales',
          job_title_id: null,
          insurance_salary: null,
          dependents_count: 0,
          jobTitle: null,
        },
      }
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(draftRow) // update()
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(makePayslip()) // findById()

      await service.update(1, { bonus_referral: '2000000' }, adminUser)

      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          bonus_referral: BigInt(2_000_000),
          total: BigInt(9_000_000), // 7M base + 2M thưởng
        }),
      })
    })

    it('thuế TNCN nhập tay GHI ĐÈ thuế hệ thống: chỉ trừ một lần', async () => {
      const draftRow = {
        id: 1, month: '2026-03', status: 'draft', deleted_at: null, working_days: null, standard_working_days: 26,
        base_salary: BigInt(7_000_000), training_days: null, training_salary: BigInt(0), probation_allowance: BigInt(0),
        sales_personal: BigInt(0), bonus_rate: null, kpi_percent: null, bonus_sales_personal: BigInt(0), sales_team: BigInt(0),
        bonus_cskh_team: BigInt(0), bonus_milestone: BigInt(0), bonus_referral: BigInt(0), holiday_bonus: BigInt(0),
        advances: BigInt(0), personal_income_tax: BigInt(0), notes: null,
        employee: { id: 1, user_id: 10, salary_rule_id: 1, position: 'sales', job_title_id: null, insurance_salary: null, dependents_count: 0, jobTitle: null },
      }
      mockTaxEngine.compute.mockResolvedValueOnce({ tax: BigInt(500_000), snapshot: null })
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(draftRow)
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(makePayslip())

      await service.update(1, { personal_income_tax: '300000' }, adminUser)

      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          personal_income_tax: BigInt(300_000),
          deductions: BigInt(0), // thuế hệ thống 500k KHÔNG còn nằm trong deductions
          total: BigInt(6_700_000), // 7M − 300k nhập tay (không trừ thêm 500k)
        }),
      })
    })

    it('phiếu đã loại khỏi kỳ (xoá mềm) không sửa được', async () => {
      mockPrisma.payslip.findUnique.mockResolvedValueOnce({ id: 1, status: 'draft', deleted_at: new Date() })
      await expect(service.update(1, { notes: 'x' }, adminUser)).rejects.toThrow('khong ton tai')
    })

    it('Thưởng Lễ: PATCH holiday_bonus → cộng vào total (KHÁC passthrough)', async () => {
      const draftRow = {
        id: 1,
        month: '2026-03',
        status: 'draft',
        working_days: null,
        standard_working_days: 26,
        base_salary: BigInt(7_000_000),
        training_days: null,
        training_salary: BigInt(0),
        probation_allowance: BigInt(0),
        sales_personal: BigInt(0),
        bonus_rate: null,
        kpi_percent: null,
        bonus_sales_personal: BigInt(0),
        sales_team: BigInt(0),
        bonus_cskh_team: BigInt(0),
        bonus_milestone: BigInt(0),
        bonus_referral: BigInt(0),
        holiday_bonus: BigInt(0),
        advances: BigInt(0),
        personal_income_tax: BigInt(0),
        notes: null,
        employee: {
          id: 1,
          user_id: 10,
          salary_rule_id: 1,
          position: 'sales',
          job_title_id: null,
          insurance_salary: null,
          dependents_count: 0,
          jobTitle: null,
        },
      }
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(draftRow) // update()
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(makePayslip()) // findById()

      await service.update(1, { holiday_bonus: '1500000' }, adminUser)

      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          holiday_bonus: BigInt(1_500_000),
          total: BigInt(8_500_000), // 7M base + 1.5M Thưởng Lễ (cộng vào cong_thuong)
        }),
      })
    })

    it('PATCH hệ số + chi_lần — passthrough, KHÔNG đổi total', async () => {
      const draftRow = {
        id: 1,
        month: '2026-03',
        status: 'draft',
        working_days: null,
        standard_working_days: 26,
        base_salary: BigInt(7_000_000),
        training_days: null,
        training_salary: BigInt(0),
        probation_allowance: BigInt(0),
        sales_personal: BigInt(1_000_000_000),
        bonus_rate: null,
        kpi_percent: null,
        bonus_sales_personal: BigInt(0),
        sales_team: BigInt(0),
        bonus_cskh_team: BigInt(0),
        bonus_milestone: BigInt(0),
        bonus_referral: BigInt(0),
        holiday_bonus: BigInt(0),
        advances: BigInt(0),
        personal_income_tax: BigInt(0),
        notes: null,
        employee: {
          id: 1,
          user_id: 10,
          salary_rule_id: 1,
          position: 'sales',
          job_title_id: null,
          insurance_salary: null,
          dependents_count: 0,
          jobTitle: null,
        },
      }
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(draftRow) // update()
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })
      mockPrisma.payslip.findUnique.mockResolvedValueOnce(makePayslip()) // findById()

      await service.update(
        1,
        { bonus_rate: 0.8, kpi_percent: 90 },
        adminUser,
      )

      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          bonus_rate: 0.8, // lưu passthrough
          kpi_percent: 90, // passthrough
          // total CHỈ từ base (hệ số KHÔNG cộng/trừ): 7M, bonus_sales_personal vẫn 0
          total: BigInt(7_000_000),
        }),
      })
    })

    it('serialize trả hệ số, đơn giá, bonus gợi ý, STK/ngân hàng', async () => {
      const payslip = makePayslip({
        base_salary: BigInt(7_800_000),
        standard_working_days: 26,
        sales_personal: BigInt(1_000_000_000),
        bonus_rate: 0.8,
        kpi_percent: 85.5,
        employee: {
          id: 1,
          user_id: 10,
          position: 'sales',
          team_id: 1,
          user: { full_name: 'Nguyen Van A', email: 'a@example.net' },
          bank_account_number: '0123456789',
          bank_name: 'Acme',
        },
      })
      mockPrisma.payslip.findUnique.mockResolvedValue(payslip)

      const result = await service.findById(1, adminUser)

      expect(result.bonus_rate).toBe(0.8)
      expect(result.kpi_percent).toBe(85.5) // passthrough
      expect(result.don_gia_ngay_cong).toBe('300000') // 7.8M / 26
      expect(result.bonus_sales_personal_suggested).toBe('8000000') // 1 tỷ × 0.8%
      expect(result.employee.bank_account_number).toBe('0123456789')
      expect(result.employee.bank_name).toBe('Acme')
    })

    it('chặn sửa phiếu đã DUYỆT (giữ audit)', async () => {
      mockPrisma.payslip.findUnique.mockResolvedValue({
        id: 1,
        month: '2026-03',
        status: 'approved',
        employee: {
          id: 1,
          user_id: 10,
          salary_rule_id: null,
          position: 'sales',
          job_title_id: null,
          insurance_salary: null,
          dependents_count: 0,
          jobTitle: null,
        },
      })

      await expect(
        service.update(1, { advances: '1000000' }, adminUser),
      ).rejects.toThrow(BadRequestException)
      expect(mockPrisma.payslip.update).not.toHaveBeenCalled()
    })
  })

  describe('computeBonusSuggestion — hệ số (%) × doanh số', () => {
    it('ví dụ: 20,8 tỷ × 0,4% = 83,2tr', () => {
      expect(computeBonusSuggestion(BigInt(20_800_000_000), 0.4)).toBe(
        BigInt(83_200_000),
      )
    })

    it('tỉ lệ 6% × 1 tỷ = 60tr', () => {
      expect(computeBonusSuggestion(BigInt(1_000_000_000), 6)).toBe(
        BigInt(60_000_000),
      )
    })

    it('hệ số null → 0', () => {
      expect(computeBonusSuggestion(BigInt(1_000_000_000), null)).toBe(BigInt(0))
    })

    it('hệ số 0 → 0', () => {
      expect(computeBonusSuggestion(BigInt(1_000_000_000), 0)).toBe(BigInt(0))
    })
  })

  describe('generateEmployeeListExcel (danh sách lương 1 sheet)', () => {
    it('super_admin: trả Buffer, query KHÔNG scope theo employee', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([makePayslip()])
      const buf = await service.generateEmployeeListExcel('2026-03', adminUser)
      expect(Buffer.isBuffer(buf)).toBe(true)
      const arg = mockPrisma.payslip.findMany.mock.calls[0][0]
      expect(arg.where).toEqual({ month: '2026-03', deleted_at: null })
    })

    it('sale: scope where.employee = { user_id: { in: [self] } }', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([makePayslip()])
      await service.generateEmployeeListExcel('2026-03', saleUser)
      const arg = mockPrisma.payslip.findMany.mock.calls[0][0]
      expect(arg.where.employee).toEqual({ user_id: { in: [saleUser.userId] } })
    })

    it('kỳ rỗng → NotFoundException', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([])
      await expect(
        service.generateEmployeeListExcel('2026-03', adminUser),
      ).rejects.toThrow(NotFoundException)
    })

    it('thứ tự dòng khớp bảng màn hình: theo team (quản lý trực tiếp) rồi tên', async () => {
      // Nhóm theo id manager tăng dần; không có manager xếp cuối.
      const listPayslip = (
        userId: number,
        fullName: string,
        managerId: number | null,
      ) =>
        makePayslip({
          employee: {
            id: userId,
            employee_code: `NV${userId}`,
            user_id: userId,
            position: 'sales',
            department: 'KD',
            bank_account_number: null,
            bank_name: null,
            jobTitle: null,
            user: {
              full_name: fullName,
              manager:
                managerId === null
                  ? null
                  : { id: managerId, full_name: `Lead ${managerId}` },
            },
          },
        })

      mockPrisma.payslip.findMany.mockResolvedValue([
        listPayslip(400, 'D không team', null),
        listPayslip(301, 'C nhân viên team 10', 10),
        listPayslip(302, 'A nhân viên team 10', 10),
        listPayslip(300, 'B nhân viên team 20', 20),
      ])

      const buf = await service.generateEmployeeListExcel('2026-03', adminUser)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as never)
      const ws = wb.worksheets[0]
      // Cột 3 = "Họ tên"; dữ liệu bắt đầu từ hàng 4.
      const names = [4, 5, 6, 7].map((r) => String(ws.getCell(r, 3).value))
      expect(names).toEqual([
        'A nhân viên team 10',
        'C nhân viên team 10',
        'B nhân viên team 20',
        'D không team',
      ])
    })

    // Helper tạo payslip cho test thứ tự theo orderedIds (đúng shape select của hàm).
    const listPayslipFor = (
      id: number,
      fullName: string,
      employeeCode: string | null,
    ) =>
      makePayslip({
        id,
        employee_id: id,
        employee: {
          id,
          employee_code: employeeCode,
          user_id: id,
          position: 'sales',
          department: 'KD',
          bank_account_number: null,
          bank_name: null,
          jobTitle: null,
          user: { full_name: fullName, manager: null },
        },
      })

    it('orderedIds: xuất ĐÚNG thứ tự FE gửi (khớp 100% màn hình) + giới hạn theo id', async () => {
      // findMany trả id-asc (như query thật orderBy id); FE gửi thứ tự đã sắp/lọc khác hẳn.
      mockPrisma.payslip.findMany.mockResolvedValue([
        listPayslipFor(7, 'An', 'NV0007'),
        listPayslipFor(12, 'Bình', 'NV0012'),
        listPayslipFor(31, 'Cường', 'NV0031'),
      ])
      const buf = await service.generateEmployeeListExcel('2026-03', adminUser, [
        31, 7, 12,
      ])

      // BE chỉ truy vấn đúng các id FE gửi (chốt chặn RBAC + đúng tập hiển thị).
      const arg = mockPrisma.payslip.findMany.mock.calls[0][0]
      expect(arg.where.id).toEqual({ in: [31, 7, 12] })

      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as never)
      const ws = wb.worksheets[0]
      const names = [4, 5, 6].map((r) => String(ws.getCell(r, 3).value))
      expect(names).toEqual(['Cường', 'An', 'Bình'])
    })

    it('orderedIds: id ngoài phạm vi (RBAC) bị loại, KHÔNG chèn dòng rỗng', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([
        listPayslipFor(7, 'An', 'NV0007'),
        listPayslipFor(12, 'Bình', 'NV0012'),
      ])
      // FE gửi cả id 99 (không thuộc kết quả query) → bị Map bỏ qua, không lọt vào file.
      const buf = await service.generateEmployeeListExcel('2026-03', adminUser, [
        12, 99, 7,
      ])
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as never)
      const ws = wb.worksheets[0]
      expect(String(ws.getCell(4, 3).value)).toBe('Bình')
      expect(String(ws.getCell(5, 3).value)).toBe('An')
      // Chỉ 2 dòng dữ liệu → hàng 6 là dòng TỔNG CỘNG (không có dòng rỗng cho id 99).
      expect(String(ws.getCell(6, 1).value)).toBe('TỔNG CỘNG')
    })

    it('mã NV trống → cột "Mã nhân viên" hiển thị NV<id> zero-pad 4 (NV0027)', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([
        listPayslipFor(27, 'Nguyễn Văn A', null),
      ])
      const buf = await service.generateEmployeeListExcel('2026-03', adminUser)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as never)
      const ws = wb.worksheets[0]
      expect(String(ws.getCell(4, 2).value)).toBe('NV0027')
    })

    it('orderedIds rỗng → giữ thứ tự mặc định theo team (KHÔNG thêm where.id)', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([
        listPayslipFor(7, 'An', 'NV0007'),
      ])
      await service.generateEmployeeListExcel('2026-03', adminUser, [])
      const arg = mockPrisma.payslip.findMany.mock.calls[0][0]
      expect(arg.where.id).toBeUndefined()
    })
  })

  describe('quản lý người trong kỳ — soft-delete + thêm lại', () => {
    // hr-tương-đương: giữ payroll.manage nhưng KHÔNG payroll.approve_final
    // (mirror hr cũ — được thao tác payslip.manage nhưng không phải người
    // duyệt bước 2, nên không được loại phiếu ĐÃ DUYỆT khỏi kỳ).
    const hrUser: AuthUser = {
      userId: 2,
      email: 'hr@example.net',
      isAdmin: false,
      grants: { 'payroll.manage': true },
    }

    it('findAll lọc deleted_at = null (ẩn phiếu đã loại)', async () => {
      mockPrisma.payslip.findMany.mockResolvedValue([])
      await service.findAll('2026-03', adminUser)
      expect(mockPrisma.payslip.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deleted_at: null }),
        }),
      )
    })

    it('generate BỎ QUA phiếu đã loại (deleted_at != null) — xóa dính', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([
        { id: 1, salary_rule_id: 1, position: 'sales' },
      ])
      mockPrisma.payslip.findUnique.mockResolvedValue({
        id: 1,
        status: 'draft',
        deleted_at: new Date('2026-03-10'),
      })
      mockPrisma.salaryRuleDetail.findMany.mockResolvedValue([])
      mockPrisma.kpiResult.findMany.mockResolvedValue([])

      const result = await service.generate('2026-03')

      expect(result.skipped).toBe(1)
      expect(result.generated).toBe(0)
      expect(mockPrisma.payslip.create).not.toHaveBeenCalled()
      expect(mockPrisma.payslip.update).not.toHaveBeenCalled()
    })

    describe('removeFromPeriod', () => {
      it('soft-delete phiếu nháp: set deleted_at (Date) + deleted_by', async () => {
        mockPrisma.payslip.findUnique.mockResolvedValue({
          id: 7,
          status: 'draft',
          deleted_at: null,
          month: '2026-03',
          employee_id: 3,
        })
        mockPrisma.payslip.update.mockResolvedValue({ id: 7 })

        const res = await service.removeFromPeriod(7, accountantUser)

        const arg = mockPrisma.payslip.update.mock.calls[0][0]
        expect(arg.where).toEqual({ id: 7 })
        expect(arg.data.deleted_by).toBe(accountantUser.userId)
        expect(arg.data.deleted_at).toBeInstanceOf(Date)
        expect(res.employee_id).toBe(3)
      })

      it('phiếu không tồn tại → NotFoundException', async () => {
        mockPrisma.payslip.findUnique.mockResolvedValue(null)
        await expect(
          service.removeFromPeriod(99, accountantUser),
        ).rejects.toThrow(NotFoundException)
      })

      it('phiếu đã loại trước đó → NotFoundException', async () => {
        mockPrisma.payslip.findUnique.mockResolvedValue({
          id: 7,
          status: 'draft',
          deleted_at: new Date(),
          month: '2026-03',
          employee_id: 3,
        })
        await expect(
          service.removeFromPeriod(7, accountantUser),
        ).rejects.toThrow(NotFoundException)
      })

      it('phiếu ĐÃ DUYỆT: hr bị chặn (ForbiddenException)', async () => {
        mockPrisma.payslip.findUnique.mockResolvedValue({
          id: 7,
          status: 'approved',
          deleted_at: null,
          month: '2026-03',
          employee_id: 3,
        })
        await expect(service.removeFromPeriod(7, hrUser)).rejects.toThrow(
          ForbiddenException,
        )
        expect(mockPrisma.payslip.update).not.toHaveBeenCalled()
      })

      it('phiếu ĐÃ DUYỆT: kế toán được loại', async () => {
        mockPrisma.payslip.findUnique.mockResolvedValue({
          id: 7,
          status: 'approved',
          deleted_at: null,
          month: '2026-03',
          employee_id: 3,
        })
        mockPrisma.payslip.update.mockResolvedValue({ id: 7 })
        await service.removeFromPeriod(7, accountantUser)
        expect(mockPrisma.payslip.update).toHaveBeenCalled()
      })
    })

    describe('addToPeriod', () => {
      beforeEach(() => {
        mockPrisma.salaryRuleDetail.findMany.mockResolvedValue([])
        mockPrisma.kpiResult.findMany.mockResolvedValue([])
          mockPrisma.employee.findUnique.mockResolvedValue({ user_id: 10 })
      })

      it('NV không active → BadRequestException', async () => {
        mockPrisma.employee.findMany.mockResolvedValue([]) // fetchEmployees rỗng
        await expect(
          service.addToPeriod('2026-03', 5, accountantUser),
        ).rejects.toThrow(BadRequestException)
      })

      it('khôi phục phiếu đã loại → gỡ deleted_at, KHÔNG tạo mới', async () => {
        mockPrisma.employee.findMany.mockResolvedValue([
          { id: 5, salary_rule_id: null, position: 'sales' },
        ])
        mockPrisma.payslip.findUnique
          .mockResolvedValueOnce({ id: 50, deleted_at: new Date('2026-03-05') })
          .mockResolvedValueOnce(makePayslip({ id: 50 }))
        mockPrisma.payslip.update.mockResolvedValue({ id: 50 })

        const res = await service.addToPeriod('2026-03', 5, accountantUser)

        expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
          where: { id: 50 },
          data: { deleted_at: null, deleted_by: null },
        })
        expect(res.id).toBe(50)
        expect(mockPrisma.payslip.create).not.toHaveBeenCalled()
      })

      it('đã có phiếu (chưa loại) → BadRequestException', async () => {
        mockPrisma.employee.findMany.mockResolvedValue([
          { id: 5, salary_rule_id: null, position: 'sales' },
        ])
        mockPrisma.payslip.findUnique.mockResolvedValue({
          id: 50,
          deleted_at: null,
        })
        await expect(
          service.addToPeriod('2026-03', 5, accountantUser),
        ).rejects.toThrow(BadRequestException)
        expect(mockPrisma.payslip.update).not.toHaveBeenCalled()
      })

      it('chưa có phiếu → tạo mới', async () => {
        mockPrisma.employee.findMany.mockResolvedValue([
          { id: 5, salary_rule_id: null, position: 'sales' },
        ])
        mockPrisma.payslip.findUnique
          .mockResolvedValueOnce(null) // addToPeriod: chưa có
          .mockResolvedValueOnce(null) // generateForEmployee: chưa có
          .mockResolvedValueOnce({ id: 60 }) // lookup phiếu vừa tạo
          .mockResolvedValueOnce(makePayslip({ id: 60 })) // findById serialize
        mockPrisma.payslip.create.mockResolvedValue({ id: 60 })

        const res = await service.addToPeriod('2026-03', 5, accountantUser)

        expect(mockPrisma.payslip.create).toHaveBeenCalled()
        expect(res.id).toBe(60)
      })
    })

    describe('listAddableEmployees', () => {
      it('loại NV đã có phiếu chưa-loại trong kỳ + fallback mã NV', async () => {
        mockPrisma.employee.findMany.mockResolvedValue([
          {
            id: 1,
            employee_code: 'MNV1',
            user_id: 10,
            position: 'sales',
            user: { full_name: 'A', email: 'a@x', manager: null },
            jobTitle: { name: 'CV' },
          },
          {
            id: 2,
            employee_code: null,
            user_id: 11,
            position: 'sales',
            user: { full_name: 'B', email: 'b@x', manager: null },
            jobTitle: null,
          },
        ])
        mockPrisma.payslip.findMany.mockResolvedValue([{ employee_id: 1 }])

        const res = await service.listAddableEmployees('2026-03', adminUser)

        expect(res).toHaveLength(1)
        expect(res[0].employee_id).toBe(2)
        // Fallback khi employee_code null → NV<id> zero-pad 4 (khớp "Quản lý nhân viên", KHÔNG cắt số 0).
        expect(res[0].employee_code).toBe('NV0002')
      })

      // Route chỉ mở cho `payroll.manage` (unscoped) — KHÔNG còn thu hẹp theo
      // subtree như hệ role cũ (4 role cũ gọi được endpoint này đều full-scope).
      it('KHÔNG scope theo user gọi — payroll.manage là quyền unscoped', async () => {
        mockPrisma.employee.findMany.mockResolvedValue([])
        mockPrisma.payslip.findMany.mockResolvedValue([])
        await service.listAddableEmployees('2026-03', adminUser)
        const arg = mockPrisma.employee.findMany.mock.calls[0][0]
        expect(arg.where).toEqual({ status: 'active' })
      })
    })
  })

  // + MAJOR — import Excel PHẢI đi qua buildPayslipData() (không ghi raw field)
  // + ghi trong 1 transaction + chặn Decimal overflow SỚM (không sập cả batch).
  describe('applyImport — recompute total qua buildPayslipData', () => {
    function buildImportBuffer(rows: Array<[string, Record<string, string | number>]>) {
      return (async () => {
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('sheet')
        const fieldHeaders = Array.from(new Set(rows.flatMap(([, f]) => Object.keys(f))))
        ws.addRow(['Mã NV', 'Họ tên', ...fieldHeaders])
        for (const [code, fields] of rows) {
          ws.addRow([code, 'Nhân viên', ...fieldHeaders.map((h) => fields[h] ?? '')])
        }
        const buf = await wb.xlsx.writeBuffer()
        return Buffer.from(buf)
      })()
    }

    const empBase = {
      id: 1,
      user_id: 10,
      salary_rule_id: null,
      position: 'sales',
      job_title_id: null,
      insurance_salary: null,
      dependents_count: 0,
      employee_code: 'NV0001',
      user: { full_name: 'Nguyen Van A' },
      jobTitle: null,
    }

    function draftPayslip(overrides: Record<string, unknown> = {}) {
      return {
        id: 1,
        employee_id: 1,
        month: '2026-03',
        status: 'draft',
        base_salary: BigInt(7_000_000),
        working_days: null,
        standard_working_days: 26,
        base_salary_actual: BigInt(7_000_000),
        training_days: null,
        training_salary: BigInt(0),
        probation_allowance: BigInt(0),
        sales_personal: BigInt(0),
        bonus_rate: null,
        kpi_percent: null,
        bonus_sales_personal: BigInt(0),
        sales_team: BigInt(0),
        bonus_cskh_team: BigInt(0),
        bonus_milestone: BigInt(0),
        bonus_referral: BigInt(0),
        holiday_bonus: BigInt(0),
        advances: BigInt(0),
        personal_income_tax: BigInt(0),
        notes: null,
        insurance_base: BigInt(0),
        insurance_json: [],
        tax_json: null,
        components_json: [],
        kpi_bonus: BigInt(0),
        deductions: BigInt(0),
        total: BigInt(7_000_000),
        tl_approved_by: null,
        tl_approved_at: null,
        approved_by: null,
        approved_at: null,
        created_at: new Date('2026-03-31'),
        updated_at: new Date('2026-03-31'),
        ...overrides,
      }
    }

    beforeEach(() => {
      mockPrisma.kpiResult.findMany.mockResolvedValue([])
      mockPrisma.salaryRuleDetail.findMany.mockResolvedValue([])
      mockPrisma.employee.findUnique.mockResolvedValue({ user_id: 10 })
    })

    it('BLOCKER: import "Lương học việc" (training_salary, ảnh hưởng total) → total được recompute ĐÚNG qua buildPayslipData, KHÔNG ghi raw field', async () => {
      mockPrisma.employee.findMany.mockResolvedValue([empBase])
      mockPrisma.payslip.findMany.mockResolvedValue([draftPayslip()])
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })

      const buf = await buildImportBuffer([['NV0001', { 'Lương học việc': 1_000_000 }]])

      await service.applyImport(buf, '2026-03', adminUser)

      // 7M (base_salary_actual) + 1M (training_salary mới) = 8M — nếu bug cũ (ghi raw field
      // không recompute) thì total vẫn giữ nguyên 7M cũ trong payload update.
      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          training_salary: BigInt(1_000_000),
          base_salary_actual: BigInt(7_000_000),
          total: BigInt(8_000_000),
        }),
      })
    })

    it('MAJOR: 1 dòng kpi_percent vượt biên (>999.99) bị skip có lý do rõ ràng, KHÔNG sập cả batch — dòng hợp lệ khác vẫn được áp dụng', async () => {
      const emp2 = { ...empBase, id: 2, employee_code: 'NV0002', user: { full_name: 'Nguyen Van B' } }
      mockPrisma.employee.findMany.mockResolvedValue([empBase, emp2])
      mockPrisma.payslip.findMany.mockResolvedValue([
        draftPayslip(),
        draftPayslip({ id: 2, employee_id: 2 }),
      ])
      mockPrisma.payslip.update.mockResolvedValue({ id: 1 })

      const buf = await buildImportBuffer([
        ['NV0001', { '% KPI': 1500 }], // vượt biên Decimal(5,2) tối đa 999.99
        ['NV0002', { 'Lương học việc': 500_000 }], // dòng hợp lệ khác
      ])

      const result = await service.applyImport(buf, '2026-03', adminUser)

      const rowA = result.find((r) => r.employee_code === 'NV0001')
      const rowB = result.find((r) => r.employee_code === 'NV0002')

      expect(rowA?.skipped).toBe(true)
      expect(rowA?.skip_reason).toContain('kpi_percent vượt giới hạn cho phép (tối đa 999.99)')

      expect(rowB?.skipped).toBe(false)
      expect(mockPrisma.payslip.update).toHaveBeenCalledWith({
        where: { id: 2 },
        data: expect.objectContaining({ training_salary: BigInt(500_000) }),
      })
      // Dòng lỗi KHÔNG được ghi (không có payload update() nào cho id:1 trong batch này).
      expect(mockPrisma.payslip.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 } }),
      )
    })
  })
})
