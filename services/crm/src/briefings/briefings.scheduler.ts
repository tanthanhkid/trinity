import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { BriefingsService } from './briefings.service';

const ONE_MIN_MS = 60_000;

/**
 * Lịch bản tin. Serverless: chỉ đăng ký job vào `cronRegistry`, `/internal/cron/tick` gọi `runDue()`  (chạy mấy lần/ngày
 * tuỳ lịch cron ngoài gọi tick).
 * Tiến trình dài: timer mỗi phút gọi `runDue()`. MẶC ĐỊNH TẮT — timer chỉ chạy khi env `BRIEFING_CRON_ENABLED=true`;
 * ngoài ra còn công tắc `enabled` trong Cài đặt và cờ `ai_briefing`.
 */
@Injectable()
export class BriefingsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BriefingsScheduler.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly briefings: BriefingsService) {}

  onModuleInit(): void {
    cronRegistry.register({ name: 'briefings.run-due', budgetMs: 40_000, run: () => this.briefings.runDue() });
    if (isServerless() || process.env.BRIEFING_CRON_ENABLED?.trim() !== 'true') return;
    this.interval = setInterval(() => void this.tick(), ONE_MIN_MS);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** Chặn chồng lượt khi một lượt chạy quá 1 phút (tác vụ chậm). */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.briefings.runDue();
    } catch (err) {
      this.logger.error(`Bản tin lỗi: ${(err as Error)?.message}`);
    } finally {
      this.running = false;
    }
  }
}
