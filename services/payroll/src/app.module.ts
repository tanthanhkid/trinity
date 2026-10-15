import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common'
import { PrismaModule } from '@trinity/prisma'
import { ElkLoggerModule } from '@trinity/logger'
import { EmployeesModule } from './employees/employees.module'
import { SalaryRulesModule } from './salary-rules/salary-rules.module'
import { SalaryComponentsModule } from './salary-components/salary-components.module'
import { InsuranceModule } from './insurance/insurance.module'
import { TaxModule } from './tax/tax.module'
import { KpiModule } from './kpi/kpi.module'
import { PayslipsModule } from './payslips/payslips.module'
import { ReportsModule } from './reports/reports.module'
import { HealthController } from './health/health.controller'
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware'
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware'

@Module({
  imports: [
    PrismaModule,
    ElkLoggerModule.forRoot({ service: 'payroll' }),
    EmployeesModule,
    SalaryRulesModule,
    SalaryComponentsModule,
    InsuranceModule,
    TaxModule,
    KpiModule,
    PayslipsModule,
    ReportsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, SecurityHeadersMiddleware).forRoutes('*')
  }
}
