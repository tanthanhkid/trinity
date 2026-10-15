import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { FacebookBroadcastsService } from './facebook-broadcasts.service';

const INTERVAL_MS = 60_000;

/** Gửi tin hàng loạt: bắt đầu lượt tới giờ hẹn rồi gửi theo lô. VPS: timer mỗi phút. Serverless: `/internal/cron/tick`. */
@Injectable()
export class FacebookBroadcastsJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FacebookBroadcastsJob.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly broadcasts: FacebookBroadcastsService) {}

  onModuleInit(): void {
    cronRegistry.register({ name: 'facebook.broadcasts', budgetMs: 30_000, run: () => this.broadcasts.runDue(30_000) });
    if (isServerless()) return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.broadcasts.runDue(50_000);
    } catch (err) {
      this.logger.error(`Job gửi hàng loạt lỗi: ${(err as Error)?.message}`);
    } finally {
      this.running = false;
    }
  }
}
