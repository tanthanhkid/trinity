import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { StaleWorkService } from './stale-work.service';
import { staleJobEnabled } from './stale-work.job';

/**
 * Nhắc việc treo. `summary`: mọi người đăng nhập — CHỈ thấy việc của mình + của cấp dưới theo cây
 * `manager_id` (sale không có cấp dưới → chỉ của mình). Cấu hình N / chạy tay: `contacts.catalog`.
 */
@ApiTags('Stale work')
@ApiBearerAuth()
@RequireOrgFeature('stale_reminders')
@Controller('stale-work')
export class StaleWorkController {
  constructor(private readonly service: StaleWorkService) {}

  @Get('summary')
  @AuthOnly()
  @ApiOperation({ summary: 'Số việc treo của tôi + của cấp dưới' })
  summary(@CurrentUser() user: AuthUser) {
    return this.service.summaryFor(user);
  }

  @Get('config')
  @AuthOnly()
  @ApiOperation({ summary: 'Cấu hình ngưỡng ngày nhắc việc treo' })
  async config() {
    return { config: await this.service.getConfig(), job_enabled: staleJobEnabled() };
  }

  @Put('config')
  @Can('contacts.catalog')
  @ApiOperation({ summary: 'Lưu ngưỡng N ngày (trường sai rơi về mặc định)' })
  async saveConfig(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { config: await this.service.saveConfig(body, user.userId) };
  }

  @Post('run')
  @HttpCode(200)
  @Can('contacts.catalog')
  @ApiOperation({ summary: 'Gửi tổng hợp việc treo ngay bây giờ (bỏ qua giờ + dấu đã gửi hôm nay)' })
  run() {
    return this.service.runOnce(new Date(), true);
  }
}
