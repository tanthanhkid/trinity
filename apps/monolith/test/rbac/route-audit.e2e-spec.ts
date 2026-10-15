import type { INestApplication } from '@nestjs/common'
import { auditRoutes } from '@trinity/rbac-nest'
import { bootApp, api } from './harness'

/**
 * Guard LUÔN strict + boot-check LUÔN chạy. Monolith thật (đủ các module)
 * không được còn route nào thiếu `@Can/@AuthOnly/@Public/@Internal`, và route
 * "xuất file" phải gắn quyền `*.export` (hoặc public/internal).
 */
describe('RBAC route audit (monolith thật)', () => {
  let app: INestApplication
  let close: () => Promise<void>

  beforeAll(async () => {
    ;({ app, close } = await bootApp())
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  it('không route nào thiếu metadata quyền / route xuất file thiếu *.export', () => {
    const { missing, exportWithoutPerm } = auditRoutes(app)
    expect({ missing, exportWithoutPerm }).toEqual({ missing: [], exportWithoutPerm: [] })
  })

  it('/health /ready /live của crm là @Public (không cần token)', async () => {
    for (const p of ['health', 'ready', 'live']) {
      await api(app).get(`/api/v1/${p}`).expect(200)
    }
  })
})
