import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'

export interface InsuranceLine {
  code: string
  name: string
  rate: number
  base: number
  amount: number
}

export interface InsuranceResult {
  total: bigint
  snapshot: InsuranceLine[]
}

/**
 * Engine khấu trừ bảo hiểm phần NLĐ đóng (BHXH/BHYT/BHTN), config-driven.
 * amount = min(lương đóng BH, trần) × tỷ lệ%. effective-dated theo tháng.
 * Luật VN đổi (tỷ lệ/trần) → super_admin tạo dòng config mới effective_from, KHÔNG sửa code.
 */
@Injectable()
export class InsuranceEngine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param insuranceBase lương đóng BH (= employee.insurance_salary ?? base_salary — lương HĐ, KHÔNG phải gross sau phụ cấp)
   * @param month 'YYYY-MM'
   */
  async compute(insuranceBase: bigint, month: string): Promise<InsuranceResult> {
    const settings = await this.fetchActiveSettings(month)
    let total = BigInt(0)
    const snapshot: InsuranceLine[] = []
    for (const s of settings) {
      const base = this.cappedBase(insuranceBase, s.base_cap)
      const rate = Number(s.employee_rate.toString())
      if (!Number.isFinite(rate) || rate <= 0 || base <= BigInt(0)) continue
      const amount = BigInt(Math.round((Number(base) * rate) / 100))
      if (amount <= BigInt(0)) continue
      total += amount
      snapshot.push({ code: s.code, name: s.name, rate, base: Number(base), amount: Number(amount) })
    }
    return { total, snapshot }
  }

  // So chuỗi 'YYYY-MM' = chronological vì DTO ép zero-pad. Số dòng BH nhỏ (≤vài) → không cần take.
  private fetchActiveSettings(month: string) {
    return this.prisma.insuranceSetting.findMany({
      where: {
        is_active: true,
        effective_from: { lte: month },
        OR: [{ effective_to: null }, { effective_to: { gte: month } }],
      },
      orderBy: { sort_order: 'asc' },
    })
  }

  // base = min(lương đóng BH, trần). base_cap null → không trần.
  private cappedBase(insuranceBase: bigint, baseCap: bigint | null): bigint {
    if (baseCap === null || baseCap <= BigInt(0)) return insuranceBase
    return insuranceBase < baseCap ? insuranceBase : baseCap
  }
}
