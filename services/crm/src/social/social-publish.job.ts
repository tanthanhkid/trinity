import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { isSecretKeyConfigured } from '../integrations/webhooks/secret-crypto';
import { SocialPostsService } from './social-posts.service';

const INTERVAL_MS = 60_000;
/** Lấy số bài đã đăng mỗi 15 phút (từng bài tự giãn: bài mới 1 giờ, bài cũ 6 giờ). */
const METRICS_INTERVAL_MS = 15 * 60_000;

/**
 * Job đăng bài + thử lại có giãn cách, và lấy số liệu bài đã đăng. Bài được đăng ngay lúc tạo (kick nền); job này nhặt phần còn lại.
 * VPS: timer mỗi phút. Serverless: chỉ `/internal/cron/tick` (Vercel Cron) — không tự thử lại, người dùng bấm Thử lại.
 */
@Injectable()
export class SocialPublishJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialPublishJob.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly posts: SocialPostsService) {}

  onModuleInit(): void {
    cronRegistry.register({
      name: 'social.publish',
      budgetMs: 40_000,
      run: async () => (isSecretKeyConfigured() ? this.posts.runDue(40_000) : { skipped: 'no-secret-key' }),
    });
    cronRegistry.register({
      name: 'social.metrics',
      budgetMs: 25_000,
      run: async () => (isSecretKeyConfigured() ? this.posts.refreshMetricsDue(25_000) : { skipped: 'no-secret-key' }),
    });
    if (isServerless()) return;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref();
    this.metricsTimer = setInterval(() => void this.metrics(), METRICS_INTERVAL_MS);
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
