import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tenantTimerTick } from './tenant-timer'

describe('tenantTimerTick theo tệp sở hữu (T01)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-crm-'))
  const file = join(dir, 'o.json')
  const prev = process.env.TRINITY_OWNERSHIP_FILE
  const put = (text: string) => {
    const tmp = join(dir, `t${Math.random()}`)
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  }
  beforeAll(() => {
    process.env.TRINITY_OWNERSHIP_FILE = file
    delete process.env.MULTI_TENANT
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.TRINITY_OWNERSHIP_FILE
    else process.env.TRINITY_OWNERSHIP_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  })

  it('job giao cho Rust thì lượt kế bỏ qua, trả về Node thì chạy lại; job khác không bị ảnh hưởng', async () => {
    const logger = { error: jest.fn() }
    const a = jest.fn().mockResolvedValue(undefined)
    const b = jest.fn().mockResolvedValue(undefined)
    const tickA = tenantTimerTick(logger, 'A', a, undefined, 'lead-scoring.run')
    const tickB = tenantTimerTick(logger, 'B', b, undefined, 'stale-work.digest')
    const noName = jest.fn().mockResolvedValue(undefined)
    const tickC = tenantTimerTick(logger, 'C', noName)

    put('{"jobs":{}}')
    await Promise.all([tickA(), tickB(), tickC()])
    expect([a.mock.calls.length, b.mock.calls.length, noName.mock.calls.length]).toEqual([1, 1, 1])

    put('{"jobs":{"lead-scoring.run":"rust"}}')
    await Promise.all([tickA(), tickB(), tickC()])
    expect([a.mock.calls.length, b.mock.calls.length, noName.mock.calls.length]).toEqual([1, 2, 2])

    put('{"jobs":{"lead-scoring.run":"node"}}')
    await tickA()
    expect(a).toHaveBeenCalledTimes(2)
  })
})
