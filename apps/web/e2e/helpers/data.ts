import { test } from '@playwright/test'

/** Luồng GHI chỉ chạy khi E2E_ALLOW_WRITE=1 (config cũng chỉ đăng ký project `flows` khi bật). */
export const WRITE_ENABLED = process.env.E2E_ALLOW_WRITE === '1'
export const WRITE_SKIP_REASON = 'Luồng ghi dữ liệu — cần E2E_ALLOW_WRITE=1 (xem e2e/README.md)'

export function requireWrite(): void {
  test.skip(!WRITE_ENABLED, WRITE_SKIP_REASON)
}

/** Tiền tố dữ liệu test: `E2E-<timestamp>-<tag>` — sweeper dọn theo `E2E-`. */
export function prefix(tag: string): string {
  return `E2E-${Date.now()}-${tag}`
}

/** Số điện thoại di động VN giả, duy nhất theo thời gian (09 + 8 số). */
let phoneSeq = 0
export function fakePhone(): string {
  // Date.now() + bộ đếm: 2 lần gọi cùng mili-giây vẫn khác số.
  const tail = String((Date.now() % 100_000_000) + phoneSeq++).padStart(8, '0').slice(-8)
  return `09${tail}`
}

/** Hàng đợi dọn dẹp chạy ở afterAll; lỗi dọn KHÔNG làm đỏ test (đã có sweeper kiểm cuối). */
export class Cleanup {
  private fns: { name: string; fn: () => Promise<unknown> }[] = []
  add(name: string, fn: () => Promise<unknown>): void {
    this.fns.push({ name, fn })
  }
  async run(): Promise<void> {
    for (const { name, fn } of this.fns.reverse()) {
      try {
        await fn()
      } catch (e) {
        console.warn(`[cleanup] ${name} lỗi: ${(e as Error).message}`)
      }
    }
    this.fns = []
  }
}
