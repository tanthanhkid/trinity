import { Test, TestingModule } from '@nestjs/testing'
import { PrismaService } from '@trinity/prisma'
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest'
import { InsuranceEngine } from '../insurance.engine'
import { InsuranceSettingsController } from '../insurance-settings.controller'

function grantedPerms(handler: (...args: never[]) => unknown): string[] {
  const meta = Reflect.getMetadata(RBAC_META, handler) as AccessMeta | undefined
  return meta?.kind === 'can' ? meta.permissions : []
}

const mockPrisma = { insuranceSetting: { findMany: jest.fn() } }

function dec(v: string) {
  return { toString: () => v }
}
function setting(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, name: 'BHXH', code: 'bhxh', employee_rate: dec('8'),
    base_cap: null, effective_from: '2024-07', effective_to: null,
    is_active: true, sort_order: 1, ...over,
  }
}

describe('InsuranceEngine', () => {
  let engine: InsuranceEngine

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InsuranceEngine, { provide: PrismaService, useValue: mockPrisma }],
    }).compile()
    engine = module.get(InsuranceEngine)
    jest.clearAllMocks()
  })

  it('BHXH 8% không trần → base × 8%', async () => {
    mockPrisma.insuranceSetting.findMany.mockResolvedValue([setting({ employee_rate: dec('8'), base_cap: null })])
    const r = await engine.compute(BigInt(10_000_000), '2026-07')
    expect(r.total).toBe(BigInt(800_000))
    expect(r.snapshot[0]).toMatchObject({ code: 'bhxh', rate: 8, base: 10_000_000, amount: 800_000 })
  })

  it('trần lương đóng BH → tính trên min(base, cap)', async () => {
    mockPrisma.insuranceSetting.findMany.mockResolvedValue([
      setting({ employee_rate: dec('8'), base_cap: BigInt(46_800_000) }),
    ])
    // lương 60tr > trần 46.8tr → BHXH = 46.8tr * 8% = 3.744.000
    const r = await engine.compute(BigInt(60_000_000), '2026-07')
    expect(r.total).toBe(BigInt(3_744_000))
    expect(r.snapshot[0].base).toBe(46_800_000)
  })

  it('base dưới trần → tính trên base thật', async () => {
    mockPrisma.insuranceSetting.findMany.mockResolvedValue([
      setting({ employee_rate: dec('8'), base_cap: BigInt(46_800_000) }),
    ])
    const r = await engine.compute(BigInt(8_000_000), '2026-07')
    expect(r.total).toBe(BigInt(640_000))
    expect(r.snapshot[0].base).toBe(8_000_000)
  })

  it('3 loại BHXH+BHYT+BHTN → tổng 10.5%', async () => {
    mockPrisma.insuranceSetting.findMany.mockResolvedValue([
      setting({ id: 1, code: 'bhxh', name: 'BHXH', employee_rate: dec('8') }),
      setting({ id: 2, code: 'bhyt', name: 'BHYT', employee_rate: dec('1.5') }),
      setting({ id: 3, code: 'bhtn', name: 'BHTN', employee_rate: dec('1') }),
    ])
    const r = await engine.compute(BigInt(10_000_000), '2026-07')
    expect(r.total).toBe(BigInt(1_050_000)) // 800k + 150k + 100k
    expect(r.snapshot).toHaveLength(3)
  })

  it('rate 0 / base 0 → bỏ qua', async () => {
    mockPrisma.insuranceSetting.findMany.mockResolvedValue([setting({ employee_rate: dec('0') })])
    const r = await engine.compute(BigInt(10_000_000), '2026-07')
    expect(r.total).toBe(BigInt(0))
    expect(r.snapshot).toHaveLength(0)
  })

  it('where lọc is_active + effective range', async () => {
    mockPrisma.insuranceSetting.findMany.mockResolvedValue([])
    await engine.compute(BigInt(1), '2026-07')
    const where = mockPrisma.insuranceSetting.findMany.mock.calls[0][0].where
    expect(where.is_active).toBe(true)
    expect(where.effective_from).toEqual({ lte: '2026-07' })
    expect(where.OR).toEqual([{ effective_to: null }, { effective_to: { gte: '2026-07' } }])
  })
})

describe('InsuranceSettingsController — RBAC (quyền + phạm vi)', () => {
  it('GET = payroll.manage', () => {
    expect(grantedPerms(InsuranceSettingsController.prototype.findAll)).toEqual(['payroll.manage'])
  })
  it('POST = payroll.manage', () => {
    expect(grantedPerms(InsuranceSettingsController.prototype.create)).toEqual(['payroll.manage'])
  })
  it('DELETE = payroll.manage', () => {
    expect(grantedPerms(InsuranceSettingsController.prototype.remove)).toEqual(['payroll.manage'])
  })
})
