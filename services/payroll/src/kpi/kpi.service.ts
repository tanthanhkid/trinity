import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import { CreateKpiConfigDto } from './dto/create-kpi-config.dto'
import { KpiAggregatorService } from './kpi-aggregator.service'

interface KpiResultRow {
  metric_name: string
  actual_value: Prisma.Decimal
  target_value: Prisma.Decimal
  achievement_rate: Prisma.Decimal | null
  achieved: boolean
  is_locked: boolean
}

interface EmployeeRow {
  id: number
  user_id: number
  position: string
  team_id: number | null
}

@Injectable()
export class KpiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregator: KpiAggregatorService,
  ) {}

  // ===================== KPI Configs =====================

  async getConfigs(role?: string) {
    const where = role ? { role } : {}
    const configs = await this.prisma.kpiConfig.findMany({
      where,
      orderBy: [{ role: 'asc' }, { id: 'asc' }],
      take: 100,
    })

    return configs.map((c) => ({
      id: c.id,
      role: c.role,
      metric_name: c.metric_name,
      target: c.target.toString(),
      unit: c.unit,
      weight: c.weight?.toString() ?? null,
      working_days_per_month: c.working_days_per_month,
    }))
  }

  async createConfig(dto: CreateKpiConfigDto) {
    const existing = await this.prisma.kpiConfig.findFirst({
      where: { role: dto.role, metric_name: dto.metric_name },
    })

    if (existing) {
      throw new ConflictException(
        `KPI config cho role "${dto.role}" voi metric "${dto.metric_name}" da ton tai`,
      )
    }

    const config = await this.prisma.kpiConfig.create({
      data: {
        role: dto.role,
        metric_name: dto.metric_name,
        target: dto.target,
        unit: dto.unit ?? null,
        weight: dto.weight ?? null,
        working_days_per_month: dto.working_days_per_month ?? 24,
      },
    })

    return {
      id: config.id,
      role: config.role,
      metric_name: config.metric_name,
      target: config.target.toString(),
      unit: config.unit,
      weight: config.weight?.toString() ?? null,
      working_days_per_month: config.working_days_per_month,
    }
  }

  // ===================== KPI Dashboard =====================

  async getByEmployee(
    employeeId: number,
    month: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, user_id: true, position: true, team_id: true },
    })

    if (!employee) {
      throw new NotFoundException(`Nhan vien #${employeeId} khong ton tai`)
    }

    const results = await this.prisma.kpiResult.findMany({
      where: { employee_id: employeeId, month },
      select: {
        metric_name: true,
        actual_value: true,
        target_value: true,
        achievement_rate: true,
        achieved: true,
        is_locked: true,
      },
      take: 100,
    })

    if (results.length === 0) {
      throw new NotFoundException(
        `Khong co du lieu KPI cho nhan vien #${employeeId} thang ${month}`,
      )
    }

    const metrics = this.buildMetricsMap(results)
    const overallRate = this.calculateOverallRate(results)
    const status = this.determineStatus(overallRate)

    return {
      employee_id: employeeId,
      month,
      metrics,
      achievement_rate: overallRate,
      status,
      is_locked: results.every((r) => r.is_locked),
    }
  }

  // ===================== KPI Calculate Batch =====================

  async calculate(
    month: string,
    employeeIds?: number[],
  ): Promise<{ processed: number }> {
    this.validateMonth(month)

    const lockedCheck = await this.prisma.kpiResult.findFirst({
      where: { month, is_locked: true },
    })
    if (lockedCheck) {
      throw new BadRequestException(
        `KPI thang ${month} da duoc chot, khong the tinh lai`,
      )
    }

    const whereEmployees: Prisma.EmployeeWhereInput = {
      status: 'active',
      deleted_at: null,
    }
    if (employeeIds && employeeIds.length > 0) {
      whereEmployees.id = { in: employeeIds }
    }

    // Duyệt TOÀN BỘ nhân viên đang hoạt động theo từng lô (cursor theo id), không cắt cứng ở 100 người.
    const BATCH = 100
    let processed = 0
    let cursorId: number | undefined
    for (;;) {
      const employees: EmployeeRow[] = await this.prisma.employee.findMany({
        where: whereEmployees,
        select: {
          id: true,
          user_id: true,
          position: true,
          team_id: true,
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
      })
      if (employees.length === 0) break

      for (const emp of employees) {
        await this.calculateForEmployee(emp, month)
        processed++
      }
      if (employees.length < BATCH) break
      cursorId = employees[employees.length - 1].id
    }

    return { processed }
  }

  // ===================== Monthly Closure =====================

  async closeMonth(
    month: string,
  ): Promise<{ closed: boolean; locked_count: number }> {
    this.validateMonth(month)

    const existing = await this.prisma.kpiResult.findFirst({
      where: { month },
    })
    if (!existing) {
      throw new NotFoundException(
        `Khong co du lieu KPI cho thang ${month} de chot`,
      )
    }

    const alreadyLocked = await this.prisma.kpiResult.findFirst({
      where: { month, is_locked: true },
    })
    if (alreadyLocked) {
      throw new ConflictException(
        `KPI thang ${month} da duoc chot truoc do`,
      )
    }

    const result = await this.prisma.kpiResult.updateMany({
      where: { month, is_locked: false },
      data: { is_locked: true },
    })

    return { closed: true, locked_count: result.count }
  }

  // ===================== Private Helpers =====================

  private async calculateForEmployee(
    employee: EmployeeRow,
    month: string,
  ): Promise<void> {
    const configs = await this.prisma.kpiConfig.findMany({
      where: { role: this.mapPositionToRole(employee.position) },
      take: 100,
    })

    if (configs.length === 0) return

    const aggregated = await this.aggregator.aggregateForEmployee(
      employee.user_id,
      month,
    )

    for (const config of configs) {
      const actualValue = this.resolveActualValue(
        config.metric_name,
        aggregated,
      )

      // Dung working_days tu config thay vi hardcode
      const targetValue = this.resolveTargetValue(config)

      const achievementRate =
        Number(targetValue) > 0
          ? Math.round(
              (actualValue / Number(targetValue)) * 10000,
            ) / 100
          : 0

      const achieved = achievementRate >= 100

      // Row-level locking: upsert voi unique constraint
      await this.prisma.$executeRaw`
        INSERT INTO kpi_results (employee_id, month, metric_name, actual_value, target_value, achievement_rate, achieved, is_locked, created_at)
        VALUES (${employee.id}, ${month}, ${config.metric_name}, ${actualValue}, ${targetValue}, ${achievementRate}, ${achieved}, false, NOW())
        ON CONFLICT (employee_id, month, metric_name)
        DO UPDATE SET
          actual_value = ${actualValue},
          target_value = ${targetValue},
          achievement_rate = ${achievementRate},
          achieved = ${achieved}
        WHERE kpi_results.is_locked = false
      `
    }
  }

  /** Actual value of a metric: looked up by name in the aggregated data, 0 when absent. */
  private resolveActualValue(
    metricName: string,
    data: Record<string, number>,
  ): number {
    return data[metricName.toLowerCase()] ?? 0
  }

  /**
   * Tinh target value dua tren working_days_per_month tu config.
   * Sale monthly target = target_per_day * working_days_per_month
   * Voi metrics don vi la "per day" (tasks/day): nhan working_days
   * Voi metrics khac (revenue, conversion): dung target truc tiep
   */
  private resolveTargetValue(config: {
    metric_name: string
    target: Prisma.Decimal
    working_days_per_month: number
  }): number {
    const metric = config.metric_name.toLowerCase()
    const targetNum = Number(config.target)
    const workingDays = config.working_days_per_month

    // Metrics theo ngay: nhan voi so ngay lam viec
    if (metric.includes('/day') || metric.includes('per_day')) {
      return targetNum * workingDays
    }

    // Metrics theo thang: dung target truc tiep
    return targetNum
  }

  private mapPositionToRole(position: string): string {
    return position
  }

  private buildMetricsMap(
    results: KpiResultRow[],
  ): Record<
    string,
    {
      actual: string
      target: string
      rate: string | null
      achieved: boolean
    }
  > {
    const metrics: Record<
      string,
      {
        actual: string
        target: string
        rate: string | null
        achieved: boolean
      }
    > = {}

    for (const r of results) {
      metrics[r.metric_name] = {
        actual: r.actual_value.toString(),
        target: r.target_value.toString(),
        rate: r.achievement_rate?.toString() ?? null,
        achieved: r.achieved,
      }
    }

    return metrics
  }

  private calculateOverallRate(results: KpiResultRow[]): number {
    if (results.length === 0) return 0

    const rates = results
      .map((r) => (r.achievement_rate ? Number(r.achievement_rate) : 0))

    const sum = rates.reduce((acc, val) => acc + val, 0)
    return Math.round((sum / rates.length) * 100) / 100
  }

  private determineStatus(
    rate: number,
  ): 'on_track' | 'behind' | 'exceeded' {
    if (rate >= 100) return 'exceeded'
    if (rate >= 80) return 'on_track'
    return 'behind'
  }

  private validateMonth(month: string): void {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new BadRequestException(
        'month phai dung format YYYY-MM',
      )
    }
  }
}
