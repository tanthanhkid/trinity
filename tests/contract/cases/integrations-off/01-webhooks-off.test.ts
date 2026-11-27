import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { control } from '../../lib/http.js'
import { B, a, contactEvent, encryptWithForeignKey, mk, resetWebhooks, st } from '../../lib/webhooks.js'

afterAll(closeDb)
beforeEach(resetWebhooks)

/** C12a, hồ sơ `integrations-off` (MCP và webhook tắt, thay cho việc xoá `INTEGRATIONS_*` ở e2e gốc). */
describe('cờ tắt', () => {
  it('cờ tắt → 404 mọi route dù đủ quyền', async () => {
    const u = await mk({ 'integrations.webhooks': true })
    const url = 'https://hooks.example.test/h'
    const res = await st(a(u.token).get(`${B}/events`), 404)
    golden('webhooks-off-events', 'admin', snap(res))
    await st(a(u.token).get(`${B}/endpoints`), 404)
    await st(a(u.token).post(`${B}/endpoints`, { name: 'x', url, events: ['contact.created'] }), 404)
    await st(a(u.token).get(`${B}/deliveries`), 404)
  })

  it('cờ TẮT: tick không làm gì (INERT): sự kiện nằm nguyên trong outbox', async () => {
    const u = await mk({ 'integrations.webhooks': true, 'contacts.view': 'all' })
    // Không tạo được endpoint qua API khi cờ tắt: seed bằng SQL (secret_enc của khoá khác, không bao giờ được dùng tới).
    await q(`INSERT INTO webhook_endpoints (name, url, secret_enc, events, created_by, updated_at) VALUES ('t', 'http://127.0.0.1:9/hook', $1, ARRAY['contact.created'], $2, now())`, [encryptWithForeignKey('whsec_x'), u.id])
    await new Promise((r) => setTimeout(r, 15))
    await contactEvent(u.id)
    const res = await control.runJob('webhook-dispatch')
    expect(res.status).toBe(200)
    expect((res.body as { result: { skipped: string | null } }).result.skipped).toMatch(/INTEGRATIONS_WEBHOOKS_ENABLED/)
    expect((await q(`SELECT 1 FROM integration_events WHERE dispatched_at IS NULL`)).length).toBe(1)
    expect((await q(`SELECT 1 FROM webhook_deliveries`)).length).toBe(0)
  })
})
