import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { golden, snap } from '../../lib/golden.js'
import { B, PHONE, a, contactEvent, mk, mkEndpoint, n, resetWebhooks, startReceiver, st, tick, verifySignature, type Body, type Receiver } from '../../lib/webhooks.js'

afterAll(closeDb)

/** C12a, hồ sơ `private-targets`. Gửi THẬT tới máy nhận cục bộ: chữ ký, che SĐT theo quyền chủ thể, phạm vi, nhật ký sạch. */
let rx: Receiver
beforeAll(async () => {
  rx = await startReceiver()
})
afterAll(async () => rx.close())
beforeEach(async () => {
  rx.seen.length = 0
  rx.status = 200
  await resetWebhooks()
})
const snapBody = (body: unknown) => snap({ status: 200, headers: new Headers(), body })
const W = { 'integrations.webhooks': true } as const

describe('gửi THẬT tới máy nhận cục bộ', () => {
  it('ping: nhận đúng chữ ký (secret hiển thị lúc tạo), header, body; lịch sử không có payload', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    const r = await st(a(u.token).post(`${B}/endpoints/${ep.id}/test`), 200)
    expect(r.body).toMatchObject({ ok: true, status_code: 200, error: null })
    expect(rx.seen).toHaveLength(1)
    const s = rx.seen[0]
    expect(verifySignature(ep.secret, s.body, s.headers['x-trinity-signature'] as string)).toBe(true)
    expect(s.headers['x-trinity-event']).toBe('ping')
    expect(s.headers['x-trinity-delivery']).toBe((r.body as Body).delivery_id)
    expect(s.headers['user-agent']).toBe('Trinity-Webhooks/1.0')
    const parsed = JSON.parse(s.body)
    expect(parsed).toMatchObject({ id: (r.body as Body).delivery_id, type: 'ping', data: { message: 'Trinity webhook test' } })
    expect(new Date(parsed.created_at).toString()).not.toBe('Invalid Date')
    golden('webhooks-ping-body', 'admin', snapBody(parsed))

    const list = await st(a(u.token).get(`${B}/deliveries`, { endpoint_id: String(ep.id) }), 200)
    expect((list.body as Body).data).toHaveLength(1)
    expect((list.body as Body).data[0]).toMatchObject({ event_type: 'ping', status: 'success', attempts: 1, last_status_code: 200 })
    expect((list.body as Body).data[0]).not.toHaveProperty('payload')
    golden('webhooks-deliveries-ping', 'admin', snap(list))
  })

  it('ping lỗi 500: dead ngay (không thử lại), KHÔNG tính vào lỗi liên tiếp', async () => {
    rx.status = 500
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    const r = await st(a(u.token).post(`${B}/endpoints/${ep.id}/test`), 200)
    expect(r.body).toMatchObject({ ok: false, status_code: 500, error: 'http_500' })
    // `duration_ms` phụ thuộc thời gian chạy: bỏ khỏi golden.
    golden('webhooks-ping-500', 'admin', snap({ ...r, body: { ...(r.body as Body), duration_ms: '<ms>' } }))
    expect(await n(`SELECT consecutive_failures AS n FROM webhook_endpoints WHERE id = $1`, [ep.id])).toBe(0)
    expect((await q<{ status: string }>(`SELECT status FROM webhook_deliveries`))[0].status).toBe('dead')
  })

  it('outbox → delivery → gửi: chữ ký đúng, SĐT che khi chủ thể KHÔNG có phone_full, nhật ký sạch SĐT/secret/URL', async () => {
    const u = await mk({ ...W, 'contacts.view': 'all' }) // không phone_full
    const ep = await mkEndpoint(u.token, rx.url)
    await contactEvent(u.id)
    await tick()

    expect(rx.seen).toHaveLength(1)
    const s = rx.seen[0]
    expect(verifySignature(ep.secret, s.body, s.headers['x-trinity-signature'] as string)).toBe(true)
    expect(s.headers['x-trinity-event']).toBe('contact.created')
    const body = JSON.parse(s.body)
    expect(body.type).toBe('contact.created')
    expect(body.id).toBe(s.headers['x-trinity-delivery'])
    expect(body.data.contact.phone).toBe('***356')
    expect(s.body).not.toContain(PHONE)
    golden('webhooks-contact-created-masked', 'sale', snapBody(body))

    const [d] = await q<{ status: string; attempts: number; last_status_code: number; event_type: string; payload: unknown }>(`SELECT status, attempts, last_status_code, event_type, payload FROM webhook_deliveries`)
    expect(d).toMatchObject({ status: 'success', attempts: 1, last_status_code: 200, event_type: 'contact.created' })
    expect(JSON.stringify(d.payload)).not.toContain(PHONE) // payload lưu đã che
    expect((await q<{ dispatched_at: string | null }>(`SELECT dispatched_at FROM integration_events`))[0].dispatched_at).not.toBeNull()
    const [epRow] = await q<{ last_success_at: string | null; consecutive_failures: number }>(`SELECT last_success_at, consecutive_failures FROM webhook_endpoints WHERE id = $1`, [ep.id])
    expect(epRow.last_success_at).not.toBeNull()
    expect(epRow.consecutive_failures).toBe(0)

    const audit = JSON.stringify(await q(`SELECT * FROM integration_audit_logs WHERE channel = 'webhook_out'`))
    for (const leak of [PHONE, ep.secret, '127.0.0.1', '/hook']) expect(audit).not.toContain(leak)
    expect(audit).toContain('contact.created')
  })

  it('chủ thể có contacts.phone_full → SĐT đầy đủ', async () => {
    const u = await mk({ ...W, 'contacts.view': 'all', 'contacts.phone_full': 'all' })
    await mkEndpoint(u.token, rx.url)
    await contactEvent(u.id)
    await tick()
    expect(JSON.parse(rx.seen[0].body).data.contact.phone).toBe(PHONE)
    golden('webhooks-contact-created-full', 'admin', snapBody(JSON.parse(rx.seen[0].body)))
  })

  it('chủ thể contacts.view scope own: chỉ nhận sự kiện của khách mình; khách người khác không gửi', async () => {
    const other = await mk({})
    const u = await mk({ ...W, 'contacts.view': 'own' })
    await mkEndpoint(u.token, rx.url)
    await contactEvent(other.id)
    await contactEvent(u.id)
    await tick()
    expect(rx.seen).toHaveLength(1)
    expect(JSON.parse(rx.seen[0].body).data.contact.assigned_to).toBe(u.id)
    expect(await n(`SELECT count(*) AS n FROM webhook_deliveries`)).toBe(1)
  })

  it('chỉ gửi sự kiện đã đăng ký; sự kiện TRƯỚC khi tạo endpoint không bị đẩy; endpoint tắt không nhận', async () => {
    const u = await mk({ ...W, 'contacts.view': 'all' })
    await contactEvent(u.id) // trước endpoint
    await new Promise((r) => setTimeout(r, 15))
    const ep = await mkEndpoint(u.token, rx.url, { events: ['deal.won'] })
    await contactEvent(u.id) // đúng thời điểm nhưng sai loại
    await tick()
    expect(rx.seen).toHaveLength(0)
    expect(await n(`SELECT count(*) AS n FROM webhook_deliveries`)).toBe(0)
    expect(await n(`SELECT count(*) AS n FROM integration_events WHERE dispatched_at IS NULL`)).toBe(0) // đã dispatch (không còn kẹt)
    await st(a(u.token).patch(`${B}/endpoints/${ep.id}`, { events: ['contact.created'], is_active: false }), 200)
    await contactEvent(u.id)
    await tick()
    expect(rx.seen).toHaveLength(0)
  })

  it('dispatcher chạy trùng (2 lần liên tiếp/đồng thời) KHÔNG tạo delivery đôi', async () => {
    const u = await mk({ ...W, 'contacts.view': 'all' })
    await mkEndpoint(u.token, rx.url)
    for (let i = 0; i < 5; i++) await contactEvent(u.id)
    // Hai lượt cùng lúc rồi thêm một lượt nữa: mỗi sự kiện chỉ thành một delivery (UNIQUE endpoint_id, event_id) và chỉ gửi một lần.
    await Promise.all([tick(), tick()])
    await tick()
    expect(await n(`SELECT count(*) AS n FROM webhook_deliveries`)).toBe(5)
    expect(rx.seen).toHaveLength(5)
    expect(new Set(rx.seen.map((s) => s.headers['x-trinity-delivery'])).size).toBe(5)
  })
})
