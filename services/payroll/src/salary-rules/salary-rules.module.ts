import { Module } from '@nestjs/common'
import { SalaryRulesController } from './salary-rules.controller'
import { SalaryRulesService } from './salary-rules.service'

@Module({
  controllers: [SalaryRulesController],
  providers: [SalaryRulesService],
  exports: [SalaryRulesService],
})
export class SalaryRulesModule {}
