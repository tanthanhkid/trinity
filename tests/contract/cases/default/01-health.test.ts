import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'

afterAll(closeDb)

describe('health và đăng ký mở', () => {
  it('GET /health, /live, /ready công khai trả 200', async () => {
    for (const p of ['health', 'live', 'ready']) {
      const res = await api.get(`/${p}`, { ip: freshIp() })
      expect(res.status, p).toBe(200)
    }
  })

  it('GET /auth/signup-enabled (hồ sơ nhiều công ty) cho biết đăng ký đang mở', async () => {
    const res = await api.get('/auth/signup-enabled', { ip: freshIp() })
    expect(res.status).toBe(200)
    golden('signup-enabled', 'anon', snap(res))
  })
})
