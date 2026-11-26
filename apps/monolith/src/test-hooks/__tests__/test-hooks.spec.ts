import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { testHooksEnabled } from '@trinity/rbac-nest'
import { TestHooksController } from '../test-hooks.controller'
import { testHooksImports } from '../test-hooks.module'
import { NotificationsService } from '../../../../../services/notification/src/notifications/notifications.service'
import { ReadCache } from '../../../../../services/crm/src/common/read-cache'

describe('API điều khiển test (C18)', () => {
  it('chỉ bật khi TRINITY_TEST_HOOKS=1 và NODE_ENV != production', () => {
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'test' })).toBe(true)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1' })).toBe(true)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'production' })).toBe(false)
    expect(testHooksEnabled({ NODE_ENV: 'test' })).toBe(false)
    expect(testHooksEnabled({ TRINITY_TEST_HOOKS: 'true' })).toBe(false)
  })

  it('production + cờ bật: không nạp module ⇒ hai đường trả 404', async () => {
    const imports = testHooksImports({ TRINITY_TEST_HOOKS: '1', NODE_ENV: 'production' })
    expect(imports).toEqual([])
    const mod = await Test.createTestingModule({ imports }).compile()
    const app = mod.createNestApplication()
    await app.init()
    await request(app.getHttpServer()).post('/internal/test/jobs/stale-work/run').expect(404)
    await request(app.getHttpServer()).post('/internal/test/cache/flush').expect(404)
    await app.close()
  })

  it('controller từ chối khởi tạo ở production dù ai đó nạp nhầm', async () => {
    const prev = { ...process.env }
    process.env.NODE_ENV = 'production'
    process.env.TRINITY_TEST_HOOKS = '1'
    try {
      await expect(Test.createTestingModule({ controllers: [TestHooksController] }).compile()).rejects.toThrow(/chỉ chạy khi/)
    } finally {
      process.env = prev
    }
  })

  describe('khi bật', () => {
    let app: INestApplication
    const reap = jest.fn().mockResolvedValue({ requeued: 1, failed: 0 })
    const readCache = new ReadCache()
    beforeAll(async () => {
      process.env.TRINITY_TEST_HOOKS = '1'
      const mod = await Test.createTestingModule({
        controllers: [TestHooksController],
        providers: [
          { provide: NotificationsService, useValue: { reapStuckProcessing: reap } },
          { provide: ReadCache, useValue: readCache },
        ],
      }).compile()
      app = mod.createNestApplication()
      await app.init()
    })
    afterAll(async () => {
      delete process.env.TRINITY_TEST_HOOKS
      await app.close()
    })

    it('chạy job theo tên, truyền now cố định cho reap-stuck', async () => {
      const res = await request(app.getHttpServer())
        .post('/internal/test/jobs/notification.reap-stuck/run')
        .send({ now: '2026-01-01T00:00:00Z' })
        .expect(200)
      expect(res.body).toEqual({ job: 'notification.reap-stuck', result: { requeued: 1, failed: 0 } })
      expect(reap).toHaveBeenCalledWith(new Date('2026-01-01T00:00:00Z'))
    })

    it('job không tồn tại và now ở job không cho phép ⇒ 400', async () => {
      await request(app.getHttpServer()).post('/internal/test/jobs/khong-co/run').expect(400)
      await request(app.getHttpServer()).post('/internal/test/jobs/stale-work/run').send({ now: '2026-01-01T00:00:00Z' }).expect(400)
      await request(app.getHttpServer()).post('/internal/test/jobs/notification.reap-stuck/run').send({ now: 'abc' }).expect(400)
    })

    it('briefings.collect cần slot và owner hợp lệ', async () => {
      await request(app.getHttpServer())
        .post('/internal/test/jobs/briefings.collect/run')
        .send({ now: '2026-01-01T00:00:00Z', owner: 'all', slot: 'x' })
        .expect(400)
    })
  })
})
