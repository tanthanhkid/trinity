import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { QueryReportRangeDto } from './dto/query-report-range.dto';
import { parseReportPeriod } from './helpers/report-date-range.helper';
import { ReportOverviewService } from './report-overview.service';

/**
 * Trung tâm báo cáo CRM tổng quát, nhóm "Tổng quan". KHÔNG đụng `deals`/doanh thu.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports/overview')
export class ReportOverviewController {
  constructor(private readonly overviewService: ReportOverviewService) {}

  @Get()
  @Can('reports.overview')
  @ApiOperation({
    summary: 'KPI Tổng quan CRM — kỳ hiện tại so với kỳ trước cùng độ dài',
    description:
      'Khách hàng mới và số hoạt động. Scope theo phạm vi quyền ' +
      '`reports.overview` (own/team/subtree/all theo cây `manager_id`).',
  })
  @ApiResponse({ status: 200 })
  async getOverview(@Query() query: QueryReportRangeDto, @CurrentUser() user: AuthUser) {
    const period = parseReportPeriod(query.date_from, query.date_to);
    return this.overviewService.getOverview(user, period);
  }
}
