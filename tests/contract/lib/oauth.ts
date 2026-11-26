import { createHash, randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { config } from './config.js'
import { api, call, freshIp } from './http.js'
import type { Res } from './http.js'

/** Dùng chung cho các ca OAuth 2.1 (C13a): mọi thứ đi qua HTTP tới máy chủ hộp đen, địa chỉ gốc = `INTEGRATIONS_PUBLIC_BASE_URL` của hồ sơ. */
export const BASE = config.baseUrl
export const ISS = `${BASE}/api/v1/oauth`
export const MCP = `${BASE}/api/v1/mcp`
export const REDIRECT = 'https://client.example.com/cb'

const b64u = (b: Buffer): string => b.toString('base64url')
export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64u(randomBytes(48))
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }
}
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export const postJson = (path: string, body: unknown, ip = freshIp()): Promise<Res> => call('POST', path, { body, ip })
export const form = (path: string, body: Record<string, string>): Promise<Res> => call('POST', path, { form: body, ip: freshIp() })

export interface Client {
  client_id: string
  client_secret?: string
}

export async function register(extra: Record<string, unknown> = {}): Promise<Client> {
  const r = await postJson('/api/v1/oauth/register', { client_name: 'ChatGPT test', redirect_uris: [REDIRECT], ...extra })
  expect(r.status).toBe(201)
  return r.body as Client
}

export const params = (clientId: string, challenge: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  scope: 'crm.read',
  state: 'st-123',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource: MCP,
  ...over,
})

export const authContext = (token: string, p: Record<string, unknown>): Promise<Res> =>
  api.post('/oauth/authorize/context', { token, body: { params: p }, ip: freshIp() })
export const authDecision = (token: string, body: unknown): Promise<Res> => api.post('/oauth/authorize/decision', { token, body, ip: freshIp() })

/** Đồng ý như trình duyệt: context → decision (Bearer JWT của người dùng) → trả code. */
export async function authorizeCode(token: string, p: Record<string, unknown>): Promise<{ url: URL; code: string }> {
  const ctx = await authContext(token, p)
  expect(ctx.status).toBe(200)
  const cb = ctx.body as { ok: boolean; consent_token: string }
  expect(cb.ok).toBe(true)
  const dec = await authDecision(token, { params: p, approve: true, consent_token: cb.consent_token })
  expect(dec.status).toBe(200)
  const url = new URL((dec.body as { redirect_to: string }).redirect_to)
  return { url, code: url.searchParams.get('code') as string }
}

export interface Tokens {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
}

export async function fullTokens(userToken: string, clientId: string, secret?: string): Promise<Tokens> {
  const { verifier, challenge } = pkce()
  const { code } = await authorizeCode(userToken, params(clientId, challenge))
  const t = await form('/api/v1/oauth/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: clientId,
    ...(secret ? { client_secret: secret } : {}),
  })
  expect(t.status).toBe(200)
  return t.body as Tokens
}

/**
 * Thay `OauthTokenService.verifyAccessToken` của e2e cũ: gọi MCP bằng chính access token đó. Token hợp lệ ⇒ 200 (initialize);
 * thu hồi, hết hạn, sai audience hay người dùng bị khoá ⇒ 401.
 */
export async function tokenWorks(accessToken: string): Promise<boolean> {
  const res = await call('POST', '/api/v1/mcp', {
    token: accessToken,
    ip: freshIp(),
    headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract', version: '0' } } },
  })
  if (res.status === 200) return true
  expect(res.status, `MCP với token không hợp lệ phải 401, nhận ${res.status}`).toBe(401)
  return false
}
