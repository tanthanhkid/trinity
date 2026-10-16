import { configureHashSecret, hashingEnabled, configureProductEvents, hashUserId, sanitizeProps, trackProductEvent } from './product-events'

const cfg = { key: 'phc_x', host: 'https://ph.example.com/', environment: 'test-env', release: 'abc1234', hashSecret: 's3cret' }
const env = process.env as Record<string, string | undefined>
const origEnv = env.NODE_ENV

afterEach(() => {
  configureProductEvents(null)
  configureHashSecret('')
  env.NODE_ENV = origEnv
  jest.restoreAllMocks()
})

describe('hashUserId', () => {
  it('HMAC hex 24 ký tự, ổn định, phụ thuộc secret', () => {
    configureProductEvents(cfg)
    const a = hashUserId(1)
    expect(a).toMatch(/^[0-9a-f]{24}$/)
    expect(hashUserId('1')).toBe(a)
    expect(hashUserId(2)).not.toBe(a)
    configureProductEvents({ ...cfg, hashSecret: 'other' })
    expect(hashUserId(1)).not.toBe(a)
  })
})

describe('configureHashSecret', () => {
  it('bật băm mà không cần PostHog', () => {
    expect(hashingEnabled()).toBe(false)
    configureHashSecret('k')
    expect(hashingEnabled()).toBe(true)
    expect(hashUserId(5)).toMatch(/^[0-9a-f]{24}$/)
  })
})

describe('sanitizeProps', () => {
  it('giữ boolean/number, cắt string dài, bỏ email và dãy ≥8 số, bỏ kiểu khác', () => {
    const out = sanitizeProps({
      ok: 'step1',
      n: 3,
      b: false,
      long: 'x'.repeat(100),
      mail: 'a@b.com',
      phone: 'call 0901234567',
      short: 'id 1234567',
      nul: null,
      obj: {} as never,
    })
    expect(out).toEqual({ ok: 'step1', n: 3, b: false, long: 'x'.repeat(60), short: 'id 1234567' })
  })
})

describe('trackProductEvent', () => {
  it('no-op khi chưa cấu hình', () => {
    env.NODE_ENV = 'production'
    const f = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    trackProductEvent('e', 1, {})
    expect(f).not.toHaveBeenCalled()
  })
  it('no-op khi NODE_ENV=test', () => {
    configureProductEvents(cfg)
    env.NODE_ENV = 'test'
    const f = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    trackProductEvent('e', 1, {})
    expect(f).not.toHaveBeenCalled()
  })
  it('POST đúng URL/body, distinct_id đã băm', () => {
    configureProductEvents(cfg)
    env.NODE_ENV = 'production'
    const f = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    trackProductEvent('feature_toggled', 7, { feature: 'social', enabled: true, email: 'a@b.c' })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://ph.example.com/i/v0/e/')
    const body = JSON.parse(String(init.body))
    expect(body.api_key).toBe('phc_x')
    expect(body.event).toBe('feature_toggled')
    expect(body.distinct_id).toBe(hashUserId(7))
    expect(body.properties).toMatchObject({ feature: 'social', enabled: true, environment: 'test-env', release: 'abc1234', $lib: 'trinity-server' })
    expect(body.properties.email).toBeUndefined()
  })
  it('không throw khi fetch lỗi (đồng bộ hoặc bất đồng bộ)', async () => {
    configureProductEvents(cfg)
    env.NODE_ENV = 'production'
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('net'))
    expect(() => trackProductEvent('e', null, {})).not.toThrow()
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('sync')
    })
    expect(() => trackProductEvent('e', 1, {})).not.toThrow()
    await Promise.resolve()
  })
})
