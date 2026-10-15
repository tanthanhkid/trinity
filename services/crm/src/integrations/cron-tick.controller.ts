import { createHash, timingSafeEqual } from 'crypto';
import { Controller, Get, Headers, HttpCode, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Public, runCronTick, type CronTickSummary } from '@trinity/rbac-nest';

/** So `Authorization: Bearer <secret>` bằng `timingSafeEqual` trên SHA-256 (độ dài cố định, không lộ độ dài secret). */
export function isValidCronAuth(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * `GET /api/v1/internal/cron/tick` — Vercel Cron gọi (kèm `Authorization: Bearer ${CRON_SECRET}` tự động).
 * Chạy MỘT lượt mọi job nền đã đăng ký vào `cronRegistry` (webhook, dọn outbox/OAuth, đề xuất AI hết hạn,
 * thông báo hẹn giờ…), mỗi job có trần thời gian, tổng < 50s. `@Public()` vì xác
 * thực bằng CRON_SECRET riêng (không phải JWT); chưa đặt CRON_SECRET ⇒ 503 (không bao giờ mở công khai).
 * Dùng được cả khi chạy tiến trình dài (gọi tay/crontab) — cờ tắt của từng job vẫn được tôn trọng.
 */
@ApiTags('internal-cron')
@Controller('internal/cron')
export class CronTickController {
  @Get('tick')
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async tick(@Headers('authorization') authorization?: string): Promise<CronTickSummary> {
    const secret = process.env.CRON_SECRET ?? '';
    if (!secret) throw new ServiceUnavailableException('CRON_SECRET chưa được cấu hình');
    if (!isValidCronAuth(authorization, secret)) throw new UnauthorizedException();
    return runCronTick();
  }
}
