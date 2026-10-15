import { BACKGROUND_TASKS_KEY, drainBackgroundTasks, isServerless, runInBackground } from './runtime'

const KEY = Symbol.for('@vercel/request-context')
const g = globalThis as Record<symbol, unknown>

describe('isServerless', () => {
  const old = process.env.TRINITY_RUNTIME
  afterEach(() => {
    if (old === undefined) delete process.env.TRINITY_RUNTIME
    else process.env.TRINITY_RUNTIME = old
  })
  it('chỉ bật khi đúng "serverless"', () => {
    delete process.env.TRINITY_RUNTIME
    expect(isServerless()).toBe(false)
    process.env.TRINITY_RUNTIME = 'vps'
    expect(isServerless()).toBe(false)
    process.env.TRINITY_RUNTIME = 'serverless'
    expect(isServerless()).toBe(true)
  })
  it('chuẩn hoá giống web/monolith (khoảng trắng, xuống dòng, hoa/thường) — không chia rẽ chế độ giữa các tầng', () => {
    process.env.TRINITY_RUNTIME = ' Serverless\n'
    expect(isServerless()).toBe(true)
  })
})

describe('runInBackground', () => {
  afterEach(() => {
    delete g[KEY]
  })

  it('có context Vercel → gọi waitUntil với promise của task', async () => {
    const waitUntil = jest.fn()
    g[KEY] = { get: () => ({ waitUntil }) }
    const task = jest.fn().mockResolvedValue(1)
    expect(runInBackground(task)).toBe('waitUntil')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0][0]
    expect(task).toHaveBeenCalled()
  })

  it('không context → detached, task vẫn chạy', async () => {
    const task = jest.fn().mockResolvedValue(1)
    expect(runInBackground(task)).toBe('detached')
    await new Promise((r) => setImmediate(r))
    expect(task).toHaveBeenCalled()
  })

  it('context hỏng (get ném lỗi) → rơi về detached, không ném', () => {
    g[KEY] = { get: () => { throw new Error('boom') } }
    expect(runInBackground(async () => undefined)).toBe('detached')
  })

  it('task ném lỗi → chuyển cho onError, không unhandled rejection', async () => {
    const onError = jest.fn()
    runInBackground(async () => { throw new Error('x') }, onError)
    await new Promise((r) => setImmediate(r))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'x' }))
  })

  it('task đồng bộ ném lỗi cũng được bắt', async () => {
    const onError = jest.fn()
    runInBackground(() => { throw new Error('sync') }, onError)
    await new Promise((r) => setImmediate(r))
    expect(onError).toHaveBeenCalled()
  })
})

describe('sổ việc nền + drainBackgroundTasks (serverless)', () => {
  const old = process.env.TRINITY_RUNTIME
  afterEach(() => {
    if (old === undefined) delete process.env.TRINITY_RUNTIME
    else process.env.TRINITY_RUNTIME = old
    delete g[KEY]
  })

  it('serverless: việc nền vào sổ tới khi xong; drain chờ cạn kể cả việc đẻ thêm', async () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    const order: string[] = []
    runInBackground(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('a')
      runInBackground(async () => {
        await new Promise((r) => setTimeout(r, 20))
        order.push('b')
      })
    })
    const set = (g[BACKGROUND_TASKS_KEY] as Set<Promise<unknown>>)
    expect(set.size).toBe(1)
    await drainBackgroundTasks(2000)
    expect(order).toEqual(['a', 'b'])
    expect(set.size).toBe(0)
  })

  it('drain tôn trọng trần thời gian (việc treo không chặn mãi)', async () => {
    process.env.TRINITY_RUNTIME = 'serverless'
    runInBackground(() => new Promise(() => undefined))
    const t0 = Date.now()
    await drainBackgroundTasks(80)
    expect(Date.now() - t0).toBeLessThan(1000)
    ;(g[BACKGROUND_TASKS_KEY] as Set<Promise<unknown>>).clear()
  })

  it('không cờ: KHÔNG ghi sổ (VPS giữ nguyên hành vi)', () => {
    delete process.env.TRINITY_RUNTIME
    const before = (g[BACKGROUND_TASKS_KEY] as Set<unknown> | undefined)?.size ?? 0
    runInBackground(async () => undefined)
    expect(((g[BACKGROUND_TASKS_KEY] as Set<unknown> | undefined)?.size ?? 0)).toBe(before)
  })
})
