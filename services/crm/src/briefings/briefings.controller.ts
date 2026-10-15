import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { PrismaService } from '@trinity/prisma';
import { RequireOrgFeature } from '../usage/org-feature.guard';
import { BriefingConfigService } from './briefing-config.service';
import { BriefingsService } from './briefings.service';
import { SlotQueryDto, UpdateBriefingConfigDto } from './dto/briefing.dto';
import type { BriefingSlot } from './briefing.types';

const nowSlot = (): BriefingSlot => (new Date(Date.now() + 7 * 3600_000).getUTCHours() < 12 ? 'morning' : 'evening');

/**
 * Bản tin sáng/chiều. Xem bản tin = `reports.overview` (phạm vi dữ liệu cũng theo quyền đó);
 * cấu hình + gửi thử toàn công ty = `settings.integrations`. Bản tin của ai chỉ người đó đọc (id ngoài chủ → 404).
 */
@ApiTags('briefings')
@ApiBearerAuth()
@Controller('briefings')
export class BriefingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly briefings: BriefingsService,
    private readonly config: BriefingConfigService,
  ) {}

  @Get('config')
  @Can('settings.integrations')
  async getConfig() {
    return { config: await this.config.get(), available: { feature: await this.config.featureOn() } };
  }

  @Patch('config')
  @Can('settings.integrations')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateBriefingConfigDto) {
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)); // 
    return this.config.update(patch, user.userId);
  }

  @Post('run-now')
  @Can('settings.integrations')
  @RequireOrgFeature('ai_briefing')
  runNow(@Query() q: SlotQueryDto) {
    return this.briefings.runSlot(q.slot ?? nowSlot());
  }

  @Get('preview')
  @Can('reports.overview')
  @RequireOrgFeature('ai_briefing')
  preview(@CurrentUser() user: AuthUser, @Query() q: SlotQueryDto) {
    return this.briefings.previewFor(user, q.slot ?? nowSlot());
  }

  @Get()
  @Can('reports.overview')
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.briefing.findMany({
      where: { user_id: user.userId },
      orderBy: { created_at: 'desc' },
      take: 30,
      select: { id: true, slot: true, day: true, title: true, text: true, channels: true, created_at: true },
    });
  }

  @Get(':id')
  @Can('reports.overview')
  async one(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.own(user, id);
  }

  private async own(user: AuthUser, id: number) {
    const row = await this.prisma.briefing.findFirst({ where: { id, user_id: user.userId } });
    if (!row) throw new NotFoundException('Không tìm thấy');
    return row;
  }
}
