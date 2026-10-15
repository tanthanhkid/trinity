import type { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { createRedisClient } from '@trinity/rbac-nest';

/**
 * Shared Redis client cho CRM service.
 *
 * Giữ provider/key chuẩn để dễ mở rộng (rate limiter, dedupe, count cache).
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (): Redis => {
    // Serverless không REDIS_URL → Redis giả trong RAM, không gõ cửa localhost:6379.
    return createRedisClient(
      () =>
        new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
          lazyConnect: false,
          // Tránh spam stack trace khi Redis tạm thời mất kết nối — caller đã có
          // fallback path (xem ContactsService count cache fallback về DB).
          maxRetriesPerRequest: 2,
        }),
    );
  },
};
