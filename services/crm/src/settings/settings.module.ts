import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { OrgFeaturesController } from './org-features.controller';
import { OrgFeaturesService } from './org-features.service';
import { SettingsService } from './settings.service';
import { SetupStatusService } from '../setup/setup-status.service';
import { SetupController } from '../setup/setup.controller';

@Module({
  controllers: [SettingsController, OrgFeaturesController, SetupController],
  providers: [
    SettingsService,
    OrgFeaturesService,
    SetupStatusService,
  ],
  exports: [SettingsService, OrgFeaturesService, SetupStatusService],
})
export class SettingsModule {}
