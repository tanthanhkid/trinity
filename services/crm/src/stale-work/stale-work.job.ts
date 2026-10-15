import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { StaleWorkService } from './stale-work.service';

const FIRST_RUN_DELAY_MS = 4 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

/** Cờ env: job nhắc việc treo MẶC ĐỊNH TẮT. Bật: `STALE_REMINDERS_ENABLED=true`. */
export const staleJobEnabled = (): boolean => process.env.STALE_REMINDERS_ENABLED === 'true';

@Injectable()
export class StaleWorkJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaleWorkJob.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly service: StaleWorkService) {}

  onModuleInit(): void {
    cronRegistry.register({
      name: 'stale-work.digest',
      budgetMs: 25_000,
      run: async () => (staleJobEnabled() ? this.service.runOnce() : { skipped: 'flag-off' }),
    });
    if (isServerless() || !staleJobEnabled()) return;
    this.first = setTimeout(() => void this.tick(), FIRST_RUN_DELAY_MS);
    this.interval = setInterval(() => void this.tick(), INTERVAL_MS);
    this.first.unref();
    this.interval.unref();
    this.logger.log('Job nhắc việc treo đã bật (kiểm tra 15 phút/lượt, gửi 1 lần/ngày)');
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.interval) clearInterval(this.interval);
    this.first = null;
    this.interval = null;
  }

  private async tick(): Promise<void> {
    try {
      await this.service.runOnce();
    } catch (err) {
      this.logger.error(`Nhắc việc treo lỗi: ${(err as Error)?.message}`);
    }
  }
}
