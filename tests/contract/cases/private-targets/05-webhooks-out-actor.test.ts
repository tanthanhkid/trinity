import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { control } from '../../lib/http.js'
import { B, PHONE, a, contactEvent, contactPayload, mk, mkEndpoint, n, pendingDelivery, resetWebhooks, startReceiver, st, tick, type Receiver } from '../../lib/webhooks.js'

afterAll(closeDb)

/** C12a, hồ sơ `private-targets`: chủ thể (người tạo) mất quyền hoặc đổi người sửa. `invalidateUsers` đổi thành xoá cache qua API điều khiển. */
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
const W = { 'integrations.webhooks': true, 'contacts.view': 'all' } as const

describe('chủ thể (người tạo) mất quyền / đổi người sửa', () => {
  it('người tạo mất integrations.webhooks → endpoint tự tắt, delivery chết, KHÔNG gửi gì', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    await contactEvent(u.id)
    await q(`DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1)`, [u.id])
    await control.flushCache() // như môi trường thật: đổi quyền ⇒ rbac:invalidate
    await tick()
    expect(rx.seen).toHaveLength(0)
    const [row] = await q<{ is_active: boolean; disabled_reason: string }>(`SELECT is_active, disabled_reason FROM webhook_endpoints WHERE id = $1`, [ep.id])
    expect(row).toMatchObject({ is_active: false, disabled_reason: 'creator_unauthorized' })
  })

  it('người tạo bị khoá → ngừng gửi', async () => {
    const u = await mk(W)
    const ep = await mkEndpoint(u.token, rx.url)
    await contactEvent(u.id)
    await q(`UPDATE users SET status = 'locked' WHERE id = $1`, [u.id])
    await control.flushCache()
    await tick()
    expect(rx.seen).toHaveLength(0)
    expect((await q<{ is_active: boolean }>(`SELECT is_active FROM webhook_endpoints WHERE id = $1`, [ep.id]))[0].is_active).toBe(false)
  })

  it('người KHÁC đổi URL ⇒ chủ thể chuyển sang họ (không leo thang SĐT), delivery chờ bị huỷ', async () => {
    const admin = await mk({ ...W, 'contacts.phone_full': 'all' })
    const low = await mk({ 'integrations.webhooks': true }) // không contacts.view, không phone_full
    const ep = await mkEndpoint(admin.token, rx.url)
    // Delivery dựng theo quyền admin (SĐT rõ), chưa gửi: như `dispatcher.dispatchEvents()` đứng riêng ở e2e gốc.
    const e = await contactEvent(admin.id, { dispatched: true })
    await pendingDelivery(ep.id, e, contactPayload(admin.id))
    expect(await n(`SELECT count(*) AS n FROM webhook_deliveries WHERE status = 'pending'`)).toBe(1)

    await st(a(low.token).patch(`${B}/endpoints/${ep.id}`, { url: `${rx.url}?x=1` }), 200)
    const [row] = await q<{ created_by: number; url: string; events: string[] }>(`SELECT created_by, url, events FROM webhook_endpoints WHERE id = $1`, [ep.id])
    expect(row.created_by).toBe(low.id)
    expect(await n(`SELECT count(*) AS n FROM webhook_deliveries WHERE status = 'pending'`)).toBe(0) // huỷ
    await tick()
    expect(rx.seen).toHaveLength(0)
    await contactEvent(admin.id)
    await tick()
    expect(rx.seen).toHaveLength(0) // chủ thể mới không có contacts.view → không nhận khách

    // Gửi lại ĐÚNG url/sự kiện đang lưu (UI lưu cả form) bởi người khác → KHÔNG chuyển chủ thể.
    await st(a(admin.token).patch(`${B}/endpoints/${ep.id}`, { url: row.url, events: [...row.events].reverse() }), 200)
    expect(await n(`SELECT created_by AS n FROM webhook_endpoints WHERE id = $1`, [ep.id])).toBe(low.id)
  })

  it('admin đổi SỰ KIỆN / tạo lại SECRET / đổi tên endpoint của người quyền thấp ⇒ chủ thể KHÔNG đổi (URL vẫn của người thấp, không nhận SĐT theo quyền admin)', async () => {
    const admin = await mk({ ...W, 'contacts.phone_full': 'all' })
    const low = await mk({ 'integrations.webhooks': true, 'contacts.view': 'own' })
    const ep = await mkEndpoint(low.token, rx.url, { events: ['contact.created'] })
    await st(a(admin.token).patch(`${B}/endpoints/${ep.id}`, { events: ['contact.created', 'contact.updated', 'deal.won'] }), 200)
    await st(a(admin.token).post(`${B}/endpoints/${ep.id}/rotate-secret`), 200)
    await st(a(admin.token).patch(`${B}/endpoints/${ep.id}`, { name: 'admin đổi tên' }), 200)
    expect(await n(`SELECT created_by AS n FROM webhook_endpoints WHERE id = $1`, [ep.id])).toBe(low.id)
    await contactEvent(admin.id) // khách của admin: người thấp (own) không xem được
    await tick()
    expect(rx.seen).toHaveLength(0)
  })

  it('quyền SĐT bị rút SAU khi dựng delivery nhưng TRƯỚC khi gửi → vẫn che (che lại lúc gửi)', async () => {
    const u = await mk({ ...W, 'contacts.phone_full': 'all' })
    const ep = await mkEndpoint(u.token, rx.url)
    // Delivery đã dựng khi chủ thể còn phone_full: payload lưu SĐT rõ (như `dispatchEvents()` đứng riêng ở e2e gốc).
    const e = await contactEvent(u.id, { dispatched: true })
    await pendingDelivery(ep.id, e, contactPayload(u.id))
    expect(JSON.stringify((await q<{ payload: unknown }>(`SELECT payload FROM webhook_deliveries`))[0].payload)).toContain(PHONE)
    await q(`DELETE FROM role_permissions WHERE permission = 'contacts.phone_full' AND role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1)`, [u.id])
    await control.flushCache()
    await tick()
    expect(rx.seen).toHaveLength(1)
    expect(rx.seen[0].body).not.toContain(PHONE)
    expect(JSON.parse(rx.seen[0].body).data.contact.phone).toBe('***356')
  })
})
