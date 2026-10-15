import { cronRegistry, runCronTick } from './cron-registry'

describe('cronRegistry + runCronTick', () => {
  beforeEach(() => cronRegistry.clear())

  it('chạy mọi job, trả tóm tắt, lỗi một job không chặn job khác', async () => {
    cronRegistry.register({ name: 'a', budgetMs: 1000, run: async () => ({ n: 2, big: 5n }) })
    cronRegistry.register({ name: 'b', budgetMs: 1000, run: async () => { throw new Error('hỏng') } })
    cronRegistry.register({ name: 'c', budgetMs: 1000, run: async () => undefined })
    const s = await runCronTick()
    const by = Object.fromEntries(s.jobs.map((j) => [j.name, j]))
    expect(by.a).toMatchObject({ status: 'ok', result: { n: 2, big: '5' } })
    expect(by.b).toMatchObject({ status: 'error', error: 'hỏng' })
    expect(by.c.status).toBe('ok')
    expect(() => JSON.stringify(s)).not.toThrow()
  })

  it('job treo bị cắt ở budget riêng và không kéo dài cả lượt', async () => {
    cronRegistry.register({ name: 'slow', budgetMs: 30, run: () => new Promise(() => undefined) })
    cronRegistry.register({ name: 'fast', budgetMs: 1000, run: async () => 1 })
    const t0 = Date.now()
    const s = await runCronTick()
    expect(Date.now() - t0).toBeLessThan(500)
    expect(s.jobs.find((j) => j.name === 'slow')?.status).toBe('timeout')
    expect(s.jobs.find((j) => j.name === 'fast')?.status).toBe('ok')
  })

  it('trần tổng cắt cả job có budget lớn hơn', async () => {
    cronRegistry.register({ name: 'big', budgetMs: 60_000, run: () => new Promise(() => undefined) })
    const s = await runCronTick(40)
    expect(s.jobs[0].status).toBe('timeout')
    expect(s.durationMs).toBeLessThan(500)
  })

  it('đăng ký trùng tên ghi đè, hàm gỡ chỉ gỡ đúng bản của mình', async () => {
    const off1 = cronRegistry.register({ name: 'x', budgetMs: 100, run: async () => 1 })
    cronRegistry.register({ name: 'x', budgetMs: 100, run: async () => 2 })
    off1()
    expect(cronRegistry.list()).toHaveLength(1)
    expect((await runCronTick()).jobs[0].result).toBe(2)
  })

  it('không job nào → lượt rỗng hợp lệ', async () => {
    expect((await runCronTick()).jobs).toEqual([])
  })
})
