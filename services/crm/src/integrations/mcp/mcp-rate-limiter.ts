import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { isServerless } from '@trinity/rbac-nest';
import { REDIS_CLIENT } from '../../common/redis.provider';
import { FixedWindowLimiter } from '../../common/helpers/fixed-window-limiter';

export const MCP_CALLS_PER_MINUTE = 60;
export const MCP_REQUESTS_PER_MINUTE = 240;
export const MCP_AUTH_FAIL_PER_MINUTE = 30;

export interface LimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Giới hạn theo USER (không theo IP — một người có thể dùng nhiều thiết bị; ChatGPT/Claude gọi từ dải IP chung).
 * Redis (`INCR` + `EXPIRE` theo phút) khi có, mất Redis → RƠI VỀ bộ đếm trong RAM (không bao giờ bỏ giới hạn).
 * Serverless không có `REDIS_URL`: dùng thẳng bộ đếm RAM của instance (không gõ cửa localhost:6379, không log).
 */
@Injectable()
export class McpRateLimiter {
  private readonly logger = new Logger(McpRateLimiter.name);
  private readonly mem = new Map<string, FixedWindowLimiter>();
  private lastWarn = 0;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private memLimiter(max: number): FixedWindowLimiter {
    const key = String(max);
    let l = this.mem.get(key);
    if (!l) {
      l = new FixedWindowLimiter(max, 60_000);
      this.mem.set(key, l);
    }
    return l;
  }

  async hit(scope: string, id: string | number, max: number): Promise<LimitResult> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `mcp:rl:${scope}:${id}:${minute}`;
    if (isServerless() && !process.env.REDIS_URL) return this.hitMem(scope, id, max);
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 70);
      return { allowed: n <= max, retryAfterSec: Math.max(1, 60 - (Math.floor(Date.now() / 1000) % 60)) };
    } catch (err) {
      if (Date.now() - this.lastWarn > 60_000) {
        this.lastWarn = Date.now();
        this.logger.warn(`Redis rate limit lỗi (${(err as Error)?.message}) — dùng bộ đếm RAM`);
      }
      return this.hitMem(scope, id, max);
    }
  }

  private hitMem(scope: string, id: string | number, max: number): LimitResult {
    const r = this.memLimiter(max).hit(`${scope}:${id}`);
    return { allowed: r.allowed, retryAfterSec: r.retryAfterSec || 1 };
  }
}
