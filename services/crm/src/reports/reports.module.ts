import { Module } from '@nestjs/common';
import { CustomReportsController } from './custom/custom-reports.controller';
import { CustomReportsService } from './custom/custom-reports.service';
import { SettingsModule } from '../settings/settings.module';
import { DashboardChannelsService } from './dashboard-channels.service';
import { ReportsController } from './reports.controller';
import { DashboardStatsTodayService } from './dashboard-stats-today.service';
import { DashboardTrendService } from './dashboard-trend.service';
import { DashboardTrendController } from './dashboard-trend.controller';
import { DashboardOverviewController } from './dashboard-overview.controller';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardTasksService } from './dashboard-tasks.service';
import { DashboardFilterRosterService } from './dashboard-filter-roster.service';
import { MarketingRecruitmentReportService } from './marketing-recruitment-report.service';
import { ReportOverviewController } from './report-overview.controller';
import { ReportOverviewService } from './report-overview.service';
import { ReportCustomersController } from './report-customers.controller';
import { ReportCustomersService } from './report-customers.service';
import { ReportCustomersUncontactedService } from './report-customers-uncontacted.service';
import { ReportEmployeePerformanceController } from './report-employee-performance.controller';
import { ReportEmployeePerformanceService } from './report-employee-performance.service';
import { ReportEmployeePerformanceExportService } from './report-employee-performance-export.service';

@Module({
  imports: [SettingsModule],
  controllers: [
    ReportsController,
    DashboardTrendController,
    DashboardOverviewController,
    ReportOverviewController,
    ReportCustomersController,
    ReportEmployeePerformanceController,
    CustomReportsController,
  ],
  providers: [
    DashboardStatsTodayService,
    DashboardTrendService,
    DashboardOverviewService,
    DashboardChannelsService,
    DashboardTasksService,
    DashboardFilterRosterService,
    MarketingRecruitmentReportService,
    ReportOverviewService,
    ReportCustomersService,
    ReportCustomersUncontactedService,
    ReportEmployeePerformanceService,
    ReportEmployeePerformanceExportService,
    CustomReportsService,
  ],
  // MCP chỉ đọc dùng lại số liệu Tổng quan.
  exports: [DashboardOverviewService, DashboardChannelsService, CustomReportsService],
})
export class ReportsModule {}
