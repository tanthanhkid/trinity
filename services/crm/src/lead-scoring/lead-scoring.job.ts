import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { LeadScoringService } from './lead-scoring.service';

const FIRST_RUN_DELAY_MS = 3 * 60 * 1000;
const INTERVAL_MS = 10 * 60 * 1000;

/** Cờ env: job chấm điểm lead MẶC ĐỊNH TẮT. Bật: `LEAD_SCORING_ENABLED=true`. */
export const leadScoringJobEnabled = (): boolean => process.env.LEAD_SCORING_ENABLED === 'true';

@Injectable()
export class LeadScoringJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadScoringJob.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly service: LeadScoringService) {}

  onModuleInit(): void {
    cronRegistry.register({
      name: 'lead-scoring.run',
      budgetMs: 25_000,
      run: async () => (leadScoringJobEnabled() ? this.service.runOnce() : { skipped: 'flag-off' }),
    });
    if (isServerless() || !leadScoringJobEnabled()) return;
    this.first = setTimeout(() => void this.tick(), FIRST_RUN_DELAY_MS);
    this.interval = setInterval(() => void this.tick(), INTERVAL_MS);
    this.first.unref();
    this.interval.unref();
    this.logger.log('Job chấm điểm lead đã bật (10 phút/lượt)');
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.interval) clearInterval(this.interval);
    this.first = null;
    this.interval = null;
  }

  private async tick(): Promise<void> {
    await this.service.runOnce();
  }
}
