import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common'
import { PrismaService } from '@trinity/prisma'
import { Prisma } from '@prisma/client'
import { ScopeService, scopeWhere, assertInScope, type AuthUser } from '@trinity/rbac-nest'
import { CreateEmployeeDto } from './dto/create-employee.dto'
import { UpdateEmployeeDto } from './dto/update-employee.dto'
import { QueryEmployeeDto } from './dto/query-employee.dto'

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  // Mẫu A — owner của hồ sơ nhân viên = user_id ( bảng owner).
  async findAll(query: QueryEmployeeDto, user: AuthUser) {
    const owner = await this.scope.ownerIds(user, 'employees.view') // null không xảy ra: guard đã kiểm @Can
    const where: Prisma.EmployeeWhereInput = { AND: [scopeWhere(owner!, ['user_id'])] }

    if (query.team_id) {
      where.team_id = query.team_id
    }
    if (query.position) {
      where.position = query.position
    }
    if (query.status) {
      where.status = query.status
    }
    if (query.search) {
      where.user = {
        full_name: { contains: query.search, mode: 'insensitive' },
      }
    }

    return this.prisma.employee.findMany({
      where,
      select: {
        id: true,
        user_id: true,
        position: true,
        department: true,
        team_id: true,
        salary_rule_id: true,
        status: true,
        joined_at: true,
        created_at: true,
        user: {
          select: {
            full_name: true,
            email: true,
            phone: true,
            avatar_url: true,
          },
        },
      },
      orderBy: { id: 'asc' },
    })
  }

  async findById(id: number, user: AuthUser) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        user_id: true,
        position: true,
        department: true,
        team_id: true,
        salary_rule_id: true,
        status: true,
        joined_at: true,
        created_at: true,
        user: {
          select: {
            full_name: true,
            email: true,
            phone: true,
            avatar_url: true,
            team: { select: { id: true, name: true } },
          },
        },
        payslips: {
          select: {
            month: true,
            total: true,
            status: true,
          },
          orderBy: { month: 'desc' },
          take: 12,
        },
        kpi_results: {
          select: {
            month: true,
            metric_name: true,
            actual_value: true,
            target_value: true,
            achievement_rate: true,
            achieved: true,
          },
          orderBy: { created_at: 'desc' },
          take: 30,
        },
      },
    })

    if (!employee) {
      throw new NotFoundException(`Nhân viên #${id} không tồn tại`)
    }
    await assertInScope(this.scope, user, 'employees.view', [employee.user_id])

    const salaryHistory = employee.payslips.map((p) => ({
      month: p.month,
      total: p.total.toString(),
      status: p.status,
    }))

    const currentMonth = this.getCurrentMonth()
    const currentKpi = employee.kpi_results.filter(
      (k) => k.month === currentMonth,
    )

    const kpiSummary: Record<string, { actual: string; target: string; rate: string | null }> = {}
    for (const k of currentKpi) {
      kpiSummary[k.metric_name] = {
        actual: k.actual_value.toString(),
        target: k.target_value.toString(),
        rate: k.achievement_rate?.toString() ?? null,
      }
    }

    return {
      id: employee.id,
      user_id: employee.user_id,
      full_name: employee.user.full_name,
      email: employee.user.email,
      phone: employee.user.phone,
      avatar_url: employee.user.avatar_url,
      position: employee.position,
      department: employee.department,
      team_id: employee.team_id,
      team: employee.user.team,
      salary_rule_id: employee.salary_rule_id,
      status: employee.status,
      joined_at: employee.joined_at,
      created_at: employee.created_at,
      salary_history: salaryHistory,
      kpi_summary: {
        current_month: currentMonth,
        metrics: kpiSummary,
      },
    }
  }

  async create(dto: CreateEmployeeDto) {
    const existing = await this.prisma.employee.findUnique({
      where: { user_id: dto.user_id },
    })

    if (existing) {
      throw new ConflictException(
        `User #${dto.user_id} đã có hồ sơ nhân viên`,
      )
    }

    return this.prisma.employee.create({
      data: {
        user_id: dto.user_id,
        position: dto.position,
        department: dto.department,
        team_id: dto.team_id,
        salary_rule_id: dto.salary_rule_id,
        joined_at: new Date(dto.joined_at),
      },
      select: {
        id: true,
        user_id: true,
        position: true,
        department: true,
        team_id: true,
        salary_rule_id: true,
        status: true,
        joined_at: true,
        created_at: true,
      },
    })
  }

  async update(id: number, dto: UpdateEmployeeDto) {
    const existing = await this.prisma.employee.findUnique({
      where: { id },
    })

    if (!existing) {
      throw new NotFoundException(`Nhân viên #${id} không tồn tại`)
    }

    return this.prisma.employee.update({
      where: { id },
      data: {
        ...(dto.position !== undefined && { position: dto.position }),
        ...(dto.department !== undefined && { department: dto.department }),
        ...(dto.team_id !== undefined && { team_id: dto.team_id }),
        ...(dto.salary_rule_id !== undefined && {
          salary_rule_id: dto.salary_rule_id,
        }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      select: {
        id: true,
        user_id: true,
        position: true,
        department: true,
        team_id: true,
        salary_rule_id: true,
        status: true,
        joined_at: true,
        created_at: true,
      },
    })
  }

  private getCurrentMonth(): string {
    // Theo giờ VN, không theo múi giờ máy chủ (UTC: 00:00–07:00 ngày mùng 1 VN vẫn là tháng trước).
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' })
      .format(new Date())
      .slice(0, 7)
  }
}
