import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { S, resetInbound, seedInboundFixtures, setupSource, type InboundFixtures } from '../../lib/inbound.js'
import { a, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
let fx: InboundFixtures
beforeAll(async () => {
  fx = await seedInboundFixtures()
})
beforeEach(resetInbound)

/**
 * C12b, từ `apps/monolith/test/rbac/webhooks-in.e2e-spec.ts` (nhóm "quản trị nguồn", 6 ca). Hồ sơ `default` (cờ webhook bật, có khoá mã hoá).
 * Phần e2e gốc xoá `INTEGRATIONS_WEBHOOKS_ENABLED` / `INTEGRATIONS_SECRET_KEY` giữa ca nằm ở `integrations-off/`, `no-secret-key/`, `bad-secret-key/`.
 */
describe('quản trị nguồn webhook vào: quyền, khoá, ràng buộc', () => {
  it('không có integrations.webhooks → 403 mọi route (cờ tắt → 404 ở hồ sơ integrations-off)', async () => {
    const nobody = await mk({ 'contacts.create': true })
    await st(a(nobody.token).get(S), 403)
    await st(a(nobody.token).post(S, {}), 403)
    await st(a(nobody.token).get(`${S}/1`), 403)
    await st(a(nobody.token).patch(`${S}/1`, {}), 403)
    await st(a(nobody.token).post(`${S}/1/rotate-token`), 403)
    await st(a(nobody.token).del(`${S}/1`), 403)
  })

  it('chỉ integrations.webhooks (thiếu contacts.create): xem/xoá được, tạo/sửa/tạo lại token → 403', async () => {
    const { src } = await setupSource(fx)
    const viewer = await mk({ 'integrations.webhooks': true })
    await st(a(viewer.token).get(S), 200)
    await st(a(viewer.token).get(`${S}/${src.id}`), 200)
    await st(a(viewer.token).post(S, { name: 'x', default_assignee_id: viewer.id, contact_source_id: fx.srcOpt }), 403)
    await st(a(viewer.token).patch(`${S}/${src.id}`, { name: 'y' }), 403)
    await st(a(viewer.token).post(`${S}/${src.id}/rotate-token`), 403)
    await st(a(viewer.token).del(`${S}/${src.id}`), 200)
  })

  it('ràng buộc: người nhận phải active + trong phạm vi contacts.transfer; nguồn khách/dự án phải hợp lệ; DTO sai → 400', async () => {
    const sale = await mk({})
    const locked = await mk({})
    await q(`UPDATE users SET status = 'locked' WHERE id = $1`, [locked.id])
    const mgr = await mk({ 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'own' })
    const body = { name: 'x', default_assignee_id: sale.id, contact_source_id: fx.srcOpt }
    const post = (over: Record<string, unknown>) => a(mgr.token).post(S, { ...body, ...over })
    await st(a(mgr.token).post(S, body), 403) // sale ngoài phạm vi transfer của mgr
    await st(post({ default_assignee_id: mgr.id }), 201) // chính mình thì được
    await st(post({ default_assignee_id: locked.id }), 400)
    await st(post({ default_assignee_id: 99999999 }), 400)
    await st(post({ default_assignee_id: mgr.id, contact_source_id: 99999999 }), 400)
    await st(post({ default_assignee_id: mgr.id, project_id: 99999999 }), 400)
    await st(post({ default_assignee_id: mgr.id, name: '' }), 400)
    await st(post({ default_assignee_id: mgr.id, hack: 1 }), 400)
    const boss = await mk({ 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'all' })
    await st(a(boss.token).post(S, body), 201)
  })

  it('token + signing secret chỉ trả khi tạo/tạo lại; DB chỉ lưu hash; list/get/audit KHÔNG lộ', async () => {
    const { boss, src } = await setupSource(fx, { signed: true })
    expect(src.token).toMatch(/^whk_/)
    expect(src.path).toBe(`/api/v1/hooks/in/${src.token}`)
    expect(src.signing_secret).toMatch(/^whsec_/)
    const [row] = await q<{ token_hash: string; signing_secret_enc: string }>(`SELECT token_hash, signing_secret_enc FROM webhook_inbound_sources WHERE id = $1`, [src.id])
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(src.token)
    expect(row.signing_secret_enc).not.toContain(src.signing_secret as string)
    const list = await st(a(boss.token).get(S), 200)
    const get = await st(a(boss.token).get(`${S}/${src.id}`), 200)
    for (const b of [list.body, get.body]) {
      const j = JSON.stringify(b)
      for (const leak of [src.token, src.signing_secret as string, row.token_hash, row.signing_secret_enc, 'token_hash', 'signing_secret_enc']) expect(j).not.toContain(leak)
    }
    expect(get.body).toMatchObject({ signed: true, token_prefix: src.token.slice(0, 12), is_active: true })
    const rot = await st(a(boss.token).post(`${S}/${src.id}/rotate-token`), 200)
    expect((rot.body as Body).token).not.toBe(src.token)
    const audits = JSON.stringify(await q(`SELECT * FROM integration_audit_logs`))
    for (const leak of [src.token, (rot.body as Body).token, src.signing_secret as string]) expect(audits).not.toContain(leak)
    expect(audits).toContain('source.created')
    expect(audits).toContain('source.token_rotated')
  })

  it('sửa: tên/người nhận/nguồn/tắt-bật; bật chữ ký trả secret MỘT lần, tắt thì bỏ; xoá nguồn xoá receipt', async () => {
    const { boss, src } = await setupSource(fx)
    const sale2 = await mk({})
    const up = await st(a(boss.token).patch(`${S}/${src.id}`, { name: 'Mới', default_assignee_id: sale2.id, contact_source_id: fx.srcOpt2, project_id: null, is_active: false }), 200)
    expect(up.body).toMatchObject({ name: 'Mới', default_assignee_id: sale2.id, contact_source_id: fx.srcOpt2, project_id: null, is_active: false, signed: false })
    const on = await st(a(boss.token).patch(`${S}/${src.id}`, { is_active: true, signed: true }), 200)
    expect((on.body as Body).signing_secret).toMatch(/^whsec_/)
    expect((await st(a(boss.token).get(`${S}/${src.id}`), 200)).body).not.toHaveProperty('signing_secret')
    const off = await st(a(boss.token).patch(`${S}/${src.id}`, { signed: false }), 200)
    expect((off.body as Body).signed).toBe(false)
    await q(`INSERT INTO webhook_inbound_receipts (source_id, external_id) VALUES ($1, 'x')`, [src.id])
    await st(a(boss.token).del(`${S}/${src.id}`), 200)
    expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM webhook_inbound_receipts`))[0].n)).toBe(0)
    await st(a(boss.token).get(`${S}/${src.id}`), 404)
  })

  it('tạo lại token / bật chữ ký / sửa nguồn của người nhận NGOÀI phạm vi contacts.transfer của mình → 403; chỉ TẮT nguồn thì được', async () => {
    const { src } = await setupSource(fx)
    const weak = await mk({ 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'own' })
    await st(a(weak.token).post(`${S}/${src.id}/rotate-token`), 403)
    await st(a(weak.token).patch(`${S}/${src.id}`, { signed: true }), 403)
    await st(a(weak.token).patch(`${S}/${src.id}`, { name: 'đổi tên' }), 403)
    await st(a(weak.token).patch(`${S}/${src.id}`, { is_active: true }), 403)
    await st(a(weak.token).patch(`${S}/${src.id}`, { is_active: false }), 200)
    const [row] = await q<{ is_active: boolean }>(`SELECT is_active FROM webhook_inbound_sources WHERE id = $1`, [src.id])
    expect(row.is_active).toBe(false)
  })
})
