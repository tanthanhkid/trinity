/**
 * Máy chủ giả Graph API (Facebook) và Zalo cho test hợp đồng (C06b). Chạy trong tiến trình của bộ chạy (`run.ts`), lắng nghe
 * loopback; máy chủ Trinity trỏ tới đây bằng `FACEBOOK_GRAPH_BASE_URL`, `ZALO_OAUTH_BASE_URL`, `ZALO_OPENAPI_BASE_URL`,
 * `ZALO_ZNS_BASE_URL` (G15). Trả lời mặc định = thành công; ca test đặt kịch bản lỗi qua `/__mock/*` (xem `lib/channels.ts`).
 *
 * Mọi lời gọi được ghi lại (`GET /__mock/calls`); đường không biết trả 501 và được ghi vào `unexpected` để ca test và bộ chạy kiểm.
 */
import * as http from 'node:http'

export interface Call {
  n: number
  method: string
  /** Đường dẫn đã bỏ tiền tố dịch vụ và phiên bản Graph, ví dụ `me/messages`, `v3.0/oa/message/cs`. */
  path: string
  service: 'graph' | 'zalo-oauth' | 'zalo-api' | 'zalo-zns'
  query: Record<string, string>
  /** Chỉ tên header xác thực có mặt, không ghi giá trị token. */
  auth: { bearer: boolean; access_token: boolean; secret_key: boolean }
  body: unknown
}

export interface Rule {
  /** `METHOD đường-dẫn` (vd `POST me/messages`) hoặc `METHOD /regex/`. */
  match: string
  status: number
  json: unknown
  /** Số lần áp dụng rồi tự gỡ; bỏ trống = mãi mãi tới khi reset. */
  times?: number
}

export interface Mock {
  url: string
  port: number
  close(): Promise<void>
  /** Xoá cả `unexpected` (bộ chạy gọi trước mỗi hồ sơ). */
  resetAll(): void
}

/** Thân lỗi Graph: `{ error: { message, type, code, error_subcode, fbtrace_id } }`. */
export const graphError = (code: number, subcode?: number, message = `Lỗi Graph giả ${code}`): unknown => ({
  error: { message, type: 'OAuthException', code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), fbtrace_id: 'MOCKTRACE' },
})

export async function startMock(port: number): Promise<Mock> {
  let calls: Call[] = []
  let rules: Rule[] = []
  let unexpected: Call[] = []
  let seq = 0

  /** Đặt lại kịch bản + lời gọi đã ghi + bộ đếm id. `unexpected` được GIỮ (ca kế tiếp reset không được xoá bằng chứng của ca trước); chỉ `all` mới xoá. */
  const reset = (all = false): void => {
    calls = []
    rules = []
    seq = 0
    if (all) unexpected = []
  }

  /** Che giá trị nhạy cảm trước khi ghi lại (query lẫn thân): token, secret, mật khẩu, khoá. */
  const SENSITIVE = /token|secret|password|authorization|api_?key|appsecret_proof/i
  const redact = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(redact)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.test(k) ? '<redacted>' : redact(x)]))
    }
    return v
  }

  const matches = (rule: Rule, method: string, path: string): boolean => {
    const sp = rule.match.indexOf(' ')
    const m = rule.match.slice(0, sp)
    const p = rule.match.slice(sp + 1)
    if (m !== method) return false
    if (p.startsWith('/') && p.endsWith('/')) return new RegExp(p.slice(1, -1)).test(path)
    return p === path
  }

  function defaults(c: Call): { status: number; json: unknown } | null {
    const { method, path } = c
    const id = (prefix: string): string => `${prefix}_${String(c.n).padStart(4, '0')}`
    if (c.service === 'graph') {
      if (method === 'GET' && path === 'debug_token') {
        return { status: 200, json: { data: { is_valid: true, expires_at: 0, data_access_expires_at: 4102444800 } } }
      }
      if (method === 'POST' && /^[^/]+\/subscribed_apps$/.test(path)) return { status: 200, json: { success: true } }
      if (method === 'POST' && path === 'me/messages') return { status: 200, json: { message_id: id('m'), recipient_id: String((c.body as { recipient?: { id?: string } })?.recipient?.id ?? '') } }
      if (method === 'GET' && path === 'me/messenger_profile') return { status: 200, json: { data: [{ get_started: { payload: 'GET_STARTED' } }] } }
      if (method === 'POST' && path === 'me/messenger_profile') return { status: 200, json: { result: 'success' } }
      if (method === 'GET' && /^[^/]+\/conversations$/.test(path)) return { status: 200, json: { data: [] } }
      if (method === 'POST' && /^[^/]+\/comments$/.test(path)) return { status: 200, json: { id: id('c') } }
      if (method === 'GET' && /^\d+$/.test(path)) return { status: 200, json: { name: 'Khách Mock' } }
    }
    if (c.service === 'zalo-oauth' && method === 'POST' && path === 'v4/oa/access_token') {
      return { status: 200, json: { access_token: 'zalo-access-mock', refresh_token: 'zalo-refresh-mock', expires_in: '90000' } }
    }
    if (c.service === 'zalo-api') {
      if (method === 'POST' && path === 'v3.0/oa/message/cs') return { status: 200, json: { error: 0, message: 'Success', data: { message_id: id('zmsg') } } }
    }
    if (c.service === 'zalo-zns' && method === 'POST' && path === 'message/template') {
      return { status: 200, json: { error: 0, message: 'Success', data: { msg_id: id('zns'), sent_time: '0', quota: { dailyQuota: '500', remainingQuota: '499' } } } }
    }
    return null
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (d: Buffer) => chunks.push(d))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw || null
      if (raw) {
        try {
          body = JSON.parse(raw)
        } catch {
          body = Object.fromEntries(new URLSearchParams(raw))
        }
      }
      const reply = (status: number, json: unknown): void => {
        const text = JSON.stringify(json)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(text)
      }

      // Điều khiển
      if (url.pathname.startsWith('/__mock/')) {
        if (url.pathname === '/__mock/reset' && req.method === 'POST') return reset(url.searchParams.get('all') === '1'), reply(200, { ok: true })
        if (url.pathname === '/__mock/rules' && req.method === 'POST') {
          const add = body as Rule | Rule[]
          for (const r of Array.isArray(add) ? add : [add]) {
            if (typeof r?.match !== 'string' || !/^[A-Z]+ \S/.test(r.match)) return reply(400, { error: `match phải có dạng "METHOD đường-dẫn" (có dấu cách): ${JSON.stringify(r?.match)}` })
          }
          rules.push(...(Array.isArray(add) ? add : [add]))
          return reply(200, { rules: rules.length })
        }
        if (url.pathname === '/__mock/calls') return reply(200, { calls, unexpected })
        return reply(404, { error: 'không có' })
      }

      let service: Call['service'] | null = null
      let path = ''
      const p = url.pathname
      if (p.startsWith('/fb/')) (service = 'graph'), (path = p.slice(4).replace(/^v\d+\.\d+\//, ''))
      else if (p.startsWith('/zoauth/')) (service = 'zalo-oauth'), (path = p.slice(8))
      else if (p.startsWith('/zapi/')) (service = 'zalo-api'), (path = p.slice(6))
      else if (p.startsWith('/zns/')) (service = 'zalo-zns'), (path = p.slice(5))
      const call: Call = {
        n: ++seq,
        method: req.method ?? 'GET',
        path,
        service: service ?? 'graph',
        query: redact(Object.fromEntries(url.searchParams)) as Record<string, string>,
        auth: {
          bearer: /^Bearer\s+\S+/.test(String(req.headers.authorization ?? '')),
          access_token: Boolean(req.headers.access_token),
          secret_key: Boolean(req.headers.secret_key),
        },
        body: redact(body),
      }
      if (!service) {
        unexpected.push(call)
        return reply(501, { error: { message: 'Đường không thuộc máy chủ giả', code: 1 } })
      }
      const idx = rules.findIndex((r) => matches(r, call.method, call.path))
      if (idx >= 0) {
        const r = rules[idx]
        calls.push(call)
        if (r.times !== undefined && --r.times <= 0) rules.splice(idx, 1)
        return reply(r.status, r.json)
      }
      const d = defaults(call)
      if (!d) {
        unexpected.push(call)
        return reply(501, { error: { message: `Máy chủ giả chưa có kịch bản cho ${call.method} ${call.path}`, code: 1 } })
      }
      calls.push(call)
      reply(d.status, d.json)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    resetAll: () => reset(true),
  }
}
