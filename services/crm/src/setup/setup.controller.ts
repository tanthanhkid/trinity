import { BadRequestException, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { can } from '@trinity/rbac';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { mcpResourceUrl, oauthEnabled, publicBaseUrl } from '../integrations/oauth/oauth-config';
import { SetupStatusService } from './setup-status.service';

/** Màn "Bắt đầu": trạng thái dựng quy trình + địa chỉ MCP + AI đã nối chưa. */
@ApiTags('Setup')
@ApiBearerAuth()
@Controller('setup')
export class SetupController {
  constructor(private readonly setup: SetupStatusService) {}

  @Get('status')
  @AuthOnly()
  @ApiOperation({ summary: 'Trạng thái dựng quy trình (chua_dung | dang_dung | da_dung) + MCP' })
  async status(@CurrentUser() user: AuthUser) {
    const base = publicBaseUrl();
    const mcpOn = oauthEnabled();
    const [status, mine, anyone] = await Promise.all([this.setup.get(), this.setup.aiConnection(user.userId), this.setup.aiConnection()]);
    return {
      status,
      mcp_url: mcpOn && base ? mcpResourceUrl(base) : null,
      ai_connected: mine.active,
      ai_granted: mine.granted,
      ai_last_active_at: mine.last_active_at,
      ai_connected_anyone: anyone.active,
      can_build: can(user.grants, 'custom_objects.manage'),
    };
  }

  @Get('onboarding')
  @AuthOnly()
  @ApiOperation({ summary: 'Màn hướng dẫn người mới: đã xem chưa + các bước bắt đầu đã xong chưa (theo dữ liệu thật)' })
  onboarding(@CurrentUser() user: AuthUser) {
    return this.setup.onboarding(user.userId);
  }

  @Post('onboarding/seen')
  @AuthOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Đánh dấu người đang đăng nhập đã xem màn hướng dẫn (lần đăng nhập sau không tự mở nữa)' })
  async onboardingSeen(@CurrentUser() user: AuthUser) {
    await this.setup.markOnboardingSeen(user.userId);
    return { seen: true };
  }

  @Post('complete')
  @Can('custom_objects.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hoàn tất dựng quy trình (dang_dung → da_dung). Chưa duyệt gói dựng thì không hoàn tất được.' })
  @ApiResponse({ status: 400, description: 'Chưa dựng (chua_dung)' })
  async complete(@CurrentUser() user: AuthUser) {
    const cur = await this.setup.get();
    if (cur === 'chua_dung') throw new BadRequestException('Chưa dựng quy trình: hãy để AI đề xuất gói dựng và duyệt trước.');
    return { status: await this.setup.set('da_dung', user.userId) };
  }
}
