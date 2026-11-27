import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { PHONES, existingContact, hook, hookRaw, lead, n, resetInbound, seedInboundFixtures, setupSource, type InboundFixtures } from '../../lib/inbound.js'
import { api, freshIp } from '../../lib/http.js'
import { S } from '../../lib/inbound.js'
import { a, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
let fx: InboundFixtures
beforeAll(async () => {
  fx = await seedInboundFixtures()
})
beforeEach(resetInbound)

const ACCEPTED = { status: 'accepted', contact_id: null }
const phonesIn = `ANY($1)`
const contactsCount = (phones: string[] = PHONES): Promise<number> => n(`SELECT count(*) AS n FROM contacts WHERE phone = ${phonesIn}`, [phones])
const one = async <T extends object>(sql: string, params: unknown[]): Promise<T> => {
  const rows = await q<T>(sql, params)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]
}

/** C12b, từ `webhooks-in.e2e-spec.ts` nhóm "POST /hooks/in/:token — nhận khách" (10 ca). Hồ sơ `default`. */
describe('POST /hooks/in/:token — nhận khách', () => {
  it('token sai định dạng / token lạ / nguồn tắt / token đã tạo lại → 404 (không phân biệt)', async () => {
    const { boss, src } = await setupSource(fx)
    expect((await hook(`whk_${'A'.repeat(43)}`, lead())).status).toBe(404)
    expect((await hook('abc', lead())).status).toBe(404)
    expect((await hook(`${src.token}x`, lead())).status).toBe(404)
    await st(a(boss.token).patch(`${S}/${src.id}`, { is_active: false }), 200)
    expect((await hook(src.token, lead())).status).toBe(404)
    await st(a(boss.token).patch(`${S}/${src.id}`, { is_active: true }), 200)
    expect((await hook(src.token, lead())).status).toBe(200)
    const rot = await st(a(boss.token).post(`${S}/${src.id}/rotate-token`), 200)
    expect((await hook(src.token, lead(PHONES[1]))).status).toBe(404)
    expect((await hook((rot.body as Body).token, lead(PHONES[1]))).status).toBe(200)
  })

  it('tạo khách: owner = người nhận mặc định, nguồn/dự án đúng, SĐT chuẩn hoá, activity note, outbox contact.created origin webhook_in', async () => {
    const { sale, src } = await setupSource(fx)
    const r = await hook(src.token, lead('+84 900 001 501', { email: 'a@x.vn', note: 'quan tâm A', source: 'FB form', extra: { utm: 'x' } }))
    expect(r.status).toBe(200)
    // Phản hồi công khai không tiết lộ khách mới hay đã có.
    expect(r.body).toEqual(ACCEPTED)
    const c = await one<{ id: number; phone: string; full_name: string; email: string; assigned_to: number; source_id: number; project_id: number }>(`SELECT * FROM contacts WHERE phone = $1`, [PHONES[0]])
    expect(c).toMatchObject({ phone: PHONES[0], full_name: 'Khách Hook', email: 'a@x.vn', assigned_to: sale.id, source_id: fx.srcOpt, project_id: fx.projectId })
    const acts = await q<{ action: string; created_by: number | null; details: { description: string }; metadata: Record<string, unknown> }>(`SELECT * FROM activities WHERE contact_id = $1`, [c.id])
    expect(acts).toHaveLength(1)
    expect(acts[0]).toMatchObject({ action: 'note', created_by: null })
    expect(acts[0].details.description).toContain('quan tâm A')
    expect(acts[0].metadata).toMatchObject({ webhook_source_id: src.id, extra: { utm: 'x' } })
    const ev = await q<{ payload: { origin: string; contact: { id: number; assigned_to: number } } }>(`SELECT payload FROM integration_events WHERE event_type = 'contact.created'`)
    expect(ev).toHaveLength(1)
    expect(ev[0].payload).toMatchObject({ origin: 'webhook_in', contact: { id: c.id, assigned_to: sale.id } })
    expect((await one<{ last_received_at: string | null }>(`SELECT last_received_at FROM webhook_inbound_sources WHERE id = $1`, [src.id])).last_received_at).not.toBeNull()
    // Quyền theo owner: người nhận (contacts.view own) thấy khách; người khác thì 404.
    await st(api.get(`/contacts/${c.id}`, { token: sale.token, ip: freshIp() }), 200)
    const other = await mk({ 'contacts.view': 'own' })
    await st(api.get(`/contacts/${c.id}`, { token: other.token, ip: freshIp() }), 404)
  })

  it('nhật ký webhook_in: có kết quả, KHÔNG có SĐT/tên/token/body', async () => {
    const { src } = await setupSource(fx)
    expect((await hook(src.token, lead(PHONES[0], { note: 'liên hệ lại 0987654321' }))).status).toBe(200)
    expect((await hook(src.token, { name: 'Khách Lỗi', phone: '0966009999999' })).status).toBe(400)
    const rows = await q<{ status: string; http_status: number; metadata: Record<string, unknown> }>(`SELECT * FROM integration_audit_logs WHERE channel = 'webhook_in' AND action = 'receive' ORDER BY id`)
    expect(rows.map((r) => [r.status, r.http_status])).toEqual([['ok', 200], ['error', 400]])
    const j = JSON.stringify(rows)
    for (const leak of [PHONES[0], '0987654321', '0966009999999', 'Khách Hook', 'Khách Lỗi', src.token, 'quan tâm']) expect(j).not.toContain(leak)
    expect(rows[0].metadata).toMatchObject({ source_id: src.id, result: 'created' })
  })

  it('số mới và số đã có trả CÙNG mã + CÙNG body (không dò được SĐT nào đã là khách)', async () => {
    const { src, sale } = await setupSource(fx)
    const fresh = await hook(src.token, lead(PHONES[0]))
    const again = await hook(src.token, lead(PHONES[0]))
    const other = await mk({})
    await existingContact(PHONES[1], 'Của người khác', other.id)
    const foreign = await hook(src.token, lead(PHONES[1]))
    for (const r of [fresh, again, foreign]) {
      expect(r.status).toBe(200)
      expect(r.body).toEqual(ACCEPTED)
    }
    expect((await one<{ assigned_to: number }>(`SELECT assigned_to FROM contacts WHERE phone = $1`, [PHONES[0]])).assigned_to).toBe(sale.id)
  })

  it('trùng SĐT (kể cả dạng +84/84) → 200 accepted, KHÔNG tạo khách mới / không đổi owner / thêm activity / không outbox mới', async () => {
    const { src } = await setupSource(fx)
    const other = await mk({})
    const oldId = await existingContact(PHONES[0], 'Khách cũ', other.id)
    const r = await hook(src.token, lead('+84900001501', { note: 'hỏi lại' }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual(ACCEPTED)
    expect(await contactsCount()).toBe(1)
    expect((await one<{ assigned_to: number }>(`SELECT assigned_to FROM contacts WHERE id = $1`, [oldId])).assigned_to).toBe(other.id)
    const acts = await q<{ details: { description: string } }>(`SELECT details FROM activities WHERE contact_id = $1`, [oldId])
    expect(acts).toHaveLength(1)
    expect(acts[0].details.description).toContain('gửi lại')
    expect(await n(`SELECT count(*) AS n FROM integration_events`)).toBe(0)
    // Khách đã xoá mềm KHÔNG tính là trùng.
    await q(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [oldId])
    expect((await hook(src.token, lead())).status).toBe(200)
  })

  it('external_id idempotent: lần 2 → 200 như cũ, không tạo lại, không thêm activity', async () => {
    const { src } = await setupSource(fx)
    const x = await hook(src.token, lead(PHONES[0], { external_id: 'lead-1' }))
    const y = await hook(src.token, lead(PHONES[1], { external_id: 'lead-1' })) // SĐT khác nhưng cùng external_id
    expect(y.body).toEqual(x.body)
    expect(await contactsCount()).toBe(1)
    const first = await one<{ id: number }>(`SELECT id FROM contacts WHERE phone = $1`, [PHONES[0]])
    expect(await n(`SELECT count(*) AS n FROM activities WHERE contact_id = $1`, [first.id])).toBe(1)
    // external_id khác nguồn thì độc lập.
    const { src: src2 } = await setupSource(fx)
    expect((await hook(src2.token, lead(PHONES[2], { external_id: 'lead-1' }))).status).toBe(200)
  })

  it('ĐỒNG THỜI: 6 request cùng external_id → đúng 1 khách; 6 request cùng SĐT khác external_id → đúng 1 khách', async () => {
    const { src } = await setupSource(fx)
    const same = await Promise.all(Array.from({ length: 6 }, () => hook(src.token, lead(PHONES[0], { external_id: 'race-1' }))))
    expect(same.filter((r) => r.status === 200)).toHaveLength(6)
    expect(await contactsCount([PHONES[0]])).toBe(1)
    const dup = await Promise.all(Array.from({ length: 6 }, (_, i) => hook(src.token, lead(PHONES[1], { external_id: `race-p-${i}` }))))
    expect(dup.filter((r) => r.status === 200)).toHaveLength(6)
    expect(await contactsCount([PHONES[0], PHONES[1]])).toBe(2)
    expect(await n(`SELECT count(*) AS n FROM integration_events WHERE event_type = 'contact.created'`)).toBe(2)
  })

  it('payload sai → 400 (thông điệp không chép lại SĐT); không phải JSON → 400; quá lớn → 413', async () => {
    const { src } = await setupSource(fx)
    const bad = await hook(src.token, { name: 'A', phone: '0966009999999' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).not.toContain('0966009999999')
    expect((await hook(src.token, { phone: PHONES[0] })).status).toBe(400)
    expect((await hook(src.token, lead(PHONES[0], { email: 'sai' }))).status).toBe(400)
    expect((await hookRaw(src.token, 'name=a', { 'content-type': 'text/plain' })).status).toBe(400)
    expect((await hook(src.token, lead(PHONES[0], { note: 'x'.repeat(70_000) }))).status).toBe(413)
    expect(await contactsCount()).toBe(0)
  })

  it('người nhận mặc định bị khoá → 422 (không tạo khách); nguồn khách bị tắt → 422', async () => {
    const { sale, src } = await setupSource(fx)
    await q(`UPDATE users SET status = 'locked' WHERE id = $1`, [sale.id])
    const r = await hook(src.token, lead())
    expect(r.status).toBe(422)
    expect((r.body as Body).message).toMatch(/người nhận/i)
    expect(await contactsCount([PHONES[0]])).toBe(0)
    const log = await one<{ status: string; http_status: number }>(`SELECT * FROM integration_audit_logs WHERE channel = 'webhook_in' ORDER BY id DESC`, [])
    expect(log).toMatchObject({ status: 'error', http_status: 422 })
    await q(`UPDATE users SET status = 'active' WHERE id = $1`, [sale.id])
    await q(`UPDATE setting_options SET is_active = false WHERE id = $1`, [fx.srcOpt])
    expect((await hook(src.token, lead())).status).toBe(422)
  })

  it('rate limit theo nguồn: 100/phút rồi 429 (nguồn khác không bị ảnh hưởng); nhật ký ghi denied', async () => {
    const { src } = await setupSource(fx)
    const { src: other } = await setupSource(fx)
    const bad = { name: '', phone: '' } // 400 nhanh, vẫn tính rate limit
    const codes: number[] = []
    for (let i = 0; i < 101; i++) codes.push((await hook(src.token, bad)).status)
    expect(codes.slice(0, 100).every((c) => c === 400)).toBe(true)
    expect(codes[100]).toBe(429)
    for (let i = 0; i < 5; i++) expect((await hook(src.token, bad)).status).toBe(429)
    expect((await hook(other.token, bad)).status).toBe(400)
    // Chỉ ghi nhật ký lần ĐẦU vượt hạn mức trong cửa sổ (không khuếch đại ghi DB khi bị dồn).
    expect(await n(`SELECT count(*) AS n FROM integration_audit_logs WHERE channel = 'webhook_in' AND status = 'denied' AND http_status = 429`)).toBe(1)
  })
})
