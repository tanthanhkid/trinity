import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { resetInbound, seedInboundFixtures, S, type InboundFixtures } from '../../lib/inbound.js'
import { a, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
let fx: InboundFixtures
beforeAll(async () => {
  fx = await seedInboundFixtures()
})
beforeEach(resetInbound)

/** C12b, hồ sơ `bad-secret-key` (khoá không đủ 32 byte): nửa "sai khoá" của ca "thiếu/sai INTEGRATIONS_SECRET_KEY → 503 khi tạo". */
describe('webhook vào khi khoá mã hoá sai độ dài', () => {
  it('tạo nguồn → 503 nêu INTEGRATIONS_SECRET_KEY', async () => {
    const u = await mk({ 'integrations.webhooks': true, 'contacts.create': true })
    const r = await st(a(u.token).post(S, { name: 'x', default_assignee_id: u.id, contact_source_id: fx.srcOpt }), 503)
    expect((r.body as Body).message).toMatch(/INTEGRATIONS_SECRET_KEY/)
  })
})
