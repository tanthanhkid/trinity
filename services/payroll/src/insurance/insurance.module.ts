import { Module } from '@nestjs/common'
import { InsuranceSettingsController } from './insurance-settings.controller'
import { InsuranceSettingsService } from './insurance-settings.service'
import { InsuranceEngine } from './insurance.engine'

@Module({
  controllers: [InsuranceSettingsController],
  providers: [InsuranceSettingsService, InsuranceEngine],
  exports: [InsuranceSettingsService, InsuranceEngine],
})
export class InsuranceModule {}
