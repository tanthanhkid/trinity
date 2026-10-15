import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'

export interface ComponentSnapshot {
  code: string
  name: string
  component_type: string
  calc_method: string
  amount: number
}

export interface ComponentTotals {
  allowances: bigint
  bonuses: bigint
  deductions: bigint
  taxableEarnings: bigint // phụ cấp+thưởng CÓ is_taxable — vào thu nhập tính thuế TNCN
  snapshot: ComponentSnapshot[]
}

/**
 * Engine cộng/trừ các "Thành phần lương" (salary_components) vào phiếu lương lúc generate.
 * Config-driven: đọc config đang hiệu lực cho tháng → tính theo calc_method → trả breakdown + snapshot.
 * Luật VN đổi (tỷ lệ BHXH, mức phụ cấp...) → super_admin tạo dòng config mới effective_from, KHÔNG sửa code.
 */
@Injectable()
export class SalaryComponentsEngine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param baseSalary lương cơ bản đã resolve (job_title / salary_rule) — dùng cho calc_method='percent_base'
   * @param month 'YYYY-MM'
   * @param rankCode rank_code của nhân viên (lọc applies_to='rank:<code>'); null nếu chưa gán chức danh
   */
  async computeForEmployee(
    baseSalary: bigint,
    month: string,
    rankCode: string | null,
  ): Promise<ComponentTotals> {
    const components = await this.fetchActiveComponents(month)
    return this.accumulateTotals(components, baseSalary, rankCode)
  }

  // So sánh CHUỖI 'YYYY-MM' đúng thứ tự thời gian vì DTO ép zero-pad (regex /^\d{4}-(0[1-9]|1[0-2])$/)
  // → lexicographic ≡ chronological. Số component active dự kiến nhỏ < ~50, không cần take limit.
  private async fetchActiveComponents(month: string) {
    return this.prisma.salaryComponent.findMany({
      where: {
        is_active: true,
        effective_from: { lte: month },
        OR: [{ effective_to: null }, { effective_to: { gte: month } }],
      },
      orderBy: { sort_order: 'asc' },
    })
  }

  private accumulateTotals(
    components: Awaited<ReturnType<typeof this.fetchActiveComponents>>,
    baseSalary: bigint,
    rankCode: string | null,
  ): ComponentTotals {
    let allowances = BigInt(0)
    let bonuses = BigInt(0)
    let deductions = BigInt(0)
    let taxableEarnings = BigInt(0)
    const snapshot: ComponentSnapshot[] = []
    for (const c of components) {
      if (!this.appliesTo(c.applies_to, rankCode)) continue
      const amount = this.computeAmount(c.calc_method, c.fixed_amount, c.percent_value, baseSalary)
      if (amount <= BigInt(0)) continue
      snapshot.push({ code: c.code, name: c.name, component_type: c.component_type, calc_method: c.calc_method, amount: Number(amount) })
      if (c.component_type === 'allowance') {
        allowances += amount
        if (c.is_taxable) taxableEarnings += amount
      } else if (c.component_type === 'bonus') {
        bonuses += amount
        if (c.is_taxable) taxableEarnings += amount
      } else if (c.component_type === 'deduction') {
        deductions += amount
      }
    }
    return { allowances, bonuses, deductions, taxableEarnings, snapshot }
  }

  // 'all' áp cho mọi NV; 'rank:NV' chỉ áp cho rank khớp. Stacking 'all'+'rank:X' là CÓ CHỦ ĐÍCH.
  private appliesTo(appliesTo: string, rankCode: string | null): boolean {
    if (appliesTo === 'all') return true
    if (appliesTo.startsWith('rank:')) {
      return !!rankCode && appliesTo.slice('rank:'.length) === rankCode
    }
    return false
  }

  // fixed → fixed_amount; percent_base → round(base * pct / 100). VND làm tròn đồng (Math.round).
  // base_salary tối đa ~45tr (< Number.MAX_SAFE_INTEGER) → Number() an toàn, không mất chính xác.
  private computeAmount(
    calcMethod: string,
    fixedAmount: bigint | null,
    percentValue: { toString(): string } | null,
    baseSalary: bigint,
  ): bigint {
    if (calcMethod === 'percent_base') {
      const pct = percentValue ? Number(percentValue.toString()) : 0
      if (!Number.isFinite(pct) || pct <= 0) return BigInt(0)
      return BigInt(Math.round((Number(baseSalary) * pct) / 100))
    }
    return fixedAmount ?? BigInt(0)
  }
}
