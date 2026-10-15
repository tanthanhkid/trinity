import { Test, TestingModule } from '@nestjs/testing'
import { PrismaService } from '@trinity/prisma'
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest'
import { TaxEngine } from '../tax.engine'
import { TaxConfigController } from '../tax-config.controller'

function grantedPerms(handler: (...args: never[]) => unknown): string[] {
  const meta = Reflect.getMetadata(RBAC_META, handler) as AccessMeta | undefined
  return meta?.kind === 'can' ? meta.permissions : []
}

const mockPrisma = {
  payrollTaxSetting: { findFirst: jest.fn() },
  taxBracket: { findMany: jest.fn() },
}
function dec(v: string) { return { toString: () => v } }
function vnBrackets(effective_from = '2026-06') {
  return [
    { bracket_order: 1, lower_bound: BigInt(0), upper_bound: BigInt(5_000_000), rate: dec('5'), effective_from },
    { bracket_order: 2, lower_bound: BigInt(5_000_000), upper_bound: BigInt(10_000_000), rate: dec('10'), effective_from },
    { bracket_order: 3, lower_bound: BigInt(10_000_000), upper_bound: BigInt(18_000_000), rate: dec('15'), effective_from },
    { bracket_order: 4, lower_bound: BigInt(18_000_000), upper_bound: BigInt(32_000_000), rate: dec('20'), effective_from },
    { bracket_order: 5, lower_bound: BigInt(32_000_000), upper_bound: BigInt(52_000_000), rate: dec('25'), effective_from },
    { bracket_order: 6, lower_bound: BigInt(52_000_000), upper_bound: BigInt(80_000_000), rate: dec('30'), effective_from },
    { bracket_order: 7, lower_bound: BigInt(80_000_000), upper_bound: null, rate: dec('35'), effective_from },
  ]
}
const VN_BRACKETS = vnBrackets()

describe('TaxEngine', () => {
  let engine: TaxEngine

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TaxEngine, { provide: PrismaService, useValue: mockPrisma }],
    }).compile()
    engine = module.get(TaxEngine)
    jest.clearAllMocks()
    mockPrisma.payrollTaxSetting.findFirst.mockResolvedValue({
      personal_deduction: BigInt(11_000_000), dependent_deduction: BigInt(4_400_000),
    })
    mockPrisma.taxBracket.findMany.mockResolvedValue(VN_BRACKETS)
  })

  it('chưa cấu hình giảm trừ → tax 0 + snapshot null', async () => {
    mockPrisma.payrollTaxSetting.findFirst.mockResolvedValue(null)
    const r = await engine.compute(BigInt(50_000_000), BigInt(0), 0, '2026-07')
    expect(r.tax).toBe(BigInt(0))
    expect(r.snapshot).toBeNull()
  })

  it('thu nhập tính thuế = 20tr → lũy tiến TỪNG PHẦN = 2.35tr (KHÔNG flat)', async () => {
    // taxable_income = 31tr gross − 0 BH − 11tr bản thân − 0 NPT = 20tr
    const r = await engine.compute(BigInt(31_000_000), BigInt(0), 0, '2026-07')
    // 5tr*5% + 5tr*10% + 8tr*15% + 2tr*20% = 250k+500k+1.2tr+400k = 2.35tr
    expect(r.tax).toBe(BigInt(2_350_000))
    expect(r.snapshot?.taxable_income).toBe(20_000_000)
    expect(r.snapshot?.brackets).toHaveLength(4) // chỉ 4 bậc có phần > 0
  })

  it('thu nhập ≤ giảm trừ → taxable 0 → tax 0', async () => {
    const r = await engine.compute(BigInt(10_000_000), BigInt(0), 0, '2026-07')
    expect(r.tax).toBe(BigInt(0))
    expect(r.snapshot?.taxable_income).toBe(0)
  })

  it('bảo hiểm + người phụ thuộc giảm thu nhập tính thuế', async () => {
    // gross 30tr − BH 3.15tr − bản thân 11tr − 2 NPT*4.4tr=8.8tr = 7.05tr taxable
    const r = await engine.compute(BigInt(30_000_000), BigInt(3_150_000), 2, '2026-07')
    expect(r.snapshot?.taxable_income).toBe(7_050_000)
    // 5tr*5% + 2.05tr*10% = 250k + 205k = 455k
    expect(r.tax).toBe(BigInt(455_000))
  })

  it('thu nhập rất cao chạm bậc 7 (>80tr taxable) tính hết phần dư 35%', async () => {
    // taxable = 100tr+11tr − 11tr = 100tr
    const r = await engine.compute(BigInt(111_000_000), BigInt(0), 0, '2026-07')
    // bậc1-6: 5*5+5*10+8*15+14*20+20*25+28*30 = 250+500+1200+2800+5000+8400 = 18.150k (cho 80tr đầu)
    // bậc7: 20tr*35% = 7.000k → tax = 25.150k
    expect(r.tax).toBe(BigInt(25_150_000))
  })

  it('2 bộ bậc cùng active (cũ 2024-07 + mới 2026-06) → CHỈ dùng bộ MỚI NHẤT (không trộn 14 bậc)', async () => {
    // bộ mới rate gấp đôi để phân biệt; DB trả desc effective_from → bộ mới đứng đầu
    const newSet = vnBrackets('2026-06').map((b) => ({ ...b, rate: dec(String(Number(b.rate.toString()) * 2)) }))
    const oldSet = vnBrackets('2024-07')
    mockPrisma.taxBracket.findMany.mockResolvedValue([...newSet, ...oldSet])
    const r = await engine.compute(BigInt(31_000_000), BigInt(0), 0, '2026-07')
    // taxable 20tr, bộ MỚI rate gấp đôi (10/20/30/40%) → 5tr*10%+5tr*20%+8tr*30%+2tr*40% = 500k+1tr+2.4tr+800k = 4.7tr
    expect(r.tax).toBe(BigInt(4_700_000))
    expect(r.snapshot?.brackets).toHaveLength(4) // chỉ bộ mới, KHÔNG 8 bậc trộn
  })

  it('bậc lệch/hở: định vị theo lower_bound, không cộng dồn độ rộng', async () => {
    // bậc 2 bắt đầu ở 10tr (hở 5–10tr): phần 5–10tr KHÔNG bị tính nhầm sang bậc 2
    mockPrisma.taxBracket.findMany.mockResolvedValue([
      { bracket_order: 1, lower_bound: BigInt(0), upper_bound: BigInt(5_000_000), rate: dec('10'), effective_from: '2026-06' },
      { bracket_order: 2, lower_bound: BigInt(10_000_000), upper_bound: null, rate: dec('20'), effective_from: '2026-06' },
    ])
    const r = await engine.compute(BigInt(11_000_000 + 12_000_000), BigInt(0), 0, '2026-07') // taxable 12tr
    // 5tr*10% + (12tr-10tr)*20% = 500k + 400k
    expect(r.tax).toBe(BigInt(900_000))
  })

  it('where lọc is_active + effective range', async () => {
    await engine.compute(BigInt(1), BigInt(0), 0, '2026-07')
    const bw = mockPrisma.taxBracket.findMany.mock.calls[0][0].where
    expect(bw.is_active).toBe(true)
    expect(bw.effective_from).toEqual({ lte: '2026-07' })
  })
})

describe('TaxConfigController — RBAC (quyền + phạm vi)', () => {
  it('GET config = payroll.manage', () => {
    expect(grantedPerms(TaxConfigController.prototype.getConfig)).toEqual(['payroll.manage'])
  })
  it('POST bracket = payroll.manage', () => {
    expect(grantedPerms(TaxConfigController.prototype.createBracket)).toEqual(['payroll.manage'])
  })
  it('DELETE bracket = payroll.manage', () => {
    expect(grantedPerms(TaxConfigController.prototype.removeBracket)).toEqual(['payroll.manage'])
  })
})
