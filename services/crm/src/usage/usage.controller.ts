import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser as RbacCurrentUser } from '@trinity/rbac-nest';
import type { AuthUser } from '@trinity/rbac-nest';
import { PLAN_KEYS, isPlanKey } from '@trinity/rbac';
import { OrgFeaturesService } from '../settings/org-features.service';
import { PlanTokenGuard } from './plan-token.guard';
import { UsageService } from './usage.service';

/** Gói dịch vụ — chỉ admin (cùng quyền `settings.features`). */
@ApiTags('Settings')
@ApiBearerAuth()
@Controller('settings')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly orgFeatures: OrgFeaturesService,
  ) {}

  @Get('usage')
  @Can('settings.features')
  @ApiOperation({ summary: 'Gói hiện tại, giới hạn user và cờ tính năng' })
  @ApiResponse({ status: 200 })
  async summary() {
    return this.usage.summary();
  }

  @Put('plan')
  @Can('settings.features')
  @UseGuards(PlanTokenGuard)
  @ApiOperation({ summary: 'Đổi gói dịch vụ — chỉ Trinity (header X-Trinity-Plan-Token); admin khách chỉ xem' })
  @ApiResponse({ status: 403, description: 'Thiếu/sai token hoặc server chưa đặt TRINITY_PLAN_ADMIN_TOKEN' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'Khoá gói không hợp lệ' })
  async setPlan(@Body() body: { plan?: unknown }, @RbacCurrentUser() user: AuthUser, @Req() req: { ip?: string }) {
    if (!isPlanKey(body?.plan)) {
      throw new BadRequestException(`Gói không hợp lệ. Chọn một trong: ${PLAN_KEYS.join(', ')}`);
    }
    await this.orgFeatures.setPlan(body.plan, user.userId, 'api', req?.ip);
    return this.usage.summary();
  }
}
