import { Injectable } from '@nestjs/common'

/**
 * Actual KPI values for one employee and month, keyed by the lower-cased
 * `kpi_configs.metric_name`. No metric source is built in: add values here
 * (for example from your own tables or an integration) and `KpiService`
 * will pick them up by name. A metric without a value counts as 0.
 */
export type AggregatedKpiData = Record<string, number>

@Injectable()
export class KpiAggregatorService {
  async aggregateForEmployee(
    _userId: number,
    _month: string,
  ): Promise<AggregatedKpiData> {
    return {}
  }
}
