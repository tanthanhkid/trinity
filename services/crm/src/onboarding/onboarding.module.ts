import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { SocialModule } from '../social/social.module';
import { OnboardingWizardController } from './onboarding-wizard.controller';
import { OnboardingWizardService } from './onboarding-wizard.service';

/** Wizard bắt đầu cho người mới. */
@Module({
  imports: [SettingsModule, SocialModule],
  controllers: [OnboardingWizardController],
  providers: [OnboardingWizardService],
})
export class OnboardingModule {}
