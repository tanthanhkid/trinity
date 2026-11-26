import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, seedContact, seedUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginAdmin, registerCompany } from '../../lib/session.js'

afterAll(closeDb)

const rowsOf = (body: unknown): { phone?: string }[] => {
  const b = body as { data?: { phone?: string }[]; items?: { phone?: string }[] }
  return b.data ?? b.items ?? []
}

describe('công ty thứ hai qua API đăng ký', () => {
  it('khách của công ty một không lộ sang công ty hai; công ty hai bắt đầu trống', async () => {
    const owner = await seedUser({ label: 'iso', grants: {} })
    await seedContact({ phone: '0933000777', name: 'Khách riêng công ty một', ownerId: owner.id, daysAgo: 1 })
    await control.flushCache()

    const one = await api.get('/contacts?search=0933000777&limit=5', { token: (await loginAdmin()).token, ip: freshIp() })
    expect(one.status).toBe(200)
    expect(rowsOf(one.body).map((r) => r.phone)).toContain('0933000777')

    const co = await registerCompany('Công ty hai')
    const list = await api.get('/contacts?limit=50', { token: co.session.token, ip: freshIp() })
    expect(list.status).toBe(200)
    expect(rowsOf(list.body)).toHaveLength(0)
    const byPhone = await api.get('/contacts?search=0933000777&limit=5', { token: co.session.token, ip: freshIp() })
    expect(rowsOf(byPhone.body)).toHaveLength(0)
  })
})
