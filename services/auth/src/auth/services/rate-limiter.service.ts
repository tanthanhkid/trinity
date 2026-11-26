import { Injectable } from '@nestjs/common'

interface RateLimitEntry {
  count: number
  expiresAt: number
}

@Injectable()
export class RateLimiterService {
  private readonly store = new Map<string, RateLimitEntry>()
  private readonly MAX_ATTEMPTS = 10
  private readonly WINDOW_MS = 15 * 60 * 1000 // 15 minutes
  private readonly PUBLIC_MAX_ATTEMPTS = 5
  private readonly PUBLIC_WINDOW_MS = 15 * 60 * 1000
  /**
   * IP khách không tin được (TRUSTED_PROXY chưa khớp): mọi người chung một IP peer.
   * - `login-untrusted:<peer>`: trần RẤT cao (3000 lần sai/15 phút) chỉ chống dò hàng loạt — một người không chặn được
   *   đăng nhập của mọi người.
   * - `login-untrusted-email:<email>`: làm chậm dần từ lần sai thứ 5 (`AuthService.slowDownUntrusted`), trần cứng 50 lần
   *   sai/15 phút (đủ cao để người dùng thật không chạm, vẫn chặn brute-force một tài khoản).
   * - `*-untrusted-all`: trần chung cho đăng ký / nhận lời mời, chỉ đếm lần THẤT BẠI.
   */
  private readonly UNTRUSTED_PEER_MAX_ATTEMPTS = 3000
  private readonly PUBLIC_UNTRUSTED_PEER_MAX_ATTEMPTS = 1000
  private readonly UNTRUSTED_EMAIL_MAX_ATTEMPTS = 50
  /** Trần chung cho đăng ký / nhận lời mời khi IP không tin được (`register-untrusted-all`, `invite-untrusted-all`), đếm lần thất bại. */
  private readonly UNTRUSTED_ALL_MAX_ATTEMPTS = 500

  isRateLimited(key: string): boolean {
    // Public third-party ("public-login:"): ngưỡng chặt. Login nội bộ ("login:"):
    // ngưỡng rộng hơn (key theo IP + email nên người dùng gõ nhầm vài lần không
    // bị khoá) nhưng vẫn chặn brute-force mật khẩu.
    if (key.startsWith('login-untrusted-email:')) return this.count(key) >= this.UNTRUSTED_EMAIL_MAX_ATTEMPTS
    if (key.endsWith('-untrusted-all')) return this.count(key) >= this.UNTRUSTED_ALL_MAX_ATTEMPTS
    const limit = key.startsWith('public-login-untrusted:')
      ? this.PUBLIC_UNTRUSTED_PEER_MAX_ATTEMPTS
      : key.startsWith('login-untrusted:')
        ? this.UNTRUSTED_PEER_MAX_ATTEMPTS
        : key.startsWith('public-login:')
          ? this.PUBLIC_MAX_ATTEMPTS
          : this.MAX_ATTEMPTS
    const entry = this.store.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return false
    }
    return entry.count >= limit
  }

  recordAttempt(key: string): void {
    this.cleanup()
    const existing = this.store.get(key)
    const now = Date.now()

    if (existing && now <= existing.expiresAt) {
      existing.count++
    } else {
      this.store.set(key, {
        count: 1,
        expiresAt: now + this.WINDOW_MS,
      })
    }
  }

  private count(key: string): number {
    return this.attempts(key)
  }

  /** Số lần đã ghi trong cửa sổ hiện tại (0 nếu hết hạn/chưa có). */
  attempts(key: string): number {
    const entry = this.store.get(key)
    if (!entry || Date.now() > entry.expiresAt) return 0
    return entry.count
  }

  resetAttempts(key: string): void {
    this.store.delete(key)
  }

  getRetryAfterSeconds(key: string): number {
    const entry = this.store.get(key)
    if (!entry) return 0
    return Math.ceil((entry.expiresAt - Date.now()) / 1000)
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
      }
    }
  }

  /** Exposed for testing */
  clear(): void {
    this.store.clear()
  }
}
