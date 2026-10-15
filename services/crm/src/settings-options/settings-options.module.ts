import { Module } from '@nestjs/common';
import { SettingsOptionsController } from './settings-options.controller';
import { SettingsOptionsService } from './settings-options.service';

@Module({
  controllers: [SettingsOptionsController],
  providers: [SettingsOptionsService],
  exports: [SettingsOptionsService],
})
export class SettingsOptionsModule {}
