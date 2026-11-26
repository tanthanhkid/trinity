import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, seedContact, seedUser } from '../../lib/db.js'
import { api, control, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

describe('response theo ngày: xu hướng dashboard 14 ngày', () => {
  let token = ''
  beforeAll(async () => {
    const u = await seedUser({ label: 'trend', grants: { 'reports.overview': 'own', 'contacts.view': 'own' } })
    // Khách tạo cách đây 0, 1, 1, 3 và 20 ngày (tương đối): kết quả chuẩn hoá không đổi theo ngày chạy.
    let i = 0
    for (const d of [0, 1, 1, 3, 20]) {
      await seedContact({ phone: `0911${String(100000 + i++)}`, name: `Trend ${d}-${i}`, ownerId: u.id, daysAgo: d })
    }
    token = (await loginSeeded(u)).token
  })

  it('14 điểm, ngày cũ → mới, điểm cuối là hôm nay; nhãn ngày tương đối giống hệt giữa các lần chạy', async () => {
    await control.flushCache()
    const res = await api.get('/reports/dashboard-trend-14d', { token, ip: freshIp() })
    expect(res.status).toBe(200)
    const body = res.body as { days: string[] }
    expect(body.days).toHaveLength(14)
    golden('dashboard-trend', 'sale', snap(res))
  })
})
