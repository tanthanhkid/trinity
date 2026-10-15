import { createHash } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { IntegrationAuditService, publishIntegrationEvent, snapshotContact, type PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * quyền nhóm "Kết nối & AI", cờ máy chủ, nhật ký tích hợp, outbox sự kiện.
 * Outbox: mọi đường ghi khách/deal/POS (đã nối dây) để lại dòng `integration_events` — và cờ TẮT (mặc định)
 * KHÔNG ảnh hưởng việc ghi outbox (chỉ worker/route nhật ký phụ thuộc cờ).
 */
const FLAGS = ['INTEGRATIONS_WEBHOOKS_ENABLED', 'INTEGRATIONS_MCP_ENABLED'] as const
const PHONES = ['0900001201', '0900001302', '0900001403']

describe('RBAC E2E — Kết nối & AI + outbox', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  let srcId = 0
  let stageA = 0
  let stageB = 0

  beforeAll(async () => {
    FLAGS.forEach((f) => delete process.env[f])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
    const mk = (group_key: string, value: string) =>
      prisma.settingOption.upsert({
        where: { group_key_value: { group_key, value } },
        update: {},
        create: { group_key, value, label: value },
        select: { id: true },
      })
    srcId = (await mk('contact_source', 'e2e_int_src')).id
    stageA = (await mk('contact_stage', 'e2e_int_a')).id
    stageB = (await mk('contact_stage', 'e2e_int_b')).id
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  afterEach(async () => {
    FLAGS.forEach((f) => delete process.env[f])
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE integration_events, integration_audit_logs RESTART IDENTITY`)
    await prisma.$executeRawUnsafe(`DELETE FROM deals WHERE title LIKE 'E2E int deal%'`)
    await prisma.$executeRawUnsafe(
      `DELETE FROM deals WHERE contact_id IN (SELECT id FROM contacts WHERE phone IN (${PHONES.map((p) => `'${p}'`).join(',')}))`,
    )
    await prisma.$executeRawUnsafe(`DELETE FROM api_keys WHERE name = 'e2e-int-key'`)
    // notifyDealAssigned (fire-and-forget) ghi notification_logs trỏ tới user test → xoá trước khi resetDb xoá user.
    await prisma.$executeRawUnsafe(
      `DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`,
    )
    await prisma.$executeRawUnsafe(
      `DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone IN (${PHONES.map((p) => `'${p}'`).join(',')}))`,
    )
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE phone IN (${PHONES.map((p) => `'${p}'`).join(',')})`)
    await resetDb(prisma)
  })

  const events = (type?: string) =>
    prisma.integrationEvent.findMany({ where: type ? { event_type: type } : {}, orderBy: { id: 'asc' } })

  describe('quyền + cờ', () => {
    it('không có quyền nhóm Kết nối & AI → 403 cả status lẫn audit-logs', async () => {
      const u = await makeUser(prisma, { grants: {} })
      await api(app, u.token).get('/api/v1/integrations/status').expect(403)
      await api(app, u.token).get('/api/v1/integrations/audit-logs').expect(403)
    })

    it('chỉ ai_connect hoặc webhooks: đọc được status, KHÔNG đọc được nhật ký toàn công ty (cần ai_admin) → 403', async () => {
      for (const perm of ['integrations.ai_connect', 'integrations.webhooks'] as const) {
        const u = await makeUser(prisma, { grants: { [perm]: true } })
        await api(app, u.token).get('/api/v1/integrations/status').expect(200)
        process.env.INTEGRATIONS_MCP_ENABLED = 'true'
        await api(app, u.token).get('/api/v1/integrations/audit-logs').expect(403)
        delete process.env.INTEGRATIONS_MCP_ENABLED
      }
    })

    it('cờ tắt (mặc định): status 200 {false,false}; audit-logs 404 dù đủ quyền', async () => {
      const u = await makeUser(prisma, { grants: { 'integrations.ai_admin': true } })
      const s = await api(app, u.token).get('/api/v1/integrations/status').expect(200)
      expect(s.body).toEqual({ webhooks_enabled: false, mcp_enabled: false, secret_key_configured: false, mcp_base_url_configured: false, mcp_url: null })
      await api(app, u.token).get('/api/v1/integrations/audit-logs').expect(404)
    })

    it('cờ bật + ai_admin: 200, lọc kênh/trạng thái, phân trang cursor, tham số sai → 400', async () => {
      process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'
      const u = await makeUser(prisma, { grants: { 'integrations.ai_admin': true } })
      const audit = app.get(IntegrationAuditService)
      for (let i = 0; i < 3; i++) await audit.log({ channel: 'mcp', action: `tool_${i}`, status: 'ok', userId: u.id })
      await audit.log({ channel: 'webhook_out', action: 'contact.created', status: 'error', httpStatus: 500 })

      const s = await api(app, u.token).get('/api/v1/integrations/status').expect(200)
      expect(s.body).toEqual({ webhooks_enabled: true, mcp_enabled: false, secret_key_configured: false, mcp_base_url_configured: false, mcp_url: null })

      const all = await api(app, u.token).get('/api/v1/integrations/audit-logs').expect(200)
      expect(all.body.data).toHaveLength(4)
      expect(all.body.meta.next_cursor).toBeNull()
      expect(all.body.data[0].action).toBe('contact.created') // mới → cũ

      const mcp = await api(app, u.token).get('/api/v1/integrations/audit-logs?channel=mcp&status=ok').expect(200)
      expect(mcp.body.data.map((r: { channel: string }) => r.channel)).toEqual(['mcp', 'mcp', 'mcp'])

      const p1 = await api(app, u.token).get('/api/v1/integrations/audit-logs?limit=3').expect(200)
      expect(p1.body.data).toHaveLength(3)
      const p2 = await api(app, u.token)
        .get(`/api/v1/integrations/audit-logs?limit=3&cursor=${p1.body.meta.next_cursor}`)
        .expect(200)
      expect(p2.body.data).toHaveLength(1)
      const ids = [...p1.body.data, ...p2.body.data].map((r: { id: string }) => r.id)
      expect(new Set(ids).size).toBe(4)

      await api(app, u.token).get('/api/v1/integrations/audit-logs?channel=sms').expect(400)
      await api(app, u.token).get('/api/v1/integrations/audit-logs?limit=9999').expect(400)
      await api(app, u.token).get('/api/v1/integrations/audit-logs?cursor=abc').expect(400)
    })

    it('nhật ký KHÔNG lưu SĐT đầy đủ/secret dù caller nhét vào', async () => {
      const audit = app.get(IntegrationAuditService)
      await audit.log({
        channel: 'webhook_in', action: 'receive', status: 'error', error: 'SĐT 0912345678 trùng',
        metadata: { phone: '0912345678', client_secret: 'topsecret', body: 'gọi 0987654321 nhé' },
      })
      const row = await prisma.integrationAuditLog.findFirstOrThrow()
      const json = JSON.stringify(row)
      for (const leak of ['0912345678', '0987654321', 'topsecret']) expect(json).not.toContain(leak)
    })

    it('vai trò hệ thống Quản trị tự có đủ 3 quyền mới', async () => {
      process.env.INTEGRATIONS_MCP_ENABLED = 'true'
      const admin = await makeUser(prisma, { admin: true })
      await api(app, admin.token).get('/api/v1/integrations/status').expect(200)
      await api(app, admin.token).get('/api/v1/integrations/audit-logs').expect(200)
      const me = await api(app, admin.token).get('/api/v1/auth/me').expect(200)
      for (const k of ['integrations.webhooks', 'integrations.ai_connect', 'integrations.ai_admin']) {
        expect(me.body.permissions[k]).toBe(true)
      }
      const cat = await api(app, admin.token).get('/api/v1/rbac/catalog').expect(200)
      const defs = cat.body.permissions as Array<{ key: string; group: string; sensitive?: boolean }>
      expect(defs.filter((d) => d.group === 'Kết nối & AI').map((d) => d.key).sort()).toEqual([
        // + 3 quyền chương trình con (`extensions.view|draft|approve`) cùng nhóm.
        'extensions.approve', 'extensions.draft', 'extensions.view', 'integrations.ai_admin', 'integrations.ai_connect', 'integrations.webhooks',
      ])
    })

    it('org-feature "integrations" là khoá hợp lệ của PUT /settings/org-features', async () => {
      const u = await makeUser(prisma, { grants: { 'settings.features': true } })
      const res = await api(app, u.token).put('/api/v1/settings/org-features').send({ integrations: false }).expect(200)
      expect(res.body.integrations).toBe(false)
      await api(app, u.token).put('/api/v1/settings/org-features').send({ integrations: true }).expect(200)
    })
  })

  describe('outbox — mọi đường ghi để lại dòng integration_events (cờ TẮT)', () => {
    it('POST /contacts → contact.created (actor = người tạo, SĐT thô trong payload)', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.create': true } })
      const res = await api(app, u.token)
        .post('/api/v1/contacts')
        .send({ phone: PHONES[0], full_name: 'Khách outbox', source_id: srcId, stage_id: stageA })
        .expect(201)
      const id = res.body.contact.id
      const evs = await events()
      expect(evs.map((e) => e.event_type)).toEqual(['contact.created'])
      expect(evs[0]).toMatchObject({ resource: 'contact', resource_id: String(id), actor_user_id: u.id, dispatched_at: null })
      const p = evs[0].payload as { contact: { id: number; phone: string; stage_id: number }; origin: string }
      expect(p.contact).toMatchObject({ id, phone: PHONES[0], stage_id: stageA })
      expect(p.origin).toBe('manual')
    })

    it('POST /contacts kèm deal_assigned_to → contact.created + deal.created', async () => {
      const sale = await makeUser(prisma, { grants: {} })
      const u = await makeUser(prisma, { grants: { 'contacts.create': true, 'deals.manage': 'all' } })
      await api(app, u.token)
        .post('/api/v1/contacts')
        .send({ phone: PHONES[0], full_name: 'Khách + deal', source_id: srcId, deal_assigned_to: sale.id })
        .expect(201)
      expect((await events()).map((e) => e.event_type).sort()).toEqual(['contact.created', 'deal.created'])
    })

    it('PATCH /contacts/:id đổi giai đoạn → contact.updated + contact.stage_changed (from/to); sửa tên thì chỉ contact.updated', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.update': 'all' } })
      const c = await prisma.contact.create({
        data: { phone: PHONES[0], full_name: null, assigned_to: u.id, stage_id: stageA },
      })
      await api(app, u.token).patch(`/api/v1/contacts/${c.id}`).send({ stage_id: stageB }).expect(200)
      let evs = await events()
      expect(evs.map((e) => e.event_type).sort()).toEqual(['contact.stage_changed', 'contact.updated'])
      const st = evs.find((e) => e.event_type === 'contact.stage_changed')!.payload as { from_stage_id: number; to_stage_id: number }
      expect(st).toMatchObject({ from_stage_id: stageA, to_stage_id: stageB })
      const up = evs.find((e) => e.event_type === 'contact.updated')!.payload as { changed_fields: string[] }
      expect(up.changed_fields).toEqual(['stage_id'])

      await prisma.integrationEvent.deleteMany()
      await api(app, u.token).patch(`/api/v1/contacts/${c.id}`).send({ full_name: 'Tên mới' }).expect(200)
      evs = await events()
      expect(evs.map((e) => e.event_type)).toEqual(['contact.updated'])
      expect((evs[0].payload as { changed_fields: string[] }).changed_fields).toEqual(['full_name'])
    })

    it('PATCH không đổi gì thật (chỉ gửi giá trị rỗng/undefined) → KHÔNG có sự kiện', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.update': 'all' } })
      const c = await prisma.contact.create({ data: { phone: PHONES[0], full_name: 'A', assigned_to: u.id } })
      await api(app, u.token).patch(`/api/v1/contacts/${c.id}`).send({}).expect(200)
      expect(await events()).toHaveLength(0)
    })

    it('POST /contacts/:id/transfer → contact.assigned (from/to + lý do); chuyển bị từ chối → không có sự kiện', async () => {
      const boss = await makeUser(prisma, { grants: { 'contacts.transfer': 'all' } })
      const from = await makeUser(prisma, { grants: {} })
      const to = await makeUser(prisma, { grants: {} })
      const c = await prisma.contact.create({ data: { phone: PHONES[0], full_name: 'A', assigned_to: from.id } })
      await api(app, boss.token).post(`/api/v1/contacts/${c.id}/transfer`).send({ new_assigned_to: 99999999 }).expect(400)
      expect(await events()).toHaveLength(0)
      await api(app, boss.token).post(`/api/v1/contacts/${c.id}/transfer`).send({ new_assigned_to: to.id, reason: 'nghỉ việc' }).expect(201)
      const evs = await events('contact.assigned')
      expect(evs).toHaveLength(1)
      expect(evs[0].actor_user_id).toBe(boss.id)
      expect(evs[0].payload).toMatchObject({ from_user_id: from.id, to_user_id: to.id, reason: 'nghỉ việc', contact: { id: c.id, assigned_to: to.id } })
    })

    it('DELETE /contacts/:id (xoá mềm) → contact.deleted có deleted_at', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.delete': 'all' } })
      const c = await prisma.contact.create({ data: { phone: PHONES[0], full_name: 'A', assigned_to: u.id } })
      await api(app, u.token).delete(`/api/v1/contacts/${c.id}`).expect(200)
      const evs = await events('contact.deleted')
      expect(evs).toHaveLength(1)
      expect((evs[0].payload as { contact: { id: number; deleted_at: string | null } }).contact).toMatchObject({ id: c.id })
      expect((evs[0].payload as { contact: { deleted_at: string | null } }).contact.deleted_at).not.toBeNull()
    })

    it('POST /public/contacts (khoá API) → contact.created origin public_api, response không lộ trường snapshot', async () => {
      const owner = await makeUser(prisma, { grants: {} })
      const raw = `e2e-int-key-${Date.now()}`
      await prisma.apiKey.create({
        data: {
          name: 'e2e-int-key', prefix: raw.slice(0, 24), key_hash: createHash('sha256').update(raw).digest('hex'),
          scopes: ['contacts:create'], owner_user_id: owner.id, created_by: owner.id,
        },
      })
      const res = await api(app)
        .post('/api/v1/public/contacts')
        .set('X-API-Key', raw)
        .send({ phone: PHONES[1], full_name: 'Khách API', source_id: srcId })
        .expect(201)
      expect(Object.keys(res.body.contact).sort()).toEqual(['assigned_to', 'created_at', 'full_name', 'id', 'phone', 'source_id'])
      const evs = await events('contact.created')
      expect(evs).toHaveLength(1)
      expect(evs[0].payload).toMatchObject({ origin: 'public_api', contact: { id: res.body.contact.id, assigned_to: owner.id } })
    })

    it('Deal: tạo → deal.created; đổi status won → stage_changed + won; lost → stage_changed + lost; sửa tên → không sự kiện', async () => {
      const u = await makeUser(prisma, { grants: { 'deals.manage': 'all' } })
      const created = await api(app, u.token)
        .post('/api/v1/deals')
        .send({ title: 'E2E int deal 1', assigned_to: u.id, value: 5_000_000 })
        .expect(201)
      const id = created.body.id
      expect((await events()).map((e) => e.event_type)).toEqual(['deal.created'])
      expect((await events())[0].payload).toMatchObject({ deal: { id, value: '5000000', status: 'open' } })

      await prisma.integrationEvent.deleteMany()
      await api(app, u.token).patch(`/api/v1/deals/${id}`).send({ title: 'E2E int deal 1b' }).expect(200)
      expect(await events()).toHaveLength(0)

      await api(app, u.token).patch(`/api/v1/deals/${id}`).send({ status: 'won' }).expect(200)
      let evs = await events()
      expect(evs.map((e) => e.event_type)).toEqual(['deal.stage_changed', 'deal.won'])
      expect(evs[0].payload).toMatchObject({ from_status: 'open', to_status: 'won' })

      await prisma.integrationEvent.deleteMany()
      await api(app, u.token).patch(`/api/v1/deals/${id}`).send({ status: 'lost' }).expect(200)
      evs = await events()
      expect(evs.map((e) => e.event_type)).toEqual(['deal.stage_changed', 'deal.lost'])
      expect(evs[0].payload).toMatchObject({ from_status: 'won', to_status: 'lost' })
    })

    it('Deal tạo thẳng ở trạng thái won → deal.created + deal.won', async () => {
      const u = await makeUser(prisma, { grants: { 'deals.manage': 'all' } })
      await api(app, u.token).post('/api/v1/deals').send({ title: 'E2E int deal 2', assigned_to: u.id, status: 'won' }).expect(201)
      expect((await events()).map((e) => e.event_type)).toEqual(['deal.created', 'deal.won'])
    })

    it('ROLLBACK: transaction nghiệp vụ lỗi sau khi publish → KHÔNG còn dòng outbox; commit → có đúng 1 dòng', async () => {
      const snap = snapshotContact({ id: 1 })
      await expect(
        prisma.$transaction(async (tx) => {
          await publishIntegrationEvent(tx, 'contact.created', { contact: snap }, { resourceId: 1 })
          throw new Error('nghiệp vụ lỗi')
        }),
      ).rejects.toThrow('nghiệp vụ lỗi')
      expect(await events()).toHaveLength(0)
      await prisma.$transaction(async (tx) => {
        await publishIntegrationEvent(tx, 'contact.created', { contact: snap }, { resourceId: 1 })
      })
      expect(await events()).toHaveLength(1)
    })

    it('cờ TẮT ⇒ route nhật ký 404 nhưng outbox vẫn ghi (chỉ thêm insert, không đổi hành vi nghiệp vụ)', async () => {
      const u = await makeUser(prisma, { grants: { 'contacts.create': true, 'integrations.ai_admin': true } })
      await api(app, u.token)
        .post('/api/v1/contacts')
        .send({ phone: PHONES[2], full_name: 'Khách cờ tắt', source_id: srcId })
        .expect(201)
      await api(app, u.token).get('/api/v1/integrations/audit-logs').expect(404)
      expect(await events('contact.created')).toHaveLength(1)
    })
  })
})
