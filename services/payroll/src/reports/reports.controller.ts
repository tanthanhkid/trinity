import { Controller, Get, Query } from '@nestjs/common'
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger'
import { Can } from '@trinity/rbac-nest'
import { ReportsService } from './reports.service'
import { QueryComparisonDto, QuerySummaryDto } from './dto/query-report.dto'

// Báo cáo tổng hợp CHI PHÍ lương toàn công ty (không lọc theo nhân viên).
// Không có quyền `reports.*` riêng cho lương trong danh mục, dùng chung
// `payroll.manage`.
@ApiTags('reports')
@ApiBearerAuth()
@Can('payroll.manage')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Tong chi phi luong thang' })
  @ApiQuery({ name: 'month', required: true, example: '2026-03' })
  @ApiResponse({ status: 200, description: 'Payroll summary' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  async getSummary(@Query() query: QuerySummaryDto) {
    return this.reportsService.getSummary(query.month)
  }

  @Get('by-department')
  @ApiOperation({ summary: 'Chi phi luong theo phong ban' })
  @ApiQuery({ name: 'month', required: true, example: '2026-03' })
  @ApiResponse({ status: 200, description: 'Department breakdown' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  async getByDepartment(@Query() query: QuerySummaryDto) {
    return this.reportsService.getByDepartment(query.month)
  }

  @Get('comparison')
  @ApiOperation({
    summary: 'So sanh chi phi luong nhieu thang',
  })
  @ApiQuery({
    name: 'months',
    required: true,
    example: '2026-01,2026-02,2026-03',
  })
  @ApiResponse({ status: 200, description: 'Month comparison' })
  @ApiResponse({ status: 403, description: 'Khong co quyen' })
  async getComparison(@Query() query: QueryComparisonDto) {
    const monthList = query.months
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
    return this.reportsService.getComparison(monthList)
  }
}
