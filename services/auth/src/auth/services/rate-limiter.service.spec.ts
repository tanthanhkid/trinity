import { RateLimiterService } from './rate-limiter.service'

describe('RateLimiterService', () => {
  it('login nội bộ: chặn sau 10 lần sai, chưa chặn ở lần 9', () => {
    const rl = new RateLimiterService()
    const key = 'login:1.1.1.1:a@b.c'
    for (let i = 0; i < 9; i++) rl.recordAttempt(key)
    expect(rl.isRateLimited(key)).toBe(false)
    rl.recordAttempt(key)
    expect(rl.isRateLimited(key)).toBe(true)
    rl.resetAttempts(key)
    expect(rl.isRateLimited(key)).toBe(false)
  })
  it('public-login: chặn sau 5 lần', () => {
    const rl = new RateLimiterService()
    const key = 'public-login:1.1.1.1:a@b.c'
    for (let i = 0; i < 5; i++) rl.recordAttempt(key)
    expect(rl.isRateLimited(key)).toBe(true)
  })

  describe('IP không tin được', () => {
    it('khoá theo email chỉ để làm chậm, không bao giờ chặn', () => {
      const rl = new RateLimiterService()
      for (let i = 0; i < 100; i++) rl.recordAttempt('login-untrusted-email:a@b.c')
      expect(rl.isRateLimited('login-untrusted-email:a@b.c')).toBe(false)
      expect(rl.attempts('login-untrusted-email:a@b.c')).toBe(100)
    })

    it('trần theo IP peer 300; đăng ký/nhận lời mời có trần chung riêng 200 và khoá riêng theo email/token (10)', () => {
      const rl = new RateLimiterService()
      for (let i = 0; i < 299; i++) rl.recordAttempt('login-untrusted:127.0.0.1')
      expect(rl.isRateLimited('login-untrusted:127.0.0.1')).toBe(false)
      rl.recordAttempt('login-untrusted:127.0.0.1')
      expect(rl.isRateLimited('login-untrusted:127.0.0.1')).toBe(true)
      for (let i = 0; i < 199; i++) rl.recordAttempt('invite-untrusted-all')
      expect(rl.isRateLimited('invite-untrusted-all')).toBe(false)
      rl.recordAttempt('invite-untrusted-all')
      expect(rl.isRateLimited('invite-untrusted-all')).toBe(true)
      for (let i = 0; i < 10; i++) rl.recordAttempt('register-untrusted:a@b.c')
      expect(rl.isRateLimited('register-untrusted:a@b.c')).toBe(true)
      expect(rl.isRateLimited('register-untrusted:other@b.c')).toBe(false)
    })
  })
})
