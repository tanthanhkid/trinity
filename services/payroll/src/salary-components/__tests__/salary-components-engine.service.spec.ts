import { Test, TestingModule } from '@nestjs/testing'
import { PrismaService } from '@trinity/prisma'
import { SalaryComponentsEngine } from '../salary-components-engine.service'

const mockPrisma = { salaryComponent: { findMany: jest.fn() } }

function comp(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, name: 'X', code: 'x', component_type: 'allowance', calc_method: 'fixed',
    fixed_amount: BigInt(0), percent_value: null, applies_to: 'all',
    effective_from: '2026-01', effective_to: null, is_active: true, sort_order: 0,
    ...over,
  }
}

describe('SalaryComponentsEngine', () => {
  let engine: SalaryComponentsEngine

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SalaryComponentsEngine, { provide: PrismaService, useValue: mockPrisma }],
    }).compile()
    engine = module.get(SalaryComponentsEngine)
    jest.clearAllMocks()
  })

  it('fixed → cộng đúng số tiền vào đúng nhóm', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      comp({ component_type: 'allowance', calc_method: 'fixed', fixed_amount: BigInt(300000) }),
      comp({ id: 2, component_type: 'bonus', calc_method: 'fixed', fixed_amount: BigInt(500000) }),
      comp({ id: 3, component_type: 'deduction', calc_method: 'fixed', fixed_amount: BigInt(100000) }),
    ])
    const r = await engine.computeForEmployee(BigInt(10_000_000), '2026-07', null)
    expect(r.allowances).toBe(BigInt(300000))
    expect(r.bonuses).toBe(BigInt(500000))
    expect(r.deductions).toBe(BigInt(100000))
    expect(r.snapshot).toHaveLength(3)
  })

  it('percent_base → round(base * pct / 100), làm tròn đồng', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      comp({ calc_method: 'percent_base', percent_value: { toString: () => '8' }, component_type: 'deduction' }),
    ])
    const r = await engine.computeForEmployee(BigInt(6_600_000), '2026-07', null)
    expect(r.deductions).toBe(BigInt(528000)) // 6.6tr * 8% = 528000
  })

  it('percent_base lẻ → Math.round', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      comp({ calc_method: 'percent_base', percent_value: { toString: () => '1.5' } }),
    ])
    const r = await engine.computeForEmployee(BigInt(7_333_333), '2026-07', null)
    // 7333333 * 1.5 / 100 = 109999.995 → round 110000
    expect(r.allowances).toBe(BigInt(110000))
  })

  it("applies_to 'rank:NV' chỉ áp cho rank khớp", async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      comp({ applies_to: 'rank:NV', fixed_amount: BigInt(200000) }),
    ])
    const matched = await engine.computeForEmployee(BigInt(6_000_000), '2026-07', 'NV')
    expect(matched.allowances).toBe(BigInt(200000))
    const unmatched = await engine.computeForEmployee(BigInt(6_000_000), '2026-07', 'TN')
    expect(unmatched.allowances).toBe(BigInt(0))
    const noRank = await engine.computeForEmployee(BigInt(6_000_000), '2026-07', null)
    expect(noRank.allowances).toBe(BigInt(0))
  })

  it("stacking 'all' + 'rank:NV' cùng áp cho NV (component khác nhau)", async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      comp({ id: 1, code: 'a', applies_to: 'all', fixed_amount: BigInt(100000) }),
      comp({ id: 2, code: 'b', applies_to: 'rank:NV', fixed_amount: BigInt(50000) }),
    ])
    const r = await engine.computeForEmployee(BigInt(6_000_000), '2026-07', 'NV')
    expect(r.allowances).toBe(BigInt(150000))
    expect(r.snapshot).toHaveLength(2)
  })

  it('amount = 0 → bỏ qua khỏi snapshot', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([
      comp({ fixed_amount: BigInt(0) }),
    ])
    const r = await engine.computeForEmployee(BigInt(6_000_000), '2026-07', null)
    expect(r.snapshot).toHaveLength(0)
    expect(r.allowances).toBe(BigInt(0))
  })

  it('where clause lọc is_active + effective range (effective_from <= month, effective_to null/>=month)', async () => {
    mockPrisma.salaryComponent.findMany.mockResolvedValue([])
    await engine.computeForEmployee(BigInt(1), '2026-07', null)
    const where = mockPrisma.salaryComponent.findMany.mock.calls[0][0].where
    expect(where.is_active).toBe(true)
    expect(where.effective_from).toEqual({ lte: '2026-07' })
    expect(where.OR).toEqual([{ effective_to: null }, { effective_to: { gte: '2026-07' } }])
  })
})
