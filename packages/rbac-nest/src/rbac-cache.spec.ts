import { RbacCache } from './rbac-cache'

describe('RbacCache.invalidateUsers — không đè nhầm user id khác có chung tiền tố', () => {
  let cache: RbacCache

  beforeEach(() => {
    cache = new RbacCache()
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

describe('RbacCache — chỉ RAM (G12a bỏ Redis)', () => {
  const OLD = { ...process.env }
  afterEach(() => {
    process.env = { ...OLD }
  })

  function load(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return { cache: new RbacCache() }
  }

  it('có REDIS_URL cũng không mở kết nối nào; vô hiệu cục bộ chạy ngay', async () => {
    const { cache } = load({ REDIS_URL: 'redis://x:1' })
    cache.set('g:1', 1)
    await cache.invalidateUsers([1])
    expect(cache.get('g:1')).toBeUndefined()
  })

  it('TTL mặc định 60s', () => {
    const { cache } = load({})
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
