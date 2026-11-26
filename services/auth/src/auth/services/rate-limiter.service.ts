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
   * IP khách không tin được (TRUSTED_PROXY chưa khớp): khoá CHỈ theo email (`login-untrusted:<email>`), không gộp chung
   * một IP peer cho mọi người — nếu gộp, ai cũng khoá được tài khoản người khác. Ngưỡng cao hơn vì mọi người dùng chung
   * một khoá theo email, không còn tách theo IP.
   */
  private readonly UNTRUSTED_MAX_ATTEMPTS = 30
  private readonly PUBLIC_UNTRUSTED_MAX_ATTEMPTS = 15

  isRateLimited(key: string): boolean {
    // Public third-party ("public-login:"): ngưỡng chặt. Login nội bộ ("login:"):
    // ngưỡng rộng hơn (key theo IP + email nên người dùng gõ nhầm vài lần không
    // bị khoá) nhưng vẫn chặn brute-force mật khẩu.
    const limit = key.startsWith('public-login-untrusted:')
      ? this.PUBLIC_UNTRUSTED_MAX_ATTEMPTS
      : key.startsWith('login-untrusted:')
        ? this.UNTRUSTED_MAX_ATTEMPTS
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
