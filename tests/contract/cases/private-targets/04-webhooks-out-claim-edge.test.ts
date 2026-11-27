import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { B, PHONE, a, contactEvent, contactPayload, encryptWithForeignKey, forceDue, mk, mkEndpoint, n, pendingDelivery, resetWebhooks, startReceiver, st, tick, type Receiver } from '../../lib/webhooks.js'

afterAll(closeDb)

/**
 * C12a, hồ sơ `private-targets`: nhận việc song song, crash, các ca biên. Ca gốc gọi `worker.claim()/processBatch()/sweepExhausted()` trong tiến trình;
 * ở đây chỉ có `tick` (API điều khiển). Phần chỉ kiểm được bằng gọi hàm (ghi kết quả muộn của lượt nhận cũ, hai `claim` đồng thời) có test riêng ở
 * Rust (`trinity-integrations/tests/webhooks_pg.rs`).
 */
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
const ids = (): string[] => rx.seen.map((s) => s.headers['x-trinity-delivery'] as string)

describe('nhận việc song song + crash', () => {
  it('nhận việc KHÔNG trùng dòng nào (FOR UPDATE SKIP LOCKED); attempts tăng ngay lúc nhận; trong lease không ai nhận lại', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    for (let i = 0; i < 60; i++) await pendingDelivery(ep.id, i + 1, contactPayload(u.id, {}, PHONE))
    // Ba lượt đồng thời (mỗi lượt nhận tối đa 20 việc), rồi chạy cho tới hết: mỗi delivery chỉ được gửi đúng một lần.
    await Promise.all([tick(), tick(), tick()])
    for (let i = 0; i < 3; i++) await tick()
    expect(rx.seen).toHaveLength(60)
    expect(new Set(ids()).size).toBe(60)
    expect(await n(`SELECT count(*) AS n FROM webhook_deliveries WHERE status = 'success' AND attempts = 1`)).toBe(60)
    await forceDue()
    await tick()
    expect(rx.seen).toHaveLength(60) // đã success: không ai nhận lại
  })

  it('crash giữa lúc gửi: dòng đã nhận nhưng chưa ghi kết quả được nhận lại SAU lease, attempts vẫn có trần', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    // Trạng thái sau một lượt nhận mà tiến trình chết trước khi gửi: attempts đã tăng, next_attempt_at đẩy ra sau lease (120 giây).
    const id = await pendingDelivery(ep.id, 1, contactPayload(u.id), { status: 'pending', attempts: 1 })
    await q(`UPDATE webhook_deliveries SET next_attempt_at = now() + interval '120 seconds' WHERE id = $1::uuid`, [id])
    await tick()
    expect(rx.seen).toHaveLength(0) // đang trong lease
    await q(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'`) // lease hết hạn
    await tick()
    expect(rx.seen).toHaveLength(1)
    const [d] = await q<{ status: string; attempts: number }>(`SELECT status, attempts FROM webhook_deliveries`)
    expect(d).toMatchObject({ status: 'success', attempts: 2 })
  })
})

describe('các ca biên: trần thử lại, tắt endpoint, ping, sự kiện cũ', () => {
  it('lượt cuối bị gián đoạn (attempts đã = 7, lease hết) ⇒ KHÔNG được nhận lại, quét về dead (trần tuyệt đối)', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    const e = await contactEvent(u.id, { dispatched: true })
    await pendingDelivery(ep.id, e, contactPayload(u.id), { status: 'failed', attempts: 7 })
    await q(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'`)
    await tick()
    const [d] = await q<{ status: string; last_error: string; attempts: number }>(`SELECT status, last_error, attempts FROM webhook_deliveries`)
    expect(d).toMatchObject({ status: 'dead', last_error: 'attempts_exhausted', attempts: 7 })
    expect(rx.seen).toHaveLength(0)
  })

  it('tắt endpoint (thủ công) ⇒ delivery chờ chuyển dead; bật lại KHÔNG dội sự kiện cũ', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    const e = await contactEvent(u.id, { dispatched: true })
    await pendingDelivery(ep.id, e, contactPayload(u.id)) // như dispatcher đã dựng, chưa gửi
    await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { is_active: false }), 200)
    const [d] = await q<{ status: string; last_error: string }>(`SELECT status, last_error FROM webhook_deliveries`)
    expect(d).toMatchObject({ status: 'dead', last_error: 'endpoint_disabled' })
    await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { is_active: true }), 200)
    await tick()
    expect(rx.seen).toHaveLength(0)
  })

  it('ping không bao giờ bị worker nhận; nhật ký ghi người bấm gửi thử (không phải chủ endpoint)', async () => {
    const owner = await mk({ 'integrations.webhooks': true })
    const clicker = await mk({ 'integrations.webhooks': true })
    const ep = await mkEndpoint(owner.token, rx.url)
    await st(a(clicker.token).post(`${B}/endpoints/${ep.id}/test`), 200)
    expect(rx.seen).toHaveLength(1)
    const [log] = await q<{ user_id: number }>(`SELECT user_id FROM integration_audit_logs WHERE action = 'ping'`)
    expect(log.user_id).toBe(clicker.id)
    await q(`UPDATE webhook_deliveries SET status = 'pending'`)
    await forceDue() // đến hạn ngay: nếu worker nhận ping thì ca này mới bắt được
    await tick()
    expect(rx.seen).toHaveLength(1) // ping không bị gửi lại
  })

  it('lỗi cấu hình khoá (đổi INTEGRATIONS_SECRET_KEY) KHÔNG tính vào bộ đếm tự tắt', async () => {
    const u = await mk(W)
    // Bản mã của một khoá khác = trạng thái sau khi đổi khoá: không giải mã được secret cũ.
    await q(`INSERT INTO webhook_endpoints (name, url, secret_enc, events, created_by, updated_at) VALUES ('khoá cũ', $1, $2, ARRAY['contact.created'], $3, now())`, [rx.url, encryptWithForeignKey('whsec_cu'), u.id])
    await new Promise((r) => setTimeout(r, 15))
    await contactEvent(u.id)
    await tick()
    const [d] = await q<{ status: string; last_error: string }>(`SELECT status, last_error FROM webhook_deliveries`)
    expect(d).toMatchObject({ status: 'failed', last_error: 'secret_unavailable' })
    expect(await n(`SELECT consecutive_failures AS n FROM webhook_endpoints`)).toBe(0)
    expect(rx.seen).toHaveLength(0)
  })

  it('sự kiện outbox cũ hơn 7 ngày (cờ tắt rồi bật lại) không được đẩy; mới thì đẩy', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    await q(`UPDATE webhook_endpoints SET created_at = now() - interval '30 days' WHERE id = $1`, [ep.id])
    await contactEvent(u.id)
    await q(`UPDATE integration_events SET created_at = now() - interval '8 days'`)
    await contactEvent(u.id)
    await tick()
    expect(rx.seen).toHaveLength(1)
    expect(await n(`SELECT count(*) AS n FROM integration_events WHERE dispatched_at IS NULL`)).toBe(0)
  })

  it('khách có SĐT trong tên/email/lý do chuyển — chủ thể thiếu phone_full không nhận số', async () => {
    const u = await mk(W)
    await mkEndpoint(u.token, rx.url)
    await contactEvent(u.id, { contact: { full_name: 'Khách Lan 0912345678', email: '0912345678@example.invalid', created_at: null } })
    await tick()
    expect(rx.seen).toHaveLength(1)
    expect(rx.seen[0].body).not.toContain('0912345678')
    expect(rx.seen[0].body).not.toContain(PHONE)
  })
})
