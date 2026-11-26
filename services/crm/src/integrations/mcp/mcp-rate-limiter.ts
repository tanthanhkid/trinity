import { Injectable } from '@nestjs/common';
import { tenantKey } from '@trinity/prisma';
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
 * Cửa sổ cố định 1 phút trong RAM của tiến trình (G12a bỏ Redis), cùng kiểu các giới hạn khác của app.
 */
@Injectable()
export class McpRateLimiter {
  private readonly mem = new Map<string, FixedWindowLimiter>();

  private memLimiter(max: number): FixedWindowLimiter {
    const key = String(max);
    let l = this.mem.get(key);
    if (!l) {
      l = new FixedWindowLimiter(max, 60_000);
      this.mem.set(key, l);
    }
    return l;
  }

  async hit(scope: string, rawId: string | number, max: number): Promise<LimitResult> {
    // User ids repeat across companies (multi-tenant): key by company too. Company 1 keeps the bare id.
    const id = tenantKey(rawId);
    const r = this.memLimiter(max).hit(`${scope}:${id}`);
    return { allowed: r.allowed, retryAfterSec: r.retryAfterSec || 1 };
  }

  /** Xoá mọi bộ đếm (test e2e dùng để bắt đầu sạch). */
  reset(): void {
    this.mem.clear();
  }
}
