import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Can, CurrentUser, type AuthUser } from '@trinity/rbac-nest';
import { BuildSystemDto } from '../setup/setup-build.dto';
import { SetupBuildService } from '../setup/setup-build.service';
import { OnboardingWizardService } from './onboarding-wizard.service';

/** "Dựng hệ thống" bằng một lần bấm: chọn loại doanh nghiệp + phân hệ, không cần trợ lý AI. */
@ApiTags('Setup')
@ApiBearerAuth()
@Controller('setup/build')
export class SetupBuildController {
  constructor(
    private readonly build: SetupBuildService,
    private readonly wizard: OnboardingWizardService,
  ) {}

  @Post()
  @Can('custom_objects.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dựng hệ thống: lưu phân hệ, áp mẫu ngành (bảng + trường), kèm vài bản ghi mẫu tự xoá khi có bản ghi thật đầu tiên. Chạy lại được.' })
  async run(@CurrentUser() user: AuthUser, @Body() dto: BuildSystemDto) {
    const result = await this.build.build(user, dto);
    return { ...result, wizard: await this.wizard.view(user.userId, user.grants) };
  }
}
