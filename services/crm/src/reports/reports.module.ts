import { Module } from '@nestjs/common';
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
  controllers: [
    ReportsController,
    DashboardTrendController,
    DashboardOverviewController,
    ReportOverviewController,
    ReportCustomersController,
    ReportEmployeePerformanceController,
  ],
  providers: [
    DashboardStatsTodayService,
    DashboardTrendService,
    DashboardOverviewService,
    DashboardTasksService,
    DashboardFilterRosterService,
    MarketingRecruitmentReportService,
    ReportOverviewService,
    ReportCustomersService,
    ReportCustomersUncontactedService,
    ReportEmployeePerformanceService,
    ReportEmployeePerformanceExportService,
  ],
  // MCP chỉ đọc dùng lại số liệu Tổng quan.
  exports: [DashboardOverviewService],
})
export class ReportsModule {}
