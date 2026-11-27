import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { a, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)

/** C12b, hồ sơ `integrations-off`: ca "cờ tắt" của `integrations.e2e-spec.ts` (e2e gốc xoá `INTEGRATIONS_*`). Hồ sơ này vẫn có khoá mã hoá và địa chỉ công khai. */
describe('Kết nối & AI khi cờ tắt', () => {
  it('cờ tắt: status 200 báo cả hai cờ false; audit-logs 404 dù đủ quyền', async () => {
    const u = await mk({ 'integrations.ai_admin': true })
    const s = await st(a(u.token).get('/integrations/status'), 200)
    expect(s.body as Body).toMatchObject({ webhooks_enabled: false, mcp_enabled: false })
    golden('integrations-status-off', 'admin', snap(s))
    await st(a(u.token).get('/integrations/audit-logs'), 404)
  })
})
