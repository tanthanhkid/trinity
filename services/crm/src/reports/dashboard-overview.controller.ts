import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardTasksService } from './dashboard-tasks.service';
import { DashboardFilterQuery } from './dashboard-overview.filter';
import { DashboardFilterRosterService } from './dashboard-filter-roster.service';

/**
 * Controller RIÊNG cho màn Tổng quan thiết kế lại — không
 * thêm route vào `reports.controller.ts` (file hot-path, tránh xung đột).
 *
 * RBAC quyền + phạm vi: CẢ 3 route `@Can('reports.overview')` — cùng quyền
 * với `dashboard-stats-today`/`dashboard-trend`; phạm vi dữ liệu = phạm vi của
 * quyền đó (own|team|subtree|all), KHÔNG còn danh sách role.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class DashboardOverviewController {
  constructor(
    private readonly overview: DashboardOverviewService,
    private readonly tasks: DashboardTasksService,
    private readonly roster: DashboardFilterRosterService,
  ) {}

  @Get('dashboard-overview')
  @Can('reports.overview')
  @ApiOperation({
    summary: 'KPI + biểu đồ Tổng quan: khách hàng, cơ hội, doanh thu thương vụ thắng',
    description:
      'Phạm vi theo scope quyền `reports.overview` (own|team|subtree|all); bộ lọc Phòng/Team/NV (scope >= team) ' +
      'AND-compose bên trong phạm vi. Cache Redis 5 phút per-user.',
  })
  @ApiResponse({ status: 200, description: 'DashboardOverviewResult' })
  getOverview(@CurrentUser() user: AuthUser, @Query() filter: DashboardFilterQuery) {
    return this.overview.getOverview(user, filter);
  }

  @Get('dashboard-tasks')
  @Can('reports.overview')
  @ApiOperation({
    summary: 'Việc cần làm hôm nay (card Kanban + lịch hẹn nhắc) — mặc định của CHÍNH user',
    description:
      'Chỉ việc của mình — không lộ việc của người khác; người giữ `reports.overview` scope >= team ' +
      'lọc được theo dept_head_id/team_lead_id/user_id TRONG phạm vi của mình, người khác bỏ qua tham số lọc. Không cache.',
  })
  @ApiResponse({ status: 200, description: 'DashboardTasksResult' })
  getTasks(@CurrentUser() user: AuthUser, @Query() filter: DashboardFilterQuery) {
    return this.tasks.getTasks(user, filter);
  }

  @Get('dashboard-filter-roster')
  @Can('reports.overview')
  @ApiOperation({
    summary: 'Roster Phòng KD / Team / Nhân viên cho bộ lọc Tổng quan (chỉ scope >= team)',
    description:
      'Lấy từ cây `users.manager_id`, chỉ gồm người TRONG phạm vi `reports.overview` của người gọi; ' +
      'scope `own` nhận 403 (kiểm ở service).',
  })
  @ApiResponse({ status: 200, description: 'DashboardFilterRoster' })
  getFilterRoster(@CurrentUser() user: AuthUser) {
    return this.roster.getRoster(user);
  }
}
