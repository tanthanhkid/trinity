import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiProduces } from '@nestjs/swagger';
import { Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { QueryReportRangeDto } from './dto/query-report-range.dto';
import { parseReportPeriod } from './helpers/report-date-range.helper';
import { ReportEmployeePerformanceService } from './report-employee-performance.service';
import { ReportEmployeePerformanceExportService } from './report-employee-performance-export.service';

/**
 * Nhóm "Hiệu suất nhân viên". Quyền `reports.staff` — admin quyết
 * định vai trò nào giữ quyền này (chính sách đó nằm ở cấu hình vai trò, KHÔNG hardcode).
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports/employee-performance')
export class ReportEmployeePerformanceController {
  constructor(
    private readonly performanceService: ReportEmployeePerformanceService,
    private readonly exportService: ReportEmployeePerformanceExportService,
  ) {}

  @Get()
  @Can('reports.staff')
  @ApiOperation({
    summary: 'Bảng hiệu suất nhân viên trong kỳ (scope theo quyền reports.staff)',
    description:
      'Khách mới được giao và số hoạt động trong kỳ.',
  })
  @ApiResponse({ status: 200 })
  async getPerformance(@Query() query: QueryReportRangeDto, @CurrentUser() user: AuthUser) {
    const period = parseReportPeriod(query.date_from, query.date_to);
    return this.performanceService.getPerformance(user, period);
  }

  @Get('export')
  @Can('reports.staff', 'reports.export')
  @ApiOperation({ summary: 'Xuất Excel Hiệu suất nhân viên' })
  @ApiResponse({ status: 200, description: 'File Excel (.xlsx)' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportExcel(
    @Query() query: QueryReportRangeDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const period = parseReportPeriod(query.date_from, query.date_to);
    const buffer = await this.exportService.exportToExcel(user, period);
    const fileName = `hieu-suat-nhan-vien-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  }
}
