import { randomBytes } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { INestApplication } from '@nestjs/common'
import { publishIntegrationEvent, type PrismaService } from '@trinity/prisma'
import { RbacCache } from '@trinity/rbac-nest'
import { bootApp, resetDb, makeUser, api } from './harness'
// Import trực tiếp từ nguồn crm (cùng cách MonolithModule gộp service).
import { WebhookDispatcherService } from '../../../../services/crm/src/integrations/webhooks/webhook-dispatcher.service'
import { WebhookDeliveryWorker } from '../../../../services/crm/src/integrations/webhooks/webhook-delivery-worker.service'
import { verifySignatureHeader } from '../../../../services/crm/src/integrations/webhooks/signature'

/**
 * webhook RA: quyền/cờ/khoá, CRUD (secret 1 lần), SSRF, gửi THẬT tới server cục bộ
 * (đúng chữ ký, SĐT che theo quyền chủ thể), thử lại, claim song song, chủ thể mất quyền, chuyển chủ thể.
 */
const ENV_KEYS = ['INTEGRATIONS_WEBHOOKS_ENABLED', 'INTEGRATIONS_MCP_ENABLED', 'INTEGRATIONS_SECRET_KEY', 'INTEGRATIONS_ALLOW_PRIVATE_TARGETS'] as const
const PHONE = '0900000356'
const B = '/api/v1/integrations/webhooks'

interface Seen { headers: http.IncomingHttpHeaders; body: string }

describe('RBAC E2E — Webhook ra', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  let server: http.Server
  let url: string
  let seen: Seen[] = []
  let status = 200
  let dispatcher: WebhookDispatcherService
  let worker: WebhookDeliveryWorker

  const enable = () => {
    process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'
    process.env.INTEGRATIONS_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS = 'true' // chỉ có tác dụng vì NODE_ENV=test
  }

  beforeAll(async () => {
    ENV_KEYS.forEach((k) => delete process.env[k])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
    dispatcher = app.get(WebhookDispatcherService)
    worker = app.get(WebhookDeliveryWorker)
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({ headers: req.headers, body })
        res.statusCode = status
        res.end('x')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
  }, 60_000)

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    await close()
  })

  beforeEach(() => { seen = []; status = 200 })
  afterEach(async () => {
    ENV_KEYS.forEach((k) => delete process.env[k])
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE webhook_deliveries, webhook_endpoints, integration_events, integration_audit_logs RESTART IDENTITY`)
    await prisma.$executeRawUnsafe(`DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await resetDb(prisma)
  })

  const mkEndpoint = async (token: string, over: Record<string, unknown> = {}) => {
    const res = await api(app, token).post(`${B}/endpoints`).send({ name: 'Test', url, events: ['contact.created'], ...over }).expect(201)
    return res.body as { id: number; secret: string }
  }
  const contactEvent = (assigned: number, phone = PHONE) =>
    publishIntegrationEvent(prisma, 'contact.created', {
      contact: {
        id: 1, phone, phone_2: null, full_name: 'Khách A', email: null, zalo_account: null, source_id: null, stage_id: null,
        contact_status_id: null, assigned_to: assigned, team_id: null, created_by_id: assigned, project_id: null,
        created_at: new Date().toISOString(), updated_at: null, deleted_at: null,
      },
      origin: 'manual',
    }, { resourceId: 1, actorUserId: assigned })

  describe('quyền + cờ + khoá', () => {
    it('không có integrations.webhooks → 403 mọi route (dù cờ bật); chỉ ai_admin/ai_connect cũng 403', async () => {
      enable()
      for (const g of [{}, { 'integrations.ai_admin': true }, { 'integrations.ai_connect': true }] as const) {
        const u = await makeUser(prisma, { grants: g })
        await api(app, u.token).get(`${B}/events`).expect(403)
        await api(app, u.token).get(`${B}/endpoints`).expect(403)
        await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'] }).expect(403)
        await api(app, u.token).get(`${B}/endpoints/1`).expect(403)
        await api(app, u.token).patch(`${B}/endpoints/1`).send({ name: 'y' }).expect(403)
        await api(app, u.token).delete(`${B}/endpoints/1`).expect(403)
        await api(app, u.token).post(`${B}/endpoints/1/rotate-secret`).expect(403)
        await api(app, u.token).post(`${B}/endpoints/1/test`).expect(403)
        await api(app, u.token).get(`${B}/deliveries`).expect(403)
        await api(app, u.token).post(`${B}/deliveries/00000000-0000-4000-8000-000000000000/retry`).expect(403)
      }
      await api(app).get(`${B}/endpoints`).expect(401)
    })

    it('cờ tắt (mặc định) → 404 mọi route dù đủ quyền', async () => {
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      await api(app, u.token).get(`${B}/events`).expect(404)
      await api(app, u.token).get(`${B}/endpoints`).expect(404)
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'] }).expect(404)
      await api(app, u.token).get(`${B}/deliveries`).expect(404)
    })

    it('cờ bật nhưng THIẾU/SAI INTEGRATIONS_SECRET_KEY → 503 rõ ràng khi tạo/tạo lại/gửi thử; xem danh sách vẫn được; status báo thiếu khoá', async () => {
      process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const r = await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'] }).expect(503)
      expect(r.body.message).toMatch(/INTEGRATIONS_SECRET_KEY/)
      await api(app, u.token).get(`${B}/endpoints`).expect(200)
      expect((await api(app, u.token).get('/api/v1/integrations/status').expect(200)).body.secret_key_configured).toBe(false)
      process.env.INTEGRATIONS_SECRET_KEY = randomBytes(16).toString('base64') // sai độ dài
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'] }).expect(503)
      process.env.INTEGRATIONS_SECRET_KEY = randomBytes(32).toString('base64')
      process.env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS = 'true'
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'] }).expect(201)
    })

    it('DTO sai → 400; id không có → 404; id không phải số → 400', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      await api(app, u.token).post(`${B}/endpoints`).send({ name: '', url, events: ['contact.created'] }).expect(400)
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url: 'không-phải-url', events: ['contact.created'] }).expect(400)
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: [] }).expect(400)
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['nope'] }).expect(400)
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'], extra: 1 }).expect(400)
      await api(app, u.token).get(`${B}/endpoints/99999`).expect(404)
      await api(app, u.token).get(`${B}/endpoints/abc`).expect(400)
      await api(app, u.token).get(`${B}/deliveries?status=zzz`).expect(400)
      await api(app, u.token).post(`${B}/deliveries/00000000-0000-4000-8000-000000000000/retry`).expect(404)
    })
  })

  describe('SSRF — URL bị chặn khi tạo/sửa (cờ ALLOW_PRIVATE không có hoặc không đủ)', () => {
    it.each([
      'http://example.com/h', 'https://127.0.0.1/h', 'https://localhost/h', 'https://[::1]/h', 'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/h', 'https://2130706433/h', 'https://0x7f.1/h', 'https://[::ffff:7f00:1]/h', 'https://user:pw@example.com/h', 'https://example.com:5432/h',
    ])('chặn %s', async (bad) => {
      process.env.INTEGRATIONS_WEBHOOKS_ENABLED = 'true'
      process.env.INTEGRATIONS_SECRET_KEY = randomBytes(32).toString('base64')
      // KHÔNG đặt ALLOW_PRIVATE_TARGETS
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url: bad, events: ['contact.created'] }).expect(400)
    })

    it('production giả lập (NODE_ENV=production + cờ riêng lẻ) vẫn chặn 127.0.0.1', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const prev = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        await api(app, u.token).post(`${B}/endpoints`).send({ name: 'x', url, events: ['contact.created'] }).expect(400)
      } finally {
        process.env.NODE_ENV = prev
      }
    })

    it('sửa URL sang địa chỉ nội bộ → 400, URL cũ giữ nguyên', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const ep = await mkEndpoint(u.token)
      delete process.env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS
      await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ url: 'https://169.254.169.254/x' }).expect(400)
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).url).toBe(url)
    })
  })

  describe('CRUD + secret', () => {
    it('secret chỉ trả khi tạo/tạo lại; DB lưu bản mã; list/get/audit KHÔNG lộ secret', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const ep = await mkEndpoint(u.token, { name: 'Zap' })
      expect(ep.secret).toMatch(/^whsec_/)
      const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
      expect(row.secret_enc).not.toContain(ep.secret)
      expect(row.created_by).toBe(u.id)

      const list = await api(app, u.token).get(`${B}/endpoints`).expect(200)
      const get = await api(app, u.token).get(`${B}/endpoints/${ep.id}`).expect(200)
      for (const body of [list.body, get.body]) {
        const json = JSON.stringify(body)
        expect(json).not.toContain(ep.secret)
        expect(json).not.toContain('secret_enc')
        expect(json).not.toContain(row.secret_enc)
      }
      expect(get.body.secret_set).toBe(true)

      const rot = await api(app, u.token).post(`${B}/endpoints/${ep.id}/rotate-secret`).expect(200)
      expect(rot.body.secret).toMatch(/^whsec_/)
      expect(rot.body.secret).not.toBe(ep.secret)
      const audits = JSON.stringify(await prisma.integrationAuditLog.findMany())
      expect(audits).not.toContain(ep.secret)
      expect(audits).not.toContain(rot.body.secret)
      expect(audits).toContain('endpoint.created')
      expect(audits).toContain('endpoint.secret_rotated')
    })

    it('sửa tên/bật tắt/sự kiện; xoá endpoint kèm lịch sử; tối đa 20 endpoint', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const ep = await mkEndpoint(u.token)
      const up = await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ name: 'Mới', is_active: false, events: ['deal.won', 'contact.created'] }).expect(200)
      expect(up.body).toMatchObject({ name: 'Mới', is_active: false, events: ['deal.won', 'contact.created'], disabled_reason: 'manual' })
      const on = await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ is_active: true }).expect(200)
      expect(on.body).toMatchObject({ is_active: true, disabled_reason: null, consecutive_failures: 0 })
      await api(app, u.token).post(`${B}/endpoints/${ep.id}/test`).expect(200)
      expect(await prisma.webhookDelivery.count()).toBe(1)
      await api(app, u.token).delete(`${B}/endpoints/${ep.id}`).expect(200)
      expect(await prisma.webhookDelivery.count()).toBe(0)
      await api(app, u.token).get(`${B}/endpoints/${ep.id}`).expect(404)

      for (let i = 0; i < 20; i++) await mkEndpoint(u.token, { name: `E${i}` })
      await api(app, u.token).post(`${B}/endpoints`).send({ name: 'thừa', url, events: ['contact.created'] }).expect(400)
    })

    it('danh mục sự kiện', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const res = await api(app, u.token).get(`${B}/events`).expect(200)
      expect(res.body.map((e: { type: string }) => e.type)).toContain('pos.order.completed')
      expect(res.body).toHaveLength(15)
    })
  })

  describe('gửi THẬT tới server cục bộ', () => {
    it('ping: nhận đúng chữ ký (secret hiển thị lúc tạo), header, body; lịch sử không có payload', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const ep = await mkEndpoint(u.token)
      const r = await api(app, u.token).post(`${B}/endpoints/${ep.id}/test`).expect(200)
      expect(r.body).toMatchObject({ ok: true, status_code: 200, error: null })
      expect(seen).toHaveLength(1)
      const s = seen[0]
      expect(verifySignatureHeader(ep.secret, s.body, s.headers['x-trinity-signature'] as string)).toBe(true)
      expect(s.headers['x-trinity-event']).toBe('ping')
      expect(s.headers['x-trinity-delivery']).toBe(r.body.delivery_id)
      const parsed = JSON.parse(s.body)
      expect(parsed).toMatchObject({ id: r.body.delivery_id, type: 'ping', data: { message: 'Trinity webhook test' } })
      expect(new Date(parsed.created_at).toString()).not.toBe('Invalid Date')

      const list = await api(app, u.token).get(`${B}/deliveries?endpoint_id=${ep.id}`).expect(200)
      expect(list.body.data).toHaveLength(1)
      expect(list.body.data[0]).toMatchObject({ event_type: 'ping', status: 'success', attempts: 1, last_status_code: 200 })
      expect(list.body.data[0]).not.toHaveProperty('payload')
    })

    it('ping lỗi 500: dead ngay (không thử lại), KHÔNG tính vào lỗi liên tiếp', async () => {
      enable()
      status = 500
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const ep = await mkEndpoint(u.token)
      const r = await api(app, u.token).post(`${B}/endpoints/${ep.id}/test`).expect(200)
      expect(r.body).toMatchObject({ ok: false, status_code: 500, error: 'http_500' })
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).consecutive_failures).toBe(0)
      expect((await prisma.webhookDelivery.findFirstOrThrow()).status).toBe('dead')
    })

    it('outbox → delivery → gửi: chữ ký đúng, SĐT che khi chủ thể KHÔNG có phone_full, nhật ký sạch SĐT/secret/URL', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } }) // không phone_full
      const ep = await mkEndpoint(u.token)
      await contactEvent(u.id)
      await dispatcher.tick()

      expect(seen).toHaveLength(1)
      const s = seen[0]
      expect(verifySignatureHeader(ep.secret, s.body, s.headers['x-trinity-signature'] as string)).toBe(true)
      expect(s.headers['x-trinity-event']).toBe('contact.created')
      const body = JSON.parse(s.body)
      expect(body.type).toBe('contact.created')
      expect(body.id).toBe(s.headers['x-trinity-delivery'])
      expect(body.data.contact.phone).toBe('***356')
      expect(s.body).not.toContain(PHONE)

      const d = await prisma.webhookDelivery.findFirstOrThrow()
      expect(d).toMatchObject({ status: 'success', attempts: 1, last_status_code: 200, event_type: 'contact.created' })
      expect(JSON.stringify(d.payload)).not.toContain(PHONE) // payload lưu đã che
      expect((await prisma.integrationEvent.findFirstOrThrow()).dispatched_at).not.toBeNull()
      const epRow = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
      expect(epRow.last_success_at).not.toBeNull()
      expect(epRow.consecutive_failures).toBe(0)

      const audit = JSON.stringify(await prisma.integrationAuditLog.findMany({ where: { channel: 'webhook_out' } }))
      for (const leak of [PHONE, ep.secret, '127.0.0.1', '/hook']) expect(audit).not.toContain(leak)
      expect(audit).toContain('contact.created')
    })

    it('chủ thể có contacts.phone_full → SĐT đầy đủ', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all', 'contacts.phone_full': 'all' } })
      await mkEndpoint(u.token)
      await contactEvent(u.id)
      await dispatcher.tick()
      expect(JSON.parse(seen[0].body).data.contact.phone).toBe(PHONE)
    })

    it('chủ thể contacts.view scope own: chỉ nhận sự kiện của khách mình; khách người khác không gửi', async () => {
      enable()
      const other = await makeUser(prisma, { grants: {} })
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'own' } })
      await mkEndpoint(u.token)
      await contactEvent(other.id)
      await contactEvent(u.id)
      await dispatcher.tick()
      expect(seen).toHaveLength(1)
      expect(JSON.parse(seen[0].body).data.contact.assigned_to).toBe(u.id)
      expect(await prisma.webhookDelivery.count()).toBe(1)
    })

    it('chỉ gửi sự kiện đã đăng ký; sự kiện TRƯỚC khi tạo endpoint không bị đẩy; endpoint tắt không nhận', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await contactEvent(u.id) // trước endpoint
      await new Promise((r) => setTimeout(r, 15))
      const ep = await mkEndpoint(u.token, { events: ['deal.won'] })
      await contactEvent(u.id) // đúng thời điểm nhưng sai loại
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
      expect(await prisma.webhookDelivery.count()).toBe(0)
      expect(await prisma.integrationEvent.count({ where: { dispatched_at: null } })).toBe(0) // đã dispatch (không còn kẹt)
      await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ events: ['contact.created'], is_active: false }).expect(200)
      await contactEvent(u.id)
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
    })

    it('cờ TẮT: tick không làm gì (INERT) — sự kiện nằm nguyên trong outbox', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await mkEndpoint(u.token)
      await contactEvent(u.id)
      delete process.env.INTEGRATIONS_WEBHOOKS_ENABLED
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
      expect(await prisma.integrationEvent.count({ where: { dispatched_at: null } })).toBe(1)
      expect(await prisma.webhookDelivery.count()).toBe(0)
    })

    it('dispatcher chạy trùng (2 lần liên tiếp/đồng thời) KHÔNG tạo delivery đôi', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await mkEndpoint(u.token)
      for (let i = 0; i < 5; i++) await contactEvent(u.id)
      const [a, b] = await Promise.all([dispatcher.dispatchEvents(), dispatcher.dispatchEvents()])
      expect(a + b).toBeGreaterThanOrEqual(5)
      expect(await prisma.webhookDelivery.count()).toBe(5) // UNIQUE (endpoint_id, event_id)
    })
  })

  describe('thử lại + chết + tắt tự động + gửi lại', () => {
    const only = async (token: string) => {
      const ep = await mkEndpoint(token)
      await contactEvent((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).created_by)
      return ep
    }
    const forceDue = () => prisma.$executeRawUnsafe(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status IN ('pending','failed')`)

    it('lỗi 500: failed + next_attempt theo lịch 1m/5m/30m/2h/6h/12h, lần thứ 7 → dead; không gửi trước hạn', async () => {
      enable()
      status = 500
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await only(u.token)
      const delays = [60, 300, 1800, 7200, 21600, 43200]
      await dispatcher.tick()
      for (let i = 0; i < 6; i++) {
        const d = await prisma.webhookDelivery.findFirstOrThrow()
        expect(d.status).toBe('failed')
        expect(d.attempts).toBe(i + 1)
        expect(d.last_status_code).toBe(500)
        const wait = (d.next_attempt_at.getTime() - Date.now()) / 1000
        expect(wait).toBeGreaterThan(delays[i] - 5)
        expect(wait).toBeLessThanOrEqual(delays[i] + 1)
        const before = seen.length
        await dispatcher.tick() // chưa đến hạn
        expect(seen.length).toBe(before)
        await forceDue()
        await dispatcher.tick()
      }
      const last = await prisma.webhookDelivery.findFirstOrThrow()
      expect(last).toMatchObject({ status: 'dead', attempts: 7 })
      expect(seen).toHaveLength(7)
      const before = seen.length
      await forceDue(); await dispatcher.tick()
      expect(seen.length).toBe(before) // dead không gửi nữa
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).consecutive_failures).toBe(7)
    })

    it('endpoint lỗi liên tiếp đủ 20 → tự tắt + thông báo người tạo; thành công giữa chừng reset bộ đếm', async () => {
      enable()
      status = 500
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await only(u.token)
      await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { consecutive_failures: 18 } })
      await dispatcher.tick()
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).is_active).toBe(true) // 19
      await forceDue(); await dispatcher.tick() // 20
      const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
      expect(row).toMatchObject({ is_active: false, disabled_reason: 'consecutive_failures', consecutive_failures: 20 })
      const n = await prisma.notificationLog.findMany({ where: { recipient_id: u.id } })
      expect(n).toHaveLength(1)
      expect(n[0]).toMatchObject({ event_type: 'webhook_endpoint_disabled', channel: 'in_app' })
      const before = seen.length
      await forceDue(); await dispatcher.tick()
      expect(seen.length).toBe(before) // đã tắt → không gửi
      await prisma.webhookDelivery.deleteMany(); await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { is_active: true, consecutive_failures: 5 } })
      status = 200
      await contactEvent(u.id); await dispatcher.tick()
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).consecutive_failures).toBe(0)
    })

    it('POST /deliveries/:id/retry: failed/dead → pending rồi gửi được; success hoặc endpoint tắt → 409; ping → 400', async () => {
      enable()
      status = 500
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await only(u.token)
      await dispatcher.tick()
      const d = await prisma.webhookDelivery.findFirstOrThrow()
      status = 200
      await api(app, u.token).post(`${B}/deliveries/${d.id}/retry`).expect(200)
      expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'pending', attempts: 0 })
      await dispatcher.tick()
      expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'success', attempts: 1 })
      await api(app, u.token).post(`${B}/deliveries/${d.id}/retry`).expect(409)

      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'dead' } })
      await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ is_active: false }).expect(200)
      await api(app, u.token).post(`${B}/deliveries/${d.id}/retry`).expect(409)

      await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ is_active: true }).expect(200)
      const ping = await api(app, u.token).post(`${B}/endpoints/${ep.id}/test`).expect(200)
      await prisma.webhookDelivery.update({ where: { id: ping.body.delivery_id }, data: { status: 'dead' } })
      await api(app, u.token).post(`${B}/deliveries/${ping.body.delivery_id}/retry`).expect(400)
    })

    it('lịch sử: lọc theo trạng thái/endpoint + phân trang cursor', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await mkEndpoint(u.token)
      for (let i = 0; i < 5; i++) await contactEvent(u.id)
      await dispatcher.tick()
      const p1 = await api(app, u.token).get(`${B}/deliveries?endpoint_id=${ep.id}&limit=3`).expect(200)
      expect(p1.body.data).toHaveLength(3)
      const p2 = await api(app, u.token).get(`${B}/deliveries?endpoint_id=${ep.id}&limit=3&cursor=${p1.body.meta.next_cursor}`).expect(200)
      expect(p2.body.data).toHaveLength(2)
      expect(p2.body.meta.next_cursor).toBeNull()
      expect(new Set([...p1.body.data, ...p2.body.data].map((r: { id: string }) => r.id)).size).toBe(5)
      expect((await api(app, u.token).get(`${B}/deliveries?status=success`).expect(200)).body.data).toHaveLength(5)
      expect((await api(app, u.token).get(`${B}/deliveries?status=dead`).expect(200)).body.data).toHaveLength(0)
      await api(app, u.token).get(`${B}/deliveries?cursor=abc`).expect(400)
    })
  })

  describe('nhận việc song song + crash', () => {
    it('2 worker claim đồng thời KHÔNG nhận trùng dòng nào (FOR UPDATE SKIP LOCKED); attempts tăng ngay lúc nhận', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await mkEndpoint(u.token)
      for (let i = 0; i < 60; i++) await contactEvent(u.id)
      await dispatcher.dispatchEvents()
      expect(await prisma.webhookDelivery.count({ where: { endpoint_id: ep.id } })).toBe(60)
      const [a, b, c] = await Promise.all([worker.claim(20), worker.claim(20), worker.claim(20)])
      const ids = [...a, ...b, ...c].map((r) => r.id)
      expect(ids).toHaveLength(60)
      expect(new Set(ids).size).toBe(60)
      for (const r of [...a, ...b, ...c]) expect(r.attempts).toBe(1)
      expect(await worker.claim(20)).toHaveLength(0) // đang trong lease → không ai nhận lại
    })

    it('crash giữa lúc gửi: dòng đã nhận nhưng chưa ghi kết quả được nhận lại SAU lease, attempts vẫn có trần', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await mkEndpoint(u.token)
      await contactEvent(u.id)
      await dispatcher.dispatchEvents()
      const first = await worker.claim()
      expect(first).toHaveLength(1) // "crash": không processBatch
      expect(await worker.claim()).toHaveLength(0)
      await prisma.$executeRawUnsafe(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'`) // lease hết hạn
      const again = await worker.claim()
      expect(again).toHaveLength(1)
      expect(again[0].attempts).toBe(2)
      await worker.processBatch(again)
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'success', attempts: 2 })
      // Ghi kết quả muộn của lượt nhận CŨ (attempts=1) không được đè kết quả hiện tại.
      await worker.processBatch(first)
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'success', attempts: 2 })
    })
  })

  describe('các ca biên — trần thử lại, tắt endpoint, ping, sự kiện cũ', () => {
    const only = async (token: string, over: Record<string, unknown> = {}) => {
      const ep = await mkEndpoint(token, over)
      return ep
    }

    it('lượt cuối bị gián đoạn (attempts đã = 7, lease hết) ⇒ KHÔNG được nhận lại, quét về dead (trần tuyệt đối)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await only(u.token)
      await contactEvent(u.id)
      await dispatcher.dispatchEvents()
      await prisma.$executeRawUnsafe(`UPDATE webhook_deliveries SET attempts = 7, status = 'failed', next_attempt_at = now() - interval '1 second'`)
      expect(await worker.claim()).toHaveLength(0)
      expect(await worker.sweepExhausted()).toBe(1)
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'dead', last_error: 'attempts_exhausted', attempts: 7 })
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
    })

    it('tắt endpoint (thủ công) ⇒ delivery chờ chuyển dead; bật lại KHÔNG dội sự kiện cũ', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await only(u.token)
      await contactEvent(u.id)
      await dispatcher.dispatchEvents()
      await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ is_active: false }).expect(200)
      expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ status: 'dead', last_error: 'endpoint_disabled' })
      await api(app, u.token).patch(`${B}/endpoints/${ep.id}`).send({ is_active: true }).expect(200)
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
    })

    it('ping không bao giờ bị worker nhận; nhật ký ghi người bấm gửi thử (không phải chủ endpoint)', async () => {
      enable()
      const owner = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const clicker = await makeUser(prisma, { grants: { 'integrations.webhooks': true } })
      const ep = await only(owner.token)
      await api(app, clicker.token).post(`${B}/endpoints/${ep.id}/test`).expect(200)
      const log = await prisma.integrationAuditLog.findFirstOrThrow({ where: { action: 'ping' } })
      expect(log.user_id).toBe(clicker.id)
      await prisma.webhookDelivery.updateMany({ data: { status: 'pending' } })
      expect(await worker.claim()).toHaveLength(0) // next_attempt_at xa
    })

    it('lỗi cấu hình khoá (đổi INTEGRATIONS_SECRET_KEY) KHÔNG tính vào bộ đếm tự tắt', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await only(u.token)
      await contactEvent(u.id)
      process.env.INTEGRATIONS_SECRET_KEY = randomBytes(32).toString('base64') // khoá mới ⇒ không giải mã được secret cũ
      await dispatcher.tick()
      const d = await prisma.webhookDelivery.findFirstOrThrow()
      expect(d).toMatchObject({ status: 'failed', last_error: 'secret_unavailable' })
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).consecutive_failures).toBe(0)
      expect(seen).toHaveLength(0)
    })

    it('sự kiện outbox cũ hơn 7 ngày (cờ tắt rồi bật lại) không được đẩy; mới thì đẩy', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await prisma.$executeRawUnsafe(`UPDATE webhook_endpoints SET created_at = now() - interval '30 days'`) // không có endpoint thì no-op
      const ep = await only(u.token)
      await prisma.$executeRawUnsafe(`UPDATE webhook_endpoints SET created_at = now() - interval '30 days' WHERE id = ${ep.id}`)
      await contactEvent(u.id)
      await prisma.$executeRawUnsafe(`UPDATE integration_events SET created_at = now() - interval '8 days'`)
      await contactEvent(u.id)
      await dispatcher.tick()
      expect(seen).toHaveLength(1)
      expect(await prisma.integrationEvent.count({ where: { dispatched_at: null } })).toBe(0)
    })

    it('khách có SĐT trong tên/email/lý do chuyển — chủ thể thiếu phone_full không nhận số', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      await only(u.token)
      await publishIntegrationEvent(prisma, 'contact.created', {
        contact: { id: 1, phone: PHONE, phone_2: null, full_name: 'Khách Lan 0912345678', email: '0912345678@example.invalid', zalo_account: null, source_id: null,
          stage_id: null, contact_status_id: null, assigned_to: u.id, team_id: null, created_by_id: u.id, project_id: null, created_at: null, updated_at: null, deleted_at: null },
        origin: 'manual',
      }, { resourceId: 1, actorUserId: u.id })
      await dispatcher.tick()
      expect(seen).toHaveLength(1)
      expect(seen[0].body).not.toContain('0912345678')
      expect(seen[0].body).not.toContain(PHONE)
    })
  })

  describe('chủ thể (người tạo) mất quyền / đổi người sửa', () => {
    it('người tạo mất integrations.webhooks → endpoint tự tắt, delivery chết, KHÔNG gửi gì', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await mkEndpoint(u.token)
      await contactEvent(u.id)
      await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id = ${u.id})`)
      // Như môi trường thật: đổi quyền ⇒ publish rbac:invalidate.
      await app.get(RbacCache).invalidateUsers([u.id])
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
      expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).toMatchObject({ is_active: false, disabled_reason: 'creator_unauthorized' })
    })

    it('người tạo bị khoá → ngừng gửi', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all' } })
      const ep = await mkEndpoint(u.token)
      await contactEvent(u.id)
      await prisma.user.update({ where: { id: u.id }, data: { status: 'locked' } })
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).is_active).toBe(false)
    })

    it('người KHÁC đổi URL ⇒ chủ thể chuyển sang họ (không leo thang SĐT), delivery chờ bị huỷ', async () => {
      enable()
      const admin = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all', 'contacts.phone_full': 'all' } })
      const low = await makeUser(prisma, { grants: { 'integrations.webhooks': true } }) // không contacts.view, không phone_full
      const ep = await mkEndpoint(admin.token)
      await contactEvent(admin.id)
      await dispatcher.dispatchEvents() // delivery dựng theo quyền admin (SĐT rõ), chưa gửi
      expect(await prisma.webhookDelivery.count({ where: { status: 'pending' } })).toBe(1)

      await api(app, low.token).patch(`${B}/endpoints/${ep.id}`).send({ url: `${url}?x=1` }).expect(200)
      const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
      expect(row.created_by).toBe(low.id)
      expect(await prisma.webhookDelivery.count({ where: { status: 'pending' } })).toBe(0) // huỷ
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
      await contactEvent(admin.id)
      await dispatcher.tick()
      expect(seen).toHaveLength(0) // chủ thể mới không có contacts.view → không nhận khách

      // Gửi lại ĐÚNG url/sự kiện đang lưu (UI lưu cả form) bởi người khác → KHÔNG chuyển chủ thể.
      const cur = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
      await api(app, admin.token).patch(`${B}/endpoints/${ep.id}`).send({ url: cur.url, events: [...cur.events].reverse() }).expect(200)
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).created_by).toBe(low.id)
    })

    it('admin đổi SỰ KIỆN / tạo lại SECRET / đổi tên endpoint của người quyền thấp ⇒ chủ thể KHÔNG đổi (URL vẫn của người thấp, không nhận SĐT theo quyền admin)', async () => {
      enable()
      const admin = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all', 'contacts.phone_full': 'all' } })
      const low = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'own' } })
      const ep = await mkEndpoint(low.token, { events: ['contact.created'] })
      await api(app, admin.token).patch(`${B}/endpoints/${ep.id}`).send({ events: ['contact.created', 'contact.updated', 'deal.won'] }).expect(200)
      await api(app, admin.token).post(`${B}/endpoints/${ep.id}/rotate-secret`).expect(200)
      await api(app, admin.token).patch(`${B}/endpoints/${ep.id}`).send({ name: 'admin đổi tên' }).expect(200)
      expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).created_by).toBe(low.id)
      await contactEvent(admin.id) // khách của admin: người thấp (own) không xem được
      await dispatcher.tick()
      expect(seen).toHaveLength(0)
    })

    it('quyền SĐT bị rút SAU khi dựng delivery nhưng TRƯỚC khi gửi → vẫn che (che lại lúc gửi)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.webhooks': true, 'contacts.view': 'all', 'contacts.phone_full': 'all' } })
      await mkEndpoint(u.token)
      await contactEvent(u.id)
      await dispatcher.dispatchEvents()
      expect(JSON.stringify((await prisma.webhookDelivery.findFirstOrThrow()).payload)).toContain(PHONE)
      await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE permission = 'contacts.phone_full' AND role_id IN (SELECT role_id FROM user_roles WHERE user_id = ${u.id})`)
      await app.get(RbacCache).invalidateUsers([u.id])
      await dispatcher.tick()
      expect(seen).toHaveLength(1)
      expect(seen[0].body).not.toContain(PHONE)
      expect(JSON.parse(seen[0].body).data.contact.phone).toBe('***356')
    })
  })
})
