import { createHash, randomBytes } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * Chương trình con (agent tự mở rộng hệ thống) — luồng THẬT trên Postgres: agent (OAuth + MCP) tạo NHÁP → NGƯỜI duyệt bằng JWT phiên web →
 * agent deploy. Kiểm: cờ tắt ⇒ 404 + tool ẩn; thiếu quyền ⇒ 403; token của AI KHÔNG duyệt được (401); deploy bản chưa duyệt bị chặn.
 * (Loại job: deploy chỉ đổi trạng thái — không cần Deno ở test này; chạy Deno thật nằm ở services/crm/src/extensions/__tests__.)
 */
const BASE = 'http://localhost:4000'
const MCP = `${BASE}/api/v1/mcp`
const EXT = '/api/v1/extensions'
const REDIRECT = 'https://client.example.com/cb'
const ENV = ['INTEGRATIONS_MCP_ENABLED', 'INTEGRATIONS_PUBLIC_BASE_URL', 'EXTENSIONS_ENABLED'] as const
const b64u = (b: Buffer): string => b.toString('base64url')
let ipSeq = 150
const freshIp = (): string => `10.49.0.${(ipSeq += 1) % 250}`
const MANIFEST = { net: ['api.example.com'], tables: { read: [], write: [] }, schedule: '0 8 * * *' }
const CODE = 'export default async function (ctx) { ctx.log("xin chào"); return { ok: true } }'

describe('E2E — chương trình con: nháp → duyệt → deploy', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>

  const enable = (ext = true): void => {
    process.env.INTEGRATIONS_MCP_ENABLED = 'true'
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = BASE
    if (ext) process.env.EXTENSIONS_ENABLED = 'true'
  }
  const form = (path: string, body: Record<string, string>) => request(app.getHttpServer()).post(path).set('x-real-ip', freshIp()).type('form').send(body)

  async function connect(userToken: string): Promise<string> {
    const reg = await request(app.getHttpServer()).post('/api/v1/oauth/register').set('x-real-ip', freshIp()).send({ client_name: 'ChatGPT e2e', redirect_uris: [REDIRECT] })
    const clientId = reg.body.client_id as string
    const verifier = b64u(randomBytes(48))
    const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'crm.read crm.write', state: 's', resource: MCP, code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' }
    const ctx = await api(app, userToken).post('/api/v1/oauth/authorize/context').send({ params })
    expect(ctx.status).toBe(200)
    const dec = await api(app, userToken).post('/api/v1/oauth/authorize/decision').send({ params, approve: true, consent_token: ctx.body.consent_token })
    const code = new URL(dec.body.redirect_to as string).searchParams.get('code') as string
    const tok = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId })
    expect(tok.status).toBe(200)
    return tok.body.access_token as string
  }

  let rid = 0
  const rpc = (access: string, method: string, params?: unknown) =>
    request(app.getHttpServer()).post('/api/v1/mcp').set('x-real-ip', freshIp()).set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json').set('Authorization', `Bearer ${access}`).send({ jsonrpc: '2.0', id: (rid += 1), method, params })
  async function call(access: string, name: string, args: Record<string, unknown> = {}) {
    const r = await rpc(access, 'tools/call', { name, arguments: args })
    expect(r.status).toBe(200)
    return r.body.result as { isError?: boolean; content: { text: string }[]; structuredContent?: { data: Record<string, any> } }
  }

  beforeAll(async () => {
    ENV.forEach((f) => delete process.env[f])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)
  afterAll(async () => {
    await close()
  })
  afterEach(async () => {
    ENV.forEach((f) => delete process.env[f])
    await prisma.$executeRawUnsafe(`DELETE FROM extensions`)
    await prisma.$executeRawUnsafe(`DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE '%@rbac-e2e.test')`)
    await prisma.$executeRawUnsafe(`DELETE FROM integration_audit_logs`)
    await resetDb(prisma)
  })

  it('cờ TẮT (mặc định): mọi route 404 dù là quản trị; không tool chương trình con trong tools/list', async () => {
    enable(false)
    const admin = await makeUser(prisma, { admin: true })
    for (const [m, url] of [['get', EXT], ['get', `${EXT}/1`], ['post', `${EXT}/1/versions/1/approve`], ['post', `${EXT}/1/enable`]] as const) {
      expect((await api(app, admin.token)[m](url)).status).toBe(404)
    }
    const access = await connect(admin.token)
    const names = ((await rpc(access, 'tools/list')).body.result.tools as { name: string }[]).map((t) => t.name)
    expect(names.filter((n) => n.endsWith('_extension') || n === 'list_extensions')).toEqual([])
  })

  it('RBAC: không quyền ⇒ 403; chỉ extensions.view ⇒ đọc được mã nhưng KHÔNG duyệt (403)', async () => {
    enable()
    const admin = await makeUser(prisma, { admin: true })
    const created = await call(await connect(admin.token), 'create_extension', { key: 'rbac-1', kind: 'job', code: CODE, manifest: MANIFEST })
    expect(created.isError).toBeUndefined()
    const id = created.structuredContent!.data.extension.id as number

    const nobody = await makeUser(prisma, { grants: {} })
    expect((await api(app, nobody.token).get(EXT)).status).toBe(403)
    const viewer = await makeUser(prisma, { grants: { 'extensions.view': true } })
    expect((await api(app, viewer.token).get(EXT)).body.data).toHaveLength(1)
    expect((await api(app, viewer.token).get(`${EXT}/${id}/versions/1`)).body.version.code).toBe(CODE)
    for (const act of ['approve', 'reject']) expect((await api(app, viewer.token).post(`${EXT}/${id}/versions/1/${act}`)).status).toBe(403)
    for (const act of ['deploy', 'rollback', 'disable', 'enable']) expect((await api(app, viewer.token).post(`${EXT}/${id}/${act}`).send({ version: 1 })).status).toBe(403)
    expect((await prisma.extension.findUniqueOrThrow({ where: { id } })).status).toBe('draft')
  })

  it('LUỒNG: AI tạo nháp → deploy bị chặn → token AI không duyệt được → NGƯỜI duyệt → AI deploy → AI sửa → quay lui', async () => {
    enable()
    const admin = await makeUser(prisma, { admin: true })
    const access = await connect(admin.token)

    const created = await call(access, 'create_extension', { key: 'dong-bo', kind: 'job', name: 'Đồng bộ', code: CODE, manifest: MANIFEST })
    const id = created.structuredContent!.data.extension.id as number
    // Admin nhận thông báo có bản nháp chờ duyệt.
    await new Promise((r) => setTimeout(r, 300))
    expect(await prisma.notificationLog.count({ where: { recipient_id: admin.id, event_type: 'extension.pending' } })).toBe(1)

    const early = await call(access, 'deploy_extension', { key: 'dong-bo' })
    expect(early.isError).toBe(true)
    expect(early.content[0].text).toContain('NGƯỜI duyệt')

    // Token của AI (chuỗi opaque, không phải JWT phiên web) KHÔNG có đường duyệt.
    expect((await api(app, access).post(`${EXT}/${id}/versions/1/approve`)).status).toBe(401)
    expect((await prisma.extensionVersion.findFirstOrThrow({ where: { extension_id: id, version: 1 } })).review_status).toBe('draft')

    const ok = await api(app, admin.token).post(`${EXT}/${id}/versions/1/approve`)
    expect(ok.status).toBe(200)
    expect(ok.body.extension.status).toBe('approved')
    expect((await prisma.extensionVersion.findFirstOrThrow({ where: { extension_id: id, version: 1 } })).reviewed_by).toBe(admin.id)
    expect((await api(app, admin.token).post(`${EXT}/${id}/versions/1/approve`)).body.message).toContain('đã được xử lý')

    const dep = await call(access, 'deploy_extension', { key: 'dong-bo' })
    expect(dep.structuredContent!.data.extension).toMatchObject({ status: 'active', active_version: 1 })

    const v2 = await call(access, 'update_extension', { key: 'dong-bo', code: `${CODE}\n// v2` })
    expect(v2.structuredContent!.data.version.version).toBe(2)
    expect((await call(access, 'deploy_extension', { key: 'dong-bo', version: 2 })).isError).toBe(true)
    await api(app, admin.token).post(`${EXT}/${id}/versions/2/approve`)
    await call(access, 'deploy_extension', { key: 'dong-bo', version: 2 })
    const back = await call(access, 'rollback_extension', { key: 'dong-bo', version: 1 })
    expect(back.structuredContent!.data.extension).toMatchObject({ status: 'active', active_version: 1 })

    const dis = await api(app, admin.token).post(`${EXT}/${id}/disable`).send({ reason: 'thử tắt' })
    expect(dis.body.extension).toMatchObject({ status: 'disabled', disabled_reason: 'thử tắt' })
    // AI deploy lại bản khác KHÔNG bật lại ngầm.
    const again = await call(access, 'deploy_extension', { key: 'dong-bo', version: 2 })
    expect(again.structuredContent!.data.extension.status).toBe('disabled')
    expect((await api(app, admin.token).post(`${EXT}/${id}/enable`)).body.extension.status).toBe('active')
    const logs = await call(access, 'logs_extension', { key: 'dong-bo' })
    expect(logs.structuredContent!.data.runs).toEqual([])
  })

  it('đầu vào sai ⇒ 400 tiếng Việt qua REST; chạy thử job bằng Deno thật không ghi dữ liệu', async () => {
    enable()
    const admin = await makeUser(prisma, { admin: true })
    const access = await connect(admin.token)
    const bad = await call(access, 'create_extension', { key: 'xau', kind: 'job', code: CODE, manifest: { ...MANIFEST, net: ['127.0.0.1:5432'] } })
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toContain('địa chỉ nội bộ')
    expect((await api(app, admin.token).get(`${EXT}/999999`)).status).toBe(404)

    await call(access, 'create_extension', { key: 'thu', kind: 'job', code: 'export default (ctx) => { ctx.log("chạy thử", ctx.dryRun); return { dry: ctx.dryRun } }', manifest: { net: [], tables: { read: [], write: [] }, schedule: '0 8 * * *' } })
    const dry = await call(access, 'dry_run_extension', { key: 'thu' })
    expect(dry.structuredContent!.data).toMatchObject({ outcome: 'ok', result: { dry: true }, would_write: 0 })
    expect(dry.structuredContent!.data.log).toContain('chạy thử true')
  })
})
