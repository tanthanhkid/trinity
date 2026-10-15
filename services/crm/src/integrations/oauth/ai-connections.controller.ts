import { Controller, Delete, Get, HttpCode, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { can } from '@trinity/rbac';
import { CanAny, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { oauthEnabled } from './oauth-config';
import { AiConnectionsService } from './ai-connections.service';

const isAiAdmin = (u: AuthUser): boolean => u.isAdmin || can(u.grants, 'integrations.ai_admin');

@ApiTags('Integrations — Kết nối AI')
@ApiBearerAuth()
@Controller('integrations/ai-connections')
export class AiConnectionsController {
  constructor(private readonly svc: AiConnectionsService) {}

  @Get()
  @CanAny('integrations.ai_connect', 'integrations.ai_admin')
  @ApiOperation({ summary: 'Ứng dụng AI đã được cấp quyền (của mình; `?scope=all` cần ai_admin)' })
  @ApiResponse({ status: 200, description: '{ data: AiConnectionRow[] }' })
  @ApiResponse({ status: 404, description: 'scope=all mà thiếu integrations.ai_admin (không lộ sự tồn tại)' })
  @ApiResponse({ status: 404, description: 'Kết nối AI chưa bật trên máy chủ' })
  async list(@Query('scope') scope: string | undefined, @CurrentUser() user: AuthUser) {
    if (!oauthEnabled()) throw new NotFoundException();
    const all = scope === 'all';
    if (all && !isAiAdmin(user)) throw new NotFoundException();
    return { data: await this.svc.list(user.userId, all) };
  }

  @Delete(':id')
  @CanAny('integrations.ai_connect', 'integrations.ai_admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Thu hồi một kết nối (của mình; ai_admin thu hồi của mọi người)' })
  @ApiResponse({ status: 204, description: 'Đã thu hồi — token chết ngay' })
  @ApiResponse({ status: 404, description: 'Không có kết nối này (hoặc của người khác mà không có ai_admin)' })
  async revoke(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<void> {
    if (!oauthEnabled()) throw new NotFoundException();
    await this.svc.revoke(id, user.userId, isAiAdmin(user));
  }
}
