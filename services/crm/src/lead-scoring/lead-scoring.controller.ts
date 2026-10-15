import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, ScopeService, assertInScope, type AuthUser } from '@trinity/rbac-nest';
import { PrismaService } from '@trinity/prisma';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { LeadScoringService } from './lead-scoring.service';
import { leadScoringJobEnabled } from './lead-scoring.job';
import { DEFAULT_LEAD_RULES } from './lead-scoring.rules';

/**
 * Chấm điểm lead. Đọc quy tắc: ai có `contacts.view`. Sửa quy tắc / chấm lại toàn bộ: `contacts.catalog`
 * (quyền cấu hình danh mục khách — không thêm quyền mới vào catalog). Chấm lại 1 khách: phải thấy khách đó (scope).
 */
@ApiTags('Lead scoring')
@ApiBearerAuth()
@RequireOrgFeature('lead_scoring')
@Controller('lead-scoring')
export class LeadScoringController {
  constructor(
    private readonly service: LeadScoringService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  @Get('rules')
  @Can('contacts.view')
  @ApiOperation({ summary: 'Quy tắc chấm điểm hiện hành + mặc định + trạng thái job' })
  async rules() {
    return { rules: await this.service.getRules(), defaults: DEFAULT_LEAD_RULES, job_enabled: leadScoringJobEnabled() };
  }

  @Put('rules')
  @Can('contacts.catalog')
  @ApiOperation({ summary: 'Lưu quy tắc chấm điểm (một phần; trường sai rơi về mặc định)' })
  @ApiResponse({ status: 200, description: 'Quy tắc hiệu lực sau chuẩn hoá' })
  async saveRules(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return { rules: await this.service.saveRules(body, user.userId) };
  }

  @Post('recompute-all')
  @HttpCode(200)
  @Can('contacts.catalog')
  @ApiOperation({ summary: 'Chấm lại điểm các khách chưa chấm/điểm cũ (tối đa 500 khách/lượt)' })
  async recomputeAll() {
    return { rescored: await this.service.rescoreStale(500) };
  }

  @Post('contacts/:id/recompute')
  @HttpCode(200)
  @Can('contacts.view')
  @ApiOperation({ summary: 'Chấm lại điểm 1 khách (phải nằm trong phạm vi contacts.view)' })
  async recomputeOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const c = await this.prisma.contact.findFirst({ where: { id, deleted_at: null }, select: { assigned_to: true, created_by_id: true } });
    if (!c) throw new NotFoundException('Không tìm thấy');
    await assertInScope(this.scope, user, 'contacts.view', [c.assigned_to, c.created_by_id]);
    await this.service.recompute([id]);
    return this.prisma.contact.findUnique({ where: { id }, select: { id: true, lead_score: true, lead_label: true, lead_score_reasons: true, lead_scored_at: true } });
  }
}
