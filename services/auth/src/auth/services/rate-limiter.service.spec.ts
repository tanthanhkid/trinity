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
})
