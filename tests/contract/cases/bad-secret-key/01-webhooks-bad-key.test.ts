import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { B, a, mk, resetWebhooks, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
beforeEach(resetWebhooks)

/** C12a, hồ sơ `bad-secret-key` (khoá không đủ 32 byte), nửa sau của ca "THIẾU/SAI khoá" ở e2e gốc. */
describe('khoá sai độ dài', () => {
  it('cờ bật nhưng khoá SAI độ dài → 503 khi tạo; status báo chưa cấu hình khoá', async () => {
    const u = await mk({ 'integrations.webhooks': true })
    const r = await st(a(u.token).post(`${B}/endpoints`, { name: 'x', url: 'https://hooks.example.test/h', events: ['contact.created'] }), 503)
    expect((r.body as Body).message).toMatch(/INTEGRATIONS_SECRET_KEY/)
    expect(((await st(a(u.token).get('/integrations/status'), 200)).body as Body).secret_key_configured).toBe(false)
  })
})
