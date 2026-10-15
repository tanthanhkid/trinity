import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { DashboardTrendService } from './dashboard-trend.service';

/**
 * Controller RIÊNG cho đường xu hướng 14 ngày của màn Tổng quan.
 *
 * Giữ TÁCH RIÊNG khỏi `reports.controller.ts` (hot-path nhiều endpoint) để sửa 1 route
 * riêng không đụng tới file đó.
 * Nest cho phép nhiều controller cùng prefix `reports` — route không đụng nhau.
 *
 * RBAC: `@Can('reports.overview')` — CÙNG quyền với `GET /reports/dashboard-stats-today`
 * (2 endpoint vẽ trên CÙNG 1 màn Tổng quan) — dùng chung 1 chuỗi quyền.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class DashboardTrendController {
  constructor(private readonly dashboardTrendService: DashboardTrendService) {}

  @Get('dashboard-trend-14d')
  @Can('reports.overview')
  @ApiOperation({
    summary: 'Chuỗi 14 ngày cho thẻ chỉ số màn Tổng quan',
    description:
      'Trả `{ days[14], series }` cho các chỉ số của thẻ Tổng quan (quan tâm). Ngày theo Asia/Ho_Chi_Minh, CŨ → MỚI, điểm cuối là hôm nay. ' +
      'Ngày không phát sinh trả 0 (KHÔNG bỏ điểm) để đường xu hướng không bị co lại. ' +
      'Mỗi chuỗi kiểm quyền NGUỒN riêng (`contacts.view`) — chuỗi thiếu quyền vắng mặt ' +
      'khỏi `series` (FE ẩn đường tương ứng). Cache Redis 120 giây per-user.',
  })
  @ApiResponse({
    status: 200,
    description: '{ days: string[14], series: Partial<Record<TrendMetric, number[14]>> }',
  })
  async getDashboardTrend14d(@CurrentUser() user: AuthUser) {
    return this.dashboardTrendService.getTrend(user);
  }
}
