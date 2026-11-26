import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { BlockList, isIP } from 'node:net'
import { Logger } from '@nestjs/common'

/**
 * IP của khách — MỘT chỗ duy nhất đọc địa chỉ kết nối và header IP cho cả backend (docs/rust/PLAN.md mục 4.13).
 *
 * Mọi nơi cần IP (kiểm Wi-Fi đăng nhập, kiểm IP chấm công, giới hạn tốc độ, nhật ký, khoá API, VNPay, trang bán
 * hàng) gọi `resolveClientIp(req)`; không file nào khác được đọc `x-real-ip`, `x-forwarded-for`,
 * `cf-connecting-ip`, `req.ip` hay `remoteAddress`.
 *
 * IP được xác định MỘT lần, ngay khi nhận header, trong `clientIpMiddleware` (đăng ký trước body-parser và multer),
 * rồi lưu vào request. Thứ tự:
 * 1. Có `x-trinity-client-ip` (do tiến trình biên Trinity ký): kiểm chữ ký HMAC-SHA256 trên `<giá trị>\n<thời điểm
 *    Unix>`, khoá dẫn bằng HKDF từ `INTERNAL_SERVICE_SECRET` rồi `SERVICE_SECRET` (cả hai, như guard `@Internal`),
 *    hạn ±60 giây. Sai hoặc quá hạn ⇒ 400 ngay, không cho qua.
 * 2. Không có header ⇒ tiến trình này là biên, áp `TRUSTED_PROXY` lên peer TCP.
 * 3. Kết quả cuối là loopback, cổng mặc định của container, hoặc dấu "không tin được" ⇒ KHÔNG tin được: kiểm Wi-Fi và
 *    chấm công cho qua (không khoá ai) + ghi lỗi cấu hình + dải cảnh báo quản trị; giới hạn tốc độ dùng IP peer.
 */

export const CLIENT_IP_HEADER = 'x-trinity-client-ip'
/** Giá trị tiến trình biên ghi khi không xác định được IP khách (thiếu tệp nạp trước, thiếu bí mật…). */
export const UNTRUSTED_CLIENT_IP = 'untrusted'
/** Hạn của chữ ký, giây (hai phía). */
export const CLIENT_IP_MAX_SKEW_SEC = 60
const HKDF_INFO = 'trinity x-trinity-client-ip v1'

/** Danh sách Cloudflare công bố (https://www.cloudflare.com/ips/). Ghi đè bằng `CLOUDFLARE_IP_RANGES` khi Cloudflare đổi. */
export const DEFAULT_CLOUDFLARE_IP_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]

/** Cờ của bản cũ: nghĩa không khớp chắc chắn giá trị mới nào nên KHÔNG ánh xạ ngầm. */
export const LEGACY_TRUST_FLAGS = [
  'ATTENDANCE_TRUST_CF_IP',
  'LOGIN_WIFI_TRUST_CF_IP',
  'ATTENDANCE_TRUST_PROXY_HEADERS',
  'LOGIN_WIFI_TRUST_PROXY_HEADERS',
] as const

export type TrustedProxy =
  | { mode: 'none' }
  | { mode: 'cloudflare' }
  | { mode: 'cloudflare-tunnel' }
  | { mode: 'cidr'; entries: string[]; header: 'x-forwarded-for' | 'x-real-ip' }
  | { mode: 'cloudflare-behind'; entries: string[] }

export interface ClientIp {
  /** IP khách tin được (đã chuẩn hoá); `null` = không tin được, KHÔNG đem so với IP văn phòng. */
  ip: string | null
  /** Khoá cho giới hạn tốc độ / nhật ký: `ip`, hoặc IP peer khi không tin được (một xô chung). */
  rateKey: string
  /** Lý do không tin được (chữ cho log và dải cảnh báo); `null` khi tin được. */
  untrustedReason: string | null
  /** `signed` = từ header có chữ ký của tiến trình biên; `edge` = tiến trình này tự xác định từ peer. */
  source: 'signed' | 'edge'
}

/** Bảng "cách triển khai → TRUSTED_PROXY" in ra khi cấu hình sai (một chỗ cho thông báo khởi động và tài liệu). */
export const TRUSTED_PROXY_GUIDE = [
  'Cách triển khai → TRUSTED_PROXY (đặt ở tiến trình nhận kết nối đầu tiên):',
  '  Caddy/nginx cùng máy → Next → API (trình quản lý tiến trình)   cidr:127.0.0.1/32',
  '  Như trên, có Cloudflare phía trước Caddy/nginx                 cloudflare-behind:127.0.0.1/32',
  '  Docker Compose, cổng web công bố thẳng                         none',
  '  Docker Compose, Cloudflare nối thẳng cổng web                  cloudflare',
  '  Docker Compose sau Caddy/nginx trên host                       cidr:docker-gateway (hoặc cloudflare-behind:docker-gateway)',
  '  Cloudflare Tunnel (cổng chỉ nghe loopback)                     cloudflare-tunnel',
  'Chi tiết: docs/deployment.md, mục "Client IP".',
].join('\n')

// ---------------------------------------------------------------------------------------------------------------
// Chuẩn hoá và so khớp địa chỉ
// ---------------------------------------------------------------------------------------------------------------

/** Chuẩn hoá một địa chỉ: bỏ khoảng trắng, `[...]`, IPv4-mapped `::ffff:a.b.c.d` → `a.b.c.d`. Không phải IP ⇒ null. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s)
  if (mapped) s = mapped[1]
  const v = isIP(s)
  if (v === 4) return s
  if (v === 6) return s.toLowerCase()
  return null
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || ip.startsWith('127.') || ip === '0.0.0.0' || ip === '::'
}

/** Mạng riêng / link-local / ULA (RFC 1918, 3927, 4193, 4291) — địa chỉ của container/proxy nội bộ, không phải khách Internet. */
const PRIVATE_NETS = (() => {
  const b = new BlockList()
  b.addSubnet('10.0.0.0', 8, 'ipv4')
  b.addSubnet('172.16.0.0', 12, 'ipv4')
  b.addSubnet('192.168.0.0', 16, 'ipv4')
  b.addSubnet('169.254.0.0', 16, 'ipv4')
  b.addSubnet('fc00::', 7, 'ipv6')
  b.addSubnet('fe80::', 10, 'ipv6')
  return b
})()

export function isPrivateIp(ip: string): boolean {
  return PRIVATE_NETS.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')
}

let routeTableOverride: string | null | undefined
let containerOverride: boolean | undefined
let containerCache: boolean | undefined
let gatewayCache: { at: number; value: string | null } | null = null
const GATEWAY_TTL_MS = 30_000

/**
 * Chỉ cho test: thay nội dung `/proc/net/route` (`null` = không có tệp; `undefined` = đọc tệp thật) và cờ "đang chạy
 * trong container" (mặc định: có bảng tuyến giả ⇒ coi như trong container).
 */
export function __setRouteTableForTest(text: string | null | undefined, inContainer: boolean | undefined = text == null ? undefined : true): void {
  routeTableOverride = text
  containerOverride = text === undefined ? undefined : inContainer
  gatewayCache = null
}

/**
 * Tiến trình có chạy trong container không (`/.dockerenv`, `/run/.containerenv`, cgroup của PID 1). Ngoài container,
 * tuyến mặc định là router của LAN — không có nghĩa "cổng Docker", nên luật cổng mặc định và `docker-gateway` không áp.
 */
export function runningInContainer(): boolean {
  if (containerOverride !== undefined) return containerOverride
  if (containerCache !== undefined) return containerCache
  let yes = existsSync('/.dockerenv') || existsSync('/run/.containerenv')
  if (!yes) {
    try {
      yes = /docker|kubepods|containerd|libpod/.test(readFileSync('/proc/1/cgroup', 'utf8'))
    } catch {
      /* không phải Linux */
    }
  }
  containerCache = yes
  return yes
}

/**
 * Cổng mặc định (tuyến `0.0.0.0/0`) đọc từ `/proc/net/route`. Trong container đây là địa chỉ Docker gán cho host:
 * peer bằng địa chỉ này nghĩa là kết nối đi qua `docker-proxy`/NAT, không phải IP khách. Đọc lại sau 30 giây (tuyến
 * đổi khi mạng compose được tạo lại). Không có tệp (macOS, Windows) ⇒ null.
 */
export function defaultGateway(now = Date.now()): string | null {
  if (!runningInContainer()) return null
  if (gatewayCache && now - gatewayCache.at < GATEWAY_TTL_MS) return gatewayCache.value
  let text: string | null
  if (routeTableOverride !== undefined) text = routeTableOverride
  else {
    try {
      text = readFileSync('/proc/net/route', 'utf8')
    } catch {
      text = null
    }
  }
  let value: string | null = null
  for (const line of (text ?? '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3 || cols[1] !== '00000000' || !/^[0-9a-f]{8}$/i.test(cols[2])) continue
    const hex = cols[2]
    // Little-endian: "010011AC" = 172.17.0.1
    value = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.')
    if (value === '0.0.0.0') value = null
    else break
  }
  gatewayCache = { at: now, value }
  return value
}

/** Danh sách CIDR / IP / `docker-gateway` → BlockList (dựng lại khi cổng mặc định đổi). */
class CidrSet {
  private cached: { gateway: string | null; list: BlockList } | null = null
  constructor(private readonly entries: readonly string[]) {}

  has(ip: string): boolean {
    const gw = this.entries.includes('docker-gateway') ? defaultGateway() : null
    if (!this.cached || this.cached.gateway !== gw) this.cached = { gateway: gw, list: buildBlockList(this.entries, gw) }
    return this.cached.list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')
  }
}

function buildBlockList(entries: readonly string[], gateway: string | null): BlockList {
  const list = new BlockList()
  for (const e of entries) {
    if (e === 'docker-gateway') {
      if (gateway) list.addAddress(gateway, 'ipv4')
      continue
    }
    const parsed = parseCidr(e)
    if (!parsed) continue
    list.addSubnet(parsed.ip, parsed.prefix, parsed.family)
  }
  return list
}

function parseCidr(raw: string): { ip: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [addr, bits, ...rest] = raw.trim().split('/')
  if (rest.length) return null
  const ip = normalizeIp(addr)
  if (!ip) return null
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4'
  const max = family === 'ipv6' ? 128 : 32
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null
  return { ip, prefix, family }
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function validateCidrList(entries: string[], name: string): void {
  if (entries.length === 0) throw new Error(`${name}: danh sách trống`)
  for (const e of entries) {
    if (e !== 'docker-gateway' && !parseCidr(e)) throw new Error(`${name}: "${e}" không phải IP/CIDR hợp lệ (hoặc từ khoá docker-gateway)`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------------------------------------------

/** Đọc `TRUSTED_PROXY`. Giá trị sai ⇒ throw (khởi động dừng với thông báo). */
export function parseTrustedProxy(raw: string | undefined): TrustedProxy {
  const v = (raw ?? '').trim()
  if (v === '' || v === 'none') return { mode: 'none' }
  if (v === 'cloudflare') return { mode: 'cloudflare' }
  if (v === 'cloudflare-tunnel') return { mode: 'cloudflare-tunnel' }
  if (v.startsWith('cidr:')) {
    const [list, ...opts] = v.slice('cidr:'.length).split(';')
    let header: 'x-forwarded-for' | 'x-real-ip' = 'x-forwarded-for'
    for (const opt of opts.map((o) => o.trim()).filter(Boolean)) {
      const m = /^header=(x-forwarded-for|x-real-ip)$/i.exec(opt)
      if (!m) throw new Error(`TRUSTED_PROXY: tuỳ chọn "${opt}" không hợp lệ (chỉ có ;header=x-real-ip)`)
      header = m[1].toLowerCase() as typeof header
    }
    const entries = splitList(list)
    validateCidrList(entries, 'TRUSTED_PROXY cidr:')
    return { mode: 'cidr', entries, header }
  }
  if (v.startsWith('cloudflare-behind:')) {
    const entries = splitList(v.slice('cloudflare-behind:'.length))
    validateCidrList(entries, 'TRUSTED_PROXY cloudflare-behind:')
    return { mode: 'cloudflare-behind', entries }
  }
  throw new Error(`TRUSTED_PROXY="${v}" không hợp lệ.\n${TRUSTED_PROXY_GUIDE}`)
}

interface ResolvedConfig {
  raw: string | undefined
  cfRaw: string | undefined
  secretsKey: string
  proxy: TrustedProxy
  proxySet: CidrSet | null
  cloudflare: CidrSet
  keys: Buffer[]
}

let configCache: ResolvedConfig | null = null

/** Khoá ký dẫn từ một bí mật nội bộ (HKDF-SHA256, salt rỗng, info cố định). Cùng hàm cho bên ký và bên kiểm. */
export function deriveClientIpKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32))
}

function internalSecrets(env: NodeJS.ProcessEnv): string[] {
  // Cùng thứ tự và cùng luật bỏ giá trị rỗng với guard `@Internal` (permission.guard.ts).
  return [env.INTERNAL_SERVICE_SECRET, env.SERVICE_SECRET].filter((v): v is string => Boolean(v))
}

function config(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const raw = env.TRUSTED_PROXY
  const cfRaw = env.CLOUDFLARE_IP_RANGES
  const secrets = internalSecrets(env)
  const secretsKey = secrets.join('\u0000')
  if (configCache && configCache.raw === raw && configCache.cfRaw === cfRaw && configCache.secretsKey === secretsKey) return configCache
  let proxy: TrustedProxy
  try {
    proxy = parseTrustedProxy(raw)
  } catch {
    // Khởi động đã chặn giá trị sai (`clientIpStartupProblems`); ở đây (test, serverless) coi như `none`.
    proxy = { mode: 'none' }
  }
  const cfEntries = cfRaw?.trim() ? splitList(cfRaw).filter((e) => e !== 'docker-gateway') : [...DEFAULT_CLOUDFLARE_IP_RANGES]
  configCache = {
    raw,
    cfRaw,
    secretsKey,
    proxy,
    proxySet: proxy.mode === 'cidr' || proxy.mode === 'cloudflare-behind' ? new CidrSet(proxy.entries) : null,
    cloudflare: new CidrSet(cfEntries),
    keys: [...new Set(secrets)].map(deriveClientIpKey),
  }
  return configCache
}

/**
 * Lỗi cấu hình khiến tiến trình KHÔNG được khởi động: `TRUSTED_PROXY`/`CLOUDFLARE_IP_RANGES` sai, hoặc còn cờ cũ
 * (`*_TRUST_CF_IP`, `*_TRUST_PROXY_HEADERS`) mà chưa đặt `TRUSTED_PROXY`. Rỗng = đạt.
 */
export function clientIpStartupProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  try {
    parseTrustedProxy(env.TRUSTED_PROXY)
  } catch (e) {
    out.push((e as Error).message)
  }
  if (env.CLOUDFLARE_IP_RANGES?.trim()) {
    try {
      const entries = splitList(env.CLOUDFLARE_IP_RANGES)
      if (entries.includes('docker-gateway')) throw new Error('CLOUDFLARE_IP_RANGES: từ khoá docker-gateway chỉ dùng trong TRUSTED_PROXY, không phải dải Cloudflare')
      validateCidrList(entries, 'CLOUDFLARE_IP_RANGES')
    } catch (e) {
      out.push((e as Error).message)
    }
  }
  // Bản cũ chỉ bật cờ khi giá trị đúng là chuỗi 'true' — chỉ giá trị đó mới chặn khởi động (giá trị khác: cảnh báo).
  const legacy = LEGACY_TRUST_FLAGS.filter((k) => env[k]?.trim() === 'true')
  if (legacy.length && !env.TRUSTED_PROXY?.trim()) {
    out.push(
      `Cờ cũ ${legacy.join(', ')} không còn tác dụng và không được tự đổi sang cấu hình mới (nghĩa cũ không khớp chắc chắn giá trị nào). ` +
        `Đặt TRUSTED_PROXY theo cách triển khai rồi xoá cờ cũ.\n${TRUSTED_PROXY_GUIDE}`,
    )
  }
  return out
}

/** Cảnh báo lúc khởi động (không chặn): cờ cũ còn trong môi trường với giá trị khác 'true' (vốn đã không có tác dụng). */
export function clientIpStartupWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const stale = LEGACY_TRUST_FLAGS.filter((k) => env[k] !== undefined && env[k]?.trim() !== 'true')
  return stale.length ? [`Cờ cũ ${stale.join(', ')} không còn tác dụng (thay bằng TRUSTED_PROXY, docs/deployment.md mục "Client IP"); có thể xoá.`] : []
}

/**
 * `cloudflare-tunnel` tin `cf-connecting-ip` của mọi peer nên cổng PHẢI chỉ nghe loopback. Trả lỗi (không rỗng) khi
 * địa chỉ thực nghe không phải loopback — caller dừng tiến trình.
 */
export function tunnelListenProblem(address: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  let proxy: TrustedProxy
  try {
    proxy = parseTrustedProxy(env.TRUSTED_PROXY)
  } catch {
    return null
  }
  if (proxy.mode !== 'cloudflare-tunnel') return null
  const ip = normalizeIp(address ?? '')
  if (ip && (ip === '::1' || ip.startsWith('127.'))) return null
  return (
    `TRUSTED_PROXY=cloudflare-tunnel nhưng tiến trình đang nghe ${address ?? '(không rõ)'}, không phải loopback: ai nối thẳng cổng này ` +
    `sẽ tự khai được IP qua cf-connecting-ip. Đặt LISTEN_HOST=127.0.0.1 (API) / HOSTNAME=127.0.0.1 (web), hoặc chọn giá trị TRUSTED_PROXY khác. Docker Compose + Tunnel: không đặt cloudflare-tunnel cho api (web gọi api:4000 qua mạng Docker), xem docs/deployment.md mục "Client IP".`
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Ký và kiểm `x-trinity-client-ip`
// ---------------------------------------------------------------------------------------------------------------

function mac(key: Buffer, value: string, ts: number): Buffer {
  return createHmac('sha256', key).update(`${value}\n${ts}`).digest()
}

/**
 * Giá trị header `x-trinity-client-ip`: `<ip hoặc untrusted>;<thời điểm Unix>;<HMAC base64url>`. Bên gửi gọi ngay
 * trước khi gửi header sang tiến trình trong (web G16b, Rust K17). Ký bằng bí mật đang hiệu lực (`INTERNAL_SERVICE_SECRET`
 * rồi `SERVICE_SECRET`).
 */
export function signClientIp(value: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `${value};${nowSec};${mac(deriveClientIpKey(secret), value, nowSec).toString('base64url')}`
}

type Verified = { ok: true; value: string } | { ok: false; error: string; log: string }

function verifySigned(header: string, keys: Buffer[], nowSec: number): Verified {
  const parts = header.split(';')
  if (parts.length !== 3) return { ok: false, error: 'Header x-trinity-client-ip sai định dạng', log: 'sai định dạng' }
  const [value, tsRaw, sigRaw] = parts.map((p) => p.trim())
  if (!/^\d{1,12}$/.test(tsRaw)) return { ok: false, error: 'Header x-trinity-client-ip sai định dạng', log: 'thời điểm sai định dạng' }
  const ts = Number(tsRaw)
  if (Math.abs(nowSec - ts) > CLIENT_IP_MAX_SKEW_SEC) {
    return { ok: false, error: 'Header x-trinity-client-ip đã hết hạn', log: `lệch ${nowSec - ts} giây (hạn ±${CLIENT_IP_MAX_SKEW_SEC}; đồng hồ hai máy lệch hoặc phát lại)` }
  }
  if (keys.length === 0) {
    return { ok: false, error: 'Máy chủ chưa đặt bí mật nội bộ để kiểm x-trinity-client-ip', log: 'API chưa đặt INTERNAL_SERVICE_SECRET/SERVICE_SECRET' }
  }
  let sig: Buffer
  try {
    sig = Buffer.from(sigRaw, 'base64url')
  } catch {
    sig = Buffer.alloc(0)
  }
  const ok = sig.length === 32 && keys.some((k) => timingSafeEqual(mac(k, value, ts), sig))
  if (!ok) {
    return {
      ok: false,
      error: 'Chữ ký x-trinity-client-ip không hợp lệ',
      log: 'chữ ký sai với cả INTERNAL_SERVICE_SECRET và SERVICE_SECRET — lệch bí mật giữa web và API (hoặc header giả)',
    }
  }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------------------------------------------
// Xác định IP
// ---------------------------------------------------------------------------------------------------------------

/** Request tối thiểu (Express `Request` hoặc `http.IncomingMessage`). */
export interface ClientIpRequest {
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | undefined } | null
}

const STORE = Symbol.for('trinity.clientIp')
type WithStore = ClientIpRequest & { [STORE]?: ClientIp }

let clockOverride: (() => number) | null = null
/** Chỉ cho test: đồng hồ (ms). `null` = `Date.now`. */
export function __setClockForTest(fn: (() => number) | null): void {
  clockOverride = fn
}
const nowMs = () => (clockOverride ? clockOverride() : Date.now())

function header(req: ClientIpRequest, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v.join(', ')
  return typeof v === 'string' ? v : undefined
}

function rightmostForwarded(req: ClientIpRequest): string | null {
  const xff = header(req, 'x-forwarded-for')
  if (!xff) return null
  const hops = xff.split(',').map((h) => h.trim()).filter(Boolean)
  return normalizeIp(hops[hops.length - 1])
}

/** Áp luật "không tin được" lên kết quả cuối, ở MỌI giá trị `TRUSTED_PROXY`. */
function finalize(candidate: string | null, peer: string, why: string | null, source: ClientIp['source']): ClientIp {
  const peerKey = peer || 'unknown'
  if (!candidate) return { ip: null, rateKey: peerKey, untrustedReason: why ?? 'không xác định được IP khách', source }
  if (isLoopback(candidate)) {
    return {
      ip: null,
      rateKey: peerKey,
      untrustedReason: `IP xác định ra là loopback (${candidate}): có proxy cùng máy phía trước mà TRUSTED_PROXY chưa khai báo nó`,
      source,
    }
  }
  const gw = defaultGateway()
  if (gw && candidate === gw) {
    return {
      ip: null,
      rateKey: peerKey,
      untrustedReason: `IP xác định ra là cổng mặc định của container (${candidate}): kết nối đi qua docker-proxy/NAT, hoặc TRUSTED_PROXY ghi sai dải mạng Docker`,
      source,
    }
  }
  return { ip: candidate, rateKey: candidate, untrustedReason: null, source }
}

function fromEdge(req: ClientIpRequest, cfg: ResolvedConfig): ClientIp {
  const peer = normalizeIp(req.socket?.remoteAddress) ?? ''
  const p = cfg.proxy
  // Peer mạng riêng (khách LAN của bản cài tại chỗ) VẪN là khách thật với `none`/`cidr:`. Request đi qua web của Trinity
  // luôn mang `x-trinity-client-ip` (có chữ ký, hoặc dấu `untrusted`), nên không rơi vào nhánh này.
  const fin = (c: string | null, why: string | null = null) => finalize(c, peer, why, 'edge')
  if (!peer) return fin(null, 'không đọc được địa chỉ kết nối')
  switch (p.mode) {
    case 'none':
      return fin(peer)
    case 'cloudflare': {
      if (!cfg.cloudflare.has(peer)) return fin(peer)
      const cf = normalizeIp(header(req, 'cf-connecting-ip'))
      return fin(cf, cf ? null : 'kết nối từ dải Cloudflare nhưng thiếu cf-connecting-ip hợp lệ')
    }
    case 'cloudflare-tunnel': {
      const cf = normalizeIp(header(req, 'cf-connecting-ip'))
      return fin(cf, cf ? null : 'TRUSTED_PROXY=cloudflare-tunnel nhưng request không có cf-connecting-ip hợp lệ')
    }
    case 'cidr': {
      if (!cfg.proxySet!.has(peer)) return fin(peer)
      const ip = p.header === 'x-real-ip' ? normalizeIp(header(req, 'x-real-ip')) : rightmostForwarded(req)
      return fin(ip, ip ? null : `peer ${peer} là proxy tin cậy nhưng không gửi ${p.header === 'x-real-ip' ? 'X-Real-IP' : 'X-Forwarded-For'} hợp lệ`)
    }
    case 'cloudflare-behind': {
      if (!cfg.proxySet!.has(peer)) return fin(peer)
      const hop = rightmostForwarded(req)
      if (!hop) return fin(null, `peer ${peer} là proxy tin cậy nhưng không gửi X-Forwarded-For hợp lệ`)
      if (!cfg.cloudflare.has(hop)) return fin(hop)
      const cf = normalizeIp(header(req, 'cf-connecting-ip'))
      return fin(cf, cf ? null : 'kết nối từ dải Cloudflare nhưng thiếu cf-connecting-ip hợp lệ')
    }
  }
}

export type ClientIpDecision = { ok: true; client: ClientIp } | { ok: false; error: string; log: string }

/** Xác định IP của một request (không lưu). Header có chữ ký sai/quá hạn ⇒ `ok: false` (caller trả 400). */
export function determineClientIp(req: ClientIpRequest, env: NodeJS.ProcessEnv = process.env): ClientIpDecision {
  const cfg = config(env)
  const signed = header(req, CLIENT_IP_HEADER)
  if (signed === undefined) return { ok: true, client: fromEdge(req, cfg) }
  // Dấu `untrusted` không chữ ký: web không có bí mật nội bộ để ký. Chỉ HẠ mức tin (không ai lợi gì khi giả nó) nên nhận.
  if (signed.trim() === UNTRUSTED_CLIENT_IP) {
    const peer = normalizeIp(req.socket?.remoteAddress) ?? ''
    return { ok: true, client: finalize(null, peer, 'tiến trình phía trước (web) không ký được IP khách: thiếu INTERNAL_SERVICE_SECRET/SERVICE_SECRET ở web', 'signed') }
  }
  const v = verifySigned(signed, cfg.keys, Math.floor(nowMs() / 1000))
  if (!v.ok) return v
  const peer = normalizeIp(req.socket?.remoteAddress) ?? ''
  if (v.value === UNTRUSTED_CLIENT_IP) {
    return {
      ok: true,
      client: finalize(null, peer, 'tiến trình biên (web) không xác định được IP khách: thiếu tệp nạp trước hoặc thiếu bí mật nội bộ', 'signed'),
    }
  }
  const ip = normalizeIp(v.value)
  if (!ip) return { ok: false, error: 'Header x-trinity-client-ip sai định dạng', log: 'giá trị không phải IP' }
  return { ok: true, client: finalize(ip, peer, null, 'signed') }
}

const logger = new Logger('ClientIp')
const LOG_EVERY_MS = 10 * 60_000
const lastLogged = new Map<string, number>()

function logOnce(key: string, msg: string): void {
  const now = nowMs()
  const prev = lastLogged.get(key)
  if (prev !== undefined && now - prev < LOG_EVERY_MS) return
  lastLogged.set(key, now)
  logger.error(msg)
}

/**
 * Middleware Express — đăng ký TRƯỚC body-parser và multer. Kiểm chữ ký ngay khi nhận header (body chậm không làm
 * chữ ký hết hạn), lưu kết quả vào request. Chữ ký sai/quá hạn ⇒ 400, không cho qua.
 */
export function clientIpMiddleware(
  req: ClientIpRequest,
  res: { statusCode: number; setHeader(name: string, value: string): unknown; end(body: string): unknown },
  next: () => void,
): void {
  const d = determineClientIp(req)
  if (!d.ok) {
    logOnce(`bad:${d.log}`, `[client-ip] từ chối header ${CLIENT_IP_HEADER}: ${d.log} (peer ${req.socket?.remoteAddress ?? '?'})`)
    res.statusCode = 400
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ statusCode: 400, message: d.error, error: 'Bad Request' }))
    return
  }
  ;(req as WithStore)[STORE] = d.client
  next()
}

// Trạng thái cho dải cảnh báo quản trị: sự kiện "không tin được" gần nhất (trong tiến trình). Không bị request tin
// được ghi đè (lưu lượng lẫn lộn không làm dải nhấp nháy); sửa cấu hình cần khởi động lại nên trạng thái tự xoá.
let lastUntrusted: { at: number; reason: string } | null = null
const WARNING_TTL_MS = 24 * 60 * 60_000

/**
 * IP khách của request — hàm DUY NHẤT mọi nơi dùng. Đọc kết quả `clientIpMiddleware` đã lưu; request chưa qua
 * middleware (test đơn vị) thì xác định tại chỗ, chữ ký sai coi như không tin được. Kết quả không tin được ⇒ ghi lỗi
 * cấu hình (tối đa 10 phút một dòng mỗi lý do) và bật dải cảnh báo quản trị.
 */
export function resolveClientIp(req: ClientIpRequest): ClientIp {
  const r = req as WithStore
  let client = r[STORE]
  if (!client) {
    const d = determineClientIp(req)
    const peer = normalizeIp(req.socket?.remoteAddress) ?? 'unknown'
    client = d.ok ? d.client : { ip: null, rateKey: peer, untrustedReason: `header ${CLIENT_IP_HEADER} không hợp lệ: ${d.log}`, source: 'signed' }
    r[STORE] = client
  }
  if (client.untrustedReason) {
    lastUntrusted = { at: nowMs(), reason: client.untrustedReason }
    logOnce(
      `untrusted:${client.untrustedReason}`,
      `[client-ip] LỖI CẤU HÌNH: ${client.untrustedReason}. Kiểm Wi-Fi đăng nhập và kiểm IP chấm công đang CHO QUA (không khoá ai), ` +
        `giới hạn tốc độ dùng chung một xô theo IP peer. Sửa TRUSTED_PROXY (TRUSTED_PROXY=${process.env.TRUSTED_PROXY ?? '(trống = none)'}).`,
    )
  }
  return client
}

/** Câu cảnh báo cho quản trị khi trong 24 giờ qua có request dùng IP không tin được; `null` = ổn. */
export function clientIpWarning(): string | null {
  if (!lastUntrusted || nowMs() - lastUntrusted.at > WARNING_TTL_MS) return null
  return (
    `Máy chủ không xác định được IP thật của người dùng (${lastUntrusted.reason}). Kiểm IP văn phòng khi đăng nhập và chấm công đang tạm cho qua. ` +
    'Người vận hành cần đặt TRUSTED_PROXY đúng cách triển khai (xem docs/deployment.md, mục "Client IP").'
  )
}

/** Chỉ cho test: xoá trạng thái cảnh báo và bộ đếm log. */
export function __resetClientIpStateForTest(): void {
  lastUntrusted = null
  containerCache = undefined
  lastLogged.clear()
  configCache = null
  gatewayCache = null
}
