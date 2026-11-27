import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { PHONES, existingContact, hook, hookRaw, lead, n, resetInbound, seedInboundFixtures, setupSource, signHeader, signedHook, type InboundFixtures } from '../../lib/inbound.js'
import { mk } from '../../lib/webhooks.js'

afterAll(closeDb)
let fx: InboundFixtures
beforeAll(async () => {
  fx = await seedInboundFixtures()
})
beforeEach(resetInbound)

const contacts = (): Promise<number> => n(`SELECT count(*) AS n FROM contacts WHERE phone = ANY($1)`, [PHONES])

/** C12b, từ `webhooks-in.e2e-spec.ts` nhóm "nguồn có chữ ký" (2 ca ở đây, 1 ở `no-secret-key/`) và "các ca biên" (5 ca còn lại). Hồ sơ `default`. */
describe('nguồn có chữ ký', () => {
  it('thiếu/sai/quá hạn/body bị sửa → 401; đúng → 200; 401 không tạo gì và nhật ký là denied', async () => {
    const { src } = await setupSource(fx, { signed: true })
    const secret = src.signing_secret as string
    expect((await hook(src.token, lead())).status).toBe(401) // không header
    expect((await hook(src.token, lead(), { 'x-trinity-signature': 't=1,v1=' + 'a'.repeat(64) })).status).toBe(401)
    expect((await signedHook(src.token, 'whsec_sai', lead())).status).toBe(401)
    expect((await signedHook(src.token, secret, lead(), -3600)).status).toBe(401) // quá hạn (replay)
    const raw = JSON.stringify(lead())
    const swapped = await hookRaw(src.token, JSON.stringify(lead(PHONES[1])), { 'content-type': 'application/json', 'x-trinity-signature': signHeader(secret, raw) }) // ký body khác
    expect(swapped.status).toBe(401)
    expect(await contacts()).toBe(0)
    expect(await n(`SELECT count(*) AS n FROM integration_audit_logs WHERE channel = 'webhook_in' AND status = 'denied' AND http_status = 401`)).toBe(5)
    const r = await signedHook(src.token, secret, lead())
    expect(r.status).toBe(200)
    expect((r.body as { status: string }).status).toBe('accepted')
    expect((await hook(src.token, lead(), {})).status).toBe(401)
  })

  it('nguồn KHÔNG có chữ ký không đòi header', async () => {
    const { src } = await setupSource(fx)
    expect((await hook(src.token, lead())).status).toBe(200)
  })
})

describe('các ca biên — webhook vào', () => {
  it('sai chữ ký liên tục bị chặn 429 riêng (30/phút) và KHÔNG tiêu hạn mức của bên gửi hợp lệ; 429 chỉ ghi nhật ký 1 lần', async () => {
    const { src } = await setupSource(fx, { signed: true })
    const secret = src.signing_secret as string
    const codes: number[] = []
    for (let i = 0; i < 33; i++) codes.push((await hook(src.token, lead(), { 'x-trinity-signature': 't=1,v1=' + 'a'.repeat(64) })).status)
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true)
    expect(codes.slice(30)).toEqual([429, 429, 429])
    expect((await signedHook(src.token, secret, lead())).status).toBe(200) // bên gửi hợp lệ vẫn vào được
    expect(await n(`SELECT count(*) AS n FROM integration_audit_logs WHERE channel = 'webhook_in' AND http_status = 429`)).toBe(1)
  })

  it('chữ ký tính trên BYTE thô (body có ký tự Unicode/khoảng trắng lạ vẫn khớp)', async () => {
    const { src } = await setupSource(fx, { signed: true })
    const raw = `{ "name" : "Nguyễn Văn Ạ — đặc biệt", \n "phone":"${PHONES[0]}" }`
    const res = await hookRaw(src.token, raw, { 'content-type': 'application/json', 'x-trinity-signature': signHeader(src.signing_secret as string, Buffer.from(raw, 'utf8')) })
    expect(res.status).toBe(200)
  })

  it('nhật ký webhook_in KHÔNG gán user_id = sale nhận (tác nhân là hệ thống ngoài); có assignee_id trong metadata', async () => {
    const { src, sale } = await setupSource(fx)
    expect((await hook(src.token, lead())).status).toBe(200)
    const [log] = await q<{ user_id: number | null; metadata: Record<string, unknown> }>(`SELECT * FROM integration_audit_logs WHERE channel = 'webhook_in' AND action = 'receive'`)
    expect(log.user_id).toBeNull()
    expect(log.metadata).toMatchObject({ source_id: src.id, assignee_id: sale.id })
  })

  it('H1 giảm thiểu: trùng SĐT với khách của NGƯỜI KHÁC → activity ngắn (note cắt 500, KHÔNG extra); khách của chính người nhận → đầy đủ', async () => {
    const { src, sale } = await setupSource(fx)
    const other = await mk({})
    const foreign = await existingContact(PHONES[0], 'Của người khác', other.id)
    const mine = await existingContact(PHONES[1], 'Của sale nhận', sale.id)
    const long = 'n'.repeat(800)
    expect((await hook(src.token, lead(PHONES[0], { note: long, extra: { utm: 'x' } }))).status).toBe(200)
    const own = await hook(src.token, lead(PHONES[1], { note: long, extra: { utm: 'x' } }))
    expect(own.status).toBe(200)
    // Phản hồi giống hệt cho khách của chính người nhận lẫn của người khác.
    expect(own.body).toEqual({ status: 'accepted', contact_id: null })
    const [a] = await q<{ details: { description: string }; metadata: Record<string, unknown> }>(`SELECT details, metadata FROM activities WHERE contact_id = $1`, [foreign])
    const [b] = await q<{ details: { description: string }; metadata: Record<string, unknown> }>(`SELECT details, metadata FROM activities WHERE contact_id = $1 ORDER BY id DESC`, [mine])
    expect(a.details.description.length).toBeLessThan(700)
    expect(a.metadata).not.toHaveProperty('extra')
    expect(b.details.description.length).toBeGreaterThan(800)
    expect(b.metadata).toMatchObject({ extra: { utm: 'x' } })
  })
})
