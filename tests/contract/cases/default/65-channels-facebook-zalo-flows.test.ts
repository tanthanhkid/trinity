import { createHash, createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { call, api, freshIp, type Res } from '../../lib/http.js'
import { mock, seedFacebookConversation, seedFacebookPage, seedZaloConnection, seedZaloThread } from '../../lib/channels.js'
import { makeUser, type U } from '../../lib/users.js'

/**
 * C14f — ca thành công / đầu vào sai cho route Facebook và Zalo OA của cụm `channels`, qua máy chủ giả Graph/Zalo (C06b): không lời gọi
 * nào ra Internet; lời gọi tới đường máy chủ giả không có kịch bản làm ca đỏ (`unexpected`). Ca sinh 401/403/400/404: `64-…generated`.
 */
const ok = <T>(res: Res, status: number | number[], what: string): T => {
  expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`).toContain(res.status)
  return res.body as T
}
let admin: U
let seq = 0
const uid = (p: string): string => `${p}${String(900 + ++seq).padStart(4, '0')}`
const t = () => ({ token: admin.token, ip: freshIp() })

beforeAll(async () => {
  admin = await makeUser({ 'integrations.webhooks': true, 'contacts.update': 'all', 'contacts.view': 'all', 'social.post': true, 'social.manage': true })
})
beforeEach(async () => {
  await mock.reset()
})
afterEach(async () => {
  expect(await mock.unexpected()).toEqual([])
})
afterAll(closeDb)

const sign = (body: string, secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('Facebook: Page, trạng thái, kết nối', () => {
  it('danh sách Page, trạng thái, sửa Page, xoá Page, link kết nối', async () => {
    const page = uid('3000')
    const pid = await seedFacebookPage({ pageId: page, adminId: admin.id })
    const list = ok<{ data?: { id: number }[] } | { id: number }[]>(await api.get('/facebook/pages', t()), 200, 'danh sách Page')
    expect((Array.isArray(list) ? list : (list.data ?? [])).some((p) => p.id === pid)).toBe(true)
    ok(await api.get('/facebook/status', t()), 200, 'trạng thái')
    ok(await api.patch(`/facebook/pages/${pid}`, { ...t(), body: { is_active: false } }), 200, 'sửa Page')
    ok(await api.patch(`/facebook/pages/${pid}`, { ...t(), body: { is_active: 'khong-phai-bool' } }), 400, 'sửa Page sai kiểu')
    ok(await api.post(`/facebook/pages/${pid}/check`, t()), 200, 'kiểm tra token Page')
    ok(await api.post('/facebook/connect-url', t()), 200, 'link kết nối')
    ok(await api.post('/facebook/tick', t()), 200, 'tick')
    ok(await api.del(`/facebook/pages/${pid}`, t()), 204, 'xoá Page')
  })
})

describe('Facebook: webhook công khai', () => {
  it('GET xác minh trả challenge; verify token sai → 403', async () => {
    const res = await call('GET', '/api/v1/facebook/webhook?hub.mode=subscribe&hub.verify_token=contract-fb-verify&hub.challenge=12345', { ip: freshIp() })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(String(res.body)).toBe('12345')
    expect((await call('GET', '/api/v1/facebook/webhook?hub.mode=subscribe&hub.verify_token=sai&hub.challenge=1', { ip: freshIp() })).status).toBe(403)
  })

  it('POST ký đúng → 200; ký sai → 401', async () => {
    const page = uid('3100')
    await seedFacebookPage({ pageId: page, adminId: admin.id })
    const body = JSON.stringify({ object: 'page', entry: [{ id: page, time: 1, messaging: [] }] })
    const good = await call('POST', '/api/v1/facebook/webhook', { headers: { 'x-hub-signature-256': sign(body, 'contract-fb-app-secret-0123456789'), 'content-type': 'application/json' }, body: JSON.parse(body), ip: freshIp() })
    expect(good.status, JSON.stringify(good.body)).toBe(200)
    const bad = await call('POST', '/api/v1/facebook/webhook', { headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: JSON.parse(body), ip: freshIp() })
    expect(bad.status).toBe(401)
  })

  it('callback OAuth chuyển hướng 302 (huỷ / thiếu tham số)', async () => {
    expect((await call('GET', '/api/v1/facebook/oauth/callback?error=access_denied', { ip: freshIp() })).status).toBe(302)
  })
})

describe('Facebook: hội thoại, bình luận', () => {
  it('danh sách hội thoại, tin nhắn, trả lời', async () => {
    const page = uid('3200')
    await seedFacebookPage({ pageId: page, adminId: admin.id })
    const conv = await seedFacebookConversation({ pageId: page, psid: uid('77'), inboundMinutesAgo: 5 })
    ok(await api.get('/facebook/conversations', t()), 200, 'danh sách hội thoại')
    ok(await api.get(`/facebook/conversations/${conv}/messages`, t()), 200, 'tin nhắn')
    ok(await api.post(`/facebook/conversations/${conv}/messages`, { ...t(), body: { text: 'Chào bạn' } }), 201, 'gửi tin')
  })

  it('bình luận: danh sách và trả lời công khai', async () => {
    const page = uid('3300')
    await seedFacebookPage({ pageId: page, adminId: admin.id })
    const cid = `${page}_c${seq}`
    const [row] = await q<{ id: string }>(
      `INSERT INTO facebook_comments (comment_id, page_id, post_id, from_id, from_name, message, status) VALUES ($1, $2, $3, '555', 'Khách', 'Giá bao nhiêu?', 'received') RETURNING id::text`,
      [cid, page, `${page}_p1`],
    )
    ok(await api.get('/facebook/comments', t()), 200, 'danh sách bình luận')
    ok(await api.post(`/facebook/comments/${row.id}/reply`, { ...t(), body: { text: 'Dạ inbox giúp em', mode: 'public' } }), [200, 201], 'trả lời bình luận')
  })
})

describe('Facebook: luật bình luận, link mở chat, kịch bản, gửi hàng loạt', () => {
  it('luật bình luận: tạo, liệt kê, sửa, thử, xoá', async () => {
    const rule = ok<{ id: number }>(await api.post('/facebook/comment-rules', { ...t(), body: { name: 'Luật hợp đồng', keywords: ['giá'], public_replies: ['Dạ inbox'], mode: 'test' } }), 201, 'tạo luật')
    ok(await api.get('/facebook/comment-rules', t()), 200, 'danh sách luật')
    ok(await api.patch(`/facebook/comment-rules/${rule.id}`, { ...t(), body: { is_active: false } }), 200, 'sửa luật')
    ok(await api.post('/facebook/comment-rules/dry-run', { ...t(), body: { message: 'Giá bao nhiêu vậy' } }), 200, 'thử luật')
    ok(await api.del(`/facebook/comment-rules/${rule.id}`, t()), 204, 'xoá luật')
  })

  it('link mở chat: tạo, liệt kê, sửa, mở công khai → 302, xoá', async () => {
    const page = uid('3400')
    await seedFacebookPage({ pageId: page, adminId: admin.id })
    const link = ok<{ id: number; code: string }>(await api.post('/facebook/chat-links', { ...t(), body: { name: 'Link hợp đồng', page_id: page } }), 201, 'tạo link')
    ok(await api.get('/facebook/chat-links', t()), 200, 'danh sách link')
    ok(await api.patch(`/facebook/chat-links/${link.id}`, { ...t(), body: { name: 'Link đã sửa' } }), 200, 'sửa link')
    const go = await call('GET', `/api/v1/facebook/go/${link.code}`, { ip: freshIp() })
    expect(go.status, JSON.stringify(go.body)).toBe(302)
    ok(await api.del(`/facebook/chat-links/${link.id}`, t()), 204, 'xoá link')
  })

  it('kịch bản tự nhắn: tạo, liệt kê, xem, sửa, lượt chạy, xoá', async () => {
    const page = uid('3500')
    await seedFacebookPage({ pageId: page, adminId: admin.id })
    const flow = ok<{ id: number }>(
      await api.post('/facebook/flows', { ...t(), body: { name: 'Kịch bản hợp đồng', page_id: page, trigger: 'keyword', keywords: ['chào'], steps: [{ type: 'text', text: 'Xin chào' }], is_active: false } }),
      201,
      'tạo kịch bản',
    )
    ok(await api.get('/facebook/flows', t()), 200, 'danh sách kịch bản')
    ok(await api.get(`/facebook/flows/${flow.id}`, t()), 200, 'xem kịch bản')
    ok(await api.patch(`/facebook/flows/${flow.id}`, { ...t(), body: { name: 'Đã sửa' } }), 200, 'sửa kịch bản')
    ok(await api.get(`/facebook/flows/${flow.id}/runs`, t()), 200, 'lượt chạy')
    ok(await api.del(`/facebook/flows/${flow.id}`, t()), 204, 'xoá kịch bản')
  })

  it('gửi hàng loạt: xem trước, tạo, liệt kê, xem, sửa, người nhận, gửi, huỷ, xoá', async () => {
    const page = uid('3600')
    await seedFacebookPage({ pageId: page, adminId: admin.id })
    ok(await api.post('/facebook/broadcasts/preview', { ...t(), body: { page_id: page, audience: {} } }), 200, 'xem trước')
    const b = ok<{ id: number }>(await api.post('/facebook/broadcasts', { ...t(), body: { name: 'Đợt hợp đồng', page_id: page, text: 'Ưu đãi tháng này', audience: {} } }), 201, 'tạo đợt gửi')
    ok(await api.get('/facebook/broadcasts', t()), 200, 'danh sách')
    ok(await api.get(`/facebook/broadcasts/${b.id}`, t()), 200, 'xem')
    ok(await api.patch(`/facebook/broadcasts/${b.id}`, { ...t(), body: { text: 'Ưu đãi đã sửa' } }), 200, 'sửa')
    ok(await api.get(`/facebook/broadcasts/${b.id}/recipients`, t()), 200, 'người nhận')
    ok(await api.post(`/facebook/broadcasts/${b.id}/send`, { ...t(), body: {} }), 200, 'gửi')
    ok(await api.post(`/facebook/broadcasts/${b.id}/cancel`, t()), [200, 400, 409], 'huỷ')
    ok(await api.del(`/facebook/broadcasts/${b.id}`, t()), [204, 400, 409], 'xoá')
    // Hẹn giờ (3 ngày tới, trần 7 ngày) rồi huỷ: đường huỷ thành công (lượt gửi ngay đã kết thúc nên huỷ trả 400).
    const later = ok<{ id: number }>(await api.post('/facebook/broadcasts', { ...t(), body: { name: 'Đợt hẹn giờ', page_id: page, text: 'Hẹn giờ', audience: {} } }), 201, 'tạo đợt hẹn giờ')
    ok(await api.post(`/facebook/broadcasts/${later.id}/send`, { ...t(), body: { scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString() } }), 200, 'hẹn giờ')
    ok(await api.post(`/facebook/broadcasts/${later.id}/cancel`, t()), 200, 'huỷ lượt hẹn giờ')
  })
})

const ZALO_SECRET = 'contract-zalo-webhook-secret'
const ZALO_APP = 'contract-zalo-app'
const zaloSign = (body: string, ts: string): string => `mac=${createHash('sha256').update(ZALO_APP).update(body).update(ts).update(ZALO_SECRET).digest('hex')}`

describe('Zalo OA', () => {
  it('kết nối, hộp thư, gửi tin, ghép khách, đọc, ZNS, ngắt kết nối', async () => {
    await q(`DELETE FROM zalo_oa_connections`)
    ok(await api.get('/zalo-oa/status', t()), 200, 'trạng thái')
    ok(await api.post('/zalo-oa/connect', t()), 200, 'bắt đầu cấp quyền')
    const oa = uid('oa')
    await seedZaloConnection({ oaId: oa, adminId: admin.id, accessExpiresInMinutes: 120 })
    const thread = await seedZaloThread({ oaId: oa, zaloUserId: uid('zu'), inboundMinutesAgo: 10 })
    ok(await api.get('/zalo-oa/threads', t()), 200, 'danh sách hội thoại')
    ok(await api.get(`/zalo-oa/threads/${thread}/messages`, t()), 200, 'tin nhắn')
    ok(await api.post(`/zalo-oa/threads/${thread}/messages`, { ...t(), body: { text: 'Chào bạn' } }), 201, 'gửi tin')
    ok(await api.post(`/zalo-oa/threads/${thread}/read`, t()), 204, 'đánh dấu đã đọc')
    const contact = await q<{ id: number }>(`SELECT id FROM contacts ORDER BY id LIMIT 1`)
    ok(await api.post(`/zalo-oa/threads/${thread}/link`, { ...t(), body: contact[0] ? { contact_id: contact[0].id } : { phone: '0933555777' } }), 200, 'ghép khách')
    ok(await api.post('/zalo-oa/zns', { ...t(), body: { phone: '0933555888', template_id: '123456', template_data: { ten: 'A' } } }), 200, 'ZNS')
    ok(await api.del('/zalo-oa/connection', t()), 204, 'ngắt kết nối')
  })

  it('callback OAuth chuyển hướng 302', async () => {
    expect((await call('GET', '/api/v1/zalo-oa/oauth/callback?code=x&oa_id=y&state=z', { ip: freshIp() })).status).toBe(302)
  })

  it('webhook: ký đúng → 200, ký sai → 401', async () => {
    const body = { app_id: ZALO_APP, event_name: 'user_send_text', timestamp: '1700000000000', sender: { id: 'nobody' }, recipient: { id: 'no-oa' }, message: { text: 'x' } }
    const raw = JSON.stringify(body)
    const good = await call('POST', '/api/v1/zalo-oa/webhook', { headers: { 'x-zevent-signature': zaloSign(raw, body.timestamp) }, body, ip: freshIp() })
    expect(good.status, JSON.stringify(good.body)).toBe(200)
    expect((await call('POST', '/api/v1/zalo-oa/webhook', { headers: { 'x-zevent-signature': 'mac=' + '0'.repeat(64) }, body, ip: freshIp() })).status).toBe(401)
  })
})
