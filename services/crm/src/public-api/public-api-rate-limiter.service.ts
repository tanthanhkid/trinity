import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { FixedWindowLimiter } from '../common/helpers/fixed-window-limiter';

/**
 * Rate limit đơn giản in-memory cho /public/* — theo dõi theo `api_key_id`.
 * 100 req/min/key. Bucket tự reset
 * mỗi window. Không share cross-instance: khi cần strict hơn, chuyển sang Redis.
 * Cơ chế đếm nằm ở `FixedWindowLimiter` (dùng chung với webhook vào).
 */
@Injectable()
export class PublicApiRateLimiterGuard implements CanActivate {
  private readonly logger = new Logger(PublicApiRateLimiterGuard.name);
  private readonly limiter = new FixedWindowLimiter(100, 60 * 1000);

  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<Request>();
    const apiKey = (request as unknown as { apiKey?: { id: number } }).apiKey;
    if (!apiKey) {
      // Bình thường ApiKeyGuard chạy trước và attach `apiKey`. Nếu không, controller
      // cấu hình lệch — log để phát hiện ra trước khi rate limit bị bypass im lặng.
      this.logger.warn(
        'PublicApiRateLimiterGuard: request không có apiKey — kiểm tra thứ tự @UseGuards (ApiKeyGuard phải đứng trước).',
      );
      return true;
    }

    const res = this.limiter.hit(`apikey:${apiKey.id}`);
    if (!res.allowed) {
      this.logger.warn(`PublicApi rate limit hit api_key=${apiKey.id} count=${res.count}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Quá nhiều request, vui lòng thử lại sau.',
          retryAfter: res.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
