import { createHash, randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { config } from './config.js'
import { q, seedUser, type Scope } from './db.js'
import { call as httpCall, freshIp } from './http.js'
import { loginSeeded } from './session.js'

/**
 * Dùng chung cho các ca MCP và thao tác AI (C13b): DCR → đồng ý (JWT phiên web) → token → MCP JSON-RPC, tất cả bằng `fetch`
 * tới máy chủ hộp đen (client SDK của e2e cũ thay bằng JSON-RPC thô; địa chỉ gốc = `INTEGRATIONS_PUBLIC_BASE_URL` của hồ sơ).
 */
export const BASE = config.baseUrl
export const MCP = `${BASE}/api/v1/mcp`
export const PRM = `${BASE}/api/v1/oauth/protected-resource`
export const REDIRECT = 'https://client.example.com/cb'

export interface U {
  id: number
  token: string
}

/** Người dùng + vai trò riêng với đúng quyền (`true` = không phạm vi), đăng nhập thật. */
export async function makeUser(grants: Record<string, Scope | true> = {}, opts: { managerId?: number } = {}): Promise<U> {
  const mapped: Record<string, Scope> = {}
  for (const [k, v] of Object.entries(grants)) mapped[k] = v === true ? null : v
  const s = await seedUser({ label: 'm', grants: mapped, managerId: opts.managerId })
  return { id: s.id, token: (await loginSeeded(s)).token }
}

const b64u = (b: Buffer): string => b.toString('base64url')

async function formPost(path: string, body: Record<string, string>): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': freshIp() },
    body: new URLSearchParams(body).toString(),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export interface Connection {
  access: string
  refresh: string
  clientId: string
  scopes: string[]
}

/** DCR → đồng ý → token; trả access token của `userToken`. `granted` = các scope người dùng giữ lại ở màn đồng ý. */
export async function connect(userToken: string, scope = 'crm.read', opts: { resource?: string; granted?: string[] } = {}): Promise<Connection> {
  const reg = await httpCall('POST', '/api/v1/oauth/register', { body: { client_name: 'ChatGPT e2e', redirect_uris: [REDIRECT] }, ip: freshIp() })
  expect(reg.status).toBe(201)
  const clientId = (reg.body as { client_id: string }).client_id
  const verifier = b64u(randomBytes(48))
  const params = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope, state: 's', resource: opts.resource ?? MCP,
    code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  }
  const ctx = await httpCall('POST', '/api/v1/oauth/authorize/context', { token: userToken, body: { params }, ip: freshIp() })
  expect(ctx.status).toBe(200)
  const dec = await httpCall('POST', '/api/v1/oauth/authorize/decision', {
    token: userToken,
    body: { params, approve: true, consent_token: (ctx.body as { consent_token: string }).consent_token, ...(opts.granted ? { granted_scopes: opts.granted } : {}) },
    ip: freshIp(),
  })
  const code = new URL((dec.body as { redirect_to: string }).redirect_to).searchParams.get('code') as string
  const tok = await formPost('/api/v1/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId })
  expect(tok.status).toBe(200)
  return { access: tok.body.access_token, refresh: tok.body.refresh_token, clientId, scopes: String(tok.body.scope ?? '').split(' ') }
}

export interface RpcRes {
  status: number
  headers: Headers
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

let rid = 0
/** POST /mcp thô: `access` null = không token; `extraHeaders` cho `Origin`. */
export async function rpcRaw(access: string | null, body: unknown, extraHeaders: Record<string, string> = {}): Promise<RpcRes> {
  const res = await httpCall('POST', '/api/v1/mcp', {
    token: access ?? undefined,
    body,
    ip: freshIp(),
    headers: { accept: 'application/json, text/event-stream', ...extraHeaders },
  })
  return { status: res.status, headers: res.headers, body: res.body }
}
export const rpc = (access: string | null, method: string, params?: unknown, extraHeaders: Record<string, string> = {}): Promise<RpcRes> =>
  rpcRaw(access, { jsonrpc: '2.0', id: (rid += 1), method, params }, extraHeaders)

export interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
  structuredContent?: any // eslint-disable-line @typescript-eslint/no-explicit-any
}
export async function callTool(access: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = await rpc(access, 'tools/call', { name, arguments: args })
  expect(r.status).toBe(200)
  expect(r.body.error).toBeUndefined()
  return r.body.result as ToolResult
}

/** Khách seed bằng SQL; tên mang tiền tố để dọn theo ca. */
export async function mkContact(prefix: string, name: string, o: { assigned_to?: number; created_by_id?: number; phone?: string; stage_id?: number } = {}): Promise<{ id: number }> {
  const [r] = await q<{ id: number }>(
    `INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, stage_id, updated_at) VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
    [o.phone ?? '0912345678', `${prefix} ${name}`, o.assigned_to ?? null, o.created_by_id ?? null, o.stage_id ?? null],
  )
  return r
}

/** Gốc cho hai bảng chung của OAuth/MCP: dọn trước mỗi ca. */
export const TRUNCATE_OAUTH = `TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs, integration_events, ai_action_drafts RESTART IDENTITY`

export async function option(group: string, value: string): Promise<number> {
  const [r] = await q<{ id: number }>(
    `INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (group_key, value) DO UPDATE SET is_active = true RETURNING id`,
    [group, value, `E2E ${value}`],
  )
  return r.id
}
