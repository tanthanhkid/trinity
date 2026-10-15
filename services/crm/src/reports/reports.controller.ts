import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Can, CurrentUser, ScopeService } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { DashboardStatsTodayService } from './dashboard-stats-today.service';
import { buildFilterDates } from '../common/helpers/parse-vn-date-range.helper';
import { resolveMarketingReportScopeIds } from './helpers/marketing-report-scope.helper';
import { QueryMarketingAccountReportDto } from './dto/query-marketing-account-report.dto';
import { MarketingRecruitmentReportService } from './marketing-recruitment-report.service';

/**
 * Endpoints: dashboard-stats-today, marketing/recruitment-overview.
 *
 * RBAC: "marketing/recruitment-overview" dùng quyền `reports.channels`
 * (nhóm "Kênh tương tác") vì catalog không có quyền riêng cho báo cáo này.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly dashboardStatsTodayService: DashboardStatsTodayService,
    private readonly marketingRecruitmentReportService: MarketingRecruitmentReportService,
    private readonly scope: ScopeService,
  ) {}

  @Get('dashboard-stats-today')
  @Can('reports.overview')
  @ApiOperation({
    summary: 'KPI widget cho Dashboard Tổng quan',
    description:
      'Số liệu hôm nay (theo ngày Asia/Ho_Chi_Minh). ' +
      'Mỗi khối kiểm quyền NGUỒN riêng (`contacts.view`) — khối thiếu quyền trả `null`. ' +
      'Cache Redis 15 giây per-user (gần realtime).',
  })
  @ApiResponse({ status: 200 })
  async getDashboardStatsToday(@CurrentUser() user: AuthUser) {
    return this.dashboardStatsTodayService.getStats(user);
  }

  @Get('marketing/recruitment-overview')
  @Can('reports.channels')
  @ApiOperation({
    summary: 'Bao cao Marketing theo tai khoan — nhom Tuyen dung',
    description:
      'So bai dang / ung vien quan tam / phong van / nhan viec. ' +
      '2 chi so khong co nguon du lieu (tin nhan tuyen dung, CV nhan) tra null + available:false.',
  })
  @ApiResponse({ status: 200, description: 'Recruitment overview' })
  async getMarketingRecruitmentOverview(
    @Query() query: QueryMarketingAccountReportDto,
    @CurrentUser() user: AuthUser,
  ) {
    const { dateFrom, dateTo } = buildFilterDates(query.date_from, query.date_to);
    const owner = (await this.scope.ownerIds(user, 'reports.channels')) ?? [];
    const scopeIds = resolveMarketingReportScopeIds(owner, query.marketing_user_id);
    return this.marketingRecruitmentReportService.getRecruitmentOverview({
      scopeIds,
      dateFrom,
      dateTo,
    });
  }

}
