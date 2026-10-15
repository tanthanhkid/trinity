import { MemoryRedis, createRedisClient, shouldUseMemoryRedis } from './memory-redis'

describe('MemoryRedis', () => {
  const OLD = { ...process.env }
  afterEach(() => {
    process.env = { ...OLD }
    jest.useRealTimers()
  })

  it('set/get/del + TTL hết hạn', async () => {
    jest.useFakeTimers()
    const r = new MemoryRedis()
    expect(await r.set('a', '1', 'EX', 10)).toBe('OK')
    expect(await r.get('a')).toBe('1')
    jest.advanceTimersByTime(11_000)
    expect(await r.get('a')).toBeNull()
    await r.setex('b', 5, 'x')
    expect(await r.del('b')).toBe(1)
  })

  it('NX không ghi đè khi còn sống', async () => {
    const r = new MemoryRedis()
    expect(await r.set('k', '1', 'EX', 30, 'NX')).toBe('OK')
    expect(await r.set('k', '2', 'EX', 30, 'NX')).toBeNull()
    expect(await r.get('k')).toBe('1')
  })

  it('incr + expire (rate limit theo phút)', async () => {
    const r = new MemoryRedis()
    expect(await r.incr('c')).toBe(1)
    expect(await r.expire('c', 70)).toBe(1)
    expect(await r.incr('c')).toBe(2)
    expect(await r.expire('nope', 1)).toBe(0)
  })

  it('createRedisClient: serverless không REDIS_URL → không gọi build()', () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    delete process.env.REDIS_URL
    const build = jest.fn()
    expect(shouldUseMemoryRedis()).toBe(true)
    expect(createRedisClient(build)).toBeInstanceOf(MemoryRedis)
    expect(build).not.toHaveBeenCalled()
  })

  it('createRedisClient: không cờ hoặc có REDIS_URL → build() thật', () => {
    delete process.env.TRINITY_RUNTIME
    const real = {} as never
    expect(createRedisClient(() => real)).toBe(real)
    process.env.TRINITY_RUNTIME = 'serverless'
    process.env.REDIS_URL = 'redis://x:6379'
    expect(createRedisClient(() => real)).toBe(real)
  })
})
