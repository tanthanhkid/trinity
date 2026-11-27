import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { B, a, contactEvent, forceDue, mk, mkEndpoint, n, resetWebhooks, startReceiver, st, tick, type Body, type Receiver } from '../../lib/webhooks.js'

afterAll(closeDb)

/** C12a, hồ sơ `private-targets`: thử lại, chết, tự tắt, gửi lại, lịch sử. */
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
const W = { 'integrations.webhooks': true, 'contacts.view': 'all' } as const

/** Endpoint của `token` kèm một sự kiện khách của chính người đó. */
async function only(u: { id: number; token: string }) {
  const ep = await mkEndpoint(u.token, rx.url)
  await contactEvent(u.id)
  return ep
}

describe('thử lại + chết + tắt tự động + gửi lại', () => {
  it('lỗi 500: failed + next_attempt theo lịch 1m/5m/30m/2h/6h/12h, lần thứ 7 → dead; không gửi trước hạn', async () => {
    rx.status = 500
    const u = await mk(W)
    const ep = await only(u)
    const delays = [60, 300, 1800, 7200, 21600, 43200]
    await tick()
    for (let i = 0; i < 6; i++) {
      const [d] = await q<{ status: string; attempts: number; last_status_code: number; wait: number }>(
        `SELECT status, attempts, last_status_code, extract(epoch FROM next_attempt_at - now())::float8 AS wait FROM webhook_deliveries`,
      )
      expect(d.status).toBe('failed')
      expect(d.attempts).toBe(i + 1)
      expect(d.last_status_code).toBe(500)
      expect(d.wait).toBeGreaterThan(delays[i] - 5)
      expect(d.wait).toBeLessThanOrEqual(delays[i] + 1)
      const before = rx.seen.length
      await tick() // chưa đến hạn
      expect(rx.seen.length).toBe(before)
      await forceDue()
      await tick()
    }
    const [last] = await q<{ status: string; attempts: number }>(`SELECT status, attempts FROM webhook_deliveries`)
    expect(last).toMatchObject({ status: 'dead', attempts: 7 })
    expect(rx.seen).toHaveLength(7)
    const before = rx.seen.length
    await forceDue()
    await tick()
    expect(rx.seen.length).toBe(before) // dead không gửi nữa
    expect(await n(`SELECT consecutive_failures AS n FROM webhook_endpoints WHERE id = $1`, [ep.id])).toBe(7)
    golden('webhooks-delivery-dead', 'admin', snap(await st(a((await mk({ 'integrations.webhooks': true })).token).get(`${B}/deliveries`, { endpoint_id: String(ep.id) }), 200)))
  })

  it('endpoint lỗi liên tiếp đủ 20 → tự tắt + thông báo người tạo; thành công giữa chừng reset bộ đếm', async () => {
    rx.status = 500
    const u = await mk(W)
    const ep = await only(u)
    await q(`UPDATE webhook_endpoints SET consecutive_failures = 18 WHERE id = $1`, [ep.id])
    await tick()
    expect((await q<{ is_active: boolean }>(`SELECT is_active FROM webhook_endpoints WHERE id = $1`, [ep.id]))[0].is_active).toBe(true) // 19
    await forceDue()
    await tick() // 20
    const [row] = await q<{ is_active: boolean; disabled_reason: string; consecutive_failures: number }>(`SELECT is_active, disabled_reason, consecutive_failures FROM webhook_endpoints WHERE id = $1`, [ep.id])
    expect(row).toMatchObject({ is_active: false, disabled_reason: 'consecutive_failures', consecutive_failures: 20 })
    const notes = await q<{ event_type: string; channel: string }>(`SELECT event_type, channel FROM notification_logs WHERE recipient_id = $1`, [u.id])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ event_type: 'webhook_endpoint_disabled', channel: 'in_app' })
    const before = rx.seen.length
    await forceDue()
    await tick()
    expect(rx.seen.length).toBe(before) // đã tắt → không gửi
    await q(`DELETE FROM webhook_deliveries`)
    await q(`UPDATE webhook_endpoints SET is_active = true, consecutive_failures = 5 WHERE id = $1`, [ep.id])
    rx.status = 200
    await contactEvent(u.id)
    await tick()
    expect(await n(`SELECT consecutive_failures AS n FROM webhook_endpoints WHERE id = $1`, [ep.id])).toBe(0)
  })

  it('POST /deliveries/:id/retry: failed/dead → pending rồi gửi được; success hoặc endpoint tắt → 409; ping → 400', async () => {
    rx.status = 500
    const u = await mk(W)
    const ep = await only(u)
    await tick()
    const [d] = await q<{ id: string }>(`SELECT id::text AS id FROM webhook_deliveries`)
    rx.status = 200
    await st(a(u.token).post(`${B}/deliveries/${d.id}/retry`), 200)
    const row = async () => (await q<{ status: string; attempts: number }>(`SELECT status, attempts FROM webhook_deliveries WHERE id = $1::uuid`, [d.id]))[0]
    expect(await row()).toMatchObject({ status: 'pending', attempts: 0 })
    await tick()
    expect(await row()).toMatchObject({ status: 'success', attempts: 1 })
    await st(a(u.token).post(`${B}/deliveries/${d.id}/retry`), 409)

    await q(`UPDATE webhook_deliveries SET status = 'dead' WHERE id = $1::uuid`, [d.id])
    await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { is_active: false }), 200)
    await st(a(u.token).post(`${B}/deliveries/${d.id}/retry`), 409)

    await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { is_active: true }), 200)
    const ping = await st(a(u.token).post(`${B}/endpoints/${ep.id}/test`), 200)
    await q(`UPDATE webhook_deliveries SET status = 'dead' WHERE id = $1::uuid`, [(ping.body as Body).delivery_id])
    await st(a(u.token).post(`${B}/deliveries/${(ping.body as Body).delivery_id}/retry`), 400)
  })

  it('lịch sử: lọc theo trạng thái/endpoint + phân trang cursor', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    for (let i = 0; i < 5; i++) await contactEvent(u.id)
    await tick()
    const p1 = await st(a(u.token).get(`${B}/deliveries`, { endpoint_id: String(ep.id), limit: '3' }), 200)
    expect((p1.body as Body).data).toHaveLength(3)
    const p2 = await st(a(u.token).get(`${B}/deliveries`, { endpoint_id: String(ep.id), limit: '3', cursor: (p1.body as Body).meta.next_cursor }), 200)
    expect((p2.body as Body).data).toHaveLength(2)
    expect((p2.body as Body).meta.next_cursor).toBeNull()
    expect(new Set([...(p1.body as Body).data, ...(p2.body as Body).data].map((r: { id: string }) => r.id)).size).toBe(5)
    // Không ghi golden trang: các delivery tạo trong cùng mili giây nên thứ tự (khoá phụ là uuid ngẫu nhiên) và con trỏ đổi mỗi lượt chạy.
    expect(((await st(a(u.token).get(`${B}/deliveries`, { status: 'success' }), 200)).body as Body).data).toHaveLength(5)
    expect(((await st(a(u.token).get(`${B}/deliveries`, { status: 'dead' }), 200)).body as Body).data).toHaveLength(0)
    await st(a(u.token).get(`${B}/deliveries`, { cursor: 'abc' }), 400)
  })
})
