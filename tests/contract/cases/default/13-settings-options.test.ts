import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/** C08, từ `settings-options.e2e-spec.ts` (3 ca). Danh mục động: đọc `@AuthOnly()` (mọi người đã đăng nhập), ghi cần `contacts.catalog`. */
const body = { group_key: 'e2e_test_group', value: 'e2e_val', label: 'Nhãn E2E' }

describe('Settings Options', () => {
  it('GET /settings/options: mọi user đã đăng nhập đọc được (AuthOnly)', async () => {
    const u = await seedUser({ label: 'reader', grants: {} })
    const res = await api.get('/settings/options', { token: (await loginSeeded(u)).token, ip: freshIp() })
    expect(res.status).toBe(200)
  })

  it('POST /settings/options không có quyền contacts.catalog → 403', async () => {
    const u = await seedUser({ label: 'no-catalog', grants: {} })
    const res = await api.post('/settings/options', { token: (await loginSeeded(u)).token, body, ip: freshIp() })
    expect(res.status).toBe(403)
    expect((await q(`SELECT 1 FROM setting_options WHERE group_key = 'e2e_test_group'`)).length).toBe(0)
  })

  it('POST /settings/options có quyền contacts.catalog → 201', async () => {
    const u = await seedUser({ label: 'catalog', grants: { 'contacts.catalog': null } })
    const res = await api.post('/settings/options', { token: (await loginSeeded(u)).token, body, ip: freshIp() })
    expect(res.status).toBe(201)
    golden('settings-options-create', 'admin', snap(res))
    const rows = await q<{ value: string; label: string }>(`SELECT value, label FROM setting_options WHERE group_key = 'e2e_test_group'`)
    expect(rows).toEqual([{ value: 'e2e_val', label: 'Nhãn E2E' }])
  })
})
