import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { PHONES, hook, lead, resetInbound, seedInboundFixtures, seedSourceSql, S, type InboundFixtures } from '../../lib/inbound.js'
import { api, freshIp } from '../../lib/http.js'
import { a, mk, st } from '../../lib/webhooks.js'

afterAll(closeDb)
let fx: InboundFixtures
beforeAll(async () => {
  fx = await seedInboundFixtures()
})
beforeEach(resetInbound)

/** C12b, hồ sơ `integrations-off` (cờ webhook + MCP tắt): nửa "cờ tắt → 404" của ca quản trị nguồn và của ca nhận khách (e2e gốc xoá `INTEGRATIONS_WEBHOOKS_ENABLED` giữa ca). */
describe('webhook vào khi cờ tắt', () => {
  it('quản trị nguồn: dù đủ quyền, mọi route → 404', async () => {
    const u = await mk({ 'integrations.webhooks': true, 'contacts.create': true })
    await st(a(u.token).get(S), 404)
    await st(a(u.token).post(S, { name: 'x', default_assignee_id: u.id, contact_source_id: fx.srcOpt }), 404)
    await st(a(u.token).get(`${S}/1`), 404)
  })

  it('nhận khách: token hợp lệ (seed bằng SQL) vẫn → 404 và KHÔNG tạo khách', async () => {
    const u = await mk({ 'integrations.webhooks': true, 'contacts.create': true })
    const src = await seedSourceSql({ assigneeId: u.id, contactSourceId: fx.srcOpt, createdBy: u.id })
    expect((await hook(src.token, lead(PHONES[2]))).status).toBe(404)
    const rows = await q(`SELECT 1 FROM contacts WHERE phone = $1`, [PHONES[2]])
    expect(rows).toHaveLength(0)
    void api
    void freshIp
  })
})
