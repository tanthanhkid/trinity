import { RbacCache } from './rbac-cache'

describe('RbacCache.invalidateUsers — không đè nhầm user id khác có chung tiền tố', () => {
  let cache: RbacCache

  beforeEach(() => {
    cache = new RbacCache()
  })

  afterEach(async () => {
    await cache.onModuleDestroy()
  })

  it('invalidate user 1 KHÔNG xoá cache của user 12/19 (bug cũ: startsWith trần)', async () => {
    cache.set('g:1', { grants: {}, isAdmin: false })
    cache.set('g:12', { grants: {}, isAdmin: false })
    cache.set('g:19', { grants: {}, isAdmin: false })

    await cache.invalidateUsers([1])

    expect(cache.get('g:1')).toBeUndefined()
    expect(cache.get('g:12')).toBeDefined()
    expect(cache.get('g:19')).toBeDefined()
  })

  it('invalidate user 1 vẫn xoá đúng khoá scope "s:1:team" (không lọt vì thiếu tiền tố)', async () => {
    cache.set('s:1:team', ['x'])
    cache.set('s:12:team', ['y'])

    await cache.invalidateUsers([1])

    expect(cache.get('s:1:team')).toBeUndefined()
    expect(cache.get('s:12:team')).toBeDefined()
  })
})

describe('RbacCache — Redis tuỳ chọn', () => {
  const OLD = { ...process.env }
  afterEach(() => {
    process.env = { ...OLD }
    jest.resetModules()
    jest.dontMock('ioredis')
  })

  function load(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const ctor = jest.fn().mockImplementation(() => ({
      subscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      publish: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
    }))
    jest.doMock('ioredis', () => ({ __esModule: true, default: ctor }))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RbacCache: C } = require('./rbac-cache') as typeof import('./rbac-cache')
    return { cache: new C(), ctor }
  }

  it('serverless + có REDIS_URL → KHÔNG mở kết nối Redis, cache RAM vẫn chạy', async () => {
    const { cache, ctor } = load({ TRINITY_RUNTIME: 'serverless', REDIS_URL: 'redis://x:1' })
    expect(ctor).not.toHaveBeenCalled()
    cache.set('g:1', 1)
    await cache.invalidateUsers([1])
    expect(cache.get('g:1')).toBeUndefined()
  })

  it('không cờ + không REDIS_URL → không kết nối, không lỗi', () => {
    const { ctor } = load({ TRINITY_RUNTIME: undefined, REDIS_URL: undefined })
    expect(ctor).not.toHaveBeenCalled()
  })

  it('không cờ + có REDIS_URL → hành vi cũ: 2 kết nối (pub + sub)', () => {
    const { ctor } = load({ TRINITY_RUNTIME: undefined, REDIS_URL: 'redis://x:1' })
    expect(ctor).toHaveBeenCalledTimes(2)
  })

  it('TTL mặc định 60s', () => {
    const { cache } = load({ TRINITY_RUNTIME: 'serverless' })
    const now = Date.now()
    const spy = jest.spyOn(Date, 'now')
    spy.mockReturnValue(now)
    cache.set('k', 1)
    spy.mockReturnValue(now + 59_000)
    expect(cache.get('k')).toBe(1)
    spy.mockReturnValue(now + 61_000)
    expect(cache.get('k')).toBeUndefined()
    spy.mockRestore()
  })
})
