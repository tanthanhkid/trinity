import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FacebookBroadcastsService } from '../../facebook/facebook-broadcasts.service'
import { FacebookFlowsService } from '../../facebook/facebook-flows.service'
import { SocialPostsService } from '../../social/social-posts.service'

/** Node thật sự nhả job (T01): mọi đường vào — timer `runDue`, `kick`, `kickIfDue` (controller tick) — dừng trước khi chạm DB. */
describe('dịch vụ nền nhả job khi tệp sở hữu giao cho Rust', () => {
  const dir = mkdtempSync(join(tmpdir(), 'own-svc-'))
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

  // Prisma giả: mọi truy cập đều đếm; khi Rust giữ job thì đếm phải là 0.
  const touched = jest.fn()
  const prisma = new Proxy({}, { get: () => new Proxy({}, { get: () => (...a: unknown[]) => { touched(...a); return Promise.resolve(null) } }) })
  const none = {} as never
  const posts = new SocialPostsService(prisma as never, none, none, none)
  const flows = new FacebookFlowsService(prisma as never, none, none)
  const broadcasts = new FacebookBroadcastsService(prisma as never, none, none)

  beforeEach(() => touched.mockClear())

  it('social.publish', async () => {
    put('{"jobs":{"social.publish":"rust"}}')
    expect(await posts.kickIfDue(1e12)).toEqual({ due: false })
    posts.kick()
    expect(await posts.runDue(1000)).toEqual({ published: 0, failed: 0, retry: 0, stale: 0 })
    await new Promise((r) => setImmediate(r))
    expect(touched).not.toHaveBeenCalled()
    put('{"jobs":{"social.publish":"node"}}')
    await posts.kickIfDue(2e12)
    expect(touched).toHaveBeenCalled()
  })

  it('facebook.flows', async () => {
    put('{"jobs":{"facebook.flows":"rust"}}')
    expect(await flows.kickIfDue(1e12)).toEqual({ due: false })
    expect(await flows.runDue(1000)).toEqual({ processed: 0 })
    expect(touched).not.toHaveBeenCalled()
    put('{"jobs":{"facebook.flows":"node"}}')
    await flows.kickIfDue(2e12)
    expect(touched).toHaveBeenCalled()
  })

  it('facebook.broadcasts', async () => {
    put('{"jobs":{"facebook.broadcasts":"rust"}}')
    expect(await broadcasts.kickIfDue(1e12)).toEqual({ due: false })
    broadcasts.kick()
    expect(await broadcasts.runDue(1000)).toEqual({ started: 0, sent: 0, failed: 0, skipped: 0 })
    await new Promise((r) => setImmediate(r))
    expect(touched).not.toHaveBeenCalled()
    put('{"jobs":{"facebook.broadcasts":"node"}}')
    await broadcasts.kickIfDue(2e12)
    expect(touched).toHaveBeenCalled()
  })
})
