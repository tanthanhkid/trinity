import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isSecretKeyConfigured } from '../integrations/webhooks/secret-crypto';
import { SocialRecurrenceService } from './social-recurrence.service';
import { SocialPostsService } from './social-posts.service';
import { tenantTimerTick } from '../common/helpers/tenant-timer';

const INTERVAL_MS = 60_000;
/** Lấy số bài đã đăng mỗi 15 phút (từng bài tự giãn: bài mới 1 giờ, bài cũ 6 giờ). */
const METRICS_INTERVAL_MS = 15 * 60_000;

/**
 * Job đăng bài + thử lại có giãn cách, và lấy số liệu bài đã đăng. Bài được đăng ngay lúc tạo (kick nền); job này nhặt phần còn lại.
 * Timer mỗi phút.
 */
@Injectable()
export class SocialPublishJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialPublishJob.name);
  /** Timer chạy ngoài request: mỗi lượt chạy cho từng công ty (multi-tenant). */
  private readonly timerTick = tenantTimerTick(this.logger, 'Job đăng bài', () => this.tick(), undefined, 'social.publish');
  private readonly metricsTick = tenantTimerTick(this.logger, 'Job lấy số bài', () => this.metrics(), undefined, 'social.metrics');
  private timer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly posts: SocialPostsService,
    private readonly recurrences: SocialRecurrenceService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.timerTick(), INTERVAL_MS);
    this.timer.unref();
    this.metricsTimer = setInterval(() => void this.metricsTick(), METRICS_INTERVAL_MS);
    this.metricsTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.timer = null;
    this.metricsTimer = null;
  }

  private async tick(): Promise<void> {
    if (!isSecretKeyConfigured()) return;
    try {
      await this.recurrences.materialize();
      await this.posts.runDue(50_000);
    } catch (err) {
      this.logger.error(`Job đăng bài lỗi: ${(err as Error)?.message}`);
    }
  }

  private async metrics(): Promise<void> {
    if (!isSecretKeyConfigured()) return;
    try {
      await this.posts.refreshMetricsDue(60_000);
    } catch (err) {
      this.logger.error(`Job lấy số bài lỗi: ${(err as Error)?.message}`);
    }
  }
}
