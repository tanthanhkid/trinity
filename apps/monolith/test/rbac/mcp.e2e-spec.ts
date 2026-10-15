import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * máy chủ MCP chỉ đọc. Luồng thật: DCR → authorize (JWT phiên web) → token → MCP
 * (initialize / tools/list / tools/call) bằng client SDK THẬT và HTTP JSON-RPC.
 */
const BASE = 'http://localhost:4000'
const MCP = `${BASE}/api/v1/mcp`
const PRM = `${BASE}/api/v1/oauth/protected-resource`
const REDIRECT = 'https://client.example.com/cb'
const ENV = ['INTEGRATIONS_MCP_ENABLED', 'INTEGRATIONS_PUBLIC_BASE_URL', 'INTEGRATIONS_MCP_ALLOWED_ORIGINS'] as const
const READ = { 'integrations.ai_connect': true } as const
const b64u = (b: Buffer): string => b.toString('base64url')
let ipSeq = 100
const freshIp = (): string => `10.47.0.${(ipSeq += 1) % 250}`

describe('E2E — MCP server (đọc + ghi theo quyền)', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  let url = ''

  const enable = (): void => {
    process.env.INTEGRATIONS_MCP_ENABLED = 'true'
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = BASE
  }
  const form = (path: string, body: Record<string, string>) => request(app.getHttpServer()).post(path).set('x-real-ip', freshIp()).type('form').send(body)

  /** DCR → đồng ý → token; trả access token của `userToken`. */
  async function connect(userToken: string, scope = 'crm.read', mcpUrl = MCP): Promise<{ access: string; refresh: string; clientId: string }> {
    const reg = await request(app.getHttpServer()).post('/api/v1/oauth/register').set('x-real-ip', freshIp()).send({ client_name: 'ChatGPT e2e', redirect_uris: [REDIRECT] })
    expect(reg.status).toBe(201)
    const clientId = reg.body.client_id as string
    const verifier = b64u(randomBytes(48))
    const params = {
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's', resource: mcpUrl,
      code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    }
    const ctx = await api(app, userToken).post('/api/v1/oauth/authorize/context').send({ params })
    expect(ctx.status).toBe(200)
    const dec = await api(app, userToken).post('/api/v1/oauth/authorize/decision').send({ params, approve: true, consent_token: ctx.body.consent_token })
    const code = new URL(dec.body.redirect_to as string).searchParams.get('code') as string
    const tok = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId })
    expect(tok.status).toBe(200)
    return { access: tok.body.access_token, refresh: tok.body.refresh_token, clientId }
  }

  const rpcReq = (access: string | null, body: unknown) => {
    let r = request(app.getHttpServer()).post('/api/v1/mcp').set('x-real-ip', freshIp()).set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json')
    if (access) r = r.set('Authorization', `Bearer ${access}`)
    return r.send(body as object)
  }
  let rid = 0
  const rpc = (access: string | null, method: string, params?: unknown) => rpcReq(access, { jsonrpc: '2.0', id: (rid += 1), method, params })
  async function call(access: string, name: string, args: Record<string, unknown> = {}) {
    const r = await rpc(access, 'tools/call', { name, arguments: args })
    expect(r.status).toBe(200)
    expect(r.body.error).toBeUndefined()
    return r.body.result as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> }
  }

  const mkContact = (name: string, o: { assigned_to?: number; created_by_id?: number; phone?: string } = {}) =>
    prisma.contact.create({ data: { phone: o.phone ?? '0912345678', full_name: `E2E-MCP ${name}`, assigned_to: o.assigned_to ?? null, created_by_id: o.created_by_id ?? null }, select: { id: true } })

  beforeAll(async () => {
    ENV.forEach((k) => delete process.env[k])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
    await app.listen(0)
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1')
  }, 60_000)

  afterAll(async () => {
    await close()
  })

  afterEach(async () => {
    ENV.forEach((k) => delete process.env[k])
    await prisma.$executeRawUnsafe(`DELETE FROM kanban_boards WHERE name LIKE 'E2E-MCP%'`)
    await prisma.$executeRawUnsafe(`DELETE FROM deals WHERE title LIKE 'E2E-MCP%'`)
    await prisma.$executeRawUnsafe(`DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE full_name LIKE 'E2E-MCP%')`)
    await prisma.$executeRawUnsafe(`DELETE FROM contacts WHERE full_name LIKE 'E2E-MCP%'`)
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs RESTART IDENTITY`)
    const redis = (app.get(require('../../../../services/crm/src/common/redis.provider').REDIS_CLIENT) as { keys: (p: string) => Promise<string[]>; del: (...k: string[]) => Promise<number> })
    const keys = await redis.keys('mcp:rl:*')
    if (keys.length) await redis.del(...keys)
    await prisma.$executeRawUnsafe(`DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await resetDb(prisma)
  })

  describe('INERT + xác thực', () => {
    it('cờ tắt (hoặc thiếu base URL) ⇒ /mcp 404', async () => {
      await rpc(null, 'initialize', {}).expect(404)
      process.env.INTEGRATIONS_MCP_ENABLED = 'true'
      await rpc(null, 'initialize', {}).expect(404)
      await request(app.getHttpServer()).get('/api/v1/mcp').expect(404)
    })

    it('không token ⇒ 401 + WWW-Authenticate có resource_metadata + scope; token rác ⇒ 401 invalid_token', async () => {
      enable()
      const none = await rpc(null, 'initialize', {})
      expect(none.status).toBe(401)
      expect(none.headers['www-authenticate']).toBe(`Bearer resource_metadata="${PRM}", scope="crm.read crm.write"`)
      const bad = await rpc('trn_at_khong-co-that', 'tools/list')
      expect(bad.status).toBe(401)
      expect(bad.headers['www-authenticate']).toContain('error="invalid_token"')
      expect(bad.headers['www-authenticate']).toContain(`resource_metadata="${PRM}"`)
      // token JWT phiên web KHÔNG dùng được ở MCP (khác audience / không phải token OAuth)
      const u = await makeUser(prisma, { grants: { ...READ } })
      expect((await rpc(u.token, 'tools/list')).status).toBe(401)
    })

    it('token thu hồi / user bị khoá / mất integrations.ai_connect / hết hạn / audience sai ⇒ 401', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own' } })
      const t = await connect(u.token)
      expect((await rpc(t.access, 'tools/list')).status).toBe(200)

      await prisma.user.update({ where: { id: u.id }, data: { status: 'locked' } })
      expect((await rpc(t.access, 'tools/list')).status).toBe(401)
      await prisma.user.update({ where: { id: u.id }, data: { status: 'active' } })
      expect((await rpc(t.access, 'tools/list')).status).toBe(200)

      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET resource = 'https://evil.example.com/mcp'`)
      expect((await rpc(t.access, 'tools/list')).status).toBe(401)
      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET resource = '${MCP}', access_expires_at = now() - interval '1 second'`)
      expect((await rpc(t.access, 'tools/list')).status).toBe(401)
      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET access_expires_at = now() + interval '1 hour'`)
      expect((await rpc(t.access, 'tools/list')).status).toBe(200)

      const { RbacCache } = require('@trinity/rbac-nest') as typeof import('@trinity/rbac-nest')
      await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE permission = 'integrations.ai_connect'`)
      await app.get(RbacCache).invalidateUsers('*')
      const lost = await rpc(t.access, 'tools/list')
      expect(lost.status).toBe(401)
      expect((await prisma.integrationAuditLog.findMany({ where: { action: 'auth', status: 'denied' } })).length).toBe(1)
    })

    it('thu hồi qua màn Kết nối AI / revoke ⇒ MCP 401 ngay', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...READ } })
      const t = await connect(u.token)
      expect((await rpc(t.access, 'tools/list')).status).toBe(200)
      const list = await api(app, u.token).get('/api/v1/integrations/ai-connections').expect(200)
      await api(app, u.token).delete(`/api/v1/integrations/ai-connections/${list.body.data[0].id}`).expect(204)
      expect((await rpc(t.access, 'tools/list')).status).toBe(401)
    })

    it('token không có scope crm.read ⇒ 403 insufficient_scope', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...READ } })
      const t = await connect(u.token, 'crm.write')
      const r = await rpc(t.access, 'tools/list')
      expect(r.status).toBe(403)
      expect(r.headers['www-authenticate']).toContain('error="insufficient_scope"')
    })

    it('Origin lạ ⇒ 403 (DNS rebinding); Origin được phép / không Origin ⇒ qua; GET/DELETE ⇒ 405; batch ⇒ 400', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { ...READ } })
      const t = await connect(u.token)
      const withOrigin = (o: string) => rpcReq(t.access, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).set('Origin', o)
      expect((await withOrigin('https://evil.example.com')).status).toBe(403)
      expect((await withOrigin('http://localhost:9999')).status).toBe(403)
      expect((await withOrigin('https://claude.ai')).status).toBe(200)
      expect((await withOrigin(BASE)).status).toBe(200)
      process.env.INTEGRATIONS_MCP_ALLOWED_ORIGINS = 'http://localhost:6274'
      expect((await withOrigin('http://localhost:6274')).status).toBe(200)
      const get = await request(app.getHttpServer()).get('/api/v1/mcp')
      expect(get.status).toBe(405)
      expect(get.headers.allow).toBe('POST')
      await request(app.getHttpServer()).delete('/api/v1/mcp').expect(405)
      expect((await rpcReq(t.access, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])).status).toBe(400)
    })
  })

  describe('client SDK thật', () => {
    it('initialize + tools/list + tools/call search/fetch; tool chỉ đọc có title, mô tả, output schema', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own', 'deals.view': 'own', 'kanban.view': 'own' } })
      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const mine = await mkContact('Nguyễn Của Tôi', { assigned_to: me.id })
      const theirs = await mkContact('Nguyễn Người Khác', { assigned_to: other.id })
      const t = await connect(me.token)

      const client = new Client({ name: 'e2e', version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/api/v1/mcp`), { requestInit: { headers: { Authorization: `Bearer ${t.access}` } } }))
      expect(client.getServerVersion()?.name).toBe('trinity-crm')
      expect(client.getInstructions()).toContain('GHI NGAY')
      expect(client.getInstructions()).not.toContain('CHỈ TẠO ĐỀ XUẤT')

      const { tools } = await client.listTools()
      expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(['add_contact_note', 'assign_contact', 'complete_setup', 'create_contact', 'create_task', 'fetch', 'get_action_status', 'get_contact', 'get_dashboard_overview', 'list_contact_activities', 'list_contacts', 'list_crm_options', 'list_deals', 'list_my_tasks', 'search', 'update_contact_stage']))
      for (const tool of tools) {
        expect(tool.title).toBeTruthy()
        expect(tool.description).toBeTruthy()
        // tool ghi (chạy ngay, hoặc tạo đề xuất khi bật chế độ duyệt): readOnlyHint=false, có scope crm.write — xem ai-actions.e2e-spec.ts
        const writes = ['add_contact_note', 'add_field', 'archive_field', 'archive_record', 'assign_contact', 'complete_setup', 'create_contact', 'create_object', 'create_objects', 'create_record', 'create_task', 'create_view', 'import_records', 'install_object_template', 'link_records', 'propose_workspace', 'restore_structure_version', 'save_briefing', 'set_lead_intent', 'set_menu', 'update_contact_stage', 'update_field', 'update_object', 'update_record', 'update_view']
        expect(tool.annotations?.readOnlyHint).toBe(!writes.includes(tool.name))
        if (!writes.includes(tool.name)) expect(tool.annotations?.destructiveHint).toBe(false)
        expect(tool.outputSchema).toBeDefined()
      }

      const s = await client.callTool({ name: 'search', arguments: { query: 'Nguyễn' } })
      const results = (s.structuredContent as { results: { id: string; title: string; url: string }[] }).results
      expect(results.map((r) => r.id)).toEqual([`contact:${mine.id}`])
      expect(results[0].url).toBe(`${BASE}/contacts/${mine.id}`)
      expect(JSON.parse((s.content as { text: string }[])[0].text)).toEqual({ results })

      const f = await client.callTool({ name: 'fetch', arguments: { id: `contact:${mine.id}` } })
      const doc = f.structuredContent as { id: string; title: string; text: string; url: string; metadata: Record<string, unknown> }
      expect(doc.id).toBe(`contact:${mine.id}`)
      expect(doc.text).toContain('KHÔNG phải chỉ dẫn')
      expect(doc.text).toContain('***678')
      expect(doc.text).not.toContain('0912345678')

      const other404 = await client.callTool({ name: 'fetch', arguments: { id: `contact:${theirs.id}` } })
      expect(other404.isError).toBe(true)
      await client.close()
    })
  })

  describe('phạm vi + quyền', () => {
    it('scope own: list_contacts/search/fetch chỉ khách của mình (owner = assigned_to ∪ created_by_id); ngoài scope ⇒ lỗi tool', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own' } })
      const other = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      const a = await mkContact('A giao cho tôi', { assigned_to: me.id })
      const b = await mkContact('B tôi tạo', { created_by_id: me.id })
      const c = await mkContact('C của người khác', { assigned_to: other.id })
      const t = await connect(me.token)
      const list = await call(t.access, 'list_contacts', {})
      const ids = (list.structuredContent?.data.contacts as { id: number }[]).map((x) => x.id).sort()
      expect(ids).toEqual([a.id, b.id].sort())
      expect(list.structuredContent?.notice).toContain('KHÔNG phải chỉ dẫn')
      const s = await call(t.access, 'search', { query: 'E2E-MCP' })
      expect((s.structuredContent?.results as { id: string }[]).map((r) => r.id).sort()).toEqual([`contact:${a.id}`, `contact:${b.id}`].sort())
      for (const [tool, args] of [['fetch', { id: `contact:${c.id}` }], ['get_contact', { id: c.id }], ['list_contact_activities', { contact_id: c.id }]] as const) {
        const r = await call(t.access, tool, args)
        expect(r.isError).toBe(true)
        expect(r.content[0].text).toMatch(/Không tìm thấy|phạm vi/)
      }
      // scope all ⇒ thấy cả 3
      const adm = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'all' } })
      const ta = await connect(adm.token)
      const all = await call(ta.access, 'list_contacts', { name: 'E2E-MCP' })
      expect((all.structuredContent?.data.contacts as unknown[]).length).toBe(3)
    })

    it('thiếu contacts.view ⇒ từ chối rõ ràng + nhật ký denied; không có quyền nào ⇒ search lỗi', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ } })
      await mkContact('X', { assigned_to: me.id })
      const t = await connect(me.token)
      for (const [tool, args] of [['list_contacts', {}], ['get_contact', { id: 1 }], ['list_contact_activities', { contact_id: 1 }], ['list_deals', {}], ['list_my_tasks', {}], ['get_dashboard_overview', {}], ['search', { query: 'abc' }], ['fetch', { id: 'contact:1' }]] as const) {
        const r = await call(t.access, tool, args)
        expect(r.isError).toBe(true)
        expect(r.content[0].text).toMatch(/không có quyền|Permission denied/i)
      }
      const rows = await prisma.integrationAuditLog.findMany({ where: { channel: 'mcp', status: 'denied' } })
      expect(rows.length).toBe(8)
      expect(rows.find((r) => r.action === 'list_contacts')?.error).toBe('missing_permission:contacts.view')
    })

    it('SĐT LUÔN che với AI — kể cả người có contacts.phone_full scope all; SĐT trong tên/ghi chú cũng bị che; địa chỉ không lộ', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'all', 'contacts.phone_full': 'all', 'deals.view': 'all', 'kanban.view': 'all' } })
      const c = await prisma.contact.create({
        data: { phone: '0987654321', phone_2: '0900000833', full_name: 'E2E-MCP Khách 0901234567', assigned_to: me.id, reminder_notes: 'liên hệ lại số 0900000955 nhé' },
        select: { id: true },
      })
      await prisma.activity.create({ data: { contact_id: c.id, action: 'note', details: { text: 'Khách để lại 0900001066 và 0901 234 567', summary: 'Zalo: 84900000356' }, created_by: me.id } })
      await prisma.deal.create({ data: { title: 'E2E-MCP deal cho 0900001170', status: 'open', value: 1500000000n, assigned_to: me.id, created_by: me.id, contact_id: c.id } })
      // sanity: người dùng này THẤY SĐT đầy đủ qua API thường
      const web = await api(app, me.token).get(`/api/v1/contacts/${c.id}`).expect(200)
      expect(web.body.phone).toBe('0987654321')

      const t = await connect(me.token)
      const outs = [
        await call(t.access, 'list_contacts', { name: 'E2E-MCP' }),
        await call(t.access, 'get_contact', { id: c.id }),
        await call(t.access, 'fetch', { id: `contact:${c.id}` }),
        await call(t.access, 'list_contact_activities', { contact_id: c.id }),
        await call(t.access, 'list_deals', {}),
        await call(t.access, 'search', { query: 'E2E-MCP' }),
        await call(t.access, 'fetch', { id: `deal:${(await prisma.deal.findFirstOrThrow({ where: { title: { startsWith: 'E2E-MCP' } } })).id}` }),
      ]
      const dump = outs.map((o) => JSON.stringify(o)).join('\n')
      for (const secret of ['0987654321', '0900000833', '0901234567', '0900000955', '0900001066', '0901 234 567', '84900000356', '0900001170', '079123456789', '99000000', '99 triệu', '1 Example Street, Q1']) {
        expect(dump).not.toContain(secret)
      }
      expect(dump).toContain('***321') // 0987654321 → ***321
      expect(outs[1].structuredContent?.data.phone).toBe('***321')
      expect(outs[4].structuredContent?.data.deals[0].value).toBe(1500000000) // số tiền KHÔNG bị che nhầm
    })

    it('tìm theo SĐT bị chặn (oracle dò chữ số); query quá ngắn lỗi', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'all', 'deals.view': 'all' } })
      await mkContact('Dò', { assigned_to: me.id, phone: '0912345678' })
      const t = await connect(me.token)
      for (const q of ['0912345678', '091 234', '+84 912 345 678']) {
        const r = await call(t.access, 'search', { query: q })
        expect(r.isError).toBe(true)
        expect(r.content[0].text).toMatch(/SĐT/)
      }
      expect((await rpc(t.access, 'tools/call', { name: 'search', arguments: { query: 'a' } })).body.result.isError).toBe(true)
      // bộ lọc văn bản khác cũng chặn dò chữ số (oracle)
      for (const [tool, args] of [['list_contacts', { name: '0912' }], ['list_deals', { search: '09123' }], ['search', { query: 'Anh 09012' }]] as const) {
        const r = await call(t.access, tool, args)
        expect(r.isError).toBe(true)
        expect(r.content[0].text).toMatch(/Không hỗ trợ/)
      }
      // tên khách chứa SĐT: tìm theo chữ vẫn thấy nhưng SĐT trong tên đã che
      const named = await mkContact('Khách Lan 0912 345 678', { assigned_to: me.id })
      const found = await call(t.access, 'list_contacts', { name: 'Khách Lan' })
      expect(JSON.stringify(found)).not.toMatch(/0912 ?345 ?678/)
      expect((found.structuredContent?.data.contacts as { id: number }[])[0].id).toBe(named.id)
    })

    it('list_contacts: lọc giai đoạn, chưa liên hệ N ngày, người phụ trách, phân trang bằng cursor', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'all' } })
      const stage = await prisma.settingOption.upsert({ where: { group_key_value: { group_key: 'contact_stage', value: 'e2e_mcp' } }, update: {}, create: { group_key: 'contact_stage', value: 'e2e_mcp', label: 'E2E MCP' }, select: { id: true } })
      const ids: number[] = []
      for (let i = 0; i < 5; i += 1) ids.push((await mkContact(`P${i}`, { assigned_to: me.id })).id)
      await prisma.contact.update({ where: { id: ids[0] }, data: { stage_id: stage.id } })
      // ids[1] có hoạt động hôm nay; ids[2] có hoạt động 30 ngày trước
      await prisma.activity.create({ data: { contact_id: ids[1], action: 'note', created_by: me.id } })
      await prisma.activity.create({ data: { contact_id: ids[2], action: 'note', created_by: me.id, created_at: new Date(Date.now() - 30 * 86400_000) } })
      const t = await connect(me.token)
      const byStage = await call(t.access, 'list_contacts', { stage_id: stage.id })
      expect((byStage.structuredContent?.data.contacts as { id: number }[]).map((x) => x.id)).toEqual([ids[0]])
      const unc = await call(t.access, 'list_contacts', { name: 'E2E-MCP', uncontacted_days: 7 })
      expect((unc.structuredContent?.data.contacts as { id: number }[]).map((x) => x.id).sort()).toEqual([ids[0], ids[2], ids[3], ids[4]].sort())
      const p1 = await call(t.access, 'list_contacts', { name: 'E2E-MCP', limit: 2 })
      expect((p1.structuredContent?.data.contacts as unknown[]).length).toBe(2)
      const p2 = await call(t.access, 'list_contacts', { name: 'E2E-MCP', limit: 2, cursor: p1.structuredContent?.data.next_cursor })
      const p3 = await call(t.access, 'list_contacts', { name: 'E2E-MCP', limit: 2, cursor: p2.structuredContent?.data.next_cursor })
      const got = [p1, p2, p3].flatMap((p) => (p.structuredContent?.data.contacts as { id: number }[]).map((x) => x.id))
      expect(got).toEqual([...ids].sort((a, b) => b - a))
      expect(p3.structuredContent?.data.next_cursor).toBeNull()
      const big = await rpc(t.access, 'tools/call', { name: 'list_contacts', arguments: { limit: 500 } })
      expect(big.body.result?.isError ?? true).toBe(true) // vượt 50 bản ghi/lần ⇒ bị schema từ chối
      expect((await call(t.access, 'list_contacts', { assigned_to: me.id, limit: 50 })).isError).toBeUndefined()
    })

    it('deal gắn khách: không có contacts.view (hoặc khách ngoài phạm vi) ⇒ ẩn tên + id khách ở list_deals/fetch/search', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'deals.view': 'own' } })
      const other = await makeUser(prisma, { grants: {} })
      const c = await mkContact('Khách ẩn', { assigned_to: other.id })
      const d = await prisma.deal.create({ data: { title: 'E2E-MCP deal có khách', status: 'open', assigned_to: me.id, created_by: me.id, contact_id: c.id } })
      const t = await connect(me.token)
      const list = await call(t.access, 'list_deals', {})
      expect(list.structuredContent?.data.deals[0].contact_id).toBeNull()
      const f = await call(t.access, 'fetch', { id: `deal:${d.id}` })
      expect(JSON.stringify(f)).not.toContain('Khách ẩn')
      const s = await call(t.access, 'search', { query: 'E2E-MCP' })
      expect(JSON.stringify(s)).not.toContain(`/contacts/${c.id}`)
    })

    it('deals + kanban + dashboard: scope own; list_my_tasks gồm cả thẻ đồng phụ trách, không gồm thẻ người khác/đã xong', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'deals.view': 'own', 'kanban.view': 'own', 'reports.overview': 'own', 'contacts.view': 'own' } })
      const other = await makeUser(prisma, { grants: {} })
      await prisma.deal.create({ data: { title: 'E2E-MCP deal của tôi', status: 'open', assigned_to: me.id, created_by: me.id } })
      await prisma.deal.create({ data: { title: 'E2E-MCP deal người khác', status: 'open', assigned_to: other.id, created_by: other.id } })
      const board = await prisma.kanbanBoard.create({ data: { name: 'E2E-MCP board' } })
      const col = await prisma.kanbanColumn.create({ data: { board_id: board.id, name: 'Todo', position: 1 } })
      const card = (title: string, o: { assignee_id?: number; created_by: number; completed?: boolean; co?: number }) =>
        prisma.kanbanCard.create({
          data: { board_id: board.id, column_id: col.id, position: 1, title, created_by: o.created_by, assignee_id: o.assignee_id ?? null, completed_at: o.completed ? new Date() : null, ...(o.co ? { assignees: { create: [{ user_id: o.co }] } } : {}) },
          select: { id: true },
        })
      const mine = await card('E2E-MCP việc chính của tôi', { assignee_id: me.id, created_by: other.id })
      const co = await card('E2E-MCP việc đồng phụ trách', { assignee_id: other.id, created_by: other.id, co: me.id })
      await card('E2E-MCP việc đã xong', { assignee_id: me.id, created_by: me.id, completed: true })
      await card('E2E-MCP việc người khác', { assignee_id: other.id, created_by: other.id })
      const t = await connect(me.token)
      const deals = await call(t.access, 'list_deals', {})
      expect((deals.structuredContent?.data.deals as { title: string }[]).map((d) => d.title)).toEqual(['E2E-MCP deal của tôi'])
      const tasks = await call(t.access, 'list_my_tasks', {})
      expect((tasks.structuredContent?.data.tasks as { id: number }[]).map((x) => x.id).sort()).toEqual([mine.id, co.id].sort())
      const f = await call(t.access, 'fetch', { id: `card:${mine.id}` })
      expect(f.structuredContent?.title).toBe('E2E-MCP việc chính của tôi')
      const s = await call(t.access, 'search', { query: 'E2E-MCP' })
      const sids = (s.structuredContent?.results as { id: string }[]).map((r) => r.id)
      expect(sids).toContain(`card:${mine.id}`)
      expect(sids.some((i) => i.startsWith('deal:'))).toBe(true)
      const dash = await call(t.access, 'get_dashboard_overview', {})
      expect(dash.isError).toBeUndefined()
      expect(dash.structuredContent?.notice).toBeDefined()
    })
  })

  describe('script hậu kiểm mcp-smoke.mjs', () => {
    const run = (env: Record<string, string>) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const script = path.resolve(__dirname, '../../../../scripts/ops/mcp-smoke.mjs')
        execFile('node', [script], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
        )
      })

    it('chạy được với server thật: đạt hết khi có token; thiếu MCP_URL ⇒ mã 2; token sai ⇒ hỏng; không in token', async () => {
      const base = url.replace(/\/$/, '')
      process.env.INTEGRATIONS_MCP_ENABLED = 'true'
      process.env.INTEGRATIONS_PUBLIC_BASE_URL = base
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own' } })
      await mkContact('Smoke Khách', { assigned_to: me.id })
      const t = await connect(me.token, 'crm.read', `${base}/api/v1/mcp`)
      const env = { MCP_URL: `${base}/api/v1/mcp`, MCP_TOKEN: t.access, MCP_QUERY: 'Smoke', MCP_SKIP_WELLKNOWN: '1' }
      const ok = await run(env)
      expect(ok.out).toContain('Tất cả bước đạt')
      expect(ok.out).not.toContain('FAIL')
      expect(ok.out).toContain('search ⇒ 1 kết quả')
      expect(ok.out).not.toContain(t.access)
      expect(ok.code).toBe(0)
      const bad = await run({ ...env, MCP_TOKEN: 'trn_at_sai' })
      expect(bad.code).toBe(1)
      expect(bad.out).toContain('FAIL')
      expect((await run({ MCP_URL: '' })).code).toBe(2)
    }, 30_000)
  })

  describe('giới hạn + nhật ký', () => {
    it('60 lời gọi tool/phút/user: lời gọi thứ 61 bị từ chối; user khác không bị ảnh hưởng', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own' } })
      const you = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own' } })
      const t = await connect(me.token)
      const t2 = await connect(you.token)
      for (let i = 0; i < 60; i += 1) expect((await call(t.access, 'list_contacts', { limit: 1 })).isError).toBeUndefined()
      const over = await call(t.access, 'list_contacts', { limit: 1 })
      expect(over.isError).toBe(true)
      expect(over.content[0].text).toMatch(/giới hạn/)
      expect((await call(t2.access, 'list_contacts', { limit: 1 })).isError).toBeUndefined()
    }, 60_000)

    it('mỗi lời gọi tool ghi integration_audit_logs (channel mcp, client_id, tool, status, duration), không chứa token/SĐT', async () => {
      enable()
      const me = await makeUser(prisma, { grants: { ...READ, 'contacts.view': 'own' } })
      const t = await connect(me.token)
      await call(t.access, 'list_contacts', {})
      await call(t.access, 'get_contact', { id: 999999 })
      const rows = await prisma.integrationAuditLog.findMany({ where: { channel: 'mcp', action: { in: ['list_contacts', 'get_contact'] } }, orderBy: { id: 'asc' } })
      expect(rows.map((r) => [r.action, r.status])).toEqual([['list_contacts', 'ok'], ['get_contact', 'denied']])
      expect(rows[0]).toMatchObject({ client_id: t.clientId, user_id: me.id })
      expect(rows[0].duration_ms).not.toBeNull()
      expect(JSON.stringify(rows)).not.toContain(t.access)
    })
  })
})
