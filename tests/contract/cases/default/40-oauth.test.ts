import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { api, call, control, freshIp } from '../../lib/http.js'
import { makeUser } from '../../lib/users.js'
import {
  authContext, authDecision, authorizeCode, BASE, form, fullTokens, ISS, MCP, params, pkce, postJson, REDIRECT, register, sha256, tokenWorks,
} from '../../lib/oauth.js'

/**
 * Chuyển từ `apps/monolith/test/rbac/oauth.e2e-spec.ts` (OAuth 2.1 AS) sang hộp đen, hồ sơ `default` (MCP bật, có địa chỉ gốc).
 * Phần e2e cũ đổi env giữa ca nằm ở hồ sơ riêng: `integrations-off`, `no-public-base-url` (INERT), `private-targets` và
 * `restricted-origins` (CIMD). `verifyAccessToken` trực tiếp ⇒ gọi MCP bằng chính token (`tokenWorks`); đọc/sửa DB ⇒ SQL.
 */
const AI = { 'integrations.ai_connect': true } as const

beforeEach(async () => {
  await q(`TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs RESTART IDENTITY`)
})
afterAll(closeDb)

type Body = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('trạng thái', () => {
  it('/integrations/status báo mcp_url + base_url_configured khi bật', async () => {
    const u = await makeUser(AI)
    const s = await api.get('/integrations/status', { token: u.token, ip: freshIp() })
    expect(s.status).toBe(200)
    expect(s.body).toMatchObject({ mcp_enabled: true, mcp_base_url_configured: true, mcp_url: MCP })
  })
})

describe('metadata (RFC 8414 / 9728)', () => {
  it('AS metadata: S256, CIMD, iss, endpoints khớp issuer', async () => {
    const r = await call('GET', '/api/v1/oauth/.well-known/oauth-authorization-server', { ip: freshIp() })
    expect(r.status).toBe(200)
    const b = r.body as Body
    expect(b).toMatchObject({
      issuer: ISS,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${ISS}/token`,
      registration_endpoint: `${ISS}/register`,
      revocation_endpoint: `${ISS}/revoke`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    })
    expect(b.token_endpoint_auth_methods_supported).toContain('none')
    expect(b.grant_types_supported).not.toContain('implicit')
    expect(b.grant_types_supported).not.toContain('password')
  })

  it('PRM: resource = URL MCP chuẩn tắc, authorization_servers = issuer', async () => {
    const r = await call('GET', '/api/v1/oauth/protected-resource', { ip: freshIp() })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ resource: MCP, authorization_servers: [ISS], bearer_methods_supported: ['header'] })
  })
})

describe('DCR (RFC 7591)', () => {
  it('đăng ký public client; redirect_uri nguy hiểm bị từ chối', async () => {
    const ok = await register()
    expect(ok.client_id).toMatch(/^trn_c_/)
    for (const bad of ['javascript:alert(1)', 'http://evil.example.com/cb', `${REDIRECT}#frag`, 'https://user:pw@client.example.com/cb', 'data:text/html,x', 'chatgpt://cb', 'https://x.example.com/a b']) {
      const r = await postJson('/api/v1/oauth/register', { client_name: 'bad', redirect_uris: [bad] })
      expect(r.status, bad).toBe(400)
      expect((r.body as Body).error).toBe('invalid_redirect_uri')
    }
    const loop = await postJson('/api/v1/oauth/register', { client_name: 'cc', redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] })
    expect(loop.status).toBe(201)
  })

  it('chặn spam: > 10 đăng ký/giờ/IP ⇒ 429', async () => {
    const ip = freshIp()
    for (let i = 0; i < 10; i += 1) expect((await postJson('/api/v1/oauth/register', { redirect_uris: [REDIRECT] }, ip)).status).toBe(201)
    const r = await postJson('/api/v1/oauth/register', { redirect_uris: [REDIRECT] }, ip)
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).not.toBeNull()
  })
})

describe('authorize (màn đồng ý)', () => {
  it('thiếu integrations.ai_connect ⇒ 403 (không cấp được token)', async () => {
    const c = await register()
    const u = await makeUser({ 'contacts.view': 'own' })
    expect((await authContext(u.token, params(c.client_id, pkce().challenge))).status).toBe(403)
    expect((await authDecision(u.token, { params: {}, approve: true, consent_token: 'x' })).status).toBe(403)
  })

  it('client lạ / redirect_uri không đăng ký ⇒ 400, KHÔNG redirect (chống open redirect)', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const { challenge } = pkce()
    const unknown = await authContext(u.token, params('trn_c_nope', challenge))
    expect(unknown.status).toBe(400)
    expect((unknown.body as Body).error).toBe('invalid_client')
    for (const uri of ['https://evil.example.com/cb', `${REDIRECT}/../x`, `${REDIRECT}?a=1`, 'http://client.example.com/cb']) {
      const r = await authContext(u.token, params(c.client_id, challenge, { redirect_uri: uri }))
      expect(r.status, uri).toBe(400)
      expect((r.body as Body).error).toBe('invalid_request')
      expect((r.body as Body).redirect_to).toBeUndefined()
    }
  })

  it('PKCE plain/thiếu, response_type lạ, scope lạ, resource lạ ⇒ lỗi redirect về client (có state + iss)', async () => {
    const c = await register()
    const u = await makeUser(AI)
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
      const r = await authContext(u.token, params(c.client_id, challenge, over))
      expect(r.status).toBe(200)
      expect((r.body as Body).ok).toBe(false)
      const url = new URL((r.body as Body).redirect_to as string)
      expect(url.origin + url.pathname).toBe(REDIRECT)
      expect(url.searchParams.get('error')).toBe(err)
      expect(url.searchParams.get('state')).toBe('st-123')
      expect(url.searchParams.get('iss')).toBe(ISS)
    }
  })

  it('context trả thông tin hiển thị (tên client, host redirect, scope tiếng Việt)', async () => {
    const c = await register({ client_name: 'Trợ lý X' })
    const u = await makeUser(AI)
    const r = await authContext(u.token, params(c.client_id, pkce().challenge, { scope: 'crm.read crm.write' }))
    expect(r.status).toBe(200)
    const b = r.body as Body
    expect(b.client).toMatchObject({ name: 'Trợ lý X', redirect_host: 'client.example.com', loopback: false, known_as: null })
    expect(b.scopes.map((s: { scope: string }) => s.scope)).toEqual(['crm.read', 'crm.write'])
    expect(b.scopes[1]).toMatchObject({ available: true, optional: true })
  })

  it('decision: consent_token của người khác / sai tham số / giả mạo ⇒ 400; từ chối ⇒ access_denied', async () => {
    const c = await register()
    const a = await makeUser(AI)
    const b = await makeUser(AI)
    const p = params(c.client_id, pkce().challenge)
    const ctx = await authContext(a.token, p)
    expect(ctx.status).toBe(200)
    const tok = (ctx.body as Body).consent_token as string
    expect((await authDecision(b.token, { params: p, approve: true, consent_token: tok })).status).toBe(400) // người khác dùng token của A
    expect((await authDecision(a.token, { params: { ...p, scope: 'crm.read crm.write' }, approve: true, consent_token: tok })).status).toBe(400) // đổi scope
    expect((await authDecision(a.token, { params: { ...p, code_challenge: pkce().challenge }, approve: true, consent_token: tok })).status).toBe(400)
    expect((await authDecision(a.token, { params: p, approve: true, consent_token: `${tok}x` })).status).toBe(400) // token giả
    expect((await authDecision(a.token, { params: p, approve: true })).status).toBe(400)
    expect((await q<{ n: string }>(`SELECT count(*) AS n FROM oauth_authorization_codes`))[0].n).toBe('0')
    const deny = await authDecision(a.token, { params: p, approve: false, consent_token: tok })
    expect(deny.status).toBe(200)
    const url = new URL((deny.body as Body).redirect_to as string)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('code')).toBeNull()
    expect(url.searchParams.get('state')).toBe('st-123')
  })

  it('loopback (Claude Code): URI đăng ký không cổng ⇒ nhận mọi cổng; cổng khác path ⇒ từ chối', async () => {
    const c = await register({ redirect_uris: ['http://localhost/callback'] })
    const u = await makeUser(AI)
    const { challenge } = pkce()
    const ok = await authContext(u.token, params(c.client_id, challenge, { redirect_uri: 'http://localhost:3118/callback' }))
    expect((ok.body as Body).ok).toBe(true)
    expect((ok.body as Body).client.loopback).toBe(true)
    const bad = await authContext(u.token, params(c.client_id, challenge, { redirect_uri: 'http://localhost:3118/other' }))
    expect(bad.status).toBe(400)
  })
})

describe('token / refresh / thu hồi', () => {
  it('luồng đầy đủ: code (1 lần) → access + refresh; sai PKCE/redirect_uri/client ⇒ invalid_grant; dùng lại code ⇒ thu hồi chuỗi', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const { verifier, challenge } = pkce()
    const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id }
    const err = async (over: Record<string, string>): Promise<unknown> => ((await form('/api/v1/oauth/token', { ...base, ...over })).body as Body).error

    const a1 = await authorizeCode(u.token, params(c.client_id, challenge)) // PKCE sai → đốt mã
    const wrong = await form('/api/v1/oauth/token', { ...base, code: a1.code, code_verifier: pkce().verifier })
    expect(wrong.status).toBe(400)
    expect((wrong.body as Body).error).toBe('invalid_grant')
    expect(await err({ code: a1.code, code_verifier: verifier })).toBe('invalid_grant')

    const a2 = await authorizeCode(u.token, params(c.client_id, challenge)) // redirect_uri khác lúc xin mã
    expect(await err({ redirect_uri: 'https://client.example.com/other', code: a2.code, code_verifier: verifier })).toBe('invalid_grant')

    const other = await register() // client khác dùng mã
    const a3 = await authorizeCode(u.token, params(c.client_id, challenge))
    expect(await err({ client_id: other.client_id, code: a3.code, code_verifier: verifier })).toBe('invalid_grant')

    const a4 = await authorizeCode(u.token, params(c.client_id, challenge)) // thành công
    const ok = await form('/api/v1/oauth/token', { ...base, code: a4.code, code_verifier: verifier })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    const t = ok.body as Body
    expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'crm.read' })
    expect(t.access_token).toMatch(/^trn_at_/)
    expect(t.refresh_token).toMatch(/^trn_rt_/)
    // DB chỉ có băm SHA-256, không có giá trị gốc
    const row = (await q<Record<string, unknown>>(`SELECT * FROM oauth_tokens ORDER BY id LIMIT 1`))[0]
    expect(row.access_hash).toBe(sha256(t.access_token))
    expect(JSON.stringify(row)).not.toContain(t.access_token)
    expect(JSON.stringify(row)).not.toContain(t.refresh_token)
    const codeRow = (await q<{ code_hash: string }>(`SELECT code_hash FROM oauth_authorization_codes WHERE used_at IS NOT NULL ORDER BY id DESC LIMIT 1`))[0]
    expect(codeRow.code_hash).toHaveLength(64)

    // client KHÁC dùng lại mã đã đổi ⇒ invalid_grant nhưng KHÔNG thu hồi phiên của nạn nhân
    expect(await err({ client_id: other.client_id, code: a4.code, code_verifier: verifier })).toBe('invalid_grant')
    expect((await q<{ revoked_at: unknown }>(`SELECT revoked_at FROM oauth_tokens LIMIT 1`))[0].revoked_at).toBeNull()
    // đúng client dùng lại mã đã đổi ⇒ invalid_grant + chuỗi token sinh từ mã bị thu hồi
    expect(await err({ code: a4.code, code_verifier: verifier })).toBe('invalid_grant')
    expect((await q<{ revoked_at: unknown }>(`SELECT revoked_at FROM oauth_tokens LIMIT 1`))[0].revoked_at).not.toBeNull()
  })

  it('mã hết hạn (60s) bị từ chối', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const { verifier, challenge } = pkce()
    const a = await authorizeCode(u.token, params(c.client_id, challenge))
    await q(`UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 second'`)
    const r = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id, code: a.code, code_verifier: verifier })
    expect((r.body as Body).error).toBe('invalid_grant')
  })

  it('refresh xoay vòng; dùng lại refresh cũ ⇒ thu hồi CẢ chuỗi (token mới cũng chết)', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const t1 = await fullTokens(u.token, c.client_id)
    const refresh = (rt: string) => form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: rt, client_id: c.client_id })
    const r1 = await refresh(t1.refresh_token)
    expect(r1.status).toBe(200)
    const n1 = r1.body as Body
    expect(n1.refresh_token).not.toBe(t1.refresh_token)
    expect(n1.access_token).not.toBe(t1.access_token)
    expect(await tokenWorks(n1.access_token)).toBe(true)
    // refresh song song cùng token trong cửa sổ 10s ⇒ lành tính (không thu hồi), cấp cặp mới cùng chuỗi
    const parallel = await refresh(t1.refresh_token)
    expect(parallel.status).toBe(200)
    expect(await tokenWorks(n1.access_token)).toBe(true)
    // ăn cắp: dùng lại refresh cũ QUÁ cửa sổ
    await q(`UPDATE oauth_tokens SET refresh_used_at = now() - interval '1 minute' WHERE refresh_used_at IS NOT NULL`)
    const reuse = await refresh(t1.refresh_token)
    expect(reuse.status).toBe(400)
    expect((reuse.body as Body).error).toBe('invalid_grant')
    expect(await tokenWorks(n1.access_token)).toBe(false)
    expect(await tokenWorks((parallel.body as Body).access_token)).toBe(false)
    expect(((await refresh(n1.refresh_token)).body as Body).error).toBe('invalid_grant')
    expect(await q(`SELECT 1 FROM integration_audit_logs WHERE action = 'oauth.refresh_reuse'`)).toHaveLength(1)
  })

  it('refresh: client khác ⇒ invalid_grant; xin scope rộng hơn ⇒ invalid_scope; token hết hạn refresh ⇒ invalid_grant', async () => {
    const c = await register()
    const other = await register()
    const u = await makeUser(AI)
    const t = await fullTokens(u.token, c.client_id)
    const err = async (over: Record<string, string>): Promise<unknown> =>
      ((await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id, ...over })).body as Body).error
    expect(await err({ client_id: other.client_id })).toBe('invalid_grant')
    expect(await err({ scope: 'crm.read crm.write' })).toBe('invalid_scope')
    await q(`UPDATE oauth_tokens SET refresh_expires_at = now() - interval '1 second', refresh_used_at = NULL, revoked_at = NULL`)
    expect(await err({})).toBe('invalid_grant')
  })

  it('user bị khoá / mất integrations.ai_connect ⇒ token chết; refresh bị từ chối', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const t = await fullTokens(u.token, c.client_id)
    expect(await tokenWorks(t.access_token)).toBe(true)
    await q(`UPDATE users SET status = 'locked' WHERE id = $1`, [u.id])
    expect(await tokenWorks(t.access_token)).toBe(false)
    await q(`UPDATE users SET status = 'active' WHERE id = $1`, [u.id])
    expect(await tokenWorks(t.access_token)).toBe(true)
    // gỡ quyền ai_connect (+ xoá cache RBAC bằng API điều khiển) ⇒ refresh bị từ chối
    await q(`DELETE FROM role_permissions WHERE permission = 'integrations.ai_connect' AND role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1)`, [u.id])
    expect((await control.flushCache()).status).toBe(200)
    const r = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.client_id })
    expect(r.status).toBe(400)
    expect((r.body as Body).error).toBe('invalid_grant')
  })

  it('revoke (RFC 7009) luôn 200; token bị thu hồi ⇒ không còn dùng được', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const t = await fullTokens(u.token, c.client_id)
    expect((await form('/api/v1/oauth/revoke', { token: 'khong-ton-tai', client_id: c.client_id })).status).toBe(200)
    const other = await register()
    expect((await form('/api/v1/oauth/revoke', { token: t.access_token, client_id: other.client_id })).status).toBe(200) // client khác: vô tác dụng
    expect(await tokenWorks(t.access_token)).toBe(true)
    expect((await form('/api/v1/oauth/revoke', { token: t.refresh_token, client_id: c.client_id })).status).toBe(200)
    expect(await tokenWorks(t.access_token)).toBe(false)
  })

  it('token hết hạn / audience sai ⇒ không dùng được', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const t = await fullTokens(u.token, c.client_id)
    await q(`UPDATE oauth_tokens SET resource = 'https://evil.example.com/mcp'`)
    expect(await tokenWorks(t.access_token)).toBe(false)
    await q(`UPDATE oauth_tokens SET resource = $1, access_expires_at = now() - interval '1 second'`, [MCP])
    expect(await tokenWorks(t.access_token)).toBe(false)
  })

  it('client_secret_post: sai/thiếu secret ⇒ 401 invalid_client; đúng ⇒ cấp token', async () => {
    const c = await register({ token_endpoint_auth_method: 'client_secret_post' })
    expect(c.client_secret).toMatch(/^trn_s_/)
    const u = await makeUser(AI)
    const { verifier, challenge } = pkce()
    const a = await authorizeCode(u.token, params(c.client_id, challenge))
    const base = { grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: c.client_id, code: a.code, code_verifier: verifier }
    const noSecret = await form('/api/v1/oauth/token', base)
    expect(noSecret.status).toBe(401)
    expect((noSecret.body as Body).error).toBe('invalid_client')
    expect((await form('/api/v1/oauth/token', { ...base, client_secret: 'sai' })).status).toBe(401)
    const row = (await q<{ client_secret_hash: string }>(`SELECT client_secret_hash FROM oauth_clients LIMIT 1`))[0]
    expect(row.client_secret_hash).toBe(sha256(c.client_secret as string))
    expect((await form('/api/v1/oauth/token', { ...base, client_secret: c.client_secret as string })).status).toBe(200)
  })

  it('grant lạ (password/implicit/client_credentials) ⇒ unsupported_grant_type; thiếu tham số ⇒ invalid_request', async () => {
    const c = await register()
    for (const g of ['password', 'client_credentials', 'implicit']) {
      const r = await form('/api/v1/oauth/token', { grant_type: g, client_id: c.client_id })
      expect(r.status, g).toBe(400)
      expect((r.body as Body).error).toBe('unsupported_grant_type')
    }
    expect(((await form('/api/v1/oauth/token', { grant_type: 'authorization_code', client_id: c.client_id })).body as Body).error).toBe('invalid_request')
  })

  it('nhật ký tích hợp: ghi authorize/token_issued, KHÔNG chứa token/code', async () => {
    const c = await register()
    const u = await makeUser(AI)
    const t = await fullTokens(u.token, c.client_id)
    const rows = await q<{ action: string }>(`SELECT * FROM integration_audit_logs WHERE channel = 'mcp'`)
    expect(rows.map((r) => r.action).sort()).toEqual(['oauth.authorize', 'oauth.register', 'oauth.token_issued'])
    const dump = JSON.stringify(rows)
    expect(dump).not.toContain(t.access_token)
    expect(dump).not.toContain(t.refresh_token)
  })
})

describe('danh sách / thu hồi kết nối AI', () => {
  it('mình thấy của mình; người khác không thấy; ai_admin thấy tất cả + thu hồi; không phải chủ ⇒ 404', async () => {
    const c = await register({ client_name: 'Claude test' })
    const a = await makeUser(AI)
    const b = await makeUser(AI)
    const adm = await makeUser({ 'integrations.ai_admin': true })
    const ta = await fullTokens(a.token, c.client_id)
    await fullTokens(b.token, c.client_id)
    expect((await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: ta.refresh_token, client_id: c.client_id })).status).toBe(200) // vẫn 1 chuỗi

    const list = (u: { token: string }, qs = '') => api.get(`/integrations/ai-connections${qs}`, { token: u.token, ip: freshIp() })
    const mine = await list(a)
    expect(mine.status).toBe(200)
    const md = (mine.body as Body).data as Body[]
    expect(md).toHaveLength(1)
    expect(md[0]).toMatchObject({ client_name: 'Claude test', scopes: ['crm.read'] })
    expect((await list(a, '?scope=all')).status).toBe(404) // không phải ai_admin
    const all = await list(adm, '?scope=all')
    expect(all.status).toBe(200)
    expect((all.body as Body).data).toHaveLength(2)

    const remove = (u: { token: string }, id: string) => api.del(`/integrations/ai-connections/${id}`, { token: u.token, ip: freshIp() })
    const famA = md[0].id as string
    expect((await remove(b, famA)).status).toBe(404)
    expect((await remove(a, famA)).status).toBe(204)
    expect(((await list(a)).body as Body).data).toHaveLength(0)
    const famB = ((all.body as Body).data as { id: string; user: { id: number } }[]).find((r) => r.user.id === b.id)?.id as string
    expect((await remove(adm, famB)).status).toBe(204)
    expect((await remove(adm, 'khong-phai-uuid')).status).toBe(404)
  })

  it('chỉ người có quyền nhóm Kết nối & AI mới gọi được (không quyền ⇒ 403)', async () => {
    const u = await makeUser({ 'contacts.view': 'own' })
    expect((await api.get('/integrations/ai-connections', { token: u.token, ip: freshIp() })).status).toBe(403)
    expect((await api.del('/integrations/ai-connections/x', { token: u.token, ip: freshIp() })).status).toBe(403)
  })
})

describe('CIMD (client_id là URL metadata) — cờ private TẮT', () => {
  it('SSRF: client_id trỏ IP nội bộ / localhost / metadata cloud ⇒ bị chặn', async () => {
    const u = await makeUser(AI)
    for (const id of ['https://127.0.0.1/c.json', 'https://localhost/c.json', 'https://169.254.169.254/latest/meta.json', 'https://10.0.0.5/c.json', 'https://[::1]/c.json', 'https://0x7f000001/c.json']) {
      const r = await authContext(u.token, params(id, pkce().challenge))
      expect(r.status, id).toBe(400)
      expect((r.body as Body).error).toBe('invalid_client')
    }
    for (const id of ['https://example.com/', 'https://example.com', 'https://example.com/a/../b.json', 'https://u:p@example.com/c.json', 'https://example.com/c.json#x']) {
      expect((await authContext(u.token, params(id, pkce().challenge))).status, id).toBe(400)
    }
    // http (không phải https) KHÔNG được coi là CIMD khi cờ private tắt ⇒ tra như client thường ⇒ không tồn tại
    expect((await authContext(u.token, params('http://127.0.0.1:9/x.json', pkce().challenge))).status).toBe(400)
    expect(await q(`SELECT 1 FROM oauth_clients WHERE kind = 'cimd'`)).toHaveLength(0)
  })
})
