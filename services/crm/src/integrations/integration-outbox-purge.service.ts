import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IntegrationEventsService, integrationFlags } from '@trinity/prisma';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

/**
 * Job dọn outbox `integration_events` (đã dispatch > 30 ngày; chưa dispatch > 90 ngày).
 * MẶC ĐỊNH TẮT — chỉ khởi động khi `INTEGRATIONS_WEBHOOKS_ENABLED` hoặc
 * `INTEGRATIONS_MCP_ENABLED` bật. Cờ tắt = không timer nào được tạo.
 */
@Injectable()
export class IntegrationOutboxPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationOutboxPurgeService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly events: IntegrationEventsService) {}

  onModuleInit(): void {
    // Cron tick (serverless + gọi tay): cờ tắt = bỏ qua như timer.
    cronRegistry.register({
      name: 'integrations.outbox-purge',
      budgetMs: 20_000,
      run: async () => (integrationFlags.anyEnabled() ? this.runOnce() : { skipped: 'flag-off' }),
    });
    // Serverless: không timer nào — việc dọn do `/internal/cron/tick` làm.
    if (isServerless()) return;
    if (!integrationFlags.anyEnabled()) return;
    this.first = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS);
    this.interval = setInterval(() => void this.runOnce(), SIX_HOURS_MS);
    // Không giữ process sống chỉ vì job dọn.
    this.first.unref();
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.interval) clearInterval(this.interval);
    this.first = null;
    this.interval = null;
  }

  /** Public để test gọi trực tiếp. Không ném lỗi (job nền). */
  async runOnce(): Promise<void> {
    try {
      const { dispatched, stale } = await this.events.purge();
      if (dispatched + stale > 0) {
        this.logger.log(`Outbox purge: ${dispatched} đã dispatch >30 ngày, ${stale} chưa dispatch >90 ngày`);
      }
    } catch (err) {
      this.logger.error(`Outbox purge failed: ${(err as Error)?.message}`);
    }
  }
}
