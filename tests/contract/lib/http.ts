import { expect } from 'vitest'
import { config } from './config.js'
import { recordCall } from './coverage.js'

export interface Res {
  status: number
  headers: Headers
  /** JSON đã parse; chuỗi thô nếu không phải JSON; `null` nếu body rỗng. */
  body: unknown
}

export interface ReqOpts {
  token?: string
  body?: unknown
  /** Thân `application/x-www-form-urlencoded` (OAuth token/revoke). */
  form?: Record<string, string>
  headers?: Record<string, string>
  /** IP khách giả qua `x-real-ip` (proxy cùng máy đã khai ở hồ sơ). Mỗi ca nên dùng IP riêng để không dính giới hạn tốc độ. */
  ip?: string
}

export async function call(method: string, path: string, opts: ReqOpts = {}): Promise<Res> {
  if (opts.form && opts.body !== undefined) throw new Error('call(): chỉ được đặt `form` hoặc `body`, không cả hai')
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.form) headers['content-type'] = 'application/x-www-form-urlencoded'
  if (opts.ip) headers['x-real-ip'] = opts.ip
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers,
    body: opts.form ? new URLSearchParams(opts.form).toString() : opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  })
  recordCall(method, path, res.status, Boolean(opts.token))
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, headers: res.headers, body }
}

export const api = {
  get: (p: string, o?: ReqOpts) => call('GET', `/api/v1${p}`, o),
  post: (p: string, o?: ReqOpts) => call('POST', `/api/v1${p}`, o),
  put: (p: string, o?: ReqOpts) => call('PUT', `/api/v1${p}`, o),
  patch: (p: string, o?: ReqOpts) => call('PATCH', `/api/v1${p}`, o),
  del: (p: string, o?: ReqOpts) => call('DELETE', `/api/v1${p}`, o),
}

/** API điều khiển test (C18 phía TS, K34 phía Rust): cần `x-service-secret`. Không tồn tại ở hồ sơ `production`. */
export const control = {
  runJob: (name: string, body: { company_id?: number; now?: string; [k: string]: unknown } = {}) =>
    call('POST', `/api/v1/internal/test/jobs/${name}/run`, {
      body: { company_id: 1, ...body },
      headers: { 'x-service-secret': config.serviceSecret },
    }),
  flushCache: () => call('POST', '/api/v1/internal/test/cache/flush', { headers: { 'x-service-secret': config.serviceSecret } }),
}

let ipSeq = 0
/** Băm đường dẫn file ca đang chạy: mỗi file một dải IP riêng, nên thêm/bớt ca ở file khác không đổi IP (và xô giới hạn tốc độ) của file này. */
function fileHash(): number {
  const p = expect.getState().testPath ?? ''
  let h = 2166136261
  for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), 16777619)
  return h >>> 0
}

/** IP giả duy nhất trong file (10.<băm>.<băm>.n) để các ca không chia chung xô giới hạn tốc độ theo IP. */
export function freshIp(): string {
  ipSeq += 1
  const h = fileHash()
  return `10.${(h % 200) + 20}.${((h >>> 8) % 200) + 20}.${(ipSeq % 250) + 1}`
}
