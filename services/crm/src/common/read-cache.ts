import { Global, Injectable, Module } from '@nestjs/common';

/** Cờ tắt cache đọc (đếm khách, dashboard): mọi lần gọi đọc thẳng DB. Dùng cho quét so sánh Node ↔ Rust (X13). */
export const READ_CACHE_DISABLED_ENV = 'TRINITY_DISABLE_READ_CACHE';

export const isReadCacheDisabled = (env: NodeJS.ProcessEnv = process.env): boolean => (env[READ_CACHE_DISABLED_ENV] ?? '').trim() === '1';

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Cache đọc trong RAM của tiến trình (thay Redis, G12a): tổng số khách của danh sách, số liệu dashboard. Giá trị là chuỗi
 * (JSON), luôn có TTL; người gọi tự gắn công ty vào khoá bằng `tenantKey`. Hai tiến trình không thấy cache của nhau:
 * chấp nhận được vì TTL ngắn (15 giây – 5 phút); đồng bộ vô hiệu giữa tiến trình làm ở G12b (Postgres `NOTIFY`).
 * `TRINITY_DISABLE_READ_CACHE=1` ⇒ `get` luôn trượt, `set` không lưu.
 */
@Injectable()
export class ReadCache {
  static readonly MAX_KEYS = 5000;
  /** Quét khoá hết hạn tối đa một lần mỗi chu kỳ này (không quét cả kho ở mỗi lần ghi). */
  static readonly SWEEP_INTERVAL_MS = 30_000;
  private readonly store = new Map<string, Entry>();
  private lastSweep = 0;

  private sweepIfDue(now: number): void {
    if (now - this.lastSweep < ReadCache.SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [k, e] of this.store) if (e.expiresAt <= now) this.store.delete(k);
  }

  get(key: string, now = Date.now()): string | undefined {
    if (isReadCacheDisabled()) return undefined;
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: string, ttlSec: number, now = Date.now()): void {
    if (isReadCacheDisabled() || !(ttlSec > 0)) return;
    this.sweepIfDue(now);
    // Giữ bộ nhớ có trần: vẫn đầy sau khi quét thì bỏ khoá cũ nhất (Map giữ thứ tự chèn).
    if (!this.store.has(key) && this.store.size >= ReadCache.MAX_KEYS) {
      const first = this.store.keys().next();
      if (!first.done) this.store.delete(first.value);
    }
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: now + ttlSec * 1000 });
  }

  /** Xoá mọi khoá bắt đầu bằng `prefix` (vd tổng số khách của một công ty). Trả số khoá đã xoá. */
  deletePrefix(prefix: string): number {
    let n = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }

  get size(): number {
    return this.store.size;
  }
}

/** Global — `ReadCache` inject được ở mọi service trong CRM. */
@Global()
@Module({ providers: [ReadCache], exports: [ReadCache] })
export class ReadCacheModule {}
