import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'

export interface TaxBracketLine {
  rate: number
  portion: number // phần thu nhập rơi vào bậc này
  tax: number
}

export interface TaxSnapshot {
  taxable_gross: number // thu nhập chịu thuế (base+kpi+phụ cấp/thưởng chịu thuế)
  insurance: number
  personal_deduction: number
  dependents_count: number
  dependent_deduction_total: number
  taxable_income: number // thu nhập TÍNH thuế (sau giảm trừ) — đầu vào biểu thuế
  brackets: TaxBracketLine[]
  tax: number
}

export interface TaxResult {
  tax: bigint
  snapshot: TaxSnapshot | null
}

/**
 * Engine thuế TNCN config-driven — biểu thuế lũy tiến TỪNG PHẦN + giảm trừ gia cảnh.
 * thu nhập tính thuế = thu nhập chịu thuế − bảo hiểm − giảm trừ bản thân − số NPT × giảm trừ NPT.
 * Thuế = Σ (phần thu nhập trong mỗi bậc × thuế suất bậc đó). Luật đổi → sửa config, KHÔNG sửa code.
 */
@Injectable()
export class TaxEngine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param taxableGross thu nhập chịu thuế (base + kpi + phụ cấp/thưởng is_taxable)
   * @param insurance tổng bảo hiểm NLĐ đóng (giảm trừ trước thuế)
   * @param dependentsCount số người phụ thuộc
   * @param month 'YYYY-MM'
   */
  async compute(
    taxableGross: bigint,
    insurance: bigint,
    dependentsCount: number,
    month: string,
  ): Promise<TaxResult> {
    const setting = await this.fetchActiveSetting(month)
    if (!setting) return { tax: BigInt(0), snapshot: null } // chưa cấu hình thuế → không tính

    const deps = Math.max(0, dependentsCount)
    const depTotal = setting.dependent_deduction * BigInt(deps)
    const rawTaxable = taxableGross - insurance - setting.personal_deduction - depTotal
    const taxableIncome = rawTaxable > BigInt(0) ? rawTaxable : BigInt(0)

    const brackets = await this.fetchActiveBrackets(month)
    const { tax, lines } = this.applyProgressive(taxableIncome, brackets)

    return {
      tax,
      snapshot: {
        taxable_gross: Number(taxableGross),
        insurance: Number(insurance),
        personal_deduction: Number(setting.personal_deduction),
        dependents_count: deps,
        dependent_deduction_total: Number(depTotal),
        taxable_income: Number(taxableIncome),
        brackets: lines,
        tax: Number(tax),
      },
    }
  }

  private fetchActiveSetting(month: string) {
    return this.prisma.payrollTaxSetting.findFirst({
      where: {
        is_active: true,
        effective_from: { lte: month },
        OR: [{ effective_to: null }, { effective_to: { gte: month } }],
      },
      orderBy: { effective_from: 'desc' },
    })
  }

  // Lấy ĐÚNG 1 bộ biểu thuế: bộ có effective_from MỚI NHẤT ≤ month (đang hiệu lực).
  // Khi luật đổi, admin thêm bộ mới (effective_from sau) → bộ mới THẮNG, KHÔNG trộn 14 bậc với bộ cũ.
  private async fetchActiveBrackets(month: string) {
    const all = await this.prisma.taxBracket.findMany({
      where: {
        is_active: true,
        effective_from: { lte: month },
        OR: [{ effective_to: null }, { effective_to: { gte: month } }],
      },
      orderBy: [{ effective_from: 'desc' }, { bracket_order: 'asc' }],
    })
    if (all.length === 0) return all
    const latestFrom = all[0].effective_from // effective_from mới nhất (đã sort desc)
    return all
      .filter((b) => b.effective_from === latestFrom)
      .sort((a, b) => a.bracket_order - b.bracket_order)
  }

  // Lũy tiến TỪNG PHẦN: với mỗi bậc, phần = min(remaining, upper−lower); thuế += phần × rate. Bậc cuối (upper null) lấy hết.
  private applyProgressive(
    taxableIncome: bigint,
    brackets: Array<{ lower_bound: bigint; upper_bound: bigint | null; rate: { toString(): string } }>,
  ): { tax: bigint; lines: TaxBracketLine[] } {
    let tax = BigInt(0)
    const lines: TaxBracketLine[] = []
    // Mỗi bậc chiếm khoảng [lower, upper) của thu nhập tính thuế — định vị theo lower_bound, không cộng dồn độ rộng,
    // nên cấu hình hở/lệch bậc không làm sai âm thầm các bậc sau.
    for (const b of brackets) {
      const top = b.upper_bound === null || taxableIncome < b.upper_bound ? taxableIncome : b.upper_bound
      const portion = top - b.lower_bound
      if (portion <= BigInt(0)) continue
      const rate = Number(b.rate.toString())
      const taxInBracket = BigInt(Math.round((Number(portion) * rate) / 100))
      tax += taxInBracket
      lines.push({ rate, portion: Number(portion), tax: Number(taxInBracket) })
    }
    return { tax, lines }
  }
}
