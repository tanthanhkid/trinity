import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { getBaseClient } from '../tenant/clients'
import { currentCompanyId } from '../tenant/context'

/**
 * Đồng bộ trạng thái RAM giữa các tiến trình (Node, Node thứ hai, Rust) qua Postgres `LISTEN/NOTIFY` (G12b).
 * Định dạng payload và ý nghĩa từng loại: `docs/sync-notify.md` (bản Rust dùng đúng định dạng này).
 *
 * Mỗi tiến trình có một mã nguồn gốc (`o`); tin do chính mình phát không dội lại cho mình (mỗi bên tự áp dụng cục bộ
 * trước khi phát). Phát là "bắn rồi quên": lỗi mạng/DB chỉ ghi log, không làm hỏng việc chính. Mất kết nối nghe thì tự
 * nối lại có lùi bước và báo `onResync` (tin trong lúc đứt đã mất ⇒ bên nghe xoá cache để đọc lại từ DB).
 */
export const SYNC_CHANNEL = 'trinity_sync'
export const SYNC_VERSION = 1
/** Giới hạn payload của Postgres là 8000 byte; chừa chỗ an toàn. */
export const SYNC_MAX_BYTES = 7500

export type SyncKind = 'rbac' | 'token' | 'session' | 'cache' | 'bell' | 'payslip' | 'graph'

export interface SyncEnvelope {
  v: number
  /** Mã tiến trình phát. */
  o: string
  k: SyncKind
  /** Công ty (0 = không có ngữ cảnh công ty). */
  c: number
  [field: string]: unknown
}

export type SyncHandler = (msg: SyncEnvelope) => void

/** URL nghe: cần kết nối trực tiếp/session-mode (LISTEN không chạy qua pooler kiểu transaction). Bỏ các tham số riêng của Prisma. */
export function listenConnectionString(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DIRECT_DATABASE_URL || env.TENANT_DATABASE_URL || env.DATABASE_URL
  if (!raw) return null
  try {
    const url = new URL(raw)
    for (const p of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size', 'connect_timeout', 'socket_timeout']) {
      url.searchParams.delete(p)
    }
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Tham số SSL của URL kiểu Prisma (`sslmode`, `sslaccept`, `sslrootcert`) → tuỳ chọn `ssl` của `pg` (hai bên hiểu khác nhau:
 * `pg` coi `sslmode=require` là kiểm chứng chỉ đầy đủ ở một số bản). `require`/`verify-*` ⇒ bật TLS và kiểm chứng chỉ, trừ khi
 * `sslaccept=accept_invalid_certs`; `disable`/`prefer`/vắng ⇒ không TLS. Trả URL đã bỏ các tham số đó.
 */
export function sslOptionsFromUrl(connectionString: string): { connectionString: string; ssl: false | { rejectUnauthorized: boolean; ca?: string } } {
  const url = new URL(connectionString)
  const mode = (url.searchParams.get('sslmode') ?? '').toLowerCase()
  const accept = (url.searchParams.get('sslaccept') ?? '').toLowerCase()
  const rootCert = url.searchParams.get('sslrootcert')
  for (const p of ['sslmode', 'sslaccept', 'sslrootcert', 'sslcert', 'sslidentity', 'sslpassword', 'ssl', 'uselibpqcompat']) url.searchParams.delete(p)
  if (!['require', 'verify-ca', 'verify-full', 'no-verify'].includes(mode)) return { connectionString: url.toString(), ssl: false }
  const ssl: { rejectUnauthorized: boolean; ca?: string } = { rejectUnauthorized: !(mode === 'no-verify' || accept === 'accept_invalid_certs') }
  if (rootCert) {
    try { ssl.ca = readFileSync(rootCert, 'utf8') } catch { /* tệp CA không đọc được: để pg dùng kho hệ thống */ }
  }
  return { connectionString: url.toString(), ssl }
}

export function syncDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Serverless: không giữ được kết nối nghe lâu dài; `TRINITY_SYNC=off` tắt tay.
  return env.TRINITY_RUNTIME?.trim().toLowerCase() === 'serverless' || env.TRINITY_SYNC?.trim().toLowerCase() === 'off'
}

export class SyncBus {
  readonly origin: string
  private readonly handlers = new Map<SyncKind, Set<SyncHandler>>()
  private readonly resyncHandlers = new Set<() => void>()
  private client: Client | null = null
  private ready = false
  private started = false
  private stopping = false
  private retryTimer: NodeJS.Timeout | null = null
  private attempt = 0
  private lastWarn = 0

  constructor(origin?: string) {
    this.origin = origin ?? `node-${process.pid}-${randomBytes(4).toString('hex')}`
  }

  /** Đang chạy (đã `start`) — chưa chạy thì `publish` không làm gì (test đơn vị, serverless). */
  get active(): boolean {
    return this.started
  }

  get connected(): boolean {
    return this.ready
  }

  on(kind: SyncKind, handler: SyncHandler): () => void {
    let set = this.handlers.get(kind)
    if (!set) this.handlers.set(kind, (set = new Set()))
    const s = set
    s.add(handler)
    return () => s.delete(handler)
  }

  /** Gọi khi nối lại sau lúc đứt: tin có thể đã mất, xoá cache cục bộ. */
  onResync(fn: () => void): () => void {
    this.resyncHandlers.add(fn)
    return () => this.resyncHandlers.delete(fn)
  }

  async start(connectionString = listenConnectionString()): Promise<void> {
    if (this.started || !connectionString) return
    this.started = true
    this.stopping = false
    await this.connect(connectionString)
  }

  async stop(): Promise<void> {
    this.started = false
    this.stopping = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const c = this.client
    this.client = null
    this.ready = false
    if (c) {
      c.removeAllListeners()
      c.on('error', () => undefined)
      await c.end().catch(() => undefined)
    }
  }

  private warnThrottled(msg: string): void {
    if (Date.now() - this.lastWarn < 60_000) return
    this.lastWarn = Date.now()
    // eslint-disable-next-line no-console
    console.warn(`[sync-bus] ${msg}`)
  }

  private async connect(connectionString: string): Promise<void> {
    if (this.stopping) return
    const { connectionString: cs, ssl } = sslOptionsFromUrl(connectionString)
    // Hạn 5 giây: DB treo không được giữ khởi động (và `start` không bao giờ chờ vô hạn).
    const client = new Client({ connectionString: cs, ssl, application_name: 'trinity-sync', connectionTimeoutMillis: 5_000 })
    try {
      client.on('error', (e) => this.lost(client, connectionString, e))
      client.on('end', () => this.lost(client, connectionString, new Error('kết nối đóng')))
      client.on('notification', (n) => {
        if (n.channel === SYNC_CHANNEL && n.payload) this.dispatch(n.payload)
      })
      await client.connect()
      await client.query(`LISTEN ${SYNC_CHANNEL}`)
      if (this.stopping) {
        await client.end().catch(() => undefined)
        return
      }
      const wasLost = this.attempt > 0
      this.client = client
      this.ready = true
      this.attempt = 0
      if (wasLost) for (const fn of this.resyncHandlers) this.safe(fn)
    } catch (e) {
      this.lost(client, connectionString, e as Error)
    }
  }

  private lost(client: Client, connectionString: string, err: Error): void {
    if (this.client && this.client !== client) return // sự kiện muộn của kết nối cũ
    if (this.client === client) {
      this.client = null
      this.ready = false
    }
    client.removeAllListeners()
    client.on('error', () => undefined)
    void client.end().catch(() => undefined)
    if (this.stopping || !this.started || this.retryTimer) return
    this.attempt++
    // Lần đầu và khi kéo dài thì báo RÕ (không bị nuốt bởi throttle): không có đồng bộ giữa tiến trình tới khi nối được.
    if (this.attempt === 1 || this.attempt === 5) {
      // eslint-disable-next-line no-console
      console.error(`[sync-bus] ${this.attempt === 1 ? 'không nối được' : 'vẫn chưa nối được sau nhiều lần thử'} kênh LISTEN (${err.message}). Đồng bộ trạng thái giữa các tiến trình đang TẮT: cache chỉ hết hạn theo TTL. Kiểm DATABASE_URL/DIRECT_DATABASE_URL (cần nối trực tiếp, không qua pooler) và tham số SSL; đặt TRINITY_SYNC=off nếu chỉ chạy một tiến trình.`)
    } else this.warnThrottled(`mất kết nối nghe (${err.message}) — thử nối lại`)
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect(connectionString)
    }, delay)
    this.retryTimer.unref()
  }

  private safe(fn: () => void): void {
    try {
      fn()
    } catch (e) {
      this.warnThrottled(`handler lỗi: ${(e as Error).message}`)
    }
  }

  /** Nhận payload thô (xuất ra cho test). Bỏ tin của chính mình, tin sai khuôn, phiên bản lạ. */
  dispatch(payload: string): void {
    let msg: SyncEnvelope
    try {
      msg = JSON.parse(payload) as SyncEnvelope
    } catch {
      return
    }
    if (!msg || msg.v !== SYNC_VERSION || msg.o === this.origin || typeof msg.k !== 'string' || typeof msg.c !== 'number') return
    const set = this.handlers.get(msg.k)
    if (!set) return
    for (const h of [...set]) this.safe(() => h(msg))
  }

  /**
   * Phát một tin. `company` mặc định là công ty của ngữ cảnh hiện tại. Không bao giờ ném lỗi. Chưa `start` ⇒ không làm gì.
   * Trả Promise (đã nuốt lỗi) để test chờ được; mã nghiệp vụ không cần `await`.
   */
  publish(kind: SyncKind, data: Record<string, unknown>, company: number | null = currentCompanyId()): Promise<void> {
    if (!this.started) return Promise.resolve()
    const payload = JSON.stringify({ v: SYNC_VERSION, o: this.origin, k: kind, c: company ?? 0, ...data })
    if (Buffer.byteLength(payload) > SYNC_MAX_BYTES) {
      this.warnThrottled(`payload ${kind} vượt ${SYNC_MAX_BYTES} byte — bỏ (người gọi phải chia nhỏ)`)
      return Promise.resolve()
    }
    return this.send(payload).catch((e: unknown) => this.warnThrottled(`không phát được ${kind}: ${(e as Error).message}`))
  }

  private async send(payload: string): Promise<void> {
    if (this.client && this.ready) {
      await this.client.query('SELECT pg_notify($1, $2)', [SYNC_CHANNEL, payload])
      return
    }
    // pg_notify trả void: `$queryRaw` không giải mã được kiểu `void` ⇒ dùng `$executeRaw`.
    await getBaseClient().$executeRaw`SELECT pg_notify(${SYNC_CHANNEL}, ${payload})`
  }
}

/** Bus của tiến trình này. `PrismaModule` khởi động/dừng; chỗ khác chỉ `publish`/`on`. */
export const syncBus = new SyncBus()

/** Khoá cache theo công ty giống `tenantKey` nhưng cho công ty bất kỳ (bên nghe không đứng trong ngữ cảnh công ty). */
export function tenantKeyFor(companyId: number, key: string | number): string {
  return companyId === 1 ? String(key) : `c${companyId}:${key}`
}
