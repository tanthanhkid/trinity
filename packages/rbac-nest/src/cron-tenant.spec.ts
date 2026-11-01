import { currentCompanyId } from '@trinity/prisma'
import { runForEachCompany } from './cron-registry'

jest.mock('@trinity/prisma', () => ({
  ...jest.requireActual('@trinity/prisma'),
  listActiveCompanies: jest.fn(async () => [1, 2, 3, 4].map((id) => ({ id, schema: id === 1 ? 'public' : `c_${id}` }))),
}))

describe('runForEachCompany (multi-tenant)', () => {
  const prev = process.env.MULTI_TENANT
  beforeAll(() => {
    process.env.MULTI_TENANT = 'true'
  })
  afterAll(() => {
    process.env.MULTI_TENANT = prev
  })

  it('runs once per company, each in its own context', async () => {
    const seen: Array<number | null> = []
    const out = await runForEachCompany(async () => {
      seen.push(currentCompanyId())
      return 'ok'
    }, { key: 'all' })
    expect(seen).toEqual([1, 2, 3, 4])
    expect(out).toEqual({ 1: 'ok', 2: 'ok', 3: 'ok', 4: 'ok' })
  })

  it('stops at the budget and resumes from the next company on the following run', async () => {
    const seen: Array<number | null> = []
    const slow = async () => {
      seen.push(currentCompanyId())
      await new Promise((r) => setTimeout(r, 30))
    }
    await runForEachCompany(slow, { key: 'slow', budgetMs: 40 })
    const first = [...seen]
    expect(first.length).toBeGreaterThanOrEqual(1)
    expect(first.length).toBeLessThan(4)
    seen.length = 0
    await runForEachCompany(slow, { key: 'slow', budgetMs: 10_000 })
    // Second run starts where the first stopped, so later companies are not starved.
    expect(seen[0]).toBe(first.length + 1)
    expect(new Set(seen).size).toBe(4)
  })

  it('keeps going after a company fails, then rejects with the failures', async () => {
    const seen: Array<number | null> = []
    await expect(
      runForEachCompany(async () => {
        const id = currentCompanyId()
        seen.push(id)
        if (id === 2) throw new Error('boom')
      }, { key: 'fail' }),
    ).rejects.toThrow(/company 2: boom/)
    expect(seen).toEqual([1, 2, 3, 4])
  })
})
