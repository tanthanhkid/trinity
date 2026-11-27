import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q, setSetting } from '../../lib/db.js'
import { control } from '../../lib/http.js'
import { config } from '../../lib/config.js'
import { golden, snap } from '../../lib/golden.js'
import { loginAdmin } from '../../lib/session.js'
import { mock, seedZaloConnection } from '../../lib/channels.js'
import { ZALO_PATH, postRaw, zaloPost, zaloSign } from '../../lib/webhook-in.js'

/**
 * C15: webhook Zalo OA (`POST /zalo-oa/webhook`) với payload KÝ THẬT (`X-ZEvent-Signature` = `mac=` + sha256(app_id + thân thô + timestamp + khoá OA)).
 * Tin khách, tin OA, theo dõi, loại chưa hỗ trợ, gửi trùng `msg_id`, sai chữ ký, OA chưa nối, cờ gói tắt, lỗi lấy hồ sơ.
 */
let adminId = 0
let seq = 0
const oaId = (): string => `7152${String(++seq).padStart(6, '0')}`
const zuid = (): string => `zu15${String(++seq).padStart(6, '0')}`
let saved: Record<string, string | null> = {}

const PROFILE = (phone?: string) => ({ error: 0, message: 'Success', data: { display_name: 'Khách Zalo Mock', avatar: 'https://example.invalid/a.png', ...(phone ? { shared_info: { phone } } : {}) } })
const profileRule = (phone?: string) => ({ match: 'GET v3.0/oa/user/detail', status: 200, json: PROFILE(phone) })

beforeAll(async () => {
  const rows = await q<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key IN ('setup_status', 'org_features')`)
  saved = { setup_status: null, org_features: null, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) }
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
  await q(`DELETE FROM settings WHERE key = 'org_features'`)
  await control.flushCache()
})
afterAll(async () => {
  const ids = (await q<{ contact_id: number }>(`SELECT contact_id FROM zalo_oa_threads WHERE oa_id LIKE '7152%' AND contact_id IS NOT NULL`)).map((r) => r.contact_id)
  await q(`DELETE FROM activities WHERE contact_id = ANY($1)`, [ids])
  await q(`DELETE FROM zalo_oa_messages WHERE thread_id IN (SELECT id FROM zalo_oa_threads WHERE oa_id LIKE '7152%')`)
  await q(`DELETE FROM zalo_oa_threads WHERE oa_id LIKE '7152%'`)
  await q(`DELETE FROM contacts WHERE id = ANY($1) OR phone LIKE '09153%'`, [ids])
  await q(`DELETE FROM zalo_oa_connections WHERE oa_id LIKE '7152%'`)
  await q(`DELETE FROM notification_logs WHERE event_type = 'zalo_oa.message_received'`)
  for (const [key, value] of Object.entries(saved)) {
    if (value === null) await q(`DELETE FROM settings WHERE key = $1`, [key])
    else await setSetting(key, value)
  }
  await control.flushCache()
  await closeDb()
})

const connect = async (): Promise<string> => {
  const oa = oaId()
  await seedZaloConnection({ oaId: oa, adminId, accessExpiresInMinutes: 600 })
  return oa
}
let ts = Date.now()
const send = (oa: string, user: string, msgId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  app_id: config.zaloAppId,
  event_name: 'user_send_text',
  timestamp: String(++ts),
  sender: { id: user },
  recipient: { id: oa },
  message: { msg_id: msgId, text: 'Xin chào OA' },
  ...over,
})
const thread = async (oa: string, user: string) => (await q<{ id: number; contact_id: number | null; display_name: string | null; unread_count: number; last_message_preview: string | null }>(`SELECT id, contact_id, display_name, unread_count, last_message_preview FROM zalo_oa_threads WHERE oa_id = $1 AND zalo_user_id = $2`, [oa, user]))[0]
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM ${sql}`, params))[0].c)
const events = (type: string, threadId: number): Promise<number> => count(`integration_events WHERE event_type = $1 AND resource_id = $2`, [type, String(threadId)])
const OK = { ok: true }

describe('chữ ký', () => {
  const body = send('7152000000', 'zu15000000', 'sig-1')
  const raw = JSON.stringify(body)
  const ok = (): string => zaloSign(raw, String(body.timestamp))

  it('thiếu header ⇒ 401', async () => {
    expect((await postRaw(ZALO_PATH, raw)).status).toBe(401)
  })

  it('mac sai (đủ 64 hex, sai khoá) ⇒ 401', async () => {
    const res = await postRaw(ZALO_PATH, raw, { 'x-zevent-signature': zaloSign(raw, String(body.timestamp), { secret: 'khoa-khac' }) })
    expect(res.status).toBe(401)
    golden('zalo-webhook-bad-signature', 'anon', snap(res))
  })

  it('mac không phải 64 hex / thiếu ⇒ 401', async () => {
    for (const bad of ['mac=abc', 'mac=', 'zzz', `mac=${'g'.repeat(64)}`, 'x'.repeat(250)]) {
      expect((await postRaw(ZALO_PATH, raw, { 'x-zevent-signature': bad })).status, bad).toBe(401)
    }
  })

  it('mac tính với timestamp khác timestamp trong thân ⇒ 401', async () => {
    expect((await postRaw(ZALO_PATH, raw, { 'x-zevent-signature': zaloSign(raw, '1') })).status).toBe(401)
  })

  it('app_id trong thân khác app_id của hồ sơ, hoặc thân không có timestamp ⇒ 401; thân không phải JSON ⇒ 400 (bộ đọc thân từ chối trước khi tới kiểm chữ ký)', async () => {
    const other = JSON.stringify({ ...body, app_id: 'app-khac' })
    expect((await postRaw(ZALO_PATH, other, { 'x-zevent-signature': zaloSign(other, String(body.timestamp), { appId: 'app-khac' }) })).status).toBe(401)
    const noTs = JSON.stringify({ app_id: config.zaloAppId, event_name: 'user_send_text' })
    expect((await postRaw(ZALO_PATH, noTs, { 'x-zevent-signature': zaloSign(noTs, '') })).status).toBe(401)
    expect((await postRaw(ZALO_PATH, 'không phải json', { 'x-zevent-signature': ok() })).status).toBe(400)
  })

  it('mac không tiền tố `mac=` và hex viết hoa vẫn được chấp nhận (sự kiện không hỗ trợ ⇒ 200 { ok: true })', async () => {
    const ev = { app_id: config.zaloAppId, event_name: 'user_seen_message', timestamp: String(++ts) }
    const r = JSON.stringify(ev)
    const res = await postRaw(ZALO_PATH, r, { 'x-zevent-signature': zaloSign(r, String(ev.timestamp)).slice(4).toUpperCase() })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
  })
})

describe('tin nhắn', () => {
  it('tin đầu của khách ⇒ hội thoại + tin vào + lấy hồ sơ + khách mới theo SĐT + sự kiện zalo_oa.message_received', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule('84915300111'))
    const res = await zaloPost(send(oa, user, 'zm-1'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    const t = await thread(oa, user)
    expect(t).toMatchObject({ display_name: 'Khách Zalo Mock', unread_count: 1, last_message_preview: 'Xin chào OA' })
    expect(t.contact_id).not.toBeNull()
    expect((await q<{ phone: string; zalo_account: string; assigned_to: number }>(`SELECT phone, zalo_account, assigned_to FROM contacts WHERE id = $1`, [t.contact_id]))[0]).toEqual({ phone: '0915300111', zalo_account: user, assigned_to: adminId })
    expect((await q<{ direction: string; kind: string; status: string }>(`SELECT direction, kind, status FROM zalo_oa_messages WHERE thread_id = $1`, [t.id]))[0]).toEqual({ direction: 'in', kind: 'text', status: 'received' })
    expect(await events('zalo_oa.message_received', t.id)).toBe(1)
    expect((await mock.calls()).map((c) => `${c.service} ${c.method} ${c.path}`)).toEqual(['zalo-api GET v3.0/oa/user/detail'])
    golden('zalo-webhook-message-new', 'anon', snap(res))
  })

  it('gửi trùng `msg_id` ⇒ không thêm tin, sự kiện, không tăng chưa đọc, không hỏi lại hồ sơ', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule())
    const ev = send(oa, user, 'zm-dup')
    await zaloPost(ev)
    await mock.reset()
    expect((await zaloPost({ ...ev, timestamp: String(++ts) })).status).toBe(200)
    const t = await thread(oa, user)
    expect(t.unread_count).toBe(1)
    expect(await count('zalo_oa_messages WHERE thread_id = $1', [t.id])).toBe(1)
    expect(await events('zalo_oa.message_received', t.id)).toBe(1)
    expect(await mock.calls()).toEqual([])
  })

  it('tin thứ hai (msg_id mới) cùng hội thoại ⇒ chưa đọc tăng, KHÔNG lấy hồ sơ lần nữa', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule())
    await zaloPost(send(oa, user, 'zm-a'))
    await mock.reset()
    await zaloPost(send(oa, user, 'zm-b', { message: { msg_id: 'zm-b', text: 'tin hai' } }))
    const t = await thread(oa, user)
    expect(t).toMatchObject({ unread_count: 2, last_message_preview: 'tin hai' })
    expect(await events('zalo_oa.message_received', t.id)).toBe(2)
    expect(await mock.calls()).toEqual([])
  })

  it('tin do OA gửi từ app Zalo (oa_send_text) ⇒ tin ra, sự kiện zalo_oa.message_sent, hội thoại theo người nhận', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule())
    const res = await zaloPost(send(oa, user, 'zo-1', { event_name: 'oa_send_text', sender: { id: oa }, recipient: { id: user }, message: { msg_id: 'zo-1', text: 'OA trả lời' } }))
    expect(res.status).toBe(200)
    const t = await thread(oa, user)
    expect((await q<{ direction: string; status: string }>(`SELECT direction, status FROM zalo_oa_messages WHERE thread_id = $1`, [t.id]))[0]).toEqual({ direction: 'out', status: 'sent' })
    expect(await events('zalo_oa.message_sent', t.id)).toBe(1)
    expect(await events('zalo_oa.message_received', t.id)).toBe(0)
    expect(t.unread_count).toBe(0)
    // Gửi trùng ⇒ không thêm.
    await zaloPost(send(oa, user, 'zo-1', { event_name: 'oa_send_text', sender: { id: oa }, recipient: { id: user }, message: { msg_id: 'zo-1', text: 'OA trả lời' } }))
    expect(await events('zalo_oa.message_sent', t.id)).toBe(1)
  })

  it('chỉ có tệp đính kèm (user_send_image) ⇒ kind "attachment", lưu attachments', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule())
    await zaloPost(send(oa, user, 'zm-img', { event_name: 'user_send_image', message: { msg_id: 'zm-img', attachments: [{ type: 'image', payload: { url: 'https://example.invalid/i.png' } }] } }))
    const t = await thread(oa, user)
    const m = (await q<{ kind: string; text: string | null; payload: { attachments: unknown[] } }>(`SELECT kind, text, payload FROM zalo_oa_messages WHERE thread_id = $1`, [t.id]))[0]
    expect(m.kind).toBe('attachment')
    expect(m.text).toBeNull()
    expect(m.payload.attachments).toHaveLength(1)
    expect(t.last_message_preview).toBe('[Tệp đính kèm]')
  })
})

describe('theo dõi và sự kiện khác', () => {
  it('follow ⇒ tạo hội thoại + lấy hồ sơ, chưa có tin; gửi trùng không đổi gì', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule('84915300222'))
    const ev = { app_id: config.zaloAppId, event_name: 'follow', timestamp: String(++ts), oa: { id: oa }, follower: { id: user } }
    expect((await zaloPost(ev)).status).toBe(200)
    const t = await thread(oa, user)
    expect(t.display_name).toBe('Khách Zalo Mock')
    expect(t.contact_id).not.toBeNull()
    expect(await count('zalo_oa_messages WHERE thread_id = $1', [t.id])).toBe(0)
    const contacts = await count('contacts WHERE zalo_account = $1', [user])
    await zaloPost({ ...ev, timestamp: String(++ts) })
    expect(await count('zalo_oa_threads WHERE oa_id = $1', [oa])).toBe(1)
    expect(await count('contacts WHERE zalo_account = $1', [user])).toBe(contacts)
  })

  it('loại sự kiện chưa hỗ trợ (user_seen_message, unfollow…) ⇒ 200 { ok: true }, không ghi gì', async () => {
    const oa = await connect()
    const before = await count('zalo_oa_threads')
    for (const name of ['user_seen_message', 'unfollow', 'user_reacted_message']) {
      const res = await zaloPost({ app_id: config.zaloAppId, event_name: name, timestamp: String(++ts), sender: { id: zuid() }, recipient: { id: oa } })
      expect(res.status).toBe(200)
      expect(res.body).toEqual(OK)
    }
    expect(await count('zalo_oa_threads')).toBe(before)
  })

  it('OA CHƯA nối với công ty nào ⇒ 200 nhưng không ghi (không rơi về công ty 1)', async () => {
    const oa = oaId()
    const user = zuid()
    const res = await zaloPost(send(oa, user, 'zm-unknown'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    expect(await count('zalo_oa_threads WHERE oa_id = $1', [oa])).toBe(0)
    expect(await mock.calls()).toEqual([])
  })

  it('cờ tính năng `zalo_oa` tắt ⇒ vẫn 200 (Zalo không gửi lại) nhưng bỏ qua', async () => {
    const oa = await connect()
    const user = zuid()
    await setSetting('org_features', JSON.stringify({ zalo_oa: false }))
    await control.flushCache()
    const res = await zaloPost(send(oa, user, 'zm-off'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OK)
    expect(await count('zalo_oa_threads WHERE oa_id = $1', [oa])).toBe(0)
  })
})

describe('lấy hồ sơ khách', () => {
  it('Zalo lỗi khi lấy hồ sơ (HTTP 500) ⇒ tin VẪN được lưu, hội thoại chưa có khách', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules({ match: 'GET v3.0/oa/user/detail', status: 500, json: { error: -500, message: 'lỗi tạm' } })
    expect((await zaloPost(send(oa, user, 'zm-500'))).status).toBe(200)
    const t = await thread(oa, user)
    expect(t).toMatchObject({ contact_id: null, display_name: null })
    expect(await count('zalo_oa_messages WHERE thread_id = $1', [t.id])).toBe(1)
  })

  it('hồ sơ không có SĐT ⇒ cập nhật tên nhưng KHÔNG tạo khách (Contact.phone bắt buộc)', async () => {
    const oa = await connect()
    const user = zuid()
    await mock.rules(profileRule())
    await zaloPost(send(oa, user, 'zm-nophone'))
    const t = await thread(oa, user)
    expect(t).toMatchObject({ contact_id: null, display_name: 'Khách Zalo Mock' })
    expect(await count('contacts WHERE zalo_account = $1', [user])).toBe(0)
  })

  it('SĐT hồ sơ trùng khách có sẵn (dạng +84/84/0) ⇒ ghép khách đó, không tạo thêm', async () => {
    const oa = await connect()
    const user = zuid()
    const [c] = await q<{ id: number }>(`INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, updated_at) VALUES ('0915300333', 'Khách Zalo cũ', $1, $1, now()) RETURNING id`, [adminId])
    await mock.rules(profileRule('84915300333'))
    await zaloPost(send(oa, user, 'zm-link'))
    expect((await thread(oa, user)).contact_id).toBe(c.id)
    expect(await count(`contacts WHERE phone IN ('0915300333', '+84915300333', '84915300333')`)).toBe(1)
  })
})
