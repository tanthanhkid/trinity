import { createHash, randomBytes } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * AI ghi qua MCP. Mặc định (cài đặt "Yêu cầu duyệt thay đổi do AI" TẮT): thao tác CHẠY NGAY theo quyền người dùng — nhóm "ghi thẳng" ở cuối file.
 * Khi cài đặt BẬT: AI chỉ tạo bản nháp → người dùng DUYỆT bằng JWT phiên web → chạy qua đúng service nghiệp vụ (các nhóm còn lại).
 * Luồng thật: DCR → đồng ý (có/không crm.write) → token → MCP tools/call → (duyệt qua REST).
 */
const BASE = 'http://localhost:4000'
const MCP = `${BASE}/api/v1/mcp`
const ACTIONS = '/api/v1/integrations/ai-actions'
const REDIRECT = 'https://client.example.com/cb'
const ENV = ['INTEGRATIONS_MCP_ENABLED', 'INTEGRATIONS_PUBLIC_BASE_URL'] as const
const FULL_PHONE = '0987654321'
const b64u = (b: Buffer): string => b.toString('base64url')
let ipSeq = 100
const freshIp = (): string => `10.48.0.${(ipSeq += 1) % 250}`

describe('E2E — MCP thao tác: ghi thẳng (mặc định) + chế độ duyệt', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  let sourceId = 0
  let stageA = 0
  let stageB = 0

  const enable = (): void => {
    process.env.INTEGRATIONS_MCP_ENABLED = 'true'
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = BASE
  }
  const form = (path: string, body: Record<string, string>) => request(app.getHttpServer()).post(path).set('x-real-ip', freshIp()).type('form').send(body)

  async function connect(userToken: string, scope = 'crm.read crm.write', granted?: string[]): Promise<{ access: string; clientId: string; scopes: string[] }> {
    const reg = await request(app.getHttpServer()).post('/api/v1/oauth/register').set('x-real-ip', freshIp()).send({ client_name: 'ChatGPT e2e', redirect_uris: [REDIRECT] })
    const clientId = reg.body.client_id as string
    const verifier = b64u(randomBytes(48))
    const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's', resource: MCP, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }
    const ctx = await api(app, userToken).post('/api/v1/oauth/authorize/context').send({ params })
    expect(ctx.status).toBe(200)
    const dec = await api(app, userToken).post('/api/v1/oauth/authorize/decision').send({ params, approve: true, consent_token: ctx.body.consent_token, ...(granted ? { granted_scopes: granted } : {}) })
    const code = new URL(dec.body.redirect_to as string).searchParams.get('code') as string
    const tok = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId })
    expect(tok.status).toBe(200)
    return { access: tok.body.access_token, clientId, scopes: String(tok.body.scope ?? '').split(' ') }
  }

  let rid = 0
  const rpc = (access: string, method: string, params?: unknown) =>
    request(app.getHttpServer()).post('/api/v1/mcp').set('x-real-ip', freshIp()).set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').set('Authorization', `Bearer ${access}`).send({ jsonrpc: '2.0', id: (rid += 1), method, params })
  async function call(access: string, name: string, args: Record<string, unknown> = {}) {
    const r = await rpc(access, 'tools/call', { name, arguments: args })
    expect(r.status).toBe(200)
    return r.body.result as { isError?: boolean; content: { text: string }[]; structuredContent?: { data: Record<string, any> } }
  }
  const propose = async (access: string, name: string, args: Record<string, unknown>): Promise<number> => {
    const r = await call(access, name, args)
    expect({ err: r.isError, text: r.isError ? r.content[0].text : '' }).toEqual({ err: undefined, text: '' })
    return r.structuredContent!.data.action_id as number
  }
  const approve = (token: string, id: number) => api(app, token).post(`${ACTIONS}/${id}/approve`)
  const mkContact = (name: string, o: { assigned_to?: number; created_by_id?: number } = {}) =>
    prisma.contact.create({ data: { phone: '0912345678', full_name: `E2E-ACT ${name}`, assigned_to: o.assigned_to ?? null, created_by_id: o.created_by_id ?? null, stage_id: stageA }, select: { id: true } })

  const WRITER = { 'integrations.ai_connect': true, 'contacts.view': 'own', 'contacts.create': true, 'contacts.update': 'own', 'contacts.transfer': 'team', 'kanban.view': 'own', 'kanban.manage': 'own' } as const

  beforeAll(async () => {
    ENV.forEach((k) => delete process.env[k])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
    const opt = async (group_key: string, value: string) =>
      (await prisma.settingOption.upsert({ where: { group_key_value: { group_key, value } }, update: { is_active: true }, create: { group_key, value, label: `E2E ${value}` }, select: { id: true } })).id
    sourceId = await opt('contact_source', 'e2e_act_src')
    stageA = await opt('contact_stage', 'e2e_act_a')
    stageB = await opt('contact_stage', 'e2e_act_b')
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  const APPROVAL_KEY = 'ai_require_approval'
  const setApproval = (on: boolean) =>
    on
      ? prisma.setting.upsert({ where: { key: APPROVAL_KEY }, update: { value: 'true' }, create: { key: APPROVAL_KEY, value: 'true' } })
      : prisma.setting.deleteMany({ where: { key: APPROVAL_KEY } })
  // Các nhóm bên dưới (trừ "ghi thẳng") kiểm luồng nháp → duyệt ⇒ bật chế độ duyệt; nhóm ghi thẳng tự tắt lại.
  beforeEach(async () => {
    await setApproval(true)
  })

  afterEach(async () => {
    ENV.forEach((k) => delete process.env[k])
    await prisma.$executeRawUnsafe(`DELETE FROM kanban_boards WHERE name LIKE 'E2E-ACT%'`)
    await prisma.$executeRawUnsafe(`DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE full_name LIKE 'E2E-ACT%')`)
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE full_name LIKE 'E2E-ACT%'`)
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs, integration_events, ai_action_drafts RESTART IDENTITY`)
    const redis = app.get(require('../../../../services/crm/src/common/redis.provider').REDIS_CLIENT) as { keys: (p: string) => Promise<string[]>; del: (...k: string[]) => Promise<number> }
    const keys = await redis.keys('mcp:rl:*')
    if (keys.length) await redis.del(...keys)
    await prisma.$executeRawUnsafe(`DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await resetDb(prisma)
  })

  describe('luồng chính: tạo nháp → duyệt', () => {
    it('create_contact: nháp KHÔNG ghi; duyệt bằng JWT web ⇒ khách + outbox contact.created; AI hỏi get_action_status; SĐT đầy đủ không lộ', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      expect(t.scopes).toEqual(['crm.read', 'crm.write'])

      const r = await call(t.access, 'create_contact', { full_name: 'Trần Thị Nháp', phone: FULL_PHONE, source_id: sourceId, stage_id: stageA })
      expect(r.isError).toBeUndefined()
      const d = r.structuredContent!.data
      expect(d).toMatchObject({ status: 'pending', duplicate: false })
      expect(d.review_url).toBe(`${BASE}/ai-actions?id=${d.action_id}`)
      expect(d.message).toContain(`Đã tạo đề xuất #${d.action_id}, chờ người dùng duyệt`)
      expect(JSON.stringify(r)).not.toContain(FULL_PHONE)
      expect(d.summary).toContain('***321')
      // CHƯA ghi nghiệp vụ
      expect(await prisma.contact.count({ where: { full_name: 'Trần Thị Nháp' } })).toBe(0)
      expect(await prisma.integrationEvent.count({ where: { event_type: 'contact.created' } })).toBe(0)
      // thông báo + nhật ký
      const noti = await prisma.notificationLog.findMany({ where: { recipient_id: u.id, event_type: 'ai_action.created' } })
      expect(noti).toHaveLength(1)
      expect(noti[0].action_url).toBe(`/ai-actions?id=${d.action_id}`)
      expect(noti[0].body).not.toContain(FULL_PHONE)
      expect((await prisma.integrationAuditLog.findMany({ where: { action: 'ai_action.draft' } })).length).toBe(1)

      // AI hỏi lại: đang chờ
      const st1 = await call(t.access, 'get_action_status', { id: d.action_id })
      expect(st1.structuredContent!.data.status).toBe('pending')

      // Người dùng xem danh sách + chi tiết (không có `params` thô, SĐT che)
      const list = await api(app, u.token).get(ACTIONS).expect(200)
      expect(list.body.data).toHaveLength(1)
      expect(JSON.stringify(list.body)).not.toContain(FULL_PHONE)
      expect(list.body.data[0]).not.toHaveProperty('params')
      expect(list.body.data[0]).toMatchObject({ tool: 'create_contact', status: 'pending', client_name: 'ChatGPT e2e' })
      expect((await api(app, u.token).get(`${ACTIONS}/pending-count`).expect(200)).body).toEqual({ pending: 1 })

      const ok = await approve(u.token, d.action_id).expect(200)
      expect(ok.body.status).toBe('approved')
      const contactId = ok.body.result.contact_id as number
      const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } })
      expect(c).toMatchObject({ full_name: 'Trần Thị Nháp', phone: FULL_PHONE, assigned_to: u.id, source_id: sourceId })
      const ev = await prisma.integrationEvent.findMany({ where: { event_type: 'contact.created' } })
      expect(ev).toHaveLength(1)
      expect(String(ev[0].resource_id)).toBe(String(contactId))
      expect(ev[0].actor_user_id).toBe(u.id)
      expect((await prisma.integrationAuditLog.findMany({ where: { action: 'ai_action.approve', status: 'ok' } })).length).toBe(1)

      const st2 = await call(t.access, 'get_action_status', { id: d.action_id })
      expect(st2.structuredContent!.data).toMatchObject({ status: 'approved', result: { contact_id: contactId } })
      expect(JSON.stringify(st2)).not.toContain(FULL_PHONE)
      // duyệt lần 2 ⇒ 409, không tạo thêm
      await approve(u.token, d.action_id).expect(409)
      expect(await prisma.contact.count({ where: { full_name: 'Trần Thị Nháp' } })).toBe(1)
    })

    it('add_contact_note / update_contact_stage / assign_contact / create_task: duyệt ⇒ activity, outbox contact.stage_changed + contact.assigned, thẻ giao cho NGƯỜI DUYỆT', async () => {
      enable()
      const boss = await makeUser(prisma, { grants: { 'contacts.view': 'all' } })
      const mate = await makeUser(prisma, { managerId: undefined, grants: { 'contacts.view': 'own' } })
      const u = await makeUser(prisma, { grants: { ...WRITER, 'contacts.view': 'own' } })
      await prisma.user.update({ where: { id: mate.id }, data: { manager_id: u.id } })
      void boss
      const t = await connect(u.token)
      const mine = await mkContact('Của tôi', { assigned_to: u.id })
      const board = await prisma.kanbanBoard.create({ data: { name: 'E2E-ACT bảng', columns: { create: [{ name: 'Mới', position: 1 }, { name: 'Xong', position: 2, is_done: true }] } }, include: { columns: true } })

      const note = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'Khách hẹn liên hệ lại <img src=x onerror=alert(1)> 0912345678' })
      const stage = await propose(t.access, 'update_contact_stage', { contact_id: mine.id, stage_id: stageB })
      const assign = await propose(t.access, 'assign_contact', { contact_id: mine.id, new_assigned_to: mate.id, reason: 'Nghỉ phép' })
      const task = await propose(t.access, 'create_task', { title: 'Liên hệ lại khách', due_at: '2026-12-01T09:00:00Z', priority: 'high', contact_id: mine.id, column_id: board.columns[0].id, assignee_id: boss.id, assignee_ids: [boss.id] })

      const draft = (await api(app, u.token).get(`${ACTIONS}/${note}`).expect(200)).body
      expect(draft.summary).not.toContain('0912345678')
      expect(JSON.stringify(draft.details)).not.toContain('0912345678')
      expect(draft.details.some((l: { value: string }) => l.value.includes('<img'))).toBe(true) // dữ liệu thuần: FE hiển thị bằng text

      await approve(u.token, note).expect(200)
      const act = await prisma.activity.findMany({ where: { contact_id: mine.id, action: 'note' } })
      expect(act).toHaveLength(1)
      expect(act[0].created_by).toBe(u.id)

      await approve(u.token, stage).expect(200)
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: mine.id } })).stage_id).toBe(stageB)
      expect(await prisma.integrationEvent.count({ where: { event_type: 'contact.stage_changed' } })).toBe(1)

      await approve(u.token, task).expect(200)
      const card = await prisma.kanbanCard.findFirstOrThrow({ where: { title: 'Liên hệ lại khách' }, include: { assignees: true } })
      expect(card.created_by).toBe(u.id)
      expect(card.assignees.map((a) => a.user_id)).toEqual([u.id]) // KHÔNG theo assignee của AI
      expect(card.contact_id).toBe(mine.id)

      await approve(u.token, assign).expect(200)
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: mine.id } })).assigned_to).toBe(mate.id)
      expect(await prisma.integrationEvent.count({ where: { event_type: 'contact.assigned' } })).toBe(1)
    })

    it('từ chối ⇒ rejected, không ghi; không duyệt được nữa', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Từ chối', { assigned_to: u.id })
      const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'x' })
      const r = await api(app, u.token).post(`${ACTIONS}/${id}/reject`).expect(200)
      expect(r.body.status).toBe('rejected')
      expect(await prisma.activity.count({ where: { contact_id: mine.id, action: 'note' } })).toBe(0)
      await approve(u.token, id).expect(409)
      await api(app, u.token).post(`${ACTIONS}/${id}/reject`).expect(409)
      expect((await call(t.access, 'get_action_status', { id })).structuredContent!.data.status).toBe('rejected')
    })

    it('trùng tham số đang chờ ⇒ trả lại cùng nháp (duplicate), không nhân bản', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Trùng', { assigned_to: u.id })
      const a = await call(t.access, 'add_contact_note', { contact_id: mine.id, note: 'giống nhau' })
      const b = await call(t.access, 'add_contact_note', { contact_id: mine.id, note: 'giống nhau' })
      expect(b.structuredContent!.data.action_id).toBe(a.structuredContent!.data.action_id)
      expect(b.structuredContent!.data.duplicate).toBe(true)
      expect(await prisma.aiActionDraft.count()).toBe(1)
      expect(await prisma.notificationLog.count({ where: { recipient_id: u.id, event_type: 'ai_action.created' } })).toBe(1)
    })
  })

  describe('quyền + phạm vi (lúc tạo nháp VÀ lúc duyệt)', () => {
    it('thiếu contacts.create ⇒ tool lỗi rõ ràng, KHÔNG có nháp; thiếu scope crm.write ⇒ insufficient_scope', async () => {
      enable()
      const noCreate = await makeUser(prisma, { grants: { 'integrations.ai_connect': true, 'contacts.view': 'own' } })
      const t1 = await connect(noCreate.token)
      const r = await call(t1.access, 'create_contact', { full_name: 'Không quyền', phone: FULL_PHONE, source_id: sourceId })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('contacts.create')
      expect(await prisma.aiActionDraft.count()).toBe(0)
      expect((await prisma.integrationAuditLog.findMany({ where: { action: 'create_contact', status: 'denied' } })).length).toBe(1)

      const readOnly = await makeUser(prisma, { grants: { ...WRITER } })
      const t2 = await connect(readOnly.token, 'crm.read crm.write', ['crm.read']) // người dùng BỎ tick quyền ghi ở màn đồng ý
      expect(t2.scopes).toEqual(['crm.read'])
      const r2 = await call(t2.access, 'create_contact', { full_name: 'Chỉ đọc', phone: FULL_PHONE, source_id: sourceId })
      expect(r2.isError).toBe(true)
      expect(r2.content[0].text).toContain('insufficient_scope')
      expect(await prisma.aiActionDraft.count()).toBe(0)
      // tool đọc vẫn chạy
      expect((await call(t2.access, 'list_contacts')).isError).toBeUndefined()
    })

    it('ngoài phạm vi / tham số sai ⇒ lỗi sớm, không nháp: khách người khác, người nhận ngoài scope, nguồn sai, SĐT sai, cột không thấy', async () => {
      enable()
      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const theirs = await mkContact('Người khác', { assigned_to: other.id })
      const mine = await mkContact('Của tôi', { assigned_to: u.id })
      const stranger = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const cases: [string, Record<string, unknown>][] = [
        ['add_contact_note', { contact_id: theirs.id, note: 'x' }],
        ['update_contact_stage', { contact_id: theirs.id, stage_id: stageB }],
        ['update_contact_stage', { contact_id: mine.id, stage_id: 999999 }],
        ['assign_contact', { contact_id: mine.id, new_assigned_to: stranger.id }], // ngoài scope contacts.transfer 'team'
        ['assign_contact', { contact_id: theirs.id, new_assigned_to: u.id }],
        ['create_contact', { full_name: 'A', phone: '123', source_id: sourceId }],
        ['create_contact', { full_name: 'A', phone: FULL_PHONE, source_id: stageA }], // sai nhóm
        ['create_task', { title: 'x', column_id: 999999 }],
      ]
      for (const [name, args] of cases) {
        const r = await call(t.access, name, args)
        expect({ name, isError: r.isError }).toEqual({ name, isError: true })
      }
      expect(await prisma.aiActionDraft.count()).toBe(0)
    })

    it('quyền bị gỡ GIỮA CHỪNG ⇒ duyệt thất bại có lý do, không ghi; nháp chuyển failed', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const id = await propose(t.access, 'create_contact', { full_name: 'Mất quyền', phone: FULL_PHONE, source_id: sourceId })
      const { RbacCache } = require('@trinity/rbac-nest') as typeof import('@trinity/rbac-nest')
      await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE permission = 'contacts.create'`)
      await app.get(RbacCache).invalidateUsers('*')
      const r = await approve(u.token, id).expect(403)
      expect(JSON.stringify(r.body)).toContain('contacts.create')
      expect(await prisma.contact.count({ where: { full_name: 'Mất quyền' } })).toBe(0)
      const row = await prisma.aiActionDraft.findUniqueOrThrow({ where: { id } })
      expect(row.status).toBe('failed')
      expect(row.error).toContain('contacts.create')
      const st = (await call(t.access, 'get_action_status', { id })).structuredContent!.data
      expect(st).toMatchObject({ status: 'failed' })
      expect(JSON.stringify(st)).not.toContain('contacts.create') // lý do chi tiết chỉ người duyệt thấy (không thành oracle cho AI)
    })

    it('khách bị chuyển ra ngoài phạm vi sau khi tạo nháp ⇒ duyệt thất bại 404, không ghi', async () => {
      enable()
      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const c = await mkContact('Đổi chủ', { assigned_to: u.id })
      const id = await propose(t.access, 'add_contact_note', { contact_id: c.id, note: 'ghi chú' })
      await prisma.contact.update({ where: { id: c.id }, data: { assigned_to: other.id } })
      await approve(u.token, id).expect(404)
      await approve(u.token, 99999999999).expect(404) // id ngoài INT32 không gây 500
      expect(await prisma.activity.count({ where: { contact_id: c.id, action: 'note' } })).toBe(0)
      expect((await prisma.aiActionDraft.findUniqueOrThrow({ where: { id } })).status).toBe('failed')
    })
  })

  describe('không có đường nào để AI tự duyệt', () => {
    it('token OAuth gọi route duyệt/xem/từ chối/danh sách ⇒ 401; người khác duyệt/xem/từ chối ⇒ 404', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Tự duyệt', { assigned_to: u.id })
      const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'AI đừng tự duyệt' })

      const bearer = (m: 'get' | 'post', path: string) => request(app.getHttpServer())[m](path).set('Authorization', `Bearer ${t.access}`)
      expect((await bearer('post', `${ACTIONS}/${id}/approve`)).status).toBe(401)
      expect((await bearer('post', `${ACTIONS}/${id}/reject`)).status).toBe(401)
      expect((await bearer('get', ACTIONS)).status).toBe(401)
      expect((await bearer('get', `${ACTIONS}/${id}`)).status).toBe(401)
      expect((await request(app.getHttpServer()).post(`${ACTIONS}/${id}/approve`)).status).toBe(401)
      expect(await prisma.activity.count({ where: { contact_id: mine.id, action: 'note' } })).toBe(0)
      expect((await prisma.aiActionDraft.findUniqueOrThrow({ where: { id } })).status).toBe('pending')

      const intruder = await makeUser(prisma, { grants: { ...WRITER } })
      await approve(intruder.token, id).expect(404)
      await api(app, intruder.token).post(`${ACTIONS}/${id}/reject`).expect(404)
      await api(app, intruder.token).get(`${ACTIONS}/${id}`).expect(404)
      expect((await api(app, intruder.token).get(ACTIONS).expect(200)).body.data).toEqual([])
      expect((await prisma.aiActionDraft.findUniqueOrThrow({ where: { id } })).status).toBe('pending')
    })

    it('2 yêu cầu duyệt SONG SONG ⇒ đúng 1 thắng, thực thi đúng 1 lần', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const id = await propose(t.access, 'create_contact', { full_name: 'Song song', phone: FULL_PHONE, source_id: sourceId })
      const rs = await Promise.all([approve(u.token, id), approve(u.token, id), approve(u.token, id)])
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409])
      expect(await prisma.contact.count({ where: { full_name: 'Song song' } })).toBe(1)
      expect(await prisma.integrationEvent.count({ where: { event_type: 'contact.created' } })).toBe(1)
    })

    it('nháp quá 24 giờ ⇒ không duyệt được (409), hiển thị expired; job hết hạn chạy được', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Hết hạn', { assigned_to: u.id })
      const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'sẽ hết hạn' })
      const id2 = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'sẽ hết hạn (2)' })
      await prisma.$executeRawUnsafe(`UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute'`)
      expect((await api(app, u.token).get(`${ACTIONS}/${id}`).expect(200)).body.status).toBe('expired') // job chưa chạy vẫn đúng
      expect((await api(app, u.token).get(`${ACTIONS}?status=expired`).expect(200)).body.data).toHaveLength(2)
      expect((await api(app, u.token).get(`${ACTIONS}/pending-count`).expect(200)).body).toEqual({ pending: 0 })
      const r = await approve(u.token, id).expect(409)
      expect(JSON.stringify(r.body)).toContain('hết hạn')
      expect(await prisma.activity.count({ where: { contact_id: mine.id, action: 'note' } })).toBe(0)

      const { AiActionExpiryService } = require('../../../../services/crm/src/integrations/mcp/actions/ai-action-expiry.service') as typeof import('../../../../services/crm/src/integrations/mcp/actions/ai-action-expiry.service')
      expect(await app.get(AiActionExpiryService).runOnce()).toMatchObject({ expired: 1 }) // id2 còn 'pending' trong DB (id đã được đánh dấu khi duyệt hụt)
      expect((await prisma.aiActionDraft.findUniqueOrThrow({ where: { id: id2 } })).status).toBe('expired')
    })
  })

  describe('chống lạm dụng', () => {
    it('trần 50 đề xuất chờ/user và 10 đề xuất/phút (prompt injection tạo hàng loạt) — user khác không bị ảnh hưởng', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const v = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Hàng loạt', { assigned_to: u.id })
      for (let i = 0; i < 10; i += 1) await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: `ghi chú ${i}` })
      const over = await call(t.access, 'add_contact_note', { contact_id: mine.id, note: 'ghi chú 11' })
      expect(over.isError).toBe(true)
      expect(over.content[0].text).toContain('quá nhanh')
      // trần số lượng
      const redis = app.get(require('../../../../services/crm/src/common/redis.provider').REDIS_CLIENT) as { keys: (p: string) => Promise<string[]>; del: (...k: string[]) => Promise<number> }
      const rows = Array.from({ length: 40 }, (_, i) => ({ user_id: u.id, client_id: `other-app-${i % 2}`, tool: 'add_contact_note', params: { contact_id: mine.id, note: `fill ${i}` }, summary: 'x', expires_at: new Date(Date.now() + 3_600_000) }))
      await prisma.aiActionDraft.createMany({ data: rows })
      const keys = await redis.keys('mcp:rl:*')
      if (keys.length) await redis.del(...keys)
      const full = await call(t.access, 'add_contact_note', { contact_id: mine.id, note: 'vượt trần' })
      expect(full.isError).toBe(true)
      expect(full.content[0].text).toContain('50')
      expect(await prisma.aiActionDraft.count({ where: { user_id: u.id } })).toBe(50)
      // người khác vẫn tạo được
      const tv = await connect(v.token)
      const theirs = await mkContact('Của v', { assigned_to: v.id })
      await propose(tv.access, 'add_contact_note', { contact_id: theirs.id, note: 'ok' })
    })

    it('mỗi ỨNG DỤNG tối đa 20 đề xuất chờ: một client bị prompt-injection không chiếm hết hạn mức của người dùng (client khác vẫn tạo được)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const bad = await connect(u.token)
      const good = await connect(u.token)
      const mine = await mkContact('Client cap', { assigned_to: u.id })
      const rows = Array.from({ length: 20 }, (_, i) => ({ user_id: u.id, client_id: bad.clientId, tool: 'add_contact_note', params: { contact_id: mine.id, note: `inj ${i}` }, summary: 'x', expires_at: new Date(Date.now() + 3_600_000) }))
      await prisma.aiActionDraft.createMany({ data: rows })
      const r = await call(bad.access, 'add_contact_note', { contact_id: mine.id, note: 'thêm nữa' })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('Ứng dụng này')
      await propose(good.access, 'add_contact_note', { contact_id: mine.id, note: 'client khác vẫn được' })
    })

    it('tiến trình chết giữa chừng: approved chưa có kết quả ⇒ "executing" rồi "failed" (kết quả không rõ), job ghi nhận; AI KHÔNG được báo "approved"', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Kẹt', { assigned_to: u.id })
      const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'kẹt' })
      await prisma.$executeRawUnsafe(`UPDATE ai_action_drafts SET status = 'approved', decided_at = now() WHERE id = ${id}`)
      expect((await api(app, u.token).get(`${ACTIONS}/${id}`).expect(200)).body.status).toBe('executing')
      expect((await call(t.access, 'get_action_status', { id })).structuredContent!.data.status).toBe('executing')
      await approve(u.token, id).expect(409)
      await prisma.$executeRawUnsafe(`UPDATE ai_action_drafts SET decided_at = now() - interval '10 minutes' WHERE id = ${id}`)
      const v = (await api(app, u.token).get(`${ACTIONS}/${id}`).expect(200)).body
      expect(v.status).toBe('failed')
      expect(v.error).toContain('Không rõ kết quả')
      const { AiActionExpiryService } = require('../../../../services/crm/src/integrations/mcp/actions/ai-action-expiry.service') as typeof import('../../../../services/crm/src/integrations/mcp/actions/ai-action-expiry.service')
      expect(await app.get(AiActionExpiryService).runOnce()).toMatchObject({ stale: 1 })
      expect((await prisma.aiActionDraft.findUniqueOrThrow({ where: { id } })).status).toBe('failed')
    })

    it('tên khách chỉ vào summary khi khách nằm trong phạm vi ĐỌC (contacts.view) — update rộng hơn view không làm lộ tên cho AI', async () => {
      enable()
      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const u = await makeUser(prisma, { grants: { ...WRITER, 'contacts.view': 'own', 'contacts.update': 'all' } })
      const t = await connect(u.token)
      const theirs = await mkContact('Chỉ update thấy', { assigned_to: other.id })
      const r = await call(t.access, 'add_contact_note', { contact_id: theirs.id, note: 'x' })
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r)).not.toContain('Chỉ update thấy')
      expect(await prisma.aiActionDraft.count()).toBe(0)
    })

    it('get_action_status: chỉ thấy nháp do CHÍNH kết nối này tạo (kết nối khác của cùng người ⇒ không thấy)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t1 = await connect(u.token)
      const t2 = await connect(u.token)
      const mine = await mkContact('Kết nối', { assigned_to: u.id })
      const id = await propose(t1.access, 'add_contact_note', { contact_id: mine.id, note: 'riêng' })
      expect((await call(t1.access, 'get_action_status', { id })).isError).toBeUndefined()
      expect((await call(t2.access, 'get_action_status', { id })).isError).toBe(true)
    })

    it('đã đưa vào tools/list: đủ tool đề xuất với annotations đúng; KHÔNG có tool xoá/xuất/quản trị', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const { result } = (await rpc(t.access, 'tools/list')).body
      const tools = result.tools as { name: string; annotations: Record<string, boolean> }[]
      const names = tools.map((x) => x.name)
      expect(names).toEqual(expect.arrayContaining(['create_contact', 'add_contact_note', 'update_contact_stage', 'create_task', 'assign_contact', 'get_action_status', 'list_crm_options']))
      expect(names.filter((n) => /delete|remove|export|download|role|user_|password|approve/i.test(n))).toEqual([])
      const writes = tools.filter((x) => ['create_contact', 'add_contact_note', 'update_contact_stage', 'create_task', 'assign_contact'].includes(x.name))
      expect(writes.every((x) => x.annotations.readOnlyHint === false)).toBe(true)
      const byName = Object.fromEntries(tools.map((x) => [x.name, x.annotations]))
      expect(byName.create_contact.destructiveHint).toBe(false)
      expect(byName.update_contact_stage.destructiveHint).toBe(true)
      expect(byName.assign_contact.destructiveHint).toBe(true)
      expect(byName.list_contacts.readOnlyHint).toBe(true)
    })

    it('list_crm_options: id hợp lệ theo quyền; người nhận chỉ trong scope contacts.transfer', async () => {
      enable()
      const sub = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const stranger = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      await prisma.user.update({ where: { id: sub.id }, data: { manager_id: u.id } })
      const t = await connect(u.token)
      const r = await call(t.access, 'list_crm_options')
      const d = r.structuredContent!.data as Record<string, { id: number }[]>
      expect(d.sources.map((x) => x.id)).toContain(sourceId)
      expect(d.stages.map((x) => x.id)).toEqual(expect.arrayContaining([stageA, stageB]))
      const ids = d.assignable_users.map((x) => x.id)
      expect(ids).toContain(sub.id)
      expect(ids).not.toContain(stranger.id)
    })
  })

  describe('đồng ý OAuth + cờ INERT', () => {
    it('màn đồng ý: crm.write khả dụng + tuỳ chọn; granted_scopes ⊆ scope đã hiển thị; thiếu crm.read ⇒ 400', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const reg = await request(app.getHttpServer()).post('/api/v1/oauth/register').set('x-real-ip', freshIp()).send({ client_name: 'X', redirect_uris: [REDIRECT] })
      const params = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, scope: 'crm.read crm.write', state: 's', resource: MCP, code_challenge: b64u(createHash('sha256').update('v'.repeat(50)).digest()), code_challenge_method: 'S256' }
      const ctx = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params }).expect(200)
      expect(ctx.body.scopes).toEqual([
        expect.objectContaining({ scope: 'crm.read', available: true, optional: false }),
        expect.objectContaining({ scope: 'crm.write', available: true, optional: true }),
      ])
      const decide = (granted?: unknown) => api(app, u.token).post('/api/v1/oauth/authorize/decision').send({ params, approve: true, consent_token: ctx.body.consent_token, ...(granted !== undefined ? { granted_scopes: granted } : {}) })
      expect((await decide(['crm.write'])).status).toBe(400) // thiếu crm.read
      expect((await decide(['crm.read', 'offline_access'])).status).toBe(400) // ngoài tập đã hiển thị
      expect((await decide([])).status).toBe(400)
      expect((await decide('crm.read')).status).toBe(400)
      expect((await decide(['crm.read'])).status).toBe(200)
      const row = await prisma.oauthAuthorizationCode.findFirstOrThrow()
      expect(row.scopes).toEqual(['crm.read'])
    })

    it('cờ tắt ⇒ mọi route đề xuất 404 (deploy INERT)', async () => {
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      await api(app, u.token).get(ACTIONS).expect(404)
      await api(app, u.token).get(`${ACTIONS}/pending-count`).expect(404)
      await api(app, u.token).post(`${ACTIONS}/1/approve`).expect(404)
      await api(app, u.token).post(`${ACTIONS}/1/reject`).expect(404)
    })
  })

  describe('ghi thẳng (cài đặt duyệt TẮT — mặc định)', () => {
    beforeEach(async () => {
      await setApproval(false)
    })

    it('create_contact chạy NGAY: khách + outbox contact.created + audit ai_action.execute; không thông báo chờ duyệt; lịch sử executed; SĐT đầy đủ không lộ', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const r = await call(t.access, 'create_contact', { full_name: 'Trần Thị Thẳng', phone: FULL_PHONE, source_id: sourceId, stage_id: stageA })
      expect(r.isError).toBeUndefined()
      const d = r.structuredContent!.data
      expect(d).toMatchObject({ status: 'executed' })
      const contactId = d.result.contact_id as number
      expect(JSON.stringify(r)).not.toContain(FULL_PHONE)
      const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } })
      expect(c).toMatchObject({ full_name: 'Trần Thị Thẳng', phone: FULL_PHONE, assigned_to: u.id, source_id: sourceId })
      const ev = await prisma.integrationEvent.findMany({ where: { event_type: 'contact.created' } })
      expect(ev).toHaveLength(1)
      expect(ev[0].actor_user_id).toBe(u.id)
      expect((await prisma.integrationAuditLog.findMany({ where: { action: 'ai_action.execute', status: 'ok' } })).length).toBe(1)
      expect(await prisma.notificationLog.count({ where: { recipient_id: u.id, event_type: 'ai_action.created' } })).toBe(0)
      const row = await prisma.aiActionDraft.findUniqueOrThrow({ where: { id: d.action_id } })
      expect(row).toMatchObject({ status: 'executed', tool: 'create_contact' })
      expect(row.result).toMatchObject({ contact_id: contactId })
      // lịch sử "Hoạt động AI": thấy executed, không có gì chờ duyệt
      const list = await api(app, u.token).get(ACTIONS).expect(200)
      expect(list.body.data[0]).toMatchObject({ tool: 'create_contact', status: 'executed', client_name: 'ChatGPT e2e' })
      expect(JSON.stringify(list.body)).not.toContain(FULL_PHONE)
      expect((await api(app, u.token).get(`${ACTIONS}/pending-count`).expect(200)).body).toEqual({ pending: 0 })
      expect((await call(t.access, 'get_action_status', { id: d.action_id })).structuredContent!.data.status).toBe('executed')
    })

    it('add_contact_note / update_contact_stage / create_task chạy ngay theo quyền (activity, outbox, thẻ giao cho chính người dùng)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      const mine = await mkContact('Của tôi thẳng', { assigned_to: u.id })
      const board = await prisma.kanbanBoard.create({ data: { name: 'E2E-ACT bảng thẳng', columns: { create: [{ name: 'Mới', position: 1 }] } }, include: { columns: true } })
      const n = await call(t.access, 'add_contact_note', { contact_id: mine.id, note: 'Ghi thẳng' })
      const s = await call(t.access, 'update_contact_stage', { contact_id: mine.id, stage_id: stageB })
      const k = await call(t.access, 'create_task', { title: 'Việc ghi thẳng', column_id: board.columns[0].id, contact_id: mine.id })
      for (const r of [n, s, k]) expect({ err: r.isError, st: r.structuredContent?.data.status }).toEqual({ err: undefined, st: 'executed' })
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: mine.id } })).stage_id).toBe(stageB)
      expect(await prisma.activity.count({ where: { contact_id: mine.id } })).toBeGreaterThanOrEqual(1)
      const card = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: k.structuredContent!.data.result.card_id as number }, include: { assignees: true } })
      expect(card.title).toBe('Việc ghi thẳng')
    })

    it('thiếu quyền ⇒ lỗi và KHÔNG ghi gì; ngoài phạm vi ⇒ lỗi và KHÔNG ghi gì; token chỉ crm.read ⇒ insufficient_scope', async () => {
      enable()
      const noCreate = await makeUser(prisma, { grants: { 'integrations.ai_connect': true, 'contacts.view': 'own' } })
      const t1 = await connect(noCreate.token)
      const r = await call(t1.access, 'create_contact', { full_name: 'Không quyền thẳng', phone: FULL_PHONE, source_id: sourceId })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('contacts.create')

      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t2 = await connect(u.token)
      const theirs = await mkContact('Người khác thẳng', { assigned_to: other.id })
      const before = await prisma.activity.count({ where: { contact_id: theirs.id } })
      const r2 = await call(t2.access, 'add_contact_note', { contact_id: theirs.id, note: 'Lấn quyền' })
      const r3 = await call(t2.access, 'update_contact_stage', { contact_id: theirs.id, stage_id: stageB })
      expect(r2.isError).toBe(true)
      expect(r3.isError).toBe(true)
      expect(await prisma.activity.count({ where: { contact_id: theirs.id } })).toBe(before)
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: theirs.id } })).stage_id).toBe(stageA)

      const t3 = await connect(u.token, 'crm.read crm.write', ['crm.read'])
      const r4 = await call(t3.access, 'create_contact', { full_name: 'Chỉ đọc thẳng', phone: FULL_PHONE, source_id: sourceId })
      expect(r4.isError).toBe(true)
      expect(r4.content[0].text).toContain('insufficient_scope')

      expect(await prisma.contact.count({ where: { full_name: { in: ['Không quyền thẳng', 'Chỉ đọc thẳng'] } } })).toBe(0)
      expect(await prisma.aiActionDraft.count({ where: { status: 'executed' } })).toBe(0)
    })

    it('quyền bị gỡ sau khi kết nối ⇒ lần ghi kế tiếp bị từ chối (quyền kiểm lại mỗi lần gọi)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      expect((await call(t.access, 'create_contact', { full_name: 'Trước khi gỡ', phone: '0987654322', source_id: sourceId })).isError).toBeUndefined()
      const { RbacCache } = require('@trinity/rbac-nest') as typeof import('@trinity/rbac-nest')
      await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id = ${u.id}) AND permission = 'contacts.create'`)
      await app.get(RbacCache).invalidateUsers('*')
      const r = await call(t.access, 'create_contact', { full_name: 'Sau khi gỡ', phone: '0987654323', source_id: sourceId })
      expect(r.isError).toBe(true)
      expect(await prisma.contact.count({ where: { full_name: 'Sau khi gỡ' } })).toBe(0)
    })

    it('cài đặt: mọi người đọc được, chỉ ai_admin ghi; bật ⇒ AI quay về nháp chờ duyệt (pending, không ghi), tắt ⇒ ghi thẳng lại', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const admin = await makeUser(prisma, { grants: { 'integrations.ai_admin': true } })
      const t = await connect(u.token)
      expect((await api(app, u.token).get(`${ACTIONS}/settings`).expect(200)).body).toEqual({ require_approval: false })
      await api(app, u.token).patch(`${ACTIONS}/settings`).send({ require_approval: true }).expect(403)
      await api(app, admin.token).patch(`${ACTIONS}/settings`).send({ require_approval: 'yes' }).expect(400)
      expect((await api(app, admin.token).patch(`${ACTIONS}/settings`).send({ require_approval: true }).expect(200)).body).toEqual({ require_approval: true })
      const pending = await call(t.access, 'create_contact', { full_name: 'Chờ duyệt thẳng', phone: FULL_PHONE, source_id: sourceId })
      expect(pending.structuredContent!.data.status).toBe('pending')
      expect(await prisma.contact.count({ where: { full_name: 'Chờ duyệt thẳng' } })).toBe(0)
      await api(app, admin.token).patch(`${ACTIONS}/settings`).send({ require_approval: false }).expect(200)
      const direct = await call(t.access, 'create_contact', { full_name: 'Ghi thẳng lại', phone: '0987654324', source_id: sourceId })
      expect(direct.structuredContent!.data.status).toBe('executed')
    })

    it('trần ghi: 31 lần ghi/phút của một user ⇒ lần vượt bị chặn (lời gọi/phút hoặc trần ghi), dữ liệu không bị ghi thêm', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...WRITER } })
      const t = await connect(u.token)
      let ok = 0
      let blocked = 0
      for (let i = 0; i < 31; i += 1) {
        const r = await call(t.access, 'add_contact_note', { contact_id: (await mkContact(`Trần ${i}`, { assigned_to: u.id })).id, note: `n${i}` })
        if (r.isError) blocked += 1
        else ok += 1
      }
      expect(ok).toBeLessThanOrEqual(20) // trần mỗi ứng dụng AI
      expect(blocked).toBeGreaterThanOrEqual(11)
    })
  })
})
