import { createHash, randomBytes } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { PrismaService } from '@trinity/prisma'
import { bootApp, resetDb, makeUser, api } from './harness'

/**
 * OAuth 2.1 Authorization Server.
 * DCR → authorize (giả lập đồng ý bằng JWT phiên web) → token → refresh xoay vòng → thu hồi; PKCE/redirect_uri/resource/CIMD/SSRF.
 */
const BASE = 'http://localhost:4000'
const ISS = `${BASE}/api/v1/oauth`
const MCP = `${BASE}/api/v1/mcp`
const REDIRECT = 'https://client.example.com/cb'
const ENV = ['INTEGRATIONS_MCP_ENABLED', 'INTEGRATIONS_PUBLIC_BASE_URL', 'INTEGRATIONS_ALLOW_PRIVATE_TARGETS', 'INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS'] as const

const b64u = (b: Buffer): string => b.toString('base64url')
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(48))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}

let ipSeq = 0
const freshIp = (): string => `10.46.0.${(ipSeq += 1) % 250}`

describe('E2E — OAuth 2.1 AS', () => {
  let app: INestApplication
  let prisma: PrismaService
  let close: () => Promise<void>
  let server: http.Server | null = null

  const enable = (): void => {
    process.env.INTEGRATIONS_MCP_ENABLED = 'true'
    process.env.INTEGRATIONS_PUBLIC_BASE_URL = BASE
  }
  const post = (url: string, body: unknown, ip = freshIp()) => request(app.getHttpServer()).post(url).set('x-real-ip', ip).send(body as object)
  const form = (url: string, body: Record<string, string>) =>
    request(app.getHttpServer()).post(url).set('x-real-ip', freshIp()).type('form').send(body)

  async function register(extra: Record<string, unknown> = {}) {
    const r = await post('/api/v1/oauth/register', { client_name: 'ChatGPT test', redirect_uris: [REDIRECT], ...extra })
    expect(r.status).toBe(201)
    return r.body as { client_id: string; client_secret?: string }
  }

  const params = (clientId: string, challenge: string, over: Record<string, unknown> = {}) => ({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'crm.read', state: 'st-123',
    code_challenge: challenge, code_challenge_method: 'S256', resource: MCP, ...over,
  })

  /** Đồng ý như trình duyệt: context → decision (Bearer JWT của người dùng) → trả code. */
  async function authorizeCode(token: string, p: Record<string, unknown>) {
    const ctx = await api(app, token).post('/api/v1/oauth/authorize/context').send({ params: p })
    expect(ctx.status).toBe(200)
    expect(ctx.body.ok).toBe(true)
    const dec = await api(app, token).post('/api/v1/oauth/authorize/decision').send({ params: p, approve: true, consent_token: ctx.body.consent_token })
    expect(dec.status).toBe(200)
    const url = new URL(dec.body.redirect_to as string)
    return { url, code: url.searchParams.get('code') as string }
  }

  async function fullTokens(userToken: string, clientId: string, secret?: string) {
    const { verifier, challenge } = pkce()
    const { code } = await authorizeCode(userToken, params(clientId, challenge))
    const t = await form('/api/v1/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId, ...(secret ? { client_secret: secret } : {}),
    })
    expect(t.status).toBe(200)
    return t.body as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }
  }

  beforeAll(async () => {
    ENV.forEach((k) => delete process.env[k])
    ;({ app, prisma, close } = await bootApp({ validation: true }))
  }, 60_000)

  afterAll(async () => {
    if (server) await new Promise((r) => server?.close(r))
    await close()
  })

  afterEach(async () => {
    ENV.forEach((k) => delete process.env[k])
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs RESTART IDENTITY`)
    await resetDb(prisma)
  })

  describe('cờ tắt ⇒ INERT', () => {
    it('mọi route OAuth trả 404 khi cờ tắt hoặc thiếu INTEGRATIONS_PUBLIC_BASE_URL', async () => {
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      for (const off of [() => undefined, () => { process.env.INTEGRATIONS_MCP_ENABLED = 'true' }]) {
        off()
        await request(app.getHttpServer()).get('/api/v1/oauth/.well-known/oauth-authorization-server').expect(404)
        await request(app.getHttpServer()).get('/api/v1/oauth/protected-resource').expect(404)
        await post('/api/v1/oauth/register', { redirect_uris: [REDIRECT] }).expect(404)
        await post('/api/v1/oauth/token', { grant_type: 'refresh_token' }).expect(404)
        await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: {} }).expect(404)
        await api(app, u.token).get('/api/v1/integrations/ai-connections').expect(404)
      }
    })

    it('/integrations/status báo mcp_url + base_url_configured', async () => {
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      let s = await api(app, u.token).get('/api/v1/integrations/status').expect(200)
      expect(s.body).toMatchObject({ mcp_enabled: false, mcp_base_url_configured: false, mcp_url: null })
      enable()
      s = await api(app, u.token).get('/api/v1/integrations/status').expect(200)
      expect(s.body).toMatchObject({ mcp_enabled: true, mcp_base_url_configured: true, mcp_url: MCP })
    })
  })

  describe('metadata (RFC 8414 / 9728)', () => {
    it('AS metadata: S256, CIMD, iss, endpoints khớp issuer', async () => {
      enable()
      const r = await request(app.getHttpServer()).get('/api/v1/oauth/.well-known/oauth-authorization-server').expect(200)
      expect(r.body).toMatchObject({
        issuer: ISS,
        authorization_endpoint: `${BASE}/oauth/authorize`,
        token_endpoint: `${ISS}/token`,
        registration_endpoint: `${ISS}/register`,
        revocation_endpoint: `${ISS}/revoke`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
      expect(r.body.token_endpoint_auth_methods_supported).toContain('none')
      expect(r.body.grant_types_supported).not.toContain('implicit')
      expect(r.body.grant_types_supported).not.toContain('password')
    })

    it('PRM: resource = URL MCP chuẩn tắc, authorization_servers = issuer', async () => {
      enable()
      const r = await request(app.getHttpServer()).get('/api/v1/oauth/protected-resource').expect(200)
      expect(r.body).toMatchObject({ resource: MCP, authorization_servers: [ISS], bearer_methods_supported: ['header'] })
    })
  })

  describe('DCR (RFC 7591)', () => {
    it('đăng ký public client; redirect_uri nguy hiểm bị từ chối', async () => {
      enable()
      const ok = await register()
      expect(ok.client_id).toMatch(/^trn_c_/)
      for (const bad of ['javascript:alert(1)', 'http://evil.example.com/cb', `${REDIRECT}#frag`, 'https://user:pw@client.example.com/cb', 'data:text/html,x', 'chatgpt://cb', 'https://x.example.com/a b']) {
        const r = await post('/api/v1/oauth/register', { client_name: 'bad', redirect_uris: [bad] })
        expect(r.status).toBe(400)
        expect(r.body.error).toBe('invalid_redirect_uri')
      }
      const loop = await post('/api/v1/oauth/register', { client_name: 'cc', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] })
      expect(loop.status).toBe(201)
    })

    it('chặn spam: > 10 đăng ký/giờ/IP ⇒ 429', async () => {
      enable()
      const ip = freshIp()
      for (let i = 0; i < 10; i += 1) await post('/api/v1/oauth/register', { redirect_uris: [REDIRECT] }, ip).expect(201)
      const r = await post('/api/v1/oauth/register', { redirect_uris: [REDIRECT] }, ip)
      expect(r.status).toBe(429)
      expect(r.headers['retry-after']).toBeDefined()
    })
  })

  describe('authorize (màn đồng ý)', () => {
    it('thiếu integrations.ai_connect ⇒ 403 (không cấp được token)', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(c.client_id, pkce().challenge) }).expect(403)
      await api(app, u.token).post('/api/v1/oauth/authorize/decision').send({ params: {}, approve: true, consent_token: 'x' }).expect(403)
    })

    it('client lạ / redirect_uri không đăng ký ⇒ 400, KHÔNG redirect (chống open redirect)', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const { challenge } = pkce()
      const unknown = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params('trn_c_nope', challenge) })
      expect(unknown.status).toBe(400)
      expect(unknown.body.error).toBe('invalid_client')
      for (const uri of ['https://evil.example.com/cb', `${REDIRECT}/../x`, `${REDIRECT}?a=1`, 'http://client.example.com/cb']) {
        const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(c.client_id, challenge, { redirect_uri: uri }) })
        expect(r.status).toBe(400)
        expect(r.body.error).toBe('invalid_request')
        expect(r.body.redirect_to).toBeUndefined()
      }
    })

    it('PKCE plain/thiếu, response_type lạ, scope lạ, resource lạ ⇒ lỗi redirect về client (có state + iss)', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const { challenge } = pkce()
      const cases: [Record<string, unknown>, string][] = [
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ code_challenge: undefined }, 'invalid_request'],
        [{ code_challenge: 'short' }, 'invalid_request'],
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ scope: 'crm.read admin.root' }, 'invalid_scope'],
        [{ resource: 'https://evil.example.com/mcp' }, 'invalid_target'],
      ]
      for (const [over, err] of cases) {
        const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(c.client_id, challenge, over) })
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(false)
        const url = new URL(r.body.redirect_to as string)
        expect(url.origin + url.pathname).toBe(REDIRECT)
        expect(url.searchParams.get('error')).toBe(err)
        expect(url.searchParams.get('state')).toBe('st-123')
        expect(url.searchParams.get('iss')).toBe(ISS)
      }
    })

    it('context trả thông tin hiển thị (tên client, host redirect, scope tiếng Việt)', async () => {
      enable()
      const c = await register({ client_name: 'Trợ lý X' })
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(c.client_id, pkce().challenge, { scope: 'crm.read crm.write' }) }).expect(200)
      expect(r.body.client).toMatchObject({ name: 'Trợ lý X', redirect_host: 'client.example.com', loopback: false, known_as: null })
      expect(r.body.scopes.map((s: { scope: string }) => s.scope)).toEqual(['crm.read', 'crm.write'])
      expect(r.body.scopes[1]).toMatchObject({ available: true, optional: true }) // ghi = scope tuỳ chọn (mặc định ghi thẳng theo quyền người kết nối; chế độ duyệt là tuỳ chọn)
    })

    it('decision: consent_token của người khác / sai tham số / giả mạo ⇒ 400; từ chối ⇒ access_denied', async () => {
      enable()
      const c = await register()
      const a = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const b = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const p = params(c.client_id, pkce().challenge)
      const ctx = await api(app, a.token).post('/api/v1/oauth/authorize/context').send({ params: p }).expect(200)
      const tok = ctx.body.consent_token as string
      // người khác dùng token consent của A
      await api(app, b.token).post('/api/v1/oauth/authorize/decision').send({ params: p, approve: true, consent_token: tok }).expect(400)
      // đổi tham số (scope) sau khi hiển thị
      await api(app, a.token).post('/api/v1/oauth/authorize/decision').send({ params: { ...p, scope: 'crm.read crm.write' }, approve: true, consent_token: tok }).expect(400)
      // đổi code_challenge
      await api(app, a.token).post('/api/v1/oauth/authorize/decision').send({ params: { ...p, code_challenge: pkce().challenge }, approve: true, consent_token: tok }).expect(400)
      // token giả
      await api(app, a.token).post('/api/v1/oauth/authorize/decision').send({ params: p, approve: true, consent_token: `${tok}x` }).expect(400)
      await api(app, a.token).post('/api/v1/oauth/authorize/decision').send({ params: p, approve: true }).expect(400)
      expect(await prisma.oauthAuthorizationCode.count()).toBe(0)
      const deny = await api(app, a.token).post('/api/v1/oauth/authorize/decision').send({ params: p, approve: false, consent_token: tok }).expect(200)
      const url = new URL(deny.body.redirect_to as string)
      expect(url.searchParams.get('error')).toBe('access_denied')
      expect(url.searchParams.get('code')).toBeNull()
      expect(url.searchParams.get('state')).toBe('st-123')
    })

    it('loopback (Claude Code): URI đăng ký không cổng ⇒ nhận mọi cổng; cổng khác path ⇒ từ chối', async () => {
      enable()
      const c = await register({ redirect_uris: ['http://localhost/callback'] })
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const { challenge } = pkce()
      const ok = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(c.client_id, challenge, { redirect_uri: 'http://localhost:3118/callback' }) })
      expect(ok.body.ok).toBe(true)
      expect(ok.body.client.loopback).toBe(true)
      const bad = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(c.client_id, challenge, { redirect_uri: 'http://localhost:3118/other' }) })
      expect(bad.status).toBe(400)
    })
  })

  describe('token / refresh / thu hồi', () => {
    it('luồng đầy đủ: code (1 lần) → access + refresh; sai PKCE/redirect_uri/client ⇒ invalid_grant; dùng lại code ⇒ thu hồi chuỗi', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const { verifier, challenge } = pkce()
      const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id }

      // PKCE sai → đốt mã
      const a1 = await authorizeCode(u.token, params(c.client_id, challenge))
      const wrong = await form('/api/v1/oauth/token', { ...base, code: a1.code, code_verifier: pkce().verifier })
      expect(wrong.status).toBe(400)
      expect(wrong.body.error).toBe('invalid_grant')
      expect((await form('/api/v1/oauth/token', { ...base, code: a1.code, code_verifier: verifier })).body.error).toBe('invalid_grant')

      // redirect_uri khác lúc xin mã
      const a2 = await authorizeCode(u.token, params(c.client_id, challenge))
      expect((await form('/api/v1/oauth/token', { ...base, redirect_uri: 'https://client.example.com/other', code: a2.code, code_verifier: verifier })).body.error).toBe('invalid_grant')

      // client khác dùng mã
      const other = await register()
      const a3 = await authorizeCode(u.token, params(c.client_id, challenge))
      expect((await form('/api/v1/oauth/token', { ...base, client_id: other.client_id, code: a3.code, code_verifier: verifier })).body.error).toBe('invalid_grant')

      // thành công
      const a4 = await authorizeCode(u.token, params(c.client_id, challenge))
      const ok = await form('/api/v1/oauth/token', { ...base, code: a4.code, code_verifier: verifier })
      expect(ok.status).toBe(200)
      expect(ok.headers['cache-control']).toBe('no-store')
      expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'crm.read' })
      expect(ok.body.access_token).toMatch(/^trn_at_/)
      expect(ok.body.refresh_token).toMatch(/^trn_rt_/)
      // DB chỉ có băm SHA-256, không có giá trị gốc
      const row = await prisma.oauthToken.findFirstOrThrow()
      expect(row.access_hash).toBe(createHash('sha256').update(ok.body.access_token).digest('hex'))
      expect(JSON.stringify(row)).not.toContain(ok.body.access_token)
      expect(JSON.stringify(row)).not.toContain(ok.body.refresh_token)
      const codeRow = await prisma.oauthAuthorizationCode.findFirstOrThrow({ where: { used_at: { not: null } }, orderBy: { id: 'desc' } })
      expect(codeRow.code_hash).toHaveLength(64)

      // client KHÁC dùng lại mã đã đổi ⇒ invalid_grant nhưng KHÔNG thu hồi phiên của nạn nhân
      expect((await form('/api/v1/oauth/token', { ...base, client_id: other.client_id, code: a4.code, code_verifier: verifier })).body.error).toBe('invalid_grant')
      expect((await prisma.oauthToken.findFirstOrThrow()).revoked_at).toBeNull()
      // đúng client dùng lại mã đã đổi ⇒ invalid_grant + chuỗi token sinh từ mã bị thu hồi
      const replay = await form('/api/v1/oauth/token', { ...base, code: a4.code, code_verifier: verifier })
      expect(replay.body.error).toBe('invalid_grant')
      expect((await prisma.oauthToken.findFirstOrThrow()).revoked_at).not.toBeNull()
    })

    it('mã hết hạn (60s) bị từ chối', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const { verifier, challenge } = pkce()
      const a = await authorizeCode(u.token, params(c.client_id, challenge))
      await prisma.$executeRawUnsafe(`UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 second'`)
      const r = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id, code: a.code, code_verifier: verifier })
      expect(r.body.error).toBe('invalid_grant')
    })

    it('refresh xoay vòng; dùng lại refresh cũ ⇒ thu hồi CẢ chuỗi (token mới cũng chết)', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const t1 = await fullTokens(u.token, c.client_id)
      const r1 = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.client_id })
      expect(r1.status).toBe(200)
      expect(r1.body.refresh_token).not.toBe(t1.refresh_token)
      expect(r1.body.access_token).not.toBe(t1.access_token)
      const { OauthTokenService } = require('../../../../services/crm/src/integrations/oauth/oauth-token.service') as typeof import('../../../../services/crm/src/integrations/oauth/oauth-token.service')
      const svc = app.get(OauthTokenService)
      expect(await svc.verifyAccessToken(r1.body.access_token)).not.toBeNull()
      // refresh song song cùng token trong cửa sổ 10s ⇒ lành tính (không thu hồi), cấp cặp mới cùng chuỗi
      const parallel = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.client_id })
      expect(parallel.status).toBe(200)
      expect(await svc.verifyAccessToken(r1.body.access_token)).not.toBeNull()
      // ăn cắp: dùng lại refresh cũ QUÁ cửa sổ
      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET refresh_used_at = now() - interval '1 minute' WHERE refresh_used_at IS NOT NULL`)
      const reuse = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: c.client_id })
      expect(reuse.status).toBe(400)
      expect(reuse.body.error).toBe('invalid_grant')
      expect(await svc.verifyAccessToken(r1.body.access_token)).toBeNull()
      expect(await svc.verifyAccessToken(parallel.body.access_token)).toBeNull()
      const afterRevoke = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: c.client_id })
      expect(afterRevoke.body.error).toBe('invalid_grant')
      const log = await prisma.integrationAuditLog.findMany({ where: { action: 'oauth.refresh_reuse' } })
      expect(log).toHaveLength(1)
    })

    it('refresh: client khác ⇒ invalid_grant; xin scope rộng hơn ⇒ invalid_scope; token hết hạn refresh ⇒ invalid_grant', async () => {
      enable()
      const c = await register()
      const other = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const t = await fullTokens(u.token, c.client_id)
      expect((await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: other.client_id })).body.error).toBe('invalid_grant')
      expect((await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id, scope: 'crm.read crm.write' })).body.error).toBe('invalid_scope')
      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET refresh_expires_at = now() - interval '1 second', refresh_used_at = NULL, revoked_at = NULL`)
      expect((await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id })).body.error).toBe('invalid_grant')
    })

    it('user bị khoá / mất integrations.ai_connect ⇒ token chết; refresh bị từ chối', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const t = await fullTokens(u.token, c.client_id)
      const { OauthTokenService } = require('../../../../services/crm/src/integrations/oauth/oauth-token.service') as typeof import('../../../../services/crm/src/integrations/oauth/oauth-token.service')
      const svc = app.get(OauthTokenService)
      expect(await svc.verifyAccessToken(t.access_token)).not.toBeNull()
      await prisma.user.update({ where: { id: u.id }, data: { status: 'locked' } })
      expect(await svc.verifyAccessToken(t.access_token)).toBeNull()
      await prisma.user.update({ where: { id: u.id }, data: { status: 'active' } })
      expect(await svc.verifyAccessToken(t.access_token)).not.toBeNull()
      // gỡ quyền ai_connect (+ xoá cache RBAC) ⇒ refresh bị từ chối
      await prisma.$executeRawUnsafe(`DELETE FROM role_permissions WHERE permission = 'integrations.ai_connect'`)
      const { RbacCache } = require('@trinity/rbac-nest') as typeof import('@trinity/rbac-nest')
      await app.get(RbacCache).invalidateUsers('*')
      const r = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('invalid_grant')
    })

    it('revoke (RFC 7009) luôn 200; token bị thu hồi ⇒ verify null', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const t = await fullTokens(u.token, c.client_id)
      const { OauthTokenService } = require('../../../../services/crm/src/integrations/oauth/oauth-token.service') as typeof import('../../../../services/crm/src/integrations/oauth/oauth-token.service')
      const svc = app.get(OauthTokenService)
      await form('/api/v1/oauth/revoke', { token: 'khong-ton-tai', client_id: c.client_id }).expect(200)
      const other = await register()
      await form('/api/v1/oauth/revoke', { token: t.access_token, client_id: other.client_id }).expect(200) // client khác: vô tác dụng
      expect(await svc.verifyAccessToken(t.access_token)).not.toBeNull()
      await form('/api/v1/oauth/revoke', { token: t.refresh_token, client_id: c.client_id }).expect(200)
      expect(await svc.verifyAccessToken(t.access_token)).toBeNull()
    })

    it('token hết hạn / audience sai ⇒ verify null', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const t = await fullTokens(u.token, c.client_id)
      const { OauthTokenService } = require('../../../../services/crm/src/integrations/oauth/oauth-token.service') as typeof import('../../../../services/crm/src/integrations/oauth/oauth-token.service')
      const svc = app.get(OauthTokenService)
      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET resource = 'https://evil.example.com/mcp'`)
      expect(await svc.verifyAccessToken(t.access_token)).toBeNull()
      await prisma.$executeRawUnsafe(`UPDATE oauth_tokens SET resource = '${MCP}', access_expires_at = now() - interval '1 second'`)
      expect(await svc.verifyAccessToken(t.access_token)).toBeNull()
    })

    it('client_secret_post: sai/thiếu secret ⇒ 401 invalid_client; đúng ⇒ cấp token', async () => {
      enable()
      const c = await register({ token_endpoint_auth_method: 'client_secret_post' })
      expect(c.client_secret).toMatch(/^trn_s_/)
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const { verifier, challenge } = pkce()
      const a = await authorizeCode(u.token, params(c.client_id, challenge))
      const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id, code: a.code, code_verifier: verifier }
      const noSecret = await form('/api/v1/oauth/token', base)
      expect(noSecret.status).toBe(401)
      expect(noSecret.body.error).toBe('invalid_client')
      expect((await form('/api/v1/oauth/token', { ...base, client_secret: 'sai' })).status).toBe(401)
      const row = await prisma.oauthClient.findFirstOrThrow()
      expect(row.client_secret_hash).toBe(createHash('sha256').update(c.client_secret as string).digest('hex'))
      await form('/api/v1/oauth/token', { ...base, client_secret: c.client_secret as string }).expect(200)
    })

    it('grant lạ (password/implicit/client_credentials) ⇒ unsupported_grant_type; thiếu tham số ⇒ invalid_request', async () => {
      enable()
      const c = await register()
      for (const g of ['password', 'client_credentials', 'implicit']) {
        const r = await form('/api/v1/oauth/token', { grant_type: g, client_id: c.client_id })
        expect(r.status).toBe(400)
        expect(r.body.error).toBe('unsupported_grant_type')
      }
      expect((await form('/api/v1/oauth/token', { grant_type: 'authorization_code', client_id: c.client_id })).body.error).toBe('invalid_request')
    })

    it('nhật ký tích hợp: ghi authorize/token_issued, KHÔNG chứa token/code', async () => {
      enable()
      const c = await register()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const t = await fullTokens(u.token, c.client_id)
      const rows = await prisma.integrationAuditLog.findMany({ where: { channel: 'mcp' } })
      expect(rows.map((r) => r.action).sort()).toEqual(['oauth.authorize', 'oauth.register', 'oauth.token_issued'])
      const dump = JSON.stringify(rows)
      expect(dump).not.toContain(t.access_token)
      expect(dump).not.toContain(t.refresh_token)
    })
  })

  describe('danh sách / thu hồi kết nối AI', () => {
    it('mình thấy của mình; người khác không thấy; ai_admin thấy tất cả + thu hồi; không phải chủ ⇒ 404', async () => {
      enable()
      const c = await register({ client_name: 'Claude test' })
      const a = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const b = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const adm = await makeUser(prisma, { grants: { 'integrations.ai_admin': true } })
      const ta = await fullTokens(a.token, c.client_id)
      await fullTokens(b.token, c.client_id)
      await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: ta.refresh_token, client_id: c.client_id }).expect(200) // vẫn 1 chuỗi

      const mine = await api(app, a.token).get('/api/v1/integrations/ai-connections').expect(200)
      expect(mine.body.data).toHaveLength(1)
      expect(mine.body.data[0]).toMatchObject({ client_name: 'Claude test', scopes: ['crm.read'] })
      await api(app, a.token).get('/api/v1/integrations/ai-connections?scope=all').expect(404) // không phải ai_admin
      const all = await api(app, adm.token).get('/api/v1/integrations/ai-connections?scope=all').expect(200)
      expect(all.body.data).toHaveLength(2)

      const famA = mine.body.data[0].id as string
      await api(app, b.token).delete(`/api/v1/integrations/ai-connections/${famA}`).expect(404)
      await api(app, a.token).delete(`/api/v1/integrations/ai-connections/${famA}`).expect(204)
      expect((await api(app, a.token).get('/api/v1/integrations/ai-connections').expect(200)).body.data).toHaveLength(0)
      const famB = (all.body.data as { id: string; user: { id: number } }[]).find((r) => r.user.id === b.id)?.id as string
      await api(app, adm.token).delete(`/api/v1/integrations/ai-connections/${famB}`).expect(204)
      await api(app, adm.token).delete(`/api/v1/integrations/ai-connections/khong-phai-uuid`).expect(404)
    })

    it('chỉ người có quyền nhóm Kết nối & AI mới gọi được (không quyền ⇒ 403)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'contacts.view': 'own' } })
      await api(app, u.token).get('/api/v1/integrations/ai-connections').expect(403)
      await api(app, u.token).delete('/api/v1/integrations/ai-connections/x').expect(403)
    })
  })

  describe('CIMD (client_id là URL metadata)', () => {
    let docs: Record<string, unknown> = {}
    let origin = ''

    beforeEach(async () => {
      docs = {}
      server = http.createServer((req, res) => {
        const d = docs[req.url ?? '']
        if (d === undefined) return void res.writeHead(404).end()
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' }).end(JSON.stringify(d))
      })
      await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
      origin = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
    })
    afterEach(async () => {
      if (server) await new Promise((r) => server?.close(r))
      server = null
    })

    it('tải metadata, kiểm client_id khớp + redirect_uris, cache; sai client_id/redirect ⇒ invalid_client', async () => {
      enable()
      process.env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS = 'true' // test: cho phép máy chủ metadata ở 127.0.0.1 (môi trường thật không bao giờ bật)
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const id = `${origin}/client.json`
      docs['/client.json'] = { client_id: id, client_name: 'CIMD App', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', logo_uri: 'https://client.example.com/logo.png' }
      const p = params(id, pkce().challenge)
      const ctx = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: p }).expect(200)
      expect(ctx.body.client).toMatchObject({ name: 'CIMD App', kind: 'cimd', logo_uri: 'https://client.example.com/logo.png' })
      const row = await prisma.oauthClient.findUniqueOrThrow({ where: { client_id: id } })
      expect(row.metadata_expires_at).not.toBeNull()
      // cache: sửa doc rồi hỏi lại trong hạn ⇒ vẫn dùng bản cũ
      docs['/client.json'] = { client_id: id, client_name: 'Đổi tên', redirect_uris: [REDIRECT] }
      expect((await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: p }).expect(200)).body.client.name).toBe('CIMD App')

      // client_id trong doc khác URL
      const id2 = `${origin}/mismatch.json`
      docs['/mismatch.json'] = { client_id: `${origin}/other.json`, client_name: 'x', redirect_uris: [REDIRECT] }
      const bad = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(id2, pkce().challenge) })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe('invalid_client')

      // redirect_uri trong yêu cầu không có trong doc
      const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(id, pkce().challenge, { redirect_uri: 'https://evil.example.com/cb' }) })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('invalid_request')

      // doc dùng client_secret ⇒ từ chối (CIMD không được có shared secret)
      const id3 = `${origin}/secret.json`
      docs['/secret.json'] = { client_id: id3, client_name: 'x', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' }
      expect((await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(id3, pkce().challenge) })).body.error).toBe('invalid_client')

      // endpoint token KHÔNG tải URL ngoài: CIMD chưa từng qua màn đồng ý ⇒ invalid_client
      const t = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x', client_id: `${origin}/never-seen.json` })
      expect(t.status).toBe(401)
    })

    it('luồng đầy đủ bằng CIMD client', async () => {
      enable()
      process.env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS = 'true'
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const id = `${origin}/full.json`
      docs['/full.json'] = { client_id: id, client_name: 'Full', redirect_uris: [REDIRECT] }
      const t = await fullTokens(u.token, id)
      expect(t.access_token).toMatch(/^trn_at_/)
    })

    it('SSRF: client_id trỏ IP nội bộ / localhost / metadata cloud ⇒ bị chặn (cờ private TẮT)', async () => {
      enable()
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      for (const id of ['https://127.0.0.1/c.json', 'https://localhost/c.json', 'https://169.254.169.254/latest/meta.json', 'https://10.0.0.5/c.json', 'https://[::1]/c.json', 'https://0x7f000001/c.json']) {
        const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(id, pkce().challenge) })
        expect(r.status).toBe(400)
        expect(r.body.error).toBe('invalid_client')
      }
      for (const id of ['https://example.com/', 'https://example.com', 'https://example.com/a/../b.json', 'https://u:p@example.com/c.json', 'https://example.com/c.json#x']) {
        const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(id, pkce().challenge) })
        expect(r.status).toBe(400)
      }
      // http (không phải https) KHÔNG được coi là CIMD khi cờ private tắt ⇒ tra như client thường ⇒ không tồn tại
      expect((await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params(`${origin}/x.json`, pkce().challenge) })).status).toBe(400)
      expect(await prisma.oauthClient.count({ where: { kind: 'cimd' } })).toBe(0)
    })

    it('INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS: host ngoài danh sách ⇒ từ chối', async () => {
      enable()
      process.env.INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS = 'claude.ai'
      const u = await makeUser(prisma, { grants: { 'integrations.ai_connect': true } })
      const r = await api(app, u.token).post('/api/v1/oauth/authorize/context').send({ params: params('https://chatgpt.com/client.json', pkce().challenge) })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('invalid_client')
    })
  })
})
