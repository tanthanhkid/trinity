import { Module } from '@nestjs/common';
import { CustomObjectsModule } from '../custom-objects/custom-objects.module';
import { SettingsModule } from '../settings/settings.module';
import { SocialModule } from '../social/social.module';
import { SetupBuildService } from '../setup/setup-build.service';
import { OnboardingWizardController } from './onboarding-wizard.controller';
import { OnboardingWizardService } from './onboarding-wizard.service';
import { SetupBuildController } from './setup-build.controller';

/** Wizard bắt đầu cho người mới + dựng hệ thống theo loại doanh nghiệp. */
@Module({
  imports: [SettingsModule, SocialModule, CustomObjectsModule],
  controllers: [OnboardingWizardController, SetupBuildController],
  providers: [OnboardingWizardService, SetupBuildService],
  exports: [SetupBuildService],
})
export class OnboardingModule {}
