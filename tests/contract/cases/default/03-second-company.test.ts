import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { registerCompany } from '../../lib/session.js'

afterAll(closeDb)

describe('công ty thứ hai qua API đăng ký', () => {
  it('đăng ký tạo công ty mới trống; người dùng công ty một không lọt sang', async () => {
    const co = await registerCompany('Công ty hai')
    const list = await api.get('/contacts?limit=5', { token: co.session.token, ip: freshIp() })
    expect(list.status).toBe(200)
    const body = list.body as { data?: unknown[]; items?: unknown[]; total?: number }
    const rows = body.data ?? body.items ?? []
    expect(rows).toHaveLength(0)
  })
})
