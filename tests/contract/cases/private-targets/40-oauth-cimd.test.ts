import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { fullTokens, params, pkce, authContext, form, REDIRECT } from '../../lib/oauth.js'
import { makeUser } from '../../lib/users.js'

/**
 * CIMD với hồ sơ `private-targets` (INTEGRATIONS_ALLOW_PRIVATE_TARGETS=true, chỉ ngoài production): máy chủ metadata của ca
 * nghe ở 127.0.0.1 trong chính tiến trình test; máy chủ hộp đen tải về qua loopback. Chuyển từ `oauth.e2e-spec.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>
let server: http.Server
let docs: Record<string, unknown> = {}
let origin = ''

beforeEach(async () => {
  await q(`TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs RESTART IDENTITY`)
  docs = {}
  server = http.createServer((req, res) => {
    const d = docs[req.url ?? '']
    if (d === undefined) return void res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' }).end(JSON.stringify(d))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
})
afterAll(closeDb)

describe('CIMD (client_id là URL metadata) — cho phép địa chỉ nội bộ', () => {
  it('tải metadata, kiểm client_id khớp + redirect_uris, cache; sai client_id/redirect ⇒ invalid_client', async () => {
    const u = await makeUser({ 'integrations.ai_connect': true })
    const id = `${origin}/client.json`
    docs['/client.json'] = { client_id: id, client_name: 'CIMD App', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', logo_uri: 'https://client.example.com/logo.png' }
    const p = params(id, pkce().challenge)
    const ctx = await authContext(u.token, p)
    expect(ctx.status).toBe(200)
    expect((ctx.body as Body).client).toMatchObject({ name: 'CIMD App', kind: 'cimd', logo_uri: 'https://client.example.com/logo.png' })
    const row = (await q<{ metadata_expires_at: unknown }>(`SELECT metadata_expires_at FROM oauth_clients WHERE client_id = $1`, [id]))[0]
    expect(row.metadata_expires_at).not.toBeNull()
    // cache: sửa doc rồi hỏi lại trong hạn ⇒ vẫn dùng bản cũ
    docs['/client.json'] = { client_id: id, client_name: 'Đổi tên', redirect_uris: [REDIRECT] }
    expect(((await authContext(u.token, p)).body as Body).client.name).toBe('CIMD App')

    const id2 = `${origin}/mismatch.json` // client_id trong doc khác URL
    docs['/mismatch.json'] = { client_id: `${origin}/other.json`, client_name: 'x', redirect_uris: [REDIRECT] }
    const bad = await authContext(u.token, params(id2, pkce().challenge))
    expect(bad.status).toBe(400)
    expect((bad.body as Body).error).toBe('invalid_client')

    const r = await authContext(u.token, params(id, pkce().challenge, { redirect_uri: 'https://evil.example.com/cb' })) // redirect_uri không có trong doc
    expect(r.status).toBe(400)
    expect((r.body as Body).error).toBe('invalid_request')

    const id3 = `${origin}/secret.json` // CIMD không được có shared secret
    docs['/secret.json'] = { client_id: id3, client_name: 'x', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' }
    expect(((await authContext(u.token, params(id3, pkce().challenge))).body as Body).error).toBe('invalid_client')

    // endpoint token KHÔNG tải URL ngoài: CIMD chưa từng qua màn đồng ý ⇒ invalid_client
    const t = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x', client_id: `${origin}/never-seen.json` })
    expect(t.status).toBe(401)
  })

  it('luồng đầy đủ bằng CIMD client', async () => {
    const u = await makeUser({ 'integrations.ai_connect': true })
    const id = `${origin}/full.json`
    docs['/full.json'] = { client_id: id, client_name: 'Full', redirect_uris: [REDIRECT] }
    const t = await fullTokens(u.token, id)
    expect(t.access_token).toMatch(/^trn_at_/)
  })
})
