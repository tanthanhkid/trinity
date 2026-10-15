import { Module } from '@nestjs/common'
import { TaxConfigController } from './tax-config.controller'
import { TaxConfigService } from './tax-config.service'
import { TaxEngine } from './tax.engine'

@Module({
  controllers: [TaxConfigController],
  providers: [TaxConfigService, TaxEngine],
  exports: [TaxConfigService, TaxEngine],
})
export class TaxModule {}
