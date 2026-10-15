import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cronRegistry, isServerless } from '@trinity/rbac-nest';
import { oauthEnabled } from '../../oauth/oauth-config';
import { AiActionsService } from './ai-actions.service';

const TEN_MIN_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 8 * 60 * 1000;

/**
 * Chuyển nháp AI chờ quá 24 giờ sang `expired` (+ dọn nháp đã xong >90 ngày). MẶC ĐỊNH TẮT — chỉ chạy khi cờ
 * `INTEGRATIONS_MCP_ENABLED` + base URL bật; tắt = không timer nào. (API vẫn coi nháp quá hạn là `expired` dù job chưa chạy.)
 */
@Injectable()
export class AiActionExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiActionExpiryService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly actions: AiActionsService) {}

  onModuleInit(): void {
    // Hết hạn đề xuất AI + kẹt `executing` (expireOverdue xử lý cả hai) — chạy trong cron tick khi serverless.
    cronRegistry.register({
      name: 'integrations.ai-action-expiry',
      budgetMs: 20_000,
      run: async () => (oauthEnabled() ? this.runOnce() : { skipped: 'flag-off' }),
    });
    if (isServerless()) return;
    if (!oauthEnabled()) return;
    this.first = setTimeout(() => void this.runOnce(), FIRST_RUN_DELAY_MS);
    this.interval = setInterval(() => void this.runOnce(), TEN_MIN_MS);
    this.first.unref();
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.interval) clearInterval(this.interval);
    this.first = null;
    this.interval = null;
  }

  async runOnce(now = Date.now()): Promise<{ expired: number; purged: number; stale: number }> {
    try {
      const out = await this.actions.expireOverdue(now);
      if (out.expired + out.purged + out.stale > 0) this.logger.log(`Đề xuất AI: ${out.expired} hết hạn, ${out.stale} kết quả không rõ, ${out.purged} đã dọn`);
      return out;
    } catch (err) {
      this.logger.error(`Dọn đề xuất AI lỗi: ${(err as Error)?.message}`);
      return { expired: 0, purged: 0, stale: 0 };
    }
  }
}
