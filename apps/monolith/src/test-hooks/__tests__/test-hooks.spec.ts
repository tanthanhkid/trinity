import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { RbacCache, TokenBlacklistService, testHooksEnabled } from '@trinity/rbac-nest'
import { RateLimiterService } from '../../../../../services/auth/src/auth/services/rate-limiter.service'
import { TestHooksController } from '../test-hooks.controller'
import { NotificationsService } from '../../../../../services/notification/src/notifications/notifications.service'
import { StaleWorkService } from '../../../../../services/crm/src/stale-work/stale-work.service'
import { FixedWindowLimiter } from '../../../../../services/crm/src/common/helpers/fixed-window-limiter'
import { ReadCache } from '../../../../../services/crm/src/common/read-cache'

const ENV_KEYS = ['NODE_ENV', 'TRINITY_TEST_HOOKS', 'JWT_SECRET', 'MULTI_TENANT'] as const

describe('API điều khiển test (C18)', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('chỉ bật khi TRINITY_TEST_HOOKS=1 và NODE_ENV là test/development', () => {
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'test' })).toBe(true)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'development' })).toBe(true)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1' })).toBe(false)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'production' })).toBe(false)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'staging' })).toBe(false)
    expect(testHooksEnabled({ NODE_ENV: 'test' })).toBe(false)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: 'true', NODE_ENV: 'test' })).toBe(false)
  })

  it('MonolithModule thật ở production có cờ bật: không có controller, không có đường nào', async () => {
    process.env.NODE_ENV = 'production'
    process.env.TRINITY_TEST_HOOKS = '1'
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(64)
    let metadata: unknown[] = []
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MonolithModule } = require('../../app.module') as typeof import('../../app.module')
      const imports = (Reflect.getMetadata('imports', MonolithModule) ?? []) as unknown[]
      metadata = imports.filter((m) => (m as { name?: string }).name === 'TestHooksModule')
    })
    expect(metadata).toEqual([])
  })

  it('MonolithModule thật khi bật (test + cờ): có TestHooksModule', () => {
    process.env.NODE_ENV = 'test'
    process.env.TRINITY_TEST_HOOKS = '1'
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(64)
    let names: string[] = []
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MonolithModule } = require('../../app.module') as typeof import('../../app.module')
      names = ((Reflect.getMetadata('imports', MonolithModule) ?? []) as { name?: string }[]).map((m) => m.name ?? '')
    })
    expect(names).toContain('TestHooksModule')
  })

  it('controller từ chối khởi tạo ở production dù ai đó nạp nhầm', async () => {
    process.env.NODE_ENV = 'production'
    process.env.TRINITY_TEST_HOOKS = '1'
    await expect(Test.createTestingModule({ controllers: [TestHooksController] }).compile()).rejects.toThrow(/chỉ chạy khi/)
  })

  describe('khi bật', () => {
    let app: INestApplication
    const reap = jest.fn().mockResolvedValue({ requeued: 1, failed: 0 })
    const stale = jest.fn().mockResolvedValue({ sent: true })
    const readCache = new ReadCache()
    beforeAll(async () => {
      process.env.NODE_ENV = 'test'
      process.env.TRINITY_TEST_HOOKS = '1'
      delete process.env.MULTI_TENANT
      const mod = await Test.createTestingModule({
        controllers: [TestHooksController],
        providers: [
          { provide: NotificationsService, useValue: { reapStuckProcessing: reap } },
          { provide: StaleWorkService, useValue: { runOnce: stale } },
          { provide: ReadCache, useValue: readCache },
          { provide: RbacCache, useValue: { clear: jest.fn() } },
          { provide: TokenBlacklistService, useValue: { clear: jest.fn() } },
          { provide: RateLimiterService, useValue: { clear: jest.fn() } },
        ],
      }).compile()
      app = mod.createNestApplication()
      await app.init()
    })
    afterAll(async () => {
      await app.close()
    })
    const post = (p: string) => request(app.getHttpServer()).post(p)

    it('chạy job theo tên, truyền now cố định cho reap-stuck', async () => {
      const res = await post('/internal/test/jobs/notification.reap-stuck/run').send({ now: '2026-01-01T00:00:00Z' }).expect(200)
      expect(res.body).toEqual({ job: 'notification.reap-stuck', result: { requeued: 1, failed: 0 } })
      expect(reap).toHaveBeenCalledWith(new Date('2026-01-01T00:00:00Z'))
    })

    it('stale-work nhận now + force', async () => {
      await post('/internal/test/jobs/stale-work/run').send({ now: '2026-01-01T09:00:00+07:00', force: true }).expect(200)
      expect(stale).toHaveBeenCalledWith(new Date('2026-01-01T02:00:00Z'), true)
    })

    it('now thiếu múi giờ / sai chỗ, job lạ ⇒ 400', async () => {
      await post('/internal/test/jobs/khong-co/run').expect(400)
      await post('/internal/test/jobs/lead-scoring/run').send({ now: '2026-01-01T00:00:00Z' }).expect(400)
      await post('/internal/test/jobs/notification.reap-stuck/run').send({ now: '2026-01-01T00:00:00' }).expect(400)
      await post('/internal/test/jobs/notification.reap-stuck/run').send({ now: 'abc' }).expect(400)
    })

    it('briefings.collect cần slot và owner hợp lệ', async () => {
      await post('/internal/test/jobs/briefings.collect/run').send({ now: '2026-01-01T00:00:00Z', owner: 'all', slot: 'x' }).expect(400)
    })

    it('cache/flush xoá mọi FixedWindowLimiter', async () => {
      const l = new FixedWindowLimiter(1, 60_000)
      l.hit('a')
      expect(l.hit('a').allowed).toBe(false)
      await post('/internal/test/cache/flush').expect(200)
      expect(l.hit('a').allowed).toBe(true)
    })
  })
})
