import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { FacebookFlowsService } from './facebook-flows.service';
import { tenantTimerTick } from '../common/helpers/tenant-timer';

const INTERVAL_MS = 60_000;

/** Gửi các bước kịch bản nhắn tin đã tới giờ (bước có "chờ N phút"). VPS: timer mỗi phút. Serverless: `/internal/cron/tick`. */
@Injectable()
export class FacebookFlowsJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FacebookFlowsJob.name);
  /** Timer chạy ngoài request: mỗi lượt chạy cho từng công ty (multi-tenant). */
  private readonly timerTick = tenantTimerTick(this.logger, 'Kịch bản nhắn tin', () => this.tick());
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly flows: FacebookFlowsService) {}

  onModuleInit(): void {
    cronRegistry.register({ name: 'facebook.flows', budgetMs: 30_000, run: () => this.flows.runDue(30_000) });
    if (isServerless()) return;
    this.timer = setInterval(() => void this.timerTick(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      await this.flows.runDue(45_000);
    } catch (err) {
      this.logger.error(`Job kịch bản nhắn tin lỗi: ${(err as Error)?.message}`);
    }
  }
}
