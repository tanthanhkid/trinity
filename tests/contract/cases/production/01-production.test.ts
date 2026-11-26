import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { loginAdmin } from '../../lib/session.js'

afterAll(closeDb)

describe('hồ sơ production: không có API điều khiển, chỉ seed bằng SQL', () => {
  it('API điều khiển test trả 404 dù có đúng x-service-secret', async () => {
    const flush = await control.flushCache()
    expect(flush.status).toBe(404)
    const job = await control.runJob('lead-scoring')
    expect(job.status).toBe(404)
    golden('hooks-absent', 'anon', snap(flush))
  })

  it('production từ chối webhook tới địa chỉ nội bộ dù INTEGRATIONS_ALLOW_PRIVATE_TARGETS=true', async () => {
    const { token } = await loginAdmin()
    const res = await api.post('/integrations/webhooks/endpoints', {
      token,
      body: { name: 'Nội bộ', url: 'http://127.0.0.1:9/hook', events: ['contact.created'] },
      ip: freshIp(),
    })
    expect(res.status).toBe(400)
    const rows = await q(`SELECT 1 FROM webhook_endpoints WHERE url LIKE 'http://127.0.0.1:9%'`)
    expect(rows).toHaveLength(0)
    golden('private-target-rejected', 'admin', snap(res))
  })
})
