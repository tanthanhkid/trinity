import { Module } from '@nestjs/common'
import { PrismaModule } from '@trinity/prisma'
import { KpiController } from './kpi.controller'
import { KpiService } from './kpi.service'
import { KpiAggregatorService } from './kpi-aggregator.service'

@Module({
  imports: [PrismaModule],
  controllers: [KpiController],
  providers: [KpiService, KpiAggregatorService],
  exports: [KpiService, KpiAggregatorService],
})
export class KpiModule {}
