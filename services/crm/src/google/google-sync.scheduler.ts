import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { loadGoogleConfig } from './google-config';
import { GoogleFeatureService } from './google-feature.service';
import { GoogleSyncService } from './google-sync.service';

const TICK_MS = 60_000;
const FIRST_DELAY_MS = 90_000;

/**
 * Chạy định kỳ các cấu hình đến hạn. Không hoạt động khi Google chưa cấu hình (không có timer, job cron trả 'skipped').
 * Serverless: không timer — `/internal/cron/tick` gọi job đã đăng ký (cùng cách `integrations.outbox-purge`).
 */
@Injectable()
export class GoogleSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GoogleSyncScheduler.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly syncs: GoogleSyncService, private readonly feature: GoogleFeatureService) {}

  onModuleInit(): void {
    cronRegistry.register({
      name: 'google.sheet-sync',
      budgetMs: 35_000,
      run: async () => (loadGoogleConfig() ? this.tick() : { skipped: 'google-not-configured' }),
    });
    if (isServerless() || !loadGoogleConfig()) return;
    this.first = setTimeout(() => void this.tick(), FIRST_DELAY_MS);
    this.interval = setInterval(() => void this.tick(), TICK_MS);
    this.first.unref();
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.interval) clearInterval(this.interval);
    this.first = this.interval = null;
  }

  /** Public để test gọi trực tiếp. Không ném lỗi (job nền); tuần tự để không dồn tải Google/DB. */
  async tick(): Promise<{ ran: number; failed: number }> {
    let ran = 0;
    let failed = 0;
    try {
      if (!(await this.feature.isEnabled())) return { ran, failed };
      for (const id of await this.syncs.due()) {
        try {
          await this.syncs.execute(id, 'schedule');
          ran++;
        } catch (e) {
          failed++;
          this.logger.warn(`Đồng bộ định kỳ sync=${id} bỏ qua: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.error(`Google sheet-sync tick lỗi: ${(e as Error)?.message}`);
    }
    return { ran, failed };
  }
}
