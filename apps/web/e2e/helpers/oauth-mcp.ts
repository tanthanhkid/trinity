import crypto from 'node:crypto'
import { request as pwRequest, type APIRequestContext } from '@playwright/test'
import { BASE_URL, type Api } from './api'
import { bypassHeaders } from './vercel-bypass'

/** Tiện ích OAuth 2.1 (PKCE S256) + MCP JSON-RPC cho flow kết nối. KHÔNG log token. */
const b64url = (b: Buffer) => b.toString('base64url')

export const REDIRECT_URI = 'https://e2e.invalid/callback'
/** `INTEGRATIONS_PUBLIC_BASE_URL` của máy chủ; mặc định = URL đang test. Đặt `E2E_PUBLIC_BASE_URL` khi test qua URL công khai khác. */
export const MCP_URL = `${(process.env.E2E_PUBLIC_BASE_URL || BASE_URL).replace(/\/$/, '')}/api/v1/mcp`
const API = `${BASE_URL.replace(/\/$/, '')}/api/v1`
/** Nơi GỬI request MCP — luôn là URL đang test (MCP_URL chỉ là định danh `resource` công khai). */
const MCP_ENDPOINT = `${API}/mcp`

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48))
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) }
}

export async function registerClient(ctx: APIRequestContext, name: string): Promise<string> {
  const res = await ctx.post(`${API}/oauth/register`, { data: { client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'crm.read crm.write' } })
  if (res.status() !== 201) throw new Error(`oauth/register → HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()) as { client_id: string }).client_id
}

export interface Tokens { access: string; refresh: string; scope: string }

/** Chạy trọn luồng: context → decision (JWT phiên web của `api`) → token. */
export async function authorize(api: Api, ctx: APIRequestContext, clientId: string, scopes: string[]): Promise<Tokens> {
  const { verifier, challenge } = pkce()
  const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI, scope: scopes.join(' '), state: 'e2e-state', code_challenge: challenge, code_challenge_method: 'S256', resource: MCP_URL }
  const c = await api.post<{ ok: boolean; consent_token: string }>('/oauth/authorize/context', { params })
  if (!c.ok) throw new Error('authorize/context: ok=false')
  const d = await api.post<{ redirect_to: string }>('/oauth/authorize/decision', { params, approve: true, consent_token: c.consent_token, granted_scopes: scopes })
  const u = new URL(d.redirect_to)
  const code = u.searchParams.get('code')
  if (!code || u.searchParams.get('state') !== 'e2e-state') throw new Error('authorize/decision: thiếu code hoặc state lệch')
  const t = await ctx.post(`${API}/oauth/token`, { form: { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: MCP_URL } })
  if (!t.ok()) throw new Error(`oauth/token → HTTP ${t.status()}: ${(await t.text()).slice(0, 200)}`)
  const j = (await t.json()) as { access_token: string; refresh_token: string; scope: string }
  return { access: j.access_token, refresh: j.refresh_token, scope: j.scope }
}

export async function revokeToken(ctx: APIRequestContext, clientId: string, token: string): Promise<number> {
  return (await ctx.post(`${API}/oauth/revoke`, { form: { client_id: clientId, token } })).status()
}

export interface McpResult { status: number; result?: Record<string, any>; error?: { code: number; message: string }; headers: Record<string, string> } // eslint-disable-line @typescript-eslint/no-explicit-any

let rpcId = 1
export async function mcp(ctx: APIRequestContext, token: string | null, method: string, params?: unknown, origin?: string): Promise<McpResult> {
  const headers: Record<string, string> = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' }
  if (token) headers.authorization = `Bearer ${token}`
  if (origin) headers.origin = origin
  const res = await ctx.post(MCP_ENDPOINT, { headers, data: { jsonrpc: '2.0', id: rpcId++, method, params } })
  const text = await res.text()
  let body: { result?: McpResult['result']; error?: McpResult['error'] } = {}
  try {
    const raw = text.trim().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5)
    body = raw ? JSON.parse(raw) : {}
  } catch { /* 401/403 không phải JSON-RPC */ }
  return { status: res.status(), result: body.result, error: body.error, headers: res.headers() }
}

export const callTool = (ctx: APIRequestContext, token: string, name: string, args: unknown) => mcp(ctx, token, 'tools/call', { name, arguments: args })

export function newCtx(): Promise<APIRequestContext> {
  return pwRequest.newContext({ extraHTTPHeaders: bypassHeaders() })
}
