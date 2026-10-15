import { Injectable } from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import type {
  SummaryResponse,
  DepartmentBreakdown,
  MonthComparison,
} from './dto/query-report.dto'

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(month: string): Promise<SummaryResponse> {
    const result = await this.prisma.payslip.aggregate({
      where: { month, deleted_at: null },
      _sum: {
        base_salary: true,
        kpi_bonus: true,
        deductions: true,
        total: true,
      },
      _count: { id: true },
    })

    const sum = result._sum

    return {
      month,
      total_employees: result._count.id,
      total_base_salary: (sum.base_salary ?? 0n).toString(),
      total_kpi_bonus: (sum.kpi_bonus ?? 0n).toString(),
      total_deductions: (sum.deductions ?? 0n).toString(),
      total_payroll_cost: (sum.total ?? 0n).toString(),
    }
  }

  async getByDepartment(
    month: string,
  ): Promise<DepartmentBreakdown[]> {
    const payslips = await this.prisma.payslip.findMany({
      where: { month, deleted_at: null },
      select: {
        base_salary: true,
        kpi_bonus: true,
        deductions: true,
        total: true,
        employee: {
          select: { department: true },
        },
      },
    })

    const deptMap = new Map<
      string,
      {
        count: number
        base: bigint
        kpi: bigint
        deductions: bigint
        cost: bigint
      }
    >()

    for (const p of payslips) {
      const dept = p.employee.department ?? 'Khác'
      const existing = deptMap.get(dept) ?? {
        count: 0,
        base: 0n,
        kpi: 0n,
        deductions: 0n,
        cost: 0n,
      }

      existing.count += 1
      existing.base += p.base_salary
      existing.kpi += p.kpi_bonus
      existing.deductions += p.deductions
      existing.cost += p.total

      deptMap.set(dept, existing)
    }

    return Array.from(deptMap.entries()).map(
      ([department, data]) => ({
        department,
        employee_count: data.count,
        total_base_salary: data.base.toString(),
        total_kpi_bonus: data.kpi.toString(),
        total_deductions: data.deductions.toString(),
        total_cost: data.cost.toString(),
      }),
    )
  }

  async getComparison(
    months: string[],
  ): Promise<MonthComparison[]> {
    const results: MonthComparison[] = []

    for (const month of months) {
      const agg = await this.prisma.payslip.aggregate({
        where: { month, deleted_at: null },
        _sum: { total: true },
        _count: { id: true },
      })

      results.push({
        month,
        total_payroll_cost: (agg._sum.total ?? 0n).toString(),
        employee_count: agg._count.id,
      })
    }

    return results
  }
}
