import { randomBytes } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { INestApplication } from '@nestjs/common'
import type { PrismaService } from '@trinity/prisma'
import request from 'supertest'
import { bootApp, resetDb, makeUser, api } from './harness'
import { WebhookDispatcherService } from '../../../../services/crm/src/integrations/webhooks/webhook-dispatcher.service'
import { buildSignatureHeader } from '../../../../services/crm/src/integrations/webhooks/signature'

/**
 * webhook VÀO: quản trị nguồn (quyền/cờ/khoá), nhận khách qua token (404 khi sai),
 * chữ ký, dedupe SĐT, idempotent external_id (kể cả đồng thời), owner = người nhận, nhật ký không lộ SĐT,
 * outbox contact.created vẫn bắn (và tới webhook ra).
 */
const ENV_KEYS = ['INTEGRATIONS_WEBHOOKS_ENABLED', 'INTEGRATIONS_SECRET_KEY', 'INTEGRATIONS_ALLOW_PRIVATE_TARGETS'] as const
const S = '/api/v1/integrations/webhooks/inbound-sources'
const HOOK = '/api/v1/hooks/in'
const PHONES = ['0900001501', '0900001602', '0900001703', '0900001804', '0900001905']
const phoneList = PHONES.map((p) => `'${p}'`).join(',')

describe('RBAC E2E — Webhook vào', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  let srcOpt = 0
  let srcOpt2 = 0
  let projectId = 0

  const enable = () => {
    process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'
    process.env.INTEGRATIONS_SECRET_KEY = randomBytes(32).toString('base64')
  }

  beforeAll(async () => {
    ENV_KEYS.forEach((k) => delete process.env[k])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
    const mk = (value: string) =>
      prisma.settingOption.upsert({ where: { group_key_value: { group_key: 'contact_source', value } }, update: { is_active: true }, create: { group_key: 'contact_source', value, label: value }, select: { id: true } })
    srcOpt = (await mk('e2e_in_src')).id
    srcOpt2 = (await mk('e2e_in_src2')).id
    projectId = (await prisma.project.upsert({ where: { code: 'E2E_IN' }, update: {}, create: { name: 'E2E in', code: 'E2E_IN' }, select: { id: true } })).id
  }, 60_000)
  afterAll(async () => { await close() })

  afterEach(async () => {
    ENV_KEYS.forEach((k) => delete process.env[k])
    await prisma.$executeRawUnsafe(`UPDATE setting_options SET is_active = true WHERE group_key = 'contact_source' AND value LIKE 'e2e_in_%'`)
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE webhook_deliveries, webhook_endpoints, webhook_inbound_sources, webhook_inbound_receipts, integration_events, integration_audit_logs RESTART IDENTITY`)
    await prisma.$executeRawUnsafe(`DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await prisma.$executeRawUnsafe(`DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone IN (${phoneList}))`)
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE phone IN (${phoneList})`)
    await resetDb(prisma)
  })

  /** Admin-ish cấu hình + người nhận. */
  const setup = async (over: { signed?: boolean } = {}) => {
    const sale = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
    const boss = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'all' } })
    const res = await api(app, boss.token).post(S).send({ name: 'FB form', default_assignee_id: sale.id, contact_source_id: srcOpt, project_id: projectId, signed: over.signed }).expect(201)
    return { sale, boss, src: res.body as { id: number; token: string; path: string; signing_secret?: string } }
  }
  const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    request(app.getHttpServer()).post(`${HOOK}/${token}`).set(headers).send(body as object)
  const signedPost = (token: string, secret: string, body: object, tOffsetSec = 0) => {
    const raw = JSON.stringify(body)
    return request(app.getHttpServer()).post(`${HOOK}/${token}`).set('Content-Type', 'application/json')
      .set('X-Trinity-Signature', buildSignatureHeader(secret, raw, Date.now() + tOffsetSec * 1000)).send(raw)
  }
  const lead = (phone = PHONES[0], extra: object = {}) => ({ name: 'Khách Hook', phone, ...extra })

  describe('quản trị nguồn: quyền, cờ, khoá, ràng buộc', () => {
    it('không có integrations.webhooks → 403 mọi route; cờ tắt → 404', async () => {
      const nobody = await makeUser(prisma, { grants: { 'contacts.create': true } })
      enable()
      await api(app, nobody.token).get(S).expect(403)
      await api(app, nobody.token).post(S).send({}).expect(403)
      await api(app, nobody.token).get(`${S}/1`).expect(403)
      await api(app, nobody.token).patch(`${S}/1`).send({}).expect(403)
      await api(app, nobody.token).post(`${S}/1/rotate-token`).expect(403)
      await api(app, nobody.token).delete(`${S}/1`).expect(403)
      delete process.env.INTEGRATIONS_WEBHOOKS_ENABLED
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.create': true } })
      await api(app, u.token).get(S).expect(404)
      await api(app, u.token).post(S).send({ name: 'x', default_assignee_id: u.id, contact_source_id: srcOpt }).expect(404)
    })

    it('chỉ integrations.webhooks (thiếu contacts.create): xem/xoá được, tạo/sửa/tạo lại token → 403', async () => {
      enable()
      const { src } = await setup()
      const viewer = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      await api(app, viewer.token).get(S).expect(200)
      await api(app, viewer.token).get(`${S}/${src.id}`).expect(200)
      await api(app, viewer.token).post(S).send({ name: 'x', default_assignee_id: viewer.id, contact_source_id: srcOpt }).expect(403)
      await api(app, viewer.token).patch(`${S}/${src.id}`).send({ name: 'y' }).expect(403)
      await api(app, viewer.token).post(`${S}/${src.id}/rotate-token`).expect(403)
      await api(app, viewer.token).delete(`${S}/${src.id}`).expect(200)
    })

    it('thiếu/sai INTEGRATIONS_SECRET_KEY → 503 khi tạo', async () => {
      process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.create': true } })
      const r = await api(app, u.token).post(S).send({ name: 'x', default_assignee_id: u.id, contact_source_id: srcOpt }).expect(503)
      expect(r.body.message).toMatch(/INTEGRATIONS_SECRET_KEY/)
    })

    it('ràng buộc: người nhận phải active + trong phạm vi contacts.transfer; nguồn khách/dự án phải hợp lệ; DTO sai → 400', async () => {
      enable()
      const sale = await makeUser(prisma, { grants: {} })
      const locked = await makeUser(prisma, { grants: {} })
      await prisma.user.update({ where: { id: locked.id }, data: { status: 'locked' } })
      const mgr = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'own' } })
      const body = { name: 'x', default_assignee_id: sale.id, contact_source_id: srcOpt }
      await api(app, mgr.token).post(S).send(body).expect(403) // sale ngoài phạm vi transfer của mgr
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: mgr.id }).expect(201) // chính mình thì được
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: locked.id }).expect(400)
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: 99999999 }).expect(400)
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: mgr.id, contact_source_id: 99999999 }).expect(400)
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: mgr.id, project_id: 99999999 }).expect(400)
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: mgr.id, name: '' }).expect(400)
      await api(app, mgr.token).post(S).send({ ...body, default_assignee_id: mgr.id, hack: 1 }).expect(400)
      const boss = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'all' } })
      await api(app, boss.token).post(S).send(body).expect(201)
    })

    it('token + signing secret chỉ trả khi tạo/tạo lại; DB chỉ lưu hash; list/get/audit KHÔNG lộ', async () => {
      enable()
      const { boss, src } = await setup({ signed: true })
      expect(src.token).toMatch(/^whk_/)
      expect(src.path).toBe(`/api/v1/hooks/in/${src.token}`)
      expect(src.signing_secret).toMatch(/^whsec_/)
      const row = await prisma.webhookInboundSource.findUniqueOrThrow({ where: { id: src.id } })
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(row)).not.toContain(src.token)
      expect(row.signing_secret_enc).not.toContain(src.signing_secret as string)
      const list = await api(app, boss.token).get(S).expect(200)
      const get = await api(app, boss.token).get(`${S}/${src.id}`).expect(200)
      for (const b of [list.body, get.body]) {
        const j = JSON.stringify(b)
        for (const leak of [src.token, src.signing_secret as string, row.token_hash, row.signing_secret_enc as string, 'token_hash', 'signing_secret_enc']) expect(j).not.toContain(leak)
      }
      expect(get.body).toMatchObject({ signed: true, token_prefix: src.token.slice(0, 12), is_active: true })
      const rot = await api(app, boss.token).post(`${S}/${src.id}/rotate-token`).expect(200)
      expect(rot.body.token).not.toBe(src.token)
      const audits = JSON.stringify(await prisma.integrationAuditLog.findMany())
      for (const leak of [src.token, rot.body.token, src.signing_secret as string]) expect(audits).not.toContain(leak)
      expect(audits).toContain('source.created')
      expect(audits).toContain('source.token_rotated')
    })

    it('sửa: tên/người nhận/nguồn/tắt-bật; bật chữ ký trả secret MỘT lần, tắt thì bỏ; xoá nguồn xoá receipt', async () => {
      enable()
      const { boss, src, sale } = await setup()
      const sale2 = await makeUser(prisma, { grants: {} })
      const up = await api(app, boss.token).patch(`${S}/${src.id}`).send({ name: 'Mới', default_assignee_id: sale2.id, contact_source_id: srcOpt2, project_id: null, is_active: false }).expect(200)
      expect(up.body).toMatchObject({ name: 'Mới', default_assignee_id: sale2.id, contact_source_id: srcOpt2, project_id: null, is_active: false, signed: false })
      const on = await api(app, boss.token).patch(`${S}/${src.id}`).send({ is_active: true, signed: true }).expect(200)
      expect(on.body.signing_secret).toMatch(/^whsec_/)
      expect((await api(app, boss.token).get(`${S}/${src.id}`).expect(200)).body).not.toHaveProperty('signing_secret')
      const off = await api(app, boss.token).patch(`${S}/${src.id}`).send({ signed: false }).expect(200)
      expect(off.body.signed).toBe(false)
      void sale
      await prisma.webhookInboundReceipt.create({ data: { source_id: src.id, external_id: 'x' } })
      await api(app, boss.token).delete(`${S}/${src.id}`).expect(200)
      expect(await prisma.webhookInboundReceipt.count()).toBe(0)
      await api(app, boss.token).get(`${S}/${src.id}`).expect(404)
    })
  })

  describe('POST /hooks/in/:token — nhận khách', () => {
    it('cờ tắt / token sai định dạng / token lạ / nguồn tắt / token đã tạo lại → 404 (không phân biệt)', async () => {
      enable()
      const { boss, src } = await setup()
      await post(`whk_${'A'.repeat(43)}`, lead()).expect(404)
      await post('abc', lead()).expect(404)
      await post(`${src.token}x`, lead()).expect(404)
      await api(app, boss.token).patch(`${S}/${src.id}`).send({ is_active: false }).expect(200)
      await post(src.token, lead()).expect(404)
      await api(app, boss.token).patch(`${S}/${src.id}`).send({ is_active: true }).expect(200)
      await post(src.token, lead()).expect(200)
      const rot = await api(app, boss.token).post(`${S}/${src.id}/rotate-token`).expect(200)
      await post(src.token, lead(PHONES[1])).expect(404)
      await post(rot.body.token, lead(PHONES[1])).expect(200)
      delete process.env.INTEGRATIONS_WEBHOOKS_ENABLED
      await post(rot.body.token, lead(PHONES[2])).expect(404)
      expect(await prisma.contact.count({ where: { phone: PHONES[2] } })).toBe(0)
    })

    it('tạo khách: 200 accepted; owner = người nhận mặc định, nguồn/dự án đúng, SĐT chuẩn hoá, activity note, outbox contact.created origin webhook_in', async () => {
      enable()
      const { sale, src } = await setup()
      const r = await post(src.token, lead('+84 900 001 501', { email: 'a@x.vn', note: 'quan tâm A', source: 'FB form', extra: { utm: 'x' } })).expect(200)
      // Phản hồi công khai không tiết lộ khách mới hay đã có: luôn { accepted, contact_id: null }.
      expect(r.body).toEqual({ status: 'accepted', contact_id: null })
      const c = await prisma.contact.findFirstOrThrow({ where: { phone: PHONES[0] } })
      expect(c).toMatchObject({ phone: PHONES[0], full_name: 'Khách Hook', email: 'a@x.vn', assigned_to: sale.id, source_id: srcOpt, project_id: projectId })
      const acts = await prisma.activity.findMany({ where: { contact_id: c.id } })
      expect(acts).toHaveLength(1)
      expect(acts[0]).toMatchObject({ action: 'note', created_by: null })
      expect((acts[0].details as { description: string }).description).toContain('quan tâm A')
      expect(acts[0].metadata).toMatchObject({ webhook_source_id: src.id, extra: { utm: 'x' } })
      const ev = await prisma.integrationEvent.findMany({ where: { event_type: 'contact.created' } })
      expect(ev).toHaveLength(1)
      expect(ev[0].payload).toMatchObject({ origin: 'webhook_in', contact: { id: c.id, assigned_to: sale.id } })
      expect((await prisma.webhookInboundSource.findUniqueOrThrow({ where: { id: src.id } })).last_received_at).not.toBeNull()
      // Quyền theo owner: người nhận (contacts.view own) thấy khách; người khác thì 404.
      await api(app, sale.token).get(`/api/v1/contacts/${c.id}`).expect(200)
      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      await api(app, other.token).get(`/api/v1/contacts/${c.id}`).expect(404)
    })

    it('nhật ký webhook_in: có kết quả, KHÔNG có SĐT/tên/token/body', async () => {
      enable()
      const { src } = await setup()
      await post(src.token, lead(PHONES[0], { note: 'liên hệ lại 0987654321' })).expect(200)
      await post(src.token, { name: 'Khách Lỗi', phone: '0966009999999' }).expect(400)
      const rows = await prisma.integrationAuditLog.findMany({ where: { channel: 'webhook_in', action: 'receive' }, orderBy: { id: 'asc' } })
      expect(rows.map((r) => [r.status, r.http_status])).toEqual([['ok', 200], ['error', 400]])
      const j = JSON.stringify(rows)
      for (const leak of [PHONES[0], '0987654321', '0966009999999', 'Khách Hook', 'Khách Lỗi', src.token, 'quan tâm']) expect(j).not.toContain(leak)
      expect(rows[0].metadata).toMatchObject({ source_id: src.id, result: 'created' })
    })

    it('số mới và số đã có trả CÙNG mã + CÙNG body (không dò được SĐT nào đã là khách)', async () => {
      enable()
      const { src, sale } = await setup()
      const fresh = await post(src.token, lead(PHONES[0])).expect(200)
      const again = await post(src.token, lead(PHONES[0])).expect(200) // đã có, của chính người nhận
      const other = await makeUser(prisma, { grants: {} })
      await prisma.contact.create({ data: { phone: PHONES[1], full_name: 'Của người khác', assigned_to: other.id } })
      const foreign = await post(src.token, lead(PHONES[1])).expect(200)
      for (const r of [fresh, again, foreign]) expect(r.body).toEqual({ status: 'accepted', contact_id: null })
      expect((await prisma.contact.findFirstOrThrow({ where: { phone: PHONES[0] } })).assigned_to).toBe(sale.id)
    })

    it('trùng SĐT (kể cả dạng +84/84) → 200 accepted, KHÔNG tạo khách mới / không đổi owner / thêm activity / không outbox mới', async () => {
      enable()
      const { src } = await setup()
      const other = await makeUser(prisma, { grants: {} })
      const old = await prisma.contact.create({ data: { phone: PHONES[0], full_name: 'Khách cũ', assigned_to: other.id } })
      const r = await post(src.token, lead('+84900001501', { note: 'hỏi lại' })).expect(200)
      // Khách của người KHÁC: không lộ contact_id / trạng thái trùng ra nguồn ngoài.
      expect(r.body).toEqual({ status: 'accepted', contact_id: null })
      expect(await prisma.contact.count({ where: { phone: { in: PHONES } } })).toBe(1)
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: old.id } })).assigned_to).toBe(other.id)
      const acts = await prisma.activity.findMany({ where: { contact_id: old.id } })
      expect(acts).toHaveLength(1)
      expect((acts[0].details as { description: string }).description).toContain('gửi lại')
      expect(await prisma.integrationEvent.count()).toBe(0)
      // Khách đã xoá mềm KHÔNG tính là trùng.
      await prisma.contact.update({ where: { id: old.id }, data: { deleted_at: new Date() } })
      await post(src.token, lead()).expect(200)
    })

    it('external_id idempotent: lần 2 → 200 như cũ, không tạo lại, không thêm activity', async () => {
      enable()
      const { src } = await setup()
      const a = await post(src.token, lead(PHONES[0], { external_id: 'lead-1' })).expect(200)
      const b = await post(src.token, lead(PHONES[1], { external_id: 'lead-1' })).expect(200) // SĐT khác nhưng cùng external_id
      expect(b.body).toEqual(a.body)
      expect(await prisma.contact.count({ where: { phone: { in: PHONES } } })).toBe(1)
      const first = await prisma.contact.findFirstOrThrow({ where: { phone: PHONES[0] } })
      expect(await prisma.activity.count({ where: { contact_id: first.id } })).toBe(1)
      // external_id khác nguồn thì độc lập.
      const { src: src2 } = await setup()
      await post(src2.token, lead(PHONES[2], { external_id: 'lead-1' })).expect(200)
    })

    it('ĐỒNG THỜI: 6 request cùng external_id → đúng 1 khách; 6 request cùng SĐT khác external_id → đúng 1 khách', async () => {
      enable()
      const { src } = await setup()
      const same = await Promise.all(Array.from({ length: 6 }, () => post(src.token, lead(PHONES[0], { external_id: 'race-1' }))))
      expect(same.filter((r) => r.status === 200)).toHaveLength(6)
      expect(await prisma.contact.count({ where: { phone: PHONES[0] } })).toBe(1)
      const dup = await Promise.all(Array.from({ length: 6 }, (_, i) => post(src.token, lead(PHONES[1], { external_id: `race-p-${i}` }))))
      expect(dup.filter((r) => r.status === 200)).toHaveLength(6)
      expect(await prisma.contact.count({ where: { phone: { in: [PHONES[0], PHONES[1]] } } })).toBe(2)
      expect(await prisma.integrationEvent.count({ where: { event_type: 'contact.created' } })).toBe(2)
    })

    it('payload sai → 400 (thông điệp không chép lại SĐT); không phải JSON → 400; quá lớn → 413', async () => {
      enable()
      const { src } = await setup()
      const bad = await post(src.token, { name: 'A', phone: '0966009999999' }).expect(400)
      expect(JSON.stringify(bad.body)).not.toContain('0966009999999')
      await post(src.token, { phone: PHONES[0] }).expect(400)
      await post(src.token, lead(PHONES[0], { email: 'sai' })).expect(400)
      await request(app.getHttpServer()).post(`${HOOK}/${src.token}`).set('Content-Type', 'text/plain').send('name=a').expect(400)
      await post(src.token, lead(PHONES[0], { note: 'x'.repeat(70_000) })).expect(413)
      expect(await prisma.contact.count({ where: { phone: { in: PHONES } } })).toBe(0)
    })

    it('người nhận mặc định bị khoá → 422 (không tạo khách); nguồn khách bị tắt → 422', async () => {
      enable()
      const { sale, src } = await setup()
      await prisma.user.update({ where: { id: sale.id }, data: { status: 'locked' } })
      const r = await post(src.token, lead()).expect(422)
      expect(r.body.message).toMatch(/người nhận/i)
      expect(await prisma.contact.count({ where: { phone: PHONES[0] } })).toBe(0)
      const log = await prisma.integrationAuditLog.findFirstOrThrow({ where: { channel: 'webhook_in' }, orderBy: { id: 'desc' } })
      expect(log).toMatchObject({ status: 'error', http_status: 422 })
      await prisma.user.update({ where: { id: sale.id }, data: { status: 'active' } })
      await prisma.settingOption.update({ where: { id: srcOpt }, data: { is_active: false } })
      await post(src.token, lead()).expect(422)
    })

    it('rate limit theo nguồn: 100/phút rồi 429 (nguồn khác không bị ảnh hưởng); nhật ký ghi denied', async () => {
      enable()
      const { src } = await setup()
      const { src: other } = await setup()
      const bad = { name: '', phone: '' } // 400 nhanh, vẫn tính rate limit
      const codes: number[] = []
      for (let i = 0; i < 101; i++) codes.push((await post(src.token, bad)).status)
      expect(codes.slice(0, 100).every((c) => c === 400)).toBe(true)
      expect(codes[100]).toBe(429)
      for (let i = 0; i < 5; i++) await post(src.token, bad).expect(429)
      await post(other.token, bad).expect(400)
      // Chỉ ghi nhật ký lần ĐẦU vượt hạn mức trong cửa sổ (không khuếch đại ghi DB khi bị dồn).
      expect(await prisma.integrationAuditLog.count({ where: { channel: 'webhook_in', status: 'denied', http_status: 429 } })).toBe(1)
    })
  })

  describe('nguồn có chữ ký', () => {
    it('thiếu/sai/quá hạn/body bị sửa → 401; đúng → 200; 401 không tạo gì và nhật ký là denied', async () => {
      enable()
      const { src } = await setup({ signed: true })
      const secret = src.signing_secret as string
      await post(src.token, lead()).expect(401) // không header
      await post(src.token, lead(), { 'X-Trinity-Signature': 't=1,v1=' + 'a'.repeat(64) }).expect(401)
      await signedPost(src.token, 'whsec_sai', lead()).expect(401)
      await signedPost(src.token, secret, lead(), -3600).expect(401) // quá hạn (replay)
      const raw = JSON.stringify(lead())
      await request(app.getHttpServer()).post(`${HOOK}/${src.token}`).set('Content-Type', 'application/json')
        .set('X-Trinity-Signature', buildSignatureHeader(secret, raw)).send(JSON.stringify(lead(PHONES[1]))).expect(401) // ký body khác
      expect(await prisma.contact.count({ where: { phone: { in: PHONES } } })).toBe(0)
      const denied = await prisma.integrationAuditLog.count({ where: { channel: 'webhook_in', status: 'denied', http_status: 401 } })
      expect(denied).toBe(5)
      const r = await signedPost(src.token, secret, lead()).expect(200)
      expect(r.body.status).toBe('accepted')
      expect((await post(src.token, lead(), {})).status).toBe(401)
    })

    it('nguồn có chữ ký nhưng máy chủ mất khoá mã hoá → 503 (KHÔNG bỏ qua kiểm chữ ký)', async () => {
      enable()
      const { src } = await setup({ signed: true })
      delete process.env.INTEGRATIONS_SECRET_KEY
      await post(src.token, lead()).expect(503)
      expect(await prisma.contact.count({ where: { phone: PHONES[0] } })).toBe(0)
    })

    it('nguồn KHÔNG có chữ ký không đòi header', async () => {
      enable()
      const { src } = await setup()
      await post(src.token, lead()).expect(200)
    })
  })

  describe('các ca biên — webhook vào', () => {
    it('tạo lại token / bật chữ ký / sửa nguồn của người nhận NGOÀI phạm vi contacts.transfer của mình → 403; chỉ TẮT nguồn thì được', async () => {
      enable()
      const { src, sale } = await setup()
      const weak = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'own' } })
      await api(app, weak.token).post(`${S}/${src.id}/rotate-token`).expect(403)
      await api(app, weak.token).patch(`${S}/${src.id}`).send({ signed: true }).expect(403)
      await api(app, weak.token).patch(`${S}/${src.id}`).send({ name: 'đổi tên' }).expect(403)
      await api(app, weak.token).patch(`${S}/${src.id}`).send({ is_active: true }).expect(403)
      await api(app, weak.token).patch(`${S}/${src.id}`).send({ is_active: false }).expect(200)
      expect((await prisma.webhookInboundSource.findUniqueOrThrow({ where: { id: src.id } })).is_active).toBe(false)
      void sale
    })

    it('sai chữ ký liên tục bị chặn 429 riêng (30/phút) và KHÔNG tiêu hạn mức của bên gửi hợp lệ; 429 chỉ ghi nhật ký 1 lần', async () => {
      enable()
      const { src } = await setup({ signed: true })
      const secret = src.signing_secret as string
      const codes: number[] = []
      for (let i = 0; i < 33; i++) codes.push((await post(src.token, lead(), { 'X-Trinity-Signature': 't=1,v1=' + 'a'.repeat(64) })).status)
      expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true)
      expect(codes.slice(30)).toEqual([429, 429, 429])
      await signedPost(src.token, secret, lead()).expect(200) // bên gửi hợp lệ vẫn vào được
      expect(await prisma.integrationAuditLog.count({ where: { channel: 'webhook_in', http_status: 429 } })).toBe(1)
    })

    it('chữ ký tính trên BYTE thô (body có ký tự Unicode/khoảng trắng lạ vẫn khớp)', async () => {
      enable()
      const { src } = await setup({ signed: true })
      const raw = `{ "name" : "Nguyễn Văn Ạ — đặc biệt", \n "phone":"${PHONES[0]}" }`
      await request(app.getHttpServer()).post(`${HOOK}/${src.token}`).set('Content-Type', 'application/json')
        .set('X-Trinity-Signature', buildSignatureHeader(src.signing_secret as string, Buffer.from(raw, 'utf8'))).send(raw).expect(200)
    })

    it('nhật ký webhook_in KHÔNG gán user_id = sale nhận (tác nhân là hệ thống ngoài); có assignee_id trong metadata', async () => {
      enable()
      const { src, sale } = await setup()
      await post(src.token, lead()).expect(200)
      const log = await prisma.integrationAuditLog.findFirstOrThrow({ where: { channel: 'webhook_in', action: 'receive' } })
      expect(log.user_id).toBeNull()
      expect(log.metadata).toMatchObject({ source_id: src.id, assignee_id: sale.id })
    })

    it('H1 giảm thiểu: trùng SĐT với khách của NGƯỜI KHÁC → activity ngắn (note cắt 500, KHÔNG extra); khách của chính người nhận → đầy đủ', async () => {
      enable()
      const { src, sale } = await setup()
      const other = await makeUser(prisma, { grants: {} })
      const foreign = await prisma.contact.create({ data: { phone: PHONES[0], full_name: 'Của người khác', assigned_to: other.id } })
      const mine = await prisma.contact.create({ data: { phone: PHONES[1], full_name: 'Của sale nhận', assigned_to: sale.id } })
      const long = 'n'.repeat(800)
      await post(src.token, lead(PHONES[0], { note: long, extra: { utm: 'x' } })).expect(200)
      const own = await post(src.token, lead(PHONES[1], { note: long, extra: { utm: 'x' } })).expect(200)
      // Phản hồi giống hệt cho khách của chính người nhận lẫn của người khác.
      expect(own.body).toEqual({ status: 'accepted', contact_id: null })
      const a = await prisma.activity.findFirstOrThrow({ where: { contact_id: foreign.id } })
      const b = await prisma.activity.findFirstOrThrow({ where: { contact_id: mine.id } })
      expect((a.details as { description: string }).description.length).toBeLessThan(700)
      expect(a.metadata).not.toHaveProperty('extra')
      expect((b.details as { description: string }).description.length).toBeGreaterThan(800)
      expect(b.metadata).toMatchObject({ extra: { utm: 'x' } })
    })
  })

  describe('tích hợp: khách vào qua webhook → bắn tiếp webhook ra', () => {
    it('contact.created từ webhook vào tới endpoint ra (SĐT che theo quyền chủ thể endpoint)', async () => {
      enable()
      process.env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS = 'true'
      const seen: string[] = []
      const server = http.createServer((req, res) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => { seen.push(b); res.end('ok') })
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      try {
        const { src } = await setup()
        const watcher = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } }) // không phone_full
        await api(app, watcher.token).post('/api/v1/integrations/webhooks/endpoints')
          .send({ name: 'out', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/h`, events: ['contact.created'] }).expect(201)
        await new Promise((r) => setTimeout(r, 15))
        await post(src.token, lead(PHONES[3])).expect(200)
        const created = await prisma.contact.findFirstOrThrow({ where: { phone: PHONES[3] } })
        await app.get(WebhookDispatcherService).tick()
        expect(seen).toHaveLength(1)
        const body = JSON.parse(seen[0])
        expect(body).toMatchObject({ type: 'contact.created', data: { origin: 'webhook_in', contact: { id: created.id, phone: '***804' } } })
        expect(seen[0]).not.toContain(PHONES[3])
      } finally {
        server.closeAllConnections()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  })
})
