import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { api, freshIp } from '../../lib/http.js'
import { config } from '../../lib/config.js'
import { golden, snap } from '../../lib/golden.js'
import { loginAdmin } from '../../lib/session.js'
import { graphFail, mock, seedFacebookConversation, seedFacebookPage, seedZaloConnection, seedZaloThread } from '../../lib/channels.js'

/**
 * Kênh Facebook/Zalo qua máy chủ giả (C06b): Trinity trỏ `FACEBOOK_GRAPH_BASE_URL` và `ZALO_*_BASE_URL` tới máy chủ giả của bộ chạy,
 * nên mọi lời gọi ra ngoài đều ghi lại và không có lời gọi nào ra Internet (máy chủ Node còn bị chặn mạng, xem mock/block-network.cjs).
 */
let token = ''
let adminId = 0
let seq = 0
const uid = (p: string): string => `${p}${String(++seq).padStart(3, '0')}`

beforeEach(async () => {
  await mock.reset()
  if (!token) {
    token = (await loginAdmin()).token
    adminId = (await q<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [config.adminEmail]))[0].id
  }
})
afterEach(async () => {
  // Không lời gọi nào tới đường mà máy chủ giả không có kịch bản (reset không xoá `unexpected`, nên kiểm sau MỖI ca và cả lượt).
  expect(await mock.unexpected()).toEqual([])
})
afterAll(closeDb)

const authed = { get token(): string { return token } }

describe('Facebook qua máy chủ giả Graph', () => {
  it('kiểm token Page: token còn sống ⇒ active, đăng ký lại webhook', async () => {
    const pid = await seedFacebookPage({ pageId: uid('1000'), adminId })
    const res = await api.post(`/facebook/pages/${pid}/check`, { token: authed.token, ip: freshIp() })
    expect(res.status).toBe(200)
    expect((res.body as { token_status: string }).token_status).toBe('active')
    const calls = await mock.calls()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining(['GET debug_token', expect.stringMatching(/^POST \d+\/subscribed_apps$/)]))
    expect(calls.every((c) => c.service === 'graph')).toBe(true)
    golden('fb-page-check-ok', 'admin', snap(res))
  })

  it('kiểm token Page: Graph trả 190 ⇒ token_status invalid', async () => {
    const pid = await seedFacebookPage({ pageId: uid('1000'), adminId })
    await mock.rules(graphFail('GET debug_token', 190, undefined, 401))
    const res = await api.post(`/facebook/pages/${pid}/check`, { token: authed.token, ip: freshIp() })
    expect(res.status).toBe(200)
    expect((res.body as { token_status: string }).token_status).toBe('invalid')
    golden('fb-page-check-190', 'admin', snap(res))
  })

  it('trả lời hội thoại trong 24 giờ ⇒ 201, gửi RESPONSE tới Graph với token Page', async () => {
    const page = uid('2000')
    await seedFacebookPage({ pageId: page, adminId })
    const conv = await seedFacebookConversation({ pageId: page, psid: '555001', inboundMinutesAgo: 30 })
    const res = await api.post(`/facebook/conversations/${conv}/messages`, { token: authed.token, body: { text: 'Xin chào từ hợp đồng' }, ip: freshIp() })
    expect(res.status).toBe(201)
    const sent = (await mock.calls()).filter((c) => c.method === 'POST' && c.path === 'me/messages')
    expect(sent).toHaveLength(1)
    expect(sent[0].auth.bearer).toBe(true)
    expect(sent[0].body).toMatchObject({ recipient: { id: '555001' }, messaging_type: 'RESPONSE', message: { text: 'Xin chào từ hợp đồng' } })
    golden('fb-reply-ok', 'admin', snap(res))
  })

  it('trả lời khi Graph báo 190 ⇒ 503 và đánh dấu token Page invalid', async () => {
    const page = uid('3000')
    await seedFacebookPage({ pageId: page, adminId })
    const conv = await seedFacebookConversation({ pageId: page, psid: '555002', inboundMinutesAgo: 10 })
    await mock.rules(graphFail('POST me/messages', 190, undefined, 400))
    const res = await api.post(`/facebook/conversations/${conv}/messages`, { token: authed.token, body: { text: 'Thử' }, ip: freshIp() })
    expect(res.status).toBe(503)
    expect((await q<{ token_status: string }>(`SELECT token_status FROM facebook_pages WHERE page_id = $1`, [page]))[0].token_status).toBe('invalid')
    golden('fb-reply-190', 'admin', snap(res))
  })

  it.each([
    [368, undefined, 400],
    [551, 1545041, 400],
    [17, undefined, 400],
    [32, undefined, 400],
    [4, undefined, 400],
    [613, undefined, 400],
  ] as const)('trả lời khi Graph báo mã %i ⇒ lỗi có câu tiếng Việt, không lộ nguyên văn Meta', async (code, subcode, status) => {
    const page = uid('4000')
    await seedFacebookPage({ pageId: page, adminId })
    const conv = await seedFacebookConversation({ pageId: page, psid: `5550${code}`, inboundMinutesAgo: 5 })
    await mock.rules(graphFail('POST me/messages', code, subcode, status))
    const res = await api.post(`/facebook/conversations/${conv}/messages`, { token: authed.token, body: { text: 'Thử mã lỗi' }, ip: freshIp() })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(res.body)).not.toContain('Lỗi Graph giả')
    golden(`fb-reply-code-${code}`, 'admin', snap(res))
  })
})

describe('Zalo OA qua máy chủ giả', () => {
  it('gửi tin tư vấn trong 48 giờ với token còn hạn ⇒ 201, không làm mới token', async () => {
    const oa = uid('oa-a')
    await seedZaloConnection({ oaId: oa, adminId, accessExpiresInMinutes: 600 })
    const thread = await seedZaloThread({ oaId: oa, zaloUserId: 'zu-001', inboundMinutesAgo: 60 })
    const res = await api.post(`/zalo-oa/threads/${thread}/messages`, { token: authed.token, body: { text: 'Chào Zalo' }, ip: freshIp() })
    expect(res.status).toBe(201)
    const calls = await mock.calls()
    expect(calls.map((c) => `${c.service} ${c.method} ${c.path}`)).toEqual(['zalo-api POST v3.0/oa/message/cs'])
    expect(calls[0].auth.access_token).toBe(true)
    golden('zalo-send-ok', 'admin', snap(res))
  })

  it('token sắp hết hạn ⇒ làm mới qua máy chủ giả rồi mới gửi', async () => {
    const oa = uid('oa-b')
    await seedZaloConnection({ oaId: oa, adminId, accessExpiresInMinutes: 2 })
    const thread = await seedZaloThread({ oaId: oa, zaloUserId: 'zu-002', inboundMinutesAgo: 60 })
    const res = await api.post(`/zalo-oa/threads/${thread}/messages`, { token: authed.token, body: { text: 'Sau khi làm mới' }, ip: freshIp() })
    expect(res.status).toBe(201)
    const calls = await mock.calls()
    expect(calls.map((c) => `${c.service} ${c.path}`)).toEqual(['zalo-oauth v4/oa/access_token', 'zalo-api v3.0/oa/message/cs'])
    expect(calls[0].auth.secret_key).toBe(true)
    golden('zalo-refresh-then-send', 'admin', snap(res))
  })

  it('Zalo báo token hết hạn (-216) ⇒ 400 câu "kết nối lại" và kết nối chuyển needs_reauth', async () => {
    const oa = uid('oa-c')
    await seedZaloConnection({ oaId: oa, adminId, accessExpiresInMinutes: 600 })
    const thread = await seedZaloThread({ oaId: oa, zaloUserId: 'zu-003', inboundMinutesAgo: 60 })
    await mock.rules({ match: 'POST v3.0/oa/message/cs', status: 200, json: { error: -216, message: 'Access token is invalid' } })
    const res = await api.post(`/zalo-oa/threads/${thread}/messages`, { token: authed.token, body: { text: 'Token hỏng' }, ip: freshIp() })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).not.toContain('Access token is invalid')
    expect((await q<{ status: string }>(`SELECT status FROM zalo_oa_connections WHERE oa_id = $1`, [oa]))[0].status).toBe('needs_reauth')
    golden('zalo-token-expired', 'admin', snap(res))
  })

  it('ZNS gửi qua máy chủ giả ZNS ⇒ 200 kèm hạn mức', async () => {
    const oa = uid('oa-d')
    await seedZaloConnection({ oaId: oa, adminId, accessExpiresInMinutes: 600 })
    const res = await api.post('/zalo-oa/zns', {
      token: authed.token,
      body: { phone: '0912345678', template_id: '123456', template_data: { ten: 'An' } },
      ip: freshIp(),
    })
    expect(res.status).toBe(200)
    const calls = await mock.calls()
    expect(calls.map((c) => `${c.service} ${c.path}`)).toEqual(['zalo-zns message/template'])
    expect(calls[0].body).toMatchObject({ phone: '84912345678', template_id: '123456' })
    golden('zalo-zns-ok', 'admin', snap(res))
  })
})
