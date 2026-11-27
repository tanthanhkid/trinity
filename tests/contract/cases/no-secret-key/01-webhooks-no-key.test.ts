import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { B, a, mk, resetWebhooks, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
beforeEach(resetWebhooks)

/** C12a, hồ sơ `no-secret-key` (`INTEGRATIONS_SECRET_KEY` trống), nửa đầu của ca "THIẾU/SAI khoá" ở e2e gốc. */
describe('thiếu khoá', () => {
  it('cờ bật nhưng THIẾU INTEGRATIONS_SECRET_KEY → 503 rõ ràng khi tạo; xem danh sách vẫn được; status báo thiếu khoá', async () => {
    const u = await mk({ 'integrations.webhooks': true })
    const url = 'https://hooks.example.test/h'
    const r = await st(a(u.token).post(`${B}/endpoints`, { name: 'x', url, events: ['contact.created'] }), 503)
    expect((r.body as Body).message).toMatch(/INTEGRATIONS_SECRET_KEY/)
    golden('webhooks-no-key-create', 'admin', snap(r))
    await st(a(u.token).get(`${B}/endpoints`), 200)
    expect(((await st(a(u.token).get('/integrations/status'), 200)).body as Body).secret_key_configured).toBe(false)
    // Tạo lại secret và gửi thử cũng cần khoá: endpoint không tồn tại nên trả 503 trước 404 (khoá được kiểm đầu tiên).
    await st(a(u.token).post(`${B}/endpoints/1/rotate-secret`), 503)
    await st(a(u.token).post(`${B}/endpoints/1/test`), 503)
  })
})
