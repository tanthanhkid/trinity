interface Bucket {
  count: number;
  expiresAt: number;
}

/**
 * Rate limit cửa sổ cố định, trong RAM (không share giữa instance — đủ cho 1 process monolith). Dùng chung cho
 * `/public/*` (theo api_key) và webhook vào (theo nguồn). Tự dọn bucket hết hạn để Map không phình vô hạn.
 */
export class FixedWindowLimiter {
  /** Mọi limiter đã tạo (tham chiếu yếu) — để API điều khiển test (C18) xoá hết bộ đếm một lần: `resetAll()`. */
  private static readonly registry = new Set<WeakRef<FixedWindowLimiter>>();
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {
    FixedWindowLimiter.registry.add(new WeakRef(this));
  }

  /** Xoá bộ đếm của MỌI limiter trong tiến trình (chỉ dùng cho API điều khiển test). Trả số limiter đã xoá. */
  static resetAll(): number {
    let n = 0;
    for (const ref of FixedWindowLimiter.registry) {
      const l = ref.deref();
      if (!l) FixedWindowLimiter.registry.delete(ref);
      else {
        l.reset();
        n++;
      }
    }
    return n;
  }

  /** `retryAfterSec` > 0 khi bị chặn. */
  hit(key: string, now: number = Date.now()): { allowed: boolean; count: number; retryAfterSec: number } {
    this.sweep(now);
    const cur = this.buckets.get(key);
    if (!cur || now > cur.expiresAt) {
      this.buckets.set(key, { count: 1, expiresAt: now + this.windowMs });
      return { allowed: true, count: 1, retryAfterSec: 0 };
    }
    cur.count += 1;
    if (cur.count > this.max) {
      return { allowed: false, count: cur.count, retryAfterSec: Math.max(1, Math.ceil((cur.expiresAt - now) / 1000)) };
    }
    return { allowed: true, count: cur.count, retryAfterSec: 0 };
  }

  /** Xoá mọi bộ đếm (API điều khiển test, C18). */
  reset(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now > b.expiresAt) this.buckets.delete(k);
  }
}
