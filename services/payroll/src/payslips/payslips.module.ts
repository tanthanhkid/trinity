import { Module } from '@nestjs/common'
import { PayslipsController } from './payslips.controller'
import { PayslipsService } from './payslips.service'
import { SalaryComponentsEngine } from '../salary-components/salary-components-engine.service'
import { InsuranceEngine } from '../insurance/insurance.engine'
import { TaxEngine } from '../tax/tax.engine'

@Module({
  controllers: [PayslipsController],
  providers: [PayslipsService, SalaryComponentsEngine, InsuranceEngine, TaxEngine],
  exports: [PayslipsService],
})
export class PayslipsModule {}
