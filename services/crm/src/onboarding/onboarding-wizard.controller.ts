import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthOnly, Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { WizardConfigDto, WizardStepDto } from './onboarding-wizard.dto';
import { OnboardingWizardService } from './onboarding-wizard.service';

/** Wizard bắt đầu: chưa đi hết thì web không cho vào ứng dụng; mỗi bước máy chủ kiểm dữ liệu thật. */
@ApiTags('Setup')
@ApiBearerAuth()
@Controller('setup/wizard')
export class OnboardingWizardController {
  constructor(private readonly wizard: OnboardingWizardService) {}

  @Get()
  @AuthOnly()
  @ApiOperation({ summary: 'Các bước bắt đầu của người đang đăng nhập: bước nào đã đạt, đang ở bước nào, đã xong chưa' })
  view(@CurrentUser() user: AuthUser) {
    return this.wizard.view(user.userId, user.grants);
  }

  @Post('confirm')
  @AuthOnly()
  @HttpCode(200)
  @ApiOperation({ summary: '"Tôi đã làm xong": kiểm thật bước; chưa đạt trả ok=false + việc còn thiếu' })
  confirm(@CurrentUser() user: AuthUser, @Body() dto: WizardStepDto) {
    return this.wizard.confirm(user.userId, user.grants, dto.step);
  }

  @Post('skip')
  @AuthOnly()
  @HttpCode(200)
  @ApiOperation({ summary: 'Bỏ qua bước — chỉ được khi cấu hình cho phép bỏ qua bước đó' })
  skip(@CurrentUser() user: AuthUser, @Body() dto: WizardStepDto) {
    return this.wizard.skip(user.userId, user.grants, dto.step);
  }

  @Get('config')
  @Can('settings.features')
  @ApiOperation({ summary: 'Cấu hình wizard (bật/tắt, bước được bỏ qua, miễn tài khoản cũ)' })
  config() {
    return this.wizard.config();
  }

  @Put('config')
  @Can('settings.features')
  @ApiOperation({ summary: 'Đổi cấu hình wizard' })
  setConfig(@CurrentUser() user: AuthUser, @Body() dto: WizardConfigDto) {
    return this.wizard.setConfig(dto, user.userId);
  }
}
