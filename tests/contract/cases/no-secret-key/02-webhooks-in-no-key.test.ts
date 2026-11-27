import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { PHONES, hook, lead, resetInbound, seedInboundFixtures, seedSourceSql, S, type InboundFixtures } from '../../lib/inbound.js'
import { a, encryptWithForeignKey, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
let fx: InboundFixtures
beforeAll(async () => {
  fx = await seedInboundFixtures()
})
beforeEach(resetInbound)

/** C12b, hồ sơ `no-secret-key` (`INTEGRATIONS_SECRET_KEY` trống): hai ca e2e gốc xoá khoá giữa ca. */
describe('webhook vào khi thiếu khoá mã hoá', () => {
  it('tạo nguồn → 503 nêu INTEGRATIONS_SECRET_KEY', async () => {
    const u = await mk({ 'integrations.webhooks': true, 'contacts.create': true })
    const r = await st(a(u.token).post(S, { name: 'x', default_assignee_id: u.id, contact_source_id: fx.srcOpt }), 503)
    expect((r.body as Body).message).toMatch(/INTEGRATIONS_SECRET_KEY/)
  })

  it('nguồn có chữ ký nhưng máy chủ mất khoá mã hoá → 503 (KHÔNG bỏ qua kiểm chữ ký), không tạo khách', async () => {
    const u = await mk({ 'integrations.webhooks': true, 'contacts.create': true })
    // Nguồn có chữ ký seed bằng SQL với bản mã của khoá khác (hồ sơ này không có khoá để mã hoá).
    const src = await seedSourceSql({ assigneeId: u.id, contactSourceId: fx.srcOpt, createdBy: u.id, signingSecretEnc: encryptWithForeignKey('whsec_x') })
    expect((await hook(src.token, lead())).status).toBe(503)
    expect(await q(`SELECT 1 FROM contacts WHERE phone = $1`, [PHONES[0]])).toHaveLength(0)
  })
})
