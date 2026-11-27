import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q, setSetting } from '../../lib/db.js'
import { control } from '../../lib/http.js'
import { config } from '../../lib/config.js'
import { loginAdmin } from '../../lib/session.js'
import { mock, seedFacebookPage, type Call } from '../../lib/channels.js'
import { FB_PATH, fbBatch, fbMessage, fbSign, postRaw } from '../../lib/webhook-in.js'

/**
 * C15, hồ sơ `fb-forward` (`FACEBOOK_WEBHOOK_FORWARD_URL` trỏ máy chủ giả): lô có Page KHÔNG nối vào bản này được chuyển NGUYÊN
 * VĂN (thân thô + chữ ký gốc) sang bản kia, kèm header chống vòng lặp; Page đã nối thì không chuyển; lô đã chuyển một lần thì không chuyển tiếp.
 */
let adminId = 0
let seq = 0
const pageId = (): string => `7151${String(++seq).padStart(5, '0')}`
const psid = (): string => `8151${String(++seq).padStart(6, '0')}`
let savedStatus: string | null = null

beforeAll(async () => {
  savedStatus = (await q<{ value: string }>(`SELECT value FROM settings WHERE key = 'setup_status'`))[0]?.value ?? null
  await setSetting('setup_status', 'da_dung')
  await control.flushCache()
  adminId = (await q<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [config.adminEmail]))[0].id
  await loginAdmin()
})
beforeEach(async () => {
  await mock.reset()
})
afterEach(async () => {
  expect(await mock.unexpected()).toEqual([])
})
afterAll(async () => {
  await q(`DELETE FROM activities WHERE contact_id IN (SELECT contact_id FROM facebook_conversations WHERE page_id LIKE '7151%')`)
  await q(`DELETE FROM facebook_messages WHERE conversation_id IN (SELECT id FROM facebook_conversations WHERE page_id LIKE '7151%')`)
  const ids = (await q<{ contact_id: number }>(`SELECT contact_id FROM facebook_conversations WHERE page_id LIKE '7151%' AND contact_id IS NOT NULL`)).map((r) => r.contact_id)
  await q(`DELETE FROM facebook_conversations WHERE page_id LIKE '7151%'`)
  await q(`DELETE FROM contacts WHERE id = ANY($1)`, [ids])
  await q(`DELETE FROM facebook_pages WHERE page_id LIKE '7151%'`)
  if (savedStatus === null) await q(`DELETE FROM settings WHERE key = 'setup_status'`)
  else await setSetting('setup_status', savedStatus)
  await control.flushCache()
  await closeDb()
})

/** Chuyển tiếp chạy nền (không chờ) ⇒ đợi tối đa vài giây tới khi máy chủ giả nhận. */
async function forwarded(wait = 4000): Promise<Call[]> {
  const until = Date.now() + wait
  for (;;) {
    const calls = (await mock.calls()).filter((c) => c.service === 'forward')
    if (calls.length > 0 || Date.now() > until) return calls
    await new Promise((r) => setTimeout(r, 100))
  }
}
const quiet = async (): Promise<Call[]> => {
  await new Promise((r) => setTimeout(r, 700))
  return (await mock.calls()).filter((c) => c.service === 'forward')
}
const signed = (payload: unknown): { raw: string; headers: Record<string, string> } => {
  const raw = JSON.stringify(payload)
  return { raw, headers: { 'x-hub-signature-256': fbSign(raw) } }
}
const stored = async (page: string): Promise<number> => Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM facebook_conversations WHERE page_id = $1`, [page]))[0].c)

describe('chuyển tiếp webhook Facebook sang bản khác', () => {
  it('Page chưa nối ⇒ chuyển nguyên văn thân + chữ ký gốc + header chống vòng lặp; bản này không ghi gì', async () => {
    const page = pageId()
    const { raw, headers } = signed(fbMessage(page, psid(), `m_fwd_${seq}`))
    const res = await postRaw(FB_PATH, raw, headers)
    expect(res.status).toBe(200)
    const calls = await forwarded()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'webhook' })
    expect(calls[0].forward).toEqual({ signature: headers['x-hub-signature-256'], forwarded: '1', raw })
    expect(await stored(page)).toBe(0)
  })

  it('Page đã nối ⇒ xử lý tại chỗ, KHÔNG chuyển tiếp', async () => {
    const page = pageId()
    await seedFacebookPage({ pageId: page, adminId })
    const { raw, headers } = signed(fbMessage(page, psid(), `m_fwd_${seq}`))
    expect((await postRaw(FB_PATH, raw, headers)).status).toBe(200)
    expect(await stored(page)).toBe(1)
    expect(await quiet()).toEqual([])
  })

  it('lô trộn Page đã nối và chưa nối ⇒ xử lý phần của mình VÀ chuyển cả lô một lần', async () => {
    const mine = pageId()
    const foreign = pageId()
    await seedFacebookPage({ pageId: mine, adminId })
    const ps = psid()
    const { raw, headers } = signed(
      fbBatch(
        { id: mine, messaging: [{ sender: { id: ps }, recipient: { id: mine }, timestamp: Date.now(), message: { mid: `m_mix_${seq}`, text: 'cho Page của mình' } }] },
        { id: foreign, messaging: [{ sender: { id: psid() }, recipient: { id: foreign }, timestamp: Date.now(), message: { mid: `m_mix2_${seq}`, text: 'cho Page bên kia' } }] },
      ),
    )
    expect((await postRaw(FB_PATH, raw, headers)).status).toBe(200)
    const calls = await forwarded()
    expect(calls).toHaveLength(1)
    expect(calls[0].forward).toEqual({ signature: headers['x-hub-signature-256'], forwarded: '1', raw })
    expect(await stored(mine)).toBe(1)
    expect(await stored(foreign)).toBe(0)
  })

  it('lô đã mang header chuyển tiếp ⇒ không chuyển tiếp lần nữa (chống vòng lặp)', async () => {
    const page = pageId()
    const { raw, headers } = signed(fbMessage(page, psid(), `m_loop_${seq}`))
    expect((await postRaw(FB_PATH, raw, { ...headers, 'x-trinity-forwarded': '1' })).status).toBe(200)
    expect(await quiet()).toEqual([])
  })

  it('chữ ký sai ⇒ 401 và KHÔNG chuyển tiếp', async () => {
    const page = pageId()
    const raw = JSON.stringify(fbMessage(page, psid(), `m_bad_${seq}`))
    expect((await postRaw(FB_PATH, raw, { 'x-hub-signature-256': fbSign(raw, 'bi-mat-khac-0123456789') })).status).toBe(401)
    expect(await quiet()).toEqual([])
  })

  it('bản kia lỗi (HTTP 500) ⇒ chỉ ghi log, lô vẫn trả 200 cho Meta', async () => {
    const page = pageId()
    await mock.rules({ match: 'POST webhook', status: 500, json: { error: 'bản kia hỏng' } })
    const { raw, headers } = signed(fbMessage(page, psid(), `m_500_${seq}`))
    expect((await postRaw(FB_PATH, raw, headers)).status).toBe(200)
    expect(await forwarded()).toHaveLength(1)
  })
})
