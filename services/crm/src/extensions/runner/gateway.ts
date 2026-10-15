import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/** Cổng dữ liệu thật phía lõi (đi qua service + RBAC của Trinity). Chương trình con KHÔNG chạm DB, chỉ gọi cổng này. */
export interface DataActor {
  extId: number
  /** Chạy thử: người đang thử (đọc dưới danh nghĩa họ). Bỏ trống ⇒ người đã duyệt phiên bản đang chạy. */
  asUserId?: number
}

export interface DataPort {
  create(actor: DataActor, table: string, rows: Record<string, unknown>[]): Promise<{ created: number }>
  list(actor: DataActor, table: string, q: { limit: number; cursor?: string }): Promise<{ items: unknown[]; next_cursor: string | null }>
}

export interface GrantSpec {
  extId: number
  asUserId?: number
  read: string[]
  write: string[]
  /** Chạy thử: đọc được (đúng phạm vi), GHI chỉ đếm — không gọi DataPort.create. */
  dryRun: boolean
}

export interface GrantStats {
  calls: number
  denied: number
  /** Số dòng đã ghi thật (chế độ thường). */
  written: number
  /** Số dòng SẼ ghi (chế độ chạy thử). */
  wouldWrite: number
}

interface Grant {
  spec: GrantSpec
  read: Set<string>
  write: Set<string>
  stats: GrantStats
}

const MAX_BODY = 1024 * 1024
export const MAX_ROWS_PER_CALL = 500
/** Trần số dòng ghi mỗi token (một lần chạy job / mỗi lần nạp tool) — chặn vòng lặp ghi vô hạn. */
export const MAX_ROWS_PER_GRANT = 20_000
const MAX_LIST = 50

/**
 * Cổng nội bộ: HTTP loopback, token sinh lúc chạy (KHÔNG phải khoá dịch vụ ngoài), phạm vi theo manifest — bảng ngoài phạm vi ⇒ 403.
 * Chương trình con chỉ nói chuyện với cổng này (và đúng các host mạng đã khai), không có đường nào tới DB.
 */
export class InternalGateway {
  private readonly grants = new Map<string, Grant>()
  private server?: Server
  private starting?: Promise<void>
  url = ''

  constructor(private readonly port: DataPort) {}

  async start(): Promise<void> {
    if (this.url) return
    this.starting ??= (async () => {
      this.server = createServer((req, res) => void this.handle(req, res))
      await new Promise<void>((ok) => this.server?.listen(0, '127.0.0.1', ok))
      this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`
    })()
    await this.starting
  }

  /** host:port để thêm vào `--allow-net` của chương trình con. */
  get hostPort(): string {
    return new URL(this.url).host
  }

  issueToken(spec: GrantSpec): string {
    const token = randomBytes(24).toString('hex')
    this.grants.set(token, { spec, read: new Set(spec.read), write: new Set(spec.write), stats: { calls: 0, denied: 0, written: 0, wouldWrite: 0 } })
    return token
  }

  stats(token: string): GrantStats | undefined {
    return this.grants.get(token)?.stats
  }

  revoke(token: string): GrantStats | undefined {
    const s = this.grants.get(token)?.stats
    this.grants.delete(token)
    return s
  }

  async stop(): Promise<void> {
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()))
    this.server = undefined
    this.starting = undefined
    this.url = ''
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    try {
      const u = new URL(req.url ?? '/', 'http://x')
      const m = /^\/records\/([^/]+)$/.exec(u.pathname)
      if (!m || (req.method !== 'POST' && req.method !== 'GET')) return reply(404, { error: 'not_found' })
      const grant = this.grants.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!grant) return reply(401, { error: 'token_invalid' })
      grant.stats.calls++
      const table = decodeURIComponent(m[1] ?? '')
      const allowed = req.method === 'POST' ? grant.write : new Set([...grant.read, ...grant.write])
      if (!allowed.has(table)) {
        grant.stats.denied++
        return reply(403, { error: 'table_out_of_scope', table })
      }
      if (req.method === 'GET') return reply(200, await this.list(grant, table, u.searchParams))
      return await this.create(grant, table, req, reply)
    } catch (e) {
      reply(502, { error: 'port_error', message: String((e as Error)?.message ?? e).slice(0, 300) })
    }
  }

  private list(g: Grant, table: string, qs: URLSearchParams) {
    const limit = Math.min(Math.max(Number(qs.get('limit')) || 20, 1), MAX_LIST)
    return this.port.list({ extId: g.spec.extId, asUserId: g.spec.asUserId }, table, { limit, cursor: qs.get('cursor') ?? undefined })
  }

  private async create(g: Grant, table: string, req: IncomingMessage, reply: (s: number, b: unknown) => void): Promise<void> {
    const rows = await readRows(req)
    if (!rows) return reply(400, { error: 'bad_body' })
    if (rows.length > MAX_ROWS_PER_CALL) return reply(400, { error: 'too_many_rows', max: MAX_ROWS_PER_CALL })
    if (g.stats.written + g.stats.wouldWrite + rows.length > MAX_ROWS_PER_GRANT) return reply(429, { error: 'row_quota_exceeded', max: MAX_ROWS_PER_GRANT })
    if (g.spec.dryRun) {
      g.stats.wouldWrite += rows.length
      return reply(200, { created: rows.length, dry_run: true })
    }
    const out = await this.port.create({ extId: g.spec.extId, asUserId: g.spec.asUserId }, table, rows)
    g.stats.written += out.created
    reply(200, { created: out.created })
  }
}

async function readRows(req: IncomingMessage): Promise<Record<string, unknown>[] | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) return null
    chunks.push(c as Buffer)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rows?: unknown }
    const ok = Array.isArray(body.rows) && body.rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))
    return ok ? (body.rows as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}
