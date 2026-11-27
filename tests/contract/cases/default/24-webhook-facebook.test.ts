import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q, seedContact, seedUser, setSetting } from '../../lib/db.js'
import { control } from '../../lib/http.js'
import { config } from '../../lib/config.js'
import { golden, snap } from '../../lib/golden.js'
import { loginAdmin } from '../../lib/session.js'
import { graphFail, mock, seedFacebookPage } from '../../lib/channels.js'
import { FB_PATH, fbBatch, fbComment, fbEcho, fbLeadgen, fbMessage, fbPost, fbReferral, fbSign, fbVerify, postRaw } from '../../lib/webhook-in.js'

/**
 * C15: webhook Facebook (`GET/POST /facebook/webhook`) với payload KÝ THẬT (`X-Hub-Signature-256` = HMAC-SHA256 thân thô, app secret của hồ sơ).
 * Mỗi loại sự kiện (tin nhắn, echo, referral, bình luận, leadgen) có ca gửi trùng; ca sai chữ ký, Page chưa nối/đã tắt, cờ gói tắt.
 * Lời gọi ra Graph đi vào máy chủ giả (C06b). Ca chuyển tiếp sang bản khác ở hồ sơ `fb-forward`.
 */
let adminId = 0
let seq = 0
// Mỗi ca có dải id riêng (Page, PSID, mid, comment, leadgen) để không giẫm nhau; PSID/leadgen toàn chữ số (Graph giả trả tên cho `GET <số>`).
const n = (): number => ++seq
const pageId = (): string => `7150${String(n()).padStart(5, '0')}`
const psid = (): string => `8150${String(n()).padStart(6, '0')}`
const mid = (): string => `m_c15_${n()}_${Date.now()}`
let saved: Record<string, string | null> = {}

beforeAll(async () => {
  const rows = await q<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key IN ('setup_status', 'org_features')`)
  saved = { setup_status: null, org_features: null, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) }
  // DB mới ở trạng thái "chưa dựng quy trình": cờ `facebook_page` tắt theo mặc định ⇒ dựng xong để webhook xử lý.
  await setSetting('setup_status', 'da_dung')
  await q(`DELETE FROM settings WHERE key = 'org_features'`)
  await control.flushCache()
  adminId = (await q<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [config.adminEmail]))[0].id
  await loginAdmin()
})
beforeEach(async () => {
  await mock.reset()
})
afterEach(async () => {
  expect(await mock.unexpected()).toEqual([])
  await q(`DELETE FROM facebook_comment_rules`)
  await q(`DELETE FROM settings WHERE key = 'org_features'`)
  await control.flushCache()
})
afterAll(async () => {
  const mine = `SELECT contact_id FROM facebook_conversations WHERE page_id LIKE '7150%' AND contact_id IS NOT NULL
    UNION SELECT contact_id FROM facebook_comments WHERE page_id LIKE '7150%' AND contact_id IS NOT NULL
    UNION SELECT contact_id FROM facebook_lead_receipts WHERE page_id LIKE '7150%' AND contact_id IS NOT NULL`
  const ids = (await q<{ contact_id: number }>(mine)).map((r) => r.contact_id)
  await q(`DELETE FROM activities WHERE contact_id = ANY($1)`, [ids])
  await q(`DELETE FROM facebook_messages WHERE conversation_id IN (SELECT id FROM facebook_conversations WHERE page_id LIKE '7150%')`)
  await q(`DELETE FROM facebook_conversations WHERE page_id LIKE '7150%'`)
  await q(`DELETE FROM facebook_comments WHERE page_id LIKE '7150%'`)
  await q(`DELETE FROM facebook_lead_receipts WHERE page_id LIKE '7150%'`)
  await q(`DELETE FROM facebook_chat_links WHERE page_id LIKE '7150%'`)
  await q(`DELETE FROM facebook_pages WHERE page_id LIKE '7150%'`)
  await q(`DELETE FROM contacts WHERE id = ANY($1) OR phone LIKE '09150%'`, [ids])
  await q(`DELETE FROM notification_logs WHERE event_type IN ('messenger.message_received', 'facebook.comment_received')`)
  await q(`DELETE FROM users WHERE email LIKE 'c15-fb-%@contract.test'`)
  for (const [key, value] of Object.entries(saved)) {
    if (value === null) await q(`DELETE FROM settings WHERE key = $1`, [key])
    else await setSetting(key, value)
  }
  await control.flushCache()
  await closeDb()
})

const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM ${sql}`, params))[0].c)
const conv = async (page: string, ps: string) => (await q<{ id: number; contact_id: number | null; customer_name: string | null; unread_count: number; entry_link_id: number | null }>(`SELECT id, contact_id, customer_name, unread_count, entry_link_id FROM facebook_conversations WHERE page_id = $1 AND psid = $2`, [page, ps]))[0]
const events = (type: string, resourceId: string | number): Promise<number> => count(`integration_events WHERE event_type = $1 AND resource_id = $2`, [type, String(resourceId)])
const OK = { status: 'ok' }

describe('xác minh webhook (GET)', () => {
  it('đúng mode + verify token ⇒ 200 trả nguyên challenge', async () => {
    const res = await fbVerify({ 'hub.mode': 'subscribe', 'hub.verify_token': config.facebookVerifyToken, 'hub.challenge': 'thu-thach-abc' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('thu-thach-abc')
    golden('fb-webhook-verify-ok', 'anon', snap(res))
  })

  it.each([
    ['sai verify token', { 'hub.mode': 'subscribe', 'hub.verify_token': 'sai-token', 'hub.challenge': 'abc' }],
    ['sai mode', { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'contract-fb-verify', 'hub.challenge': 'abc' }],
    ['thiếu challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': 'contract-fb-verify' }],
    ['thiếu verify token', { 'hub.mode': 'subscribe', 'hub.challenge': 'abc' }],
  ])('%s ⇒ 403', async (_name, query) => {
    const res = await fbVerify(query)
    expect(res.status).toBe(403)
  })
})

describe('chữ ký POST', () => {
  const raw = JSON.stringify(fbBatch({ id: '715099999', messaging: [] }))

  it('thiếu header chữ ký ⇒ 401', async () => {
    expect((await postRaw(FB_PATH, raw)).status).toBe(401)
  })

  it('chữ ký đúng định dạng nhưng sai bí mật ⇒ 401', async () => {
    const res = await postRaw(FB_PATH, raw, { 'x-hub-signature-256': fbSign(raw, 'bi-mat-khac-0123456789') })
    expect(res.status).toBe(401)
    golden('fb-webhook-bad-signature', 'anon', snap(res))
  })

  it('sai định dạng (không có tiền tố sha256=, không đủ 64 hex) ⇒ 401', async () => {
    for (const bad of ['abc', fbSign(raw).replace('sha256=', ''), `sha256=${'0'.repeat(63)}`, `sha256=${'g'.repeat(64)}`]) {
      expect((await postRaw(FB_PATH, raw, { 'x-hub-signature-256': bad })).status, bad).toBe(401)
    }
  })

  it('chữ ký của thân khác (ký lại JSON đã đổi byte) ⇒ 401', async () => {
    const res = await postRaw(FB_PATH, `${raw} `, { 'x-hub-signature-256': fbSign(raw) })
    expect(res.status).toBe(401)
  })

  it('chữ ký tính trên byte thô: hex VIẾT HOA vẫn được chấp nhận', async () => {
    const res = await postRaw(FB_PATH, raw, { 'x-hub-signature-256': `sha256=${fbSign(raw).slice(7).toUpperCase()}` })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
  })

  it('lô hợp lệ không có sự kiện, hoặc object khác `page` ⇒ 200 và không ghi gì', async () => {
    const before = await count('facebook_conversations')
    expect((await fbPost(fbBatch())).status).toBe(200)
    const other = await fbPost({ object: 'instagram', entry: [{ id: '715099998', messaging: [{ sender: { id: '1' }, message: { mid: 'x', text: 'x' } }] }] })
    expect(other.status).toBe(200)
    expect(await count('facebook_conversations')).toBe(before)
  })
})

describe('tin nhắn Messenger', () => {
  it('tin đầu của khách ⇒ hội thoại + tin + khách mới + lịch sử + sự kiện messenger.message_received', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const m = mid()
    const res = await fbPost(fbMessage(page, ps, m, { text: 'Cho mình hỏi giá' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    const c = await conv(page, ps)
    expect(c).toMatchObject({ customer_name: 'Khách Mock', unread_count: 1 })
    expect(c.contact_id).not.toBeNull()
    const msg = (await q<{ direction: string; text: string }>(`SELECT direction, text FROM facebook_messages WHERE mid = $1`, [m]))[0]
    expect(msg).toEqual({ direction: 'in', text: 'Cho mình hỏi giá' })
    expect((await q<{ full_name: string; phone: string }>(`SELECT full_name, phone FROM contacts WHERE id = $1`, [c.contact_id]))[0]).toEqual({ full_name: 'Khách Mock', phone: '' })
    expect(await count(`activities WHERE contact_id = $1 AND details->>'source' = 'facebook_messenger'`, [c.contact_id])).toBe(1)
    expect(await events('messenger.message_received', c.id)).toBe(1)
    // Tên khách lấy qua Graph bằng token Page.
    expect((await mock.calls()).map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${ps}`])
    golden('fb-webhook-message-new', 'anon', snap(res))
  })

  it('gửi trùng cùng `mid` (Meta gửi lại) ⇒ không thêm tin, sự kiện, lịch sử; không tăng chưa đọc', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const payload = fbMessage(page, ps, mid())
    expect((await fbPost(payload)).status).toBe(200)
    await mock.reset()
    expect((await fbPost(payload)).status).toBe(200)
    const c = await conv(page, ps)
    expect(c.unread_count).toBe(1)
    expect(await count(`facebook_messages WHERE conversation_id = $1`, [c.id])).toBe(1)
    expect(await count(`activities WHERE contact_id = $1`, [c.contact_id])).toBe(1)
    expect(await events('messenger.message_received', c.id)).toBe(1)
    expect(await mock.calls()).toEqual([]) // không hỏi lại Graph khi tin đã có
  })

  it('tin thứ hai của cùng người ⇒ cùng hội thoại và khách, chưa đọc tăng, không hỏi lại tên', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    await fbPost(fbMessage(page, ps, mid(), { text: 'một' }))
    await mock.reset()
    await fbPost(fbMessage(page, ps, mid(), { text: 'hai' }))
    const c = await conv(page, ps)
    expect(c.unread_count).toBe(2)
    expect(await count(`facebook_messages WHERE conversation_id = $1`, [c.id])).toBe(2)
    expect(await count(`facebook_conversations WHERE page_id = $1`, [page])).toBe(1)
    expect(await events('messenger.message_received', c.id)).toBe(2)
    expect(await mock.calls()).toEqual([])
  })

  it('echo của Page ⇒ tin ra, sự kiện message_sent, không tăng chưa đọc, không tạo khách', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const m = mid()
    expect((await fbPost(fbEcho(page, ps, m, 'Dạ em chào anh'))).status).toBe(200)
    const c = await conv(page, ps)
    expect(c).toMatchObject({ contact_id: null, unread_count: 0 })
    expect((await q<{ direction: string }>(`SELECT direction FROM facebook_messages WHERE mid = $1`, [m]))[0].direction).toBe('out')
    expect(await events('messenger.message_sent', c.id)).toBe(1)
    expect(await events('messenger.message_received', c.id)).toBe(0)
    // Gửi trùng echo ⇒ không thêm.
    await fbPost(fbEcho(page, ps, m, 'Dạ em chào anh'))
    expect(await count(`facebook_messages WHERE conversation_id = $1`, [c.id])).toBe(1)
    expect(await events('messenger.message_sent', c.id)).toBe(1)
  })

  it('tin có SĐT Việt Nam ⇒ khách mới mang SĐT đã chuẩn hoá', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    await fbPost(fbMessage(page, ps, mid(), { text: 'Gọi mình số 0915 012 345 nhé' }))
    const c = await conv(page, ps)
    expect((await q<{ phone: string }>(`SELECT phone FROM contacts WHERE id = $1`, [c.contact_id]))[0].phone).toBe('0915012345')
  })

  it('SĐT trùng khách có sẵn ⇒ ghép vào khách đó, không tạo thêm', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const existing = await seedContact({ phone: '0915000777', name: 'Khách cũ', ownerId: adminId })
    const before = await count('contacts WHERE phone = $1', ['0915000777'])
    await fbPost(fbMessage(page, ps, mid(), { text: 'SĐT của mình 0915000777' }))
    expect((await conv(page, ps)).contact_id).toBe(existing)
    expect(await count('contacts WHERE phone = $1', ['0915000777'])).toBe(before)
  })

  it('chỉ có tệp đính kèm ⇒ nội dung "[Tệp đính kèm]"', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const m = mid()
    await fbPost(fbMessage(page, ps, m, { attachments: [{ type: 'image', payload: { url: 'https://example.invalid/a.png' } }] }))
    expect((await q<{ text: string }>(`SELECT text FROM facebook_messages WHERE mid = $1`, [m]))[0].text).toBe('[Tệp đính kèm]')
  })

  it('sự kiện không phải tin nhắn (đã nhận/đã đọc, không có `mid`) ⇒ 200 và bỏ qua', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const res = await fbPost(fbBatch({ id: page, messaging: [{ sender: { id: ps }, recipient: { id: page }, timestamp: Date.now(), read: { watermark: Date.now() } }, { sender: { id: ps }, recipient: { id: page }, delivery: { mids: ['x'] } }] }))
    expect(res.status).toBe(200)
    expect(await count('facebook_conversations WHERE page_id = $1', [page])).toBe(0)
  })

  it('Page CHƯA nối với công ty nào ⇒ 200 nhưng không ghi gì (không rơi về công ty 1)', async () => {
    const page = pageId()
    const ps = psid()
    const res = await fbPost(fbMessage(page, ps, mid()))
    expect(res.status).toBe(200)
    expect(await count('facebook_conversations WHERE page_id = $1', [page])).toBe(0)
    expect(await count('facebook_messages WHERE mid LIKE $1', [`m_c15_%`])).toBeGreaterThanOrEqual(0)
    expect(await mock.calls()).toEqual([])
  })

  it('Page đã bị tắt (is_active = false) ⇒ 200 và không ghi', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    await q(`UPDATE facebook_pages SET is_active = false WHERE page_id = $1`, [page])
    expect((await fbPost(fbMessage(page, ps, mid()))).status).toBe(200)
    expect(await count('facebook_conversations WHERE page_id = $1', [page])).toBe(0)
  })

  it('cờ tính năng `facebook_page` tắt ⇒ vẫn 200 (Meta không tắt webhook) nhưng bỏ qua', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    await setSetting('org_features', JSON.stringify({ facebook_page: false }))
    await control.flushCache()
    const res = await fbPost(fbMessage(page, ps, mid()))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    expect(await count('facebook_conversations WHERE page_id = $1', [page])).toBe(0)
  })
})

describe('link/QR mở chat (referral)', () => {
  const link = async (page: string, code: string, active = true): Promise<number> =>
    (await q<{ id: number }>(
      `INSERT INTO facebook_chat_links (code, name, page_id, source_id, is_active, created_by, updated_at)
       VALUES ($1, $2, $3, (SELECT id FROM setting_options WHERE group_key = 'contact_source' ORDER BY id DESC LIMIT 1), $4, $5, now()) RETURNING id`,
      [code, `Link ${code}`, page, active, adminId],
    ))[0].id

  it('khách mở link ⇒ hội thoại gắn link, lượt chat +1, khách mới mang nguồn của link, ghi lịch sử', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const code = `c15r${n()}`
    const id = await link(page, code)
    expect((await fbPost(fbReferral(page, ps, code))).status).toBe(200)
    const c = await conv(page, ps)
    expect(c.entry_link_id).toBe(id)
    expect(c.contact_id).not.toBeNull()
    expect((await q<{ chats: number }>(`SELECT chats FROM facebook_chat_links WHERE id = $1`, [id]))[0].chats).toBe(1)
    expect(await count(`activities WHERE contact_id = $1 AND details->>'description' LIKE $2`, [c.contact_id, '%qua link%'])).toBe(1)
  })

  it('gửi trùng referral ⇒ chỉ tính một lần (hội thoại đã gắn link)', async () => {
    const page = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    const code = `c15r${n()}`
    const id = await link(page, code)
    const payload = fbReferral(page, ps, code)
    await fbPost(payload)
    await mock.reset()
    expect((await fbPost(payload)).status).toBe(200)
    expect((await q<{ chats: number }>(`SELECT chats FROM facebook_chat_links WHERE id = $1`, [id]))[0].chats).toBe(1)
    const c = await conv(page, ps)
    expect(await count(`activities WHERE contact_id = $1 AND details->>'description' LIKE $2`, [c.contact_id, '%qua link%'])).toBe(1)
  })

  it('mã không có / link đã tắt / link của Page khác ⇒ bỏ qua, không tạo hội thoại', async () => {
    const page = pageId()
    const other = pageId()
    const ps = psid()
    await seedFacebookPage({ pageId: page, adminId })
    await seedFacebookPage({ pageId: other, adminId })
    const off = `c15r${n()}`
    const foreign = `c15r${n()}`
    await link(page, off, false)
    await link(other, foreign)
    for (const code of ['khong-co-ma-nay', off, foreign]) expect((await fbPost(fbReferral(page, ps, code))).status).toBe(200)
    expect(await count('facebook_conversations WHERE page_id = $1', [page])).toBe(0)
  })
})

describe('bình luận (feed)', () => {
  const rule = async (page: string, o: { mode: 'test' | 'live'; keywords?: string[]; publicReplies?: string[]; privateReply?: string; hideIfPhone?: boolean; oncePerUser?: boolean }): Promise<number> =>
    (await q<{ id: number }>(
      `INSERT INTO facebook_comment_rules (name, page_id, keywords, public_replies, private_reply, hide_if_phone, once_per_user, mode, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [`Luật c15 ${n()}`, page, o.keywords ?? [], o.publicReplies ?? [], o.privateReply ?? null, o.hideIfPhone ?? false, o.oncePerUser ?? true, o.mode, adminId],
    ))[0].id
  const cm = (page: string, o: { comment?: string; from?: string; message?: string; post?: string; verb?: string; item?: string; name?: string } = {}): { payload: unknown; id: string; post: string; from: string } => {
    const post = o.post ?? `${page}_${n()}`
    const id = o.comment ?? `${post}_${n()}`
    const from = o.from ?? psid()
    return { id, post, from, payload: fbComment(page, { comment_id: id, post_id: post, from: { id: from, name: o.name ?? 'Người Bình Luận' }, message: o.message ?? 'Giá bao nhiêu vậy shop', ...(o.verb ? { verb: o.verb } : {}), ...(o.item ? { item: o.item } : {}) }) }
  }
  const row = async (id: string) => (await q<{ status: string; contact_id: number | null; rule_id: number | null; hidden: boolean; phone: string | null; actions: Record<string, { id?: string; message_id?: string; done?: boolean }> }>(`SELECT status, contact_id, rule_id, hidden, phone, actions FROM facebook_comments WHERE comment_id = $1`, [id]))[0]

  it('bình luận mới, không có luật ⇒ lưu (received), tạo khách, sự kiện facebook.comment_received, không gọi Graph', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const c = cm(page)
    const res = await fbPost(c.payload)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    const r = await row(c.id)
    expect(r).toMatchObject({ status: 'received', rule_id: null, hidden: false })
    expect(r.contact_id).not.toBeNull()
    expect(await count(`integration_events WHERE event_type = 'facebook.comment_received' AND payload->>'post_id' = $1`, [c.post])).toBe(1)
    expect(await mock.calls()).toEqual([])
    golden('fb-webhook-comment-new', 'anon', snap(res))
  })

  it('gửi trùng `comment_id` ⇒ không thêm bình luận, khách, sự kiện', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const c = cm(page)
    await fbPost(c.payload)
    const contacts = await count('contacts')
    expect((await fbPost(c.payload)).status).toBe(200)
    expect(await count(`facebook_comments WHERE comment_id = $1`, [c.id])).toBe(1)
    expect(await count('contacts')).toBe(contacts)
    expect(await count(`integration_events WHERE event_type = 'facebook.comment_received' AND payload->>'post_id' = $1`, [c.post])).toBe(1)
  })

  it('bình luận của chính Page, thay đổi không phải `add`, hoặc không phải comment ⇒ bỏ qua', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    for (const c of [cm(page, { from: page }), cm(page, { verb: 'edited' }), cm(page, { verb: 'remove' }), cm(page, { item: 'reaction' })]) {
      expect((await fbPost(c.payload)).status).toBe(200)
      expect(await count(`facebook_comments WHERE comment_id = $1`, [c.id])).toBe(0)
    }
  })

  it('luật chế độ thử khớp từ khoá ⇒ ghi status "test", KHÔNG gửi gì lên Facebook', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const id = await rule(page, { mode: 'test', keywords: ['giá'], publicReplies: ['Chào {ten}'], privateReply: 'Báo giá riêng' })
    const c = cm(page, { message: 'Cho hỏi GIÁ nhé' })
    await fbPost(c.payload)
    expect(await row(c.id)).toMatchObject({ status: 'test', rule_id: id })
    expect(await mock.calls()).toEqual([])
  })

  it('luật chạy thật ⇒ trả lời công khai + nhắn riêng, ghi id trả lời và tạo hội thoại Messenger với người bình luận', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    await rule(page, { mode: 'live', keywords: ['giá'], publicReplies: ['Chào {ten}, em báo giá ngay'], privateReply: 'Em nhắn riêng ạ' })
    const c = cm(page, { name: 'An' })
    await mock.rules({ match: `POST ${page}/messages`, status: 200, json: { message_id: 'm_private_1', recipient_id: c.from } })
    expect((await fbPost(c.payload)).status).toBe(200)
    const r = await row(c.id)
    expect(r.status).toBe('done')
    expect(r.actions.public_reply?.id).toMatch(/^c_/)
    expect(r.actions.private_reply?.message_id).toBe('m_private_1')
    const calls = (await mock.calls()).map((x) => `${x.method} ${x.path}`)
    expect(calls).toEqual([`POST ${c.id}/comments`, `POST ${page}/messages`])
    expect((await mock.calls())[0].body).toEqual({ message: 'Chào An, em báo giá ngay' })
    const cv = await conv(page, c.from)
    expect(cv.contact_id).toBe(r.contact_id)
    expect(await count('facebook_messages WHERE mid = $1', ['m_private_1'])).toBe(1)
  })

  it('bình luận gửi trùng khi luật chạy thật ⇒ KHÔNG trả lời lần hai', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    await rule(page, { mode: 'live', keywords: ['giá'], publicReplies: ['Chào bạn'] })
    const c = cm(page)
    await fbPost(c.payload)
    await mock.reset()
    expect((await fbPost(c.payload)).status).toBe(200)
    expect(await mock.calls()).toEqual([])
    expect(await count('facebook_comments WHERE comment_id = $1', [c.id])).toBe(1)
  })

  it('luật "mỗi người một lần mỗi bài": bình luận thứ hai cùng người, cùng bài ⇒ status "skipped", không gửi', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    await rule(page, { mode: 'live', keywords: ['giá'], publicReplies: ['Chào bạn'] })
    const post = `${page}_${n()}`
    const from = psid()
    const first = cm(page, { post, from })
    const second = cm(page, { post, from })
    await fbPost(first.payload)
    expect((await row(first.id)).status).toBe('done')
    await mock.reset()
    await fbPost(second.payload)
    expect((await row(second.id)).status).toBe('skipped')
    expect(await mock.calls()).toEqual([])
  })

  it('có SĐT trong bình luận + luật ẩn ⇒ ẩn bình luận qua Graph, lưu SĐT vào bình luận và khách', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    await rule(page, { mode: 'live', hideIfPhone: true })
    const c = cm(page, { message: 'Gọi mình 0915 000 888 nhé' })
    await mock.rules({ match: `POST ${c.id}`, status: 200, json: { success: true } })
    await fbPost(c.payload)
    const r = await row(c.id)
    expect(r).toMatchObject({ status: 'done', hidden: true, phone: '0915000888' })
    expect((await mock.calls()).map((x) => `${x.method} ${x.path}`)).toEqual([`POST ${c.id}`])
    expect((await q<{ phone: string }>(`SELECT phone FROM contacts WHERE id = $1`, [r.contact_id]))[0].phone).toBe('0915000888')
    // Gửi trùng ⇒ không ẩn lần hai.
    await mock.reset()
    await fbPost(c.payload)
    expect(await mock.calls()).toEqual([])
  })
})

describe('Lead Ads (leadgen)', () => {
  let lead = 6_000_000_000
  const leadId = (): string => String(++lead + Date.now() * 1000)
  const leadJson = (id: string, fields: Array<{ name: string; values: string[] }>): unknown => ({ id, created_time: '2026-11-27T00:00:00+0000', form_id: '9001', field_data: fields })
  // Mỗi ca một SĐT riêng (khách tìm theo SĐT toàn công ty, dùng chung sẽ ghép nhầm vào khách của ca khác).
  const uniquePhone = (): string => `09150${String(n()).padStart(5, '0')}`
  const fields = (phone: string): Array<{ name: string; values: string[] }> => [
    { name: 'full_name', values: ['Nguyễn Lead Một'] },
    { name: 'phone_number', values: [`+84 ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}`] },
    { name: 'email', values: [`lead.${phone}@example.com`] },
    { name: 'thanh_pho', values: ['Hà Nội'] },
  ]
  const receipt = async (id: string) => (await q<{ result: string; contact_id: number | null }>(`SELECT result, contact_id FROM facebook_lead_receipts WHERE leadgen_id = $1`, [id]))[0]

  it('lead mới ⇒ lấy chi tiết qua Graph, tạo khách (SĐT chuẩn hoá, giao cho người nhận của Page), ghi lịch sử và biên nhận', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const id = leadId()
    const phone = uniquePhone()
    await mock.rules({ match: `GET ${id}`, status: 200, json: leadJson(id, fields(phone)) })
    const res = await fbPost(fbLeadgen(page, id))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    const r = await receipt(id)
    expect(r.result).toBe('created')
    const c = (await q<{ full_name: string; phone: string; email: string; assigned_to: number }>(`SELECT full_name, phone, email, assigned_to FROM contacts WHERE id = $1`, [r.contact_id]))[0]
    expect(c).toEqual({ full_name: 'Nguyễn Lead Một', phone, email: `lead.${phone}@example.com`, assigned_to: adminId })
    expect((await q<{ d: string }>(`SELECT details->>'description' AS d FROM activities WHERE contact_id = $1`, [r.contact_id]))[0].d).toContain('Tạo từ form Lead Ads')
    expect(await events('contact.created', r.contact_id as number)).toBe(1)
    const calls = await mock.calls()
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${id}`])
    expect(calls[0].auth.bearer).toBe(true)
    golden('fb-webhook-leadgen-created', 'anon', snap(res))
  })

  it('gửi trùng `leadgen_id` ⇒ không gọi Graph, không tạo khách hay biên nhận thứ hai', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const id = leadId()
    await mock.rules({ match: `GET ${id}`, status: 200, json: leadJson(id, fields(uniquePhone())) })
    await fbPost(fbLeadgen(page, id))
    const contacts = await count('contacts')
    await mock.reset()
    expect((await fbPost(fbLeadgen(page, id))).status).toBe(200)
    expect(await mock.calls()).toEqual([])
    expect(await count('facebook_lead_receipts WHERE leadgen_id = $1', [id])).toBe(1)
    expect(await count('contacts')).toBe(contacts)
  })

  it('lead khác nhưng cùng SĐT ⇒ "duplicate": ghép vào khách cũ, không tạo thêm, ghi lịch sử gửi lại', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const a = leadId()
    const b = leadId()
    const phone = uniquePhone()
    await mock.rules({ match: `GET ${a}`, status: 200, json: leadJson(a, fields(phone)) }, { match: `GET ${b}`, status: 200, json: leadJson(b, [{ name: 'full_name', values: ['Tên khác'] }, { name: 'phone_number', values: [phone] }]) })
    await fbPost(fbLeadgen(page, a))
    const contacts = await count('contacts')
    expect((await fbPost(fbLeadgen(page, b))).status).toBe(200)
    const [ra, rb] = [await receipt(a), await receipt(b)]
    expect(rb).toEqual({ result: 'duplicate', contact_id: ra.contact_id })
    expect(await count('contacts')).toBe(contacts)
    expect(await count(`activities WHERE contact_id = $1 AND details->>'description' LIKE $2`, [ra.contact_id, '%gửi lại form%'])).toBe(1)
  })

  it('chỉ có email trùng khách có sẵn (không phân biệt hoa thường) ⇒ ghép khách đó', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const existing = await seedContact({ phone: uniquePhone(), name: 'Khách có email', ownerId: adminId })
    await q(`UPDATE contacts SET email = 'c15.email@example.com' WHERE id = $1`, [existing])
    const id = leadId()
    await mock.rules({ match: `GET ${id}`, status: 200, json: leadJson(id, [{ name: 'email', values: ['C15.Email@Example.com'] }]) })
    await fbPost(fbLeadgen(page, id))
    expect(await receipt(id)).toEqual({ result: 'duplicate', contact_id: existing })
  })

  it('không có SĐT lẫn email ⇒ biên nhận "no_contact_info", không tạo khách; gửi lại cũng không gọi Graph', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const id = leadId()
    await mock.rules({ match: `GET ${id}`, status: 200, json: leadJson(id, [{ name: 'thanh_pho', values: ['Huế'] }]) })
    expect((await fbPost(fbLeadgen(page, id))).status).toBe(200)
    expect(await receipt(id)).toEqual({ result: 'no_contact_info', contact_id: null })
    await mock.reset()
    await fbPost(fbLeadgen(page, id))
    expect(await mock.calls()).toEqual([])
  })

  it('người nhận khách của Page không còn hoạt động ⇒ "owner_inactive", không tạo khách', async () => {
    const page = pageId()
    const owner = await seedUser({ label: 'c15-fb-nghi', grants: {} })
    await q(`UPDATE users SET status = 'locked' WHERE id = $1`, [owner.id])
    await seedFacebookPage({ pageId: page, adminId: owner.id })
    const id = leadId()
    await mock.rules({ match: `GET ${id}`, status: 200, json: leadJson(id, fields(uniquePhone())) })
    expect((await fbPost(fbLeadgen(page, id))).status).toBe(200)
    expect(await receipt(id)).toEqual({ result: 'owner_inactive', contact_id: null })
  })

  it('Graph lỗi tạm (HTTP 500) hoặc giới hạn tần suất ⇒ webhook trả 5xx để Meta gửi lại; gửi lại khi Graph ổn thì tạo được', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const id = leadId()
    await mock.rules({ match: `GET ${id}`, status: 500, json: { error: { message: 'lỗi tạm', code: 2 } }, times: 1 })
    const r5 = await fbPost(fbLeadgen(page, id))
    expect(r5.status).toBeGreaterThanOrEqual(500)
    expect(await count('facebook_lead_receipts WHERE leadgen_id = $1', [id])).toBe(0)
    await mock.rules(graphFail(`GET ${id}`, 4, undefined, 400, 1))
    expect((await fbPost(fbLeadgen(page, id))).status).toBeGreaterThanOrEqual(500)
    await mock.rules({ match: `GET ${id}`, status: 200, json: leadJson(id, fields(uniquePhone())) })
    expect((await fbPost(fbLeadgen(page, id))).status).toBe(200)
    expect((await receipt(id)).result).toBe('created')
  })

  it('Graph lỗi vĩnh viễn (HTTP 400 mã 100) ⇒ bỏ qua với 200 và không biên nhận; token hết hạn (190) ⇒ đánh dấu Page invalid', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const a = leadId()
    const b = leadId()
    await mock.rules(graphFail(`GET ${a}`, 100, undefined, 400), graphFail(`GET ${b}`, 190, undefined, 401))
    expect((await fbPost(fbLeadgen(page, a))).status).toBe(200)
    expect((await fbPost(fbLeadgen(page, b))).status).toBe(200)
    expect(await count('facebook_lead_receipts WHERE leadgen_id = ANY($1)', [[a, b]])).toBe(0)
    expect((await q<{ token_status: string }>(`SELECT token_status FROM facebook_pages WHERE page_id = $1`, [page]))[0].token_status).toBe('invalid')
  })
})
