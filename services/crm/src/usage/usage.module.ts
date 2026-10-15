import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { OrgFeatureGuard } from './org-feature.guard';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';

/** Global: module khác (–) inject `UsageService` / dùng `@RequireOrgFeature` không cần import. */
@Global()
@Module({
  imports: [SettingsModule],
  controllers: [UsageController],
  providers: [UsageService, OrgFeatureGuard],
  exports: [UsageService, OrgFeatureGuard, SettingsModule],
})
export class UsageModule {}
