import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { B, a, mk, mkEndpoint, resetWebhooks, startReceiver, st, type Body, type Receiver } from '../../lib/webhooks.js'

afterAll(closeDb)

/** C12a, hồ sơ `private-targets` (cho phép đích nội bộ để gửi tới máy nhận cục bộ). CRUD + secret, từ `webhooks-out.e2e-spec.ts`. */
let rx: Receiver
beforeAll(async () => {
  rx = await startReceiver()
})
afterAll(async () => {
  await rx.close()
  await resetWebhooks() // không để lại endpoint/delivery của ca cuối cho file sau
})
beforeEach(async () => {
  rx.seen.length = 0
  rx.status = 200
  await resetWebhooks()
})

describe('CRUD + secret', () => {
  it('secret chỉ trả khi tạo/tạo lại; DB lưu bản mã; list/get/audit KHÔNG lộ secret', async () => {
    const u = await mk({ 'integrations.webhooks': true })
    const ep = await mkEndpoint(u.token, rx.url, { name: 'Zap' })
    expect(ep.secret).toMatch(/^whsec_/)
    const [row] = await q<{ secret_enc: string; created_by: number }>(`SELECT secret_enc, created_by FROM webhook_endpoints WHERE id = $1`, [ep.id])
    expect(row.secret_enc).not.toContain(ep.secret)
    expect(row.created_by).toBe(u.id)

    const list = await st(a(u.token).get(`${B}/endpoints`), 200)
    const get = await st(a(u.token).get(`${B}/endpoints/${ep.id}`), 200)
    for (const body of [list.body, get.body]) {
      const json = JSON.stringify(body)
      expect(json).not.toContain(ep.secret)
      expect(json).not.toContain('secret_enc')
      expect(json).not.toContain(row.secret_enc)
    }
    expect((get.body as Body).secret_set).toBe(true)
    // Cổng của máy nhận đổi mỗi lượt chạy: thay bằng nhãn cố định trước khi ghi golden.
    const fixed = (r: typeof get) => snap({ ...r, body: JSON.parse(JSON.stringify(r.body).split(rx.url).join('http://127.0.0.1:<port>/hook')) })
    golden('webhooks-endpoint-get', 'admin', fixed(get))
    golden('webhooks-endpoint-list', 'admin', fixed(list))

    const rot = await st(a(u.token).post(`${B}/endpoints/${ep.id}/rotate-secret`), 200)
    expect((rot.body as Body).secret).toMatch(/^whsec_/)
    expect((rot.body as Body).secret).not.toBe(ep.secret)
    const audits = JSON.stringify(await q(`SELECT * FROM integration_audit_logs`))
    expect(audits).not.toContain(ep.secret)
    expect(audits).not.toContain((rot.body as Body).secret)
    expect(audits).toContain('endpoint.created')
    expect(audits).toContain('endpoint.secret_rotated')
  })

  it('sửa tên/bật tắt/sự kiện; xoá endpoint kèm lịch sử; tối đa 20 endpoint', async () => {
    const u = await mk({ 'integrations.webhooks': true })
    const ep = await mkEndpoint(u.token, rx.url)
    const up = await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { name: 'Mới', is_active: false, events: ['deal.won', 'contact.created'] }), 200)
    expect(up.body).toMatchObject({ name: 'Mới', is_active: false, events: ['deal.won', 'contact.created'], disabled_reason: 'manual' })
    const on = await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { is_active: true }), 200)
    expect(on.body).toMatchObject({ is_active: true, disabled_reason: null, consecutive_failures: 0 })
    await st(a(u.token).post(`${B}/endpoints/${ep.id}/test`), 200)
    expect((await q(`SELECT 1 FROM webhook_deliveries`)).length).toBe(1)
    await st(a(u.token).del(`${B}/endpoints/${ep.id}`), 200)
    expect((await q(`SELECT 1 FROM webhook_deliveries`)).length).toBe(0)
    await st(a(u.token).get(`${B}/endpoints/${ep.id}`), 404)

    for (let i = 0; i < 20; i++) await mkEndpoint(u.token, rx.url, { name: `E${i}` })
    await st(a(u.token).post(`${B}/endpoints`, { name: 'thừa', url: rx.url, events: ['contact.created'] }), 400)
  })
})
