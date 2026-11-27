import { createCipheriv, createHmac, randomBytes } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'vitest'
import { q, seedUser, type Scope } from './db.js'
import { api, control, freshIp, type Res } from './http.js'
import { loginSeeded } from './session.js'

/**
 * Dùng chung cho các ca webhook ra (C12a): máy nhận cục bộ, chữ ký, người dùng theo quyền, seed outbox/delivery bằng SQL,
 * bước "chạy một lượt dispatcher + worker" qua API điều khiển test. Không import mã backend.
 */
export const B = '/integrations/webhooks'
export const PHONE = '0900000356'

// ---- Máy nhận ---------------------------------------------------------------------------------------------------
export interface Seen {
  headers: http.IncomingHttpHeaders
  body: string
}
export interface Receiver {
  url: string
  seen: Seen[]
  status: number
  close: () => Promise<void>
}

/** Máy chủ HTTP cục bộ ghi lại từng yêu cầu; trả mã `status` (đổi được giữa chừng). Máy chủ hộp đen gọi tới `127.0.0.1` (hồ sơ `private-targets`). */
export async function startReceiver(): Promise<Receiver> {
  const r: Receiver = { url: '', seen: [], status: 200, close: async () => undefined }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      r.seen.push({ headers: req.headers, body })
      res.statusCode = r.status
      res.end('x')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
  r.close = async () => {
    server.closeAllConnections()
    await new Promise<void>((ok) => server.close(() => ok()))
  }
  return r
}

/** `X-Trinity-Signature: t=<giây>,v1=<hex HMAC-SHA256(secret, "<t>.<thân>")>`, trong ±300 giây (viết lại độc lập với mã backend). */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '')
  if (!m) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(m[1])) > 300) return false
  return createHmac('sha256', secret).update(`${m[1]}.`).update(body).digest('hex') === m[2]
}

/** Bản mã secret theo định dạng `v1.<iv>.<tag>.<ct>` (AES-256-GCM, AAD cố định) bằng một khoá BẤT KỲ: ca "đổi khoá" seed bản mã của khoá khác. */
export function encryptWithForeignKey(plain: string): string {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from('trinity-webhook-secret/v1'))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

// ---- Người dùng và lời gọi ---------------------------------------------------------------------------------------
type Grants = Record<string, Scope | true>
export interface U {
  id: number
  token: string
}
/** Tên hiển thị nằm trong response nên nhãn đánh số tuần tự (ổn định giữa các lần chạy). */
let userSeq = 0
export async function mk(grants: Grants, extra: { managerId?: number } = {}): Promise<U> {
  const g: Record<string, Scope> = {}
  for (const [k, v] of Object.entries(grants)) g[k] = v === true ? null : v
  const u = await seedUser({ label: `u${++userSeq}`, grants: g, managerId: extra.managerId })
  return { id: u.id, token: (await loginSeeded(u)).token }
}

export function a(token?: string) {
  const url = (p: string, query?: Record<string, string>): string => (query ? `${p}?${new URLSearchParams(query).toString()}` : p)
  return {
    get: (p: string, query?: Record<string, string>) => api.get(url(p, query), { token, ip: freshIp() }),
    post: (p: string, body: unknown = {}) => api.post(p, { token, body, ip: freshIp() }),
    patch: (p: string, body: unknown = {}) => api.patch(p, { token, body, ip: freshIp() }),
    del: (p: string) => api.del(p, { token, ip: freshIp() }),
  }
}

/** `.expect(status)` của supertest: chờ response, khẳng định mã (in cả body khi sai), trả response. */
export async function st(res: Promise<Res>, status: number): Promise<Res> {
  const r = await res
  expect({ status: r.status, body: r.body }).toMatchObject({ status })
  return r
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = any

export async function mkEndpoint(token: string, url: string, over: Record<string, unknown> = {}): Promise<{ id: number; secret: string }> {
  const res = await st(a(token).post(`${B}/endpoints`, { name: 'Test', url, events: ['contact.created'], ...over }), 201)
  return res.body as { id: number; secret: string }
}

// ---- DB ---------------------------------------------------------------------------------------------------------
/** e2e gốc dọn ở `afterEach`; mỗi ca hộp đen tự dọn ở đầu (id và đếm bảng phải bắt đầu từ trống). */
export async function resetWebhooks(): Promise<void> {
  await q(`TRUNCATE TABLE webhook_deliveries, webhook_endpoints, integration_events, integration_audit_logs RESTART IDENTITY`)
}

export const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(sql, params))[0].n)

export function contactPayload(assigned: number, over: Record<string, unknown> = {}, phone = PHONE): Record<string, unknown> {
  return {
    contact: {
      id: 1, phone, phone_2: null, full_name: 'Khách A', email: null, zalo_account: null, source_id: null, stage_id: null,
      contact_status_id: null, assigned_to: assigned, team_id: null, created_by_id: assigned, project_id: null,
      created_at: new Date().toISOString(), updated_at: null, deleted_at: null, ...over,
    },
    origin: 'manual',
  }
}

/** Ghi một dòng outbox bằng SQL (thay `publishIntegrationEvent`). `dispatched` = đã đẩy sang delivery. */
export async function contactEvent(assigned: number, opts: { phone?: string; contact?: Record<string, unknown>; dispatched?: boolean } = {}): Promise<number> {
  const payload = contactPayload(assigned, opts.contact, opts.phone ?? PHONE)
  const [r] = await q<{ id: number }>(
    `INSERT INTO integration_events (event_type, resource, resource_id, payload, actor_user_id, dispatched_at)
     VALUES ('contact.created', 'contact', '1', $1::jsonb, $2, ${opts.dispatched ? 'now()' : 'NULL'}) RETURNING id`,
    [JSON.stringify(payload), assigned],
  )
  return r.id
}

/** Delivery đang chờ gửi, dựng như dispatcher đã dựng (payload theo quyền lúc dựng). Thay `dispatcher.dispatchEvents()` đứng riêng. */
export async function pendingDelivery(endpointId: number, eventId: number, payload: Record<string, unknown>, over: { status?: string; attempts?: number } = {}): Promise<string> {
  const [r] = await q<{ id: string }>(
    `INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload, status, attempts)
     VALUES ($1, $2, 'contact.created', $3::jsonb, $4, $5) RETURNING id::text AS id`,
    [endpointId, eventId, JSON.stringify(payload), over.status ?? 'pending', over.attempts ?? 0],
  )
  return r.id
}

/** Một lượt dispatcher + worker qua API điều khiển (thay `dispatcher.tick()`); lịch tự động đã tắt nên chỉ chạy khi ca gọi. */
export async function tick(): Promise<Res> {
  const res = await control.runJob('webhook-dispatch')
  expect(res.status).toBe(200)
  return res
}

export const forceDue = (): Promise<unknown> => q(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status IN ('pending','failed')`)

export const roleOf = async (userId: number): Promise<number> => (await q<{ role_id: number }>(`SELECT role_id FROM user_roles WHERE user_id = $1 LIMIT 1`, [userId]))[0].role_id
