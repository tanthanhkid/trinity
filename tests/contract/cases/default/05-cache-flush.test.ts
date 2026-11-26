import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, grant, seedUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

describe('sửa quyền trong DB rồi xoá cache bằng API điều khiển', () => {
  it('cấp quyền bằng SQL chỉ có hiệu lực sau khi xoá cache quyền', async () => {
    const u = await seedUser({ label: 'cache', grants: { 'notifications.view': 'own' } })
    const s = await loginSeeded(u)
    const before = await api.get('/contacts?limit=1', { token: s.token, ip: freshIp() })
    expect(before.status).toBe(403)
    await grant(u.id, 'contacts.view', 'own')
    const flush = await control.flushCache()
    expect(flush.status).toBe(200)
    const after = await api.get('/contacts?limit=1', { token: s.token, ip: freshIp() })
    expect(after.status).toBe(200)
  })
})
