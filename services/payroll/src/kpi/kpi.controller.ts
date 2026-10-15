import { Controller, Get, Post, Body, Query, NotFoundException } from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger'
import { PrismaService } from '@trinity/prisma'
import { Can, AuthOnly, CurrentUser, AuthUser } from '@trinity/rbac-nest'
import { KpiService } from './kpi.service'
import { CalculateKpiDto } from './dto/calculate-kpi.dto'
import { CreateKpiConfigDto } from './dto/create-kpi-config.dto'
import { QueryKpiConfigDto } from './dto/query-kpi-config.dto'
import { QueryKpiDto } from './dto/query-kpi.dto'

@ApiTags('kpi')
@ApiBearerAuth()
@Controller('kpi')
export class KpiController {
  constructor(
    private readonly kpiService: KpiService,
    private readonly prisma: PrismaService,
  ) {}

  // ===================== KPI Configs =====================

  @Get('configs')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Danh sach KPI configs' })
  @ApiQuery({ name: 'role', required: false, example: 'sales' })
  @ApiResponse({ status: 200, description: 'Danh sach KPI configs' })
  async getConfigs(@Query() query: QueryKpiConfigDto) {
    return this.kpiService.getConfigs(query.role)
  }

  @Post('configs')
  @Can('payroll.manage')
  @ApiOperation({ summary: 'Tao KPI config cho role' })
  @ApiResponse({ status: 201, description: 'Tao thanh cong' })
  @ApiResponse({
    status: 409,
    description: 'Da ton tai config cho role + metric',
  })
  async createConfig(@Body() dto: CreateKpiConfigDto) {
    return this.kpiService.createConfig(dto)
  }

  // ===================== KPI Dashboard =====================

  // "KPI của tôi" — mọi người đăng nhập gọi được, lọc CHỈ theo chính mình
  // — KHÔNG cho quản lý xem KPI cấp dưới qua route này.
  @Get()
  @AuthOnly()
  @ApiOperation({ summary: 'KPI nhan vien theo thang (chinh minh)' })
  @ApiQuery({ name: 'employee_id', required: true, type: Number })
  @ApiQuery({ name: 'month', required: true, example: '2026-03' })
  @ApiResponse({ status: 200, description: 'KPI result' })
  @ApiResponse({ status: 404, description: 'Khong tim thay' })
  async getKpi(@Query() query: QueryKpiDto, @CurrentUser() user: AuthUser) {
    const employeeId = Number(query.employee_id)
    await this.assertOwnEmployee(user.userId, employeeId)
    return this.kpiService.getByEmployee(employeeId, query.month)
  }

  // ===================== KPI Calculate =====================

  @Post('calculate')
  @Can('payroll.manage')
  @ApiOperation({
    summary: 'Tinh KPI cho tat ca nhan vien trong thang',
  })
  @ApiResponse({ status: 201, description: 'KPI calculated' })
  @ApiResponse({ status: 400, description: 'Du lieu khong hop le' })
  async calculate(@Body() dto: CalculateKpiDto) {
    return this.kpiService.calculate(dto.month, dto.employee_ids)
  }

  // ===================== Monthly Closure =====================

  @Post('close-month')
  @Can('payroll.manage')
  @ApiOperation({
    summary: 'Chot KPI thang (khong thay doi sau khi chot)',
  })
  @ApiResponse({ status: 200, description: 'Month closed' })
  @ApiResponse({ status: 400, description: 'Du lieu khong hop le' })
  @ApiResponse({
    status: 404,
    description: 'Khong co du lieu KPI de chot',
  })
  @ApiResponse({ status: 409, description: 'Da chot truoc do' })
  async closeMonth(@Body() dto: CalculateKpiDto) {
    return this.kpiService.closeMonth(dto.month)
  }

  // ===================== RBAC Enforcement =====================

  /** Ngoài phạm vi (không phải hồ sơ nhân viên của chính mình) → 404. */
  private async assertOwnEmployee(userId: number, employeeId: number): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { user_id: true },
    })
    if (!employee || employee.user_id !== userId) {
      throw new NotFoundException('Không tìm thấy')
    }
  }
}
