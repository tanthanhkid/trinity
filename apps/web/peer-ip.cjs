/* eslint-disable @typescript-eslint/no-require-imports -- tệp nạp trước CommonJS, chạy ngoài bundler */
'use strict'
/**
 * Tệp nạp trước của web (`NODE_OPTIONS=--require ./apps/web/peer-ip.cjs`): web là TIẾN TRÌNH BIÊN, xác định IP khách
 * một lần khi nhận header rồi ký để API tin (docs/deployment.md, mục "Client IP"; docs/rust/PLAN.md mục 4.13).
 *
 * Next 16 không cho route handler biết địa chỉ kết nối, nên tệp này bọc `http.createServer`:
 * - với MỌI request: xoá `x-trinity-client-ip`/`x-trinity-peer-ip` do client gửi (giữ `x-trinity-client-ip` chỉ khi chữ ký hợp lệ VÀ peer là loopback/proxy khai báo — do tiến trình
 *   Trinity phía trước ký, vd Rust trong cấu hình lai);
 * - xác định IP từ `req.socket.remoteAddress` theo `TRUSTED_PROXY` (cùng luật `packages/rbac-nest/src/client-ip.ts`;
 *   test đối chiếu ở `client-ip.spec.ts`), không xác định được ⇒ dấu `untrusted`;
 * - đặt `x-trinity-client-ip` có chữ ký lên request (đường rewrite `/.well-known` tới thẳng API) và đưa giá trị vào
 *   `AsyncLocalStorage` (route handler `/api/v1/*` đọc rồi KÝ LẠI ngay trước khi gửi sang API).
 * Ngoài ra: `cloudflare-tunnel` mà địa chỉ sắp nghe không phải loopback ⇒ thoát TRƯỚC khi mở cổng; production với bí mật
 * mẫu/ngắn ⇒ thoát; `TRUSTED_PROXY` sai ⇒ thoát.
 *
 * Định dạng: `x-trinity-client-ip: <ip|untrusted>;<unix>;<HMAC-SHA256 base64url của "<giá trị>\n<unix>">`, khoá HKDF-SHA256
 * (salt rỗng, info `trinity x-trinity-client-ip v1`) từ `INTERNAL_SERVICE_SECRET`, rồi `SERVICE_SECRET`. Không có bí mật ⇒
 * gửi dấu `untrusted` không chữ ký (API coi là không tin được).
 */
const http = require('node:http')
const { AsyncLocalStorage } = require('node:async_hooks')
const crypto = require('node:crypto')
const net = require('node:net')
const fs = require('node:fs')

const HEADER = 'x-trinity-client-ip'
const UNTRUSTED = 'untrusted'
const MAX_SKEW_SEC = 60
const HKDF_INFO = 'trinity x-trinity-client-ip v1'
const ALS_KEY = Symbol.for('trinity.peerIp.als')

const DEFAULT_CLOUDFLARE_IP_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

function normalizeIp(raw) {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s)
  if (m) s = m[1]
  const v = net.isIP(s)
  return v === 4 ? s : v === 6 ? s.toLowerCase() : null
}

function parseCidr(raw) {
  const parts = raw.trim().split('/')
  if (parts.length > 2) return null
  const ip = normalizeIp(parts[0])
  if (!ip) return null
  const family = net.isIP(ip) === 6 ? 'ipv6' : 'ipv4'
  const max = family === 'ipv6' ? 128 : 32
  const prefix = parts[1] === undefined ? max : /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : NaN
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null
  return { ip, prefix, family }
}

const splitList = (raw) => raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)

let containerCache = null
function inContainer(env) {
  if (env.TRINITY_TEST_IN_CONTAINER !== undefined) return env.TRINITY_TEST_IN_CONTAINER === '1'
  if (containerCache === null) {
    let yes = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')
    if (!yes) {
      try {
        yes = /docker|kubepods|containerd|libpod/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'))
      } catch {
        yes = false
      }
    }
    containerCache = yes // không đổi trong đời tiến trình
  }
  return containerCache
}

const GATEWAY_TTL_MS = 30_000
let gatewayCache = { at: 0, value: null }
/** Cổng mặc định của container (đọc /proc/net/route, nhớ 30 giây — tuyến đổi khi mạng compose được tạo lại). */
function defaultGateway(env) {
  if (!inContainer(env)) return null
  let text = env.TRINITY_TEST_ROUTE_TABLE
  if (text === undefined) {
    if (Date.now() - gatewayCache.at < GATEWAY_TTL_MS) return gatewayCache.value
    try {
      text = fs.readFileSync('/proc/net/route', 'utf8')
    } catch {
      text = ''
    }
  }
  let value = null
  for (const line of text.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/)
    if (c.length < 3 || c[1] !== '00000000' || !/^[0-9a-f]{8}$/i.test(c[2])) continue
    const v = [6, 4, 2, 0].map((i) => parseInt(c[2].slice(i, i + 2), 16)).join('.')
    if (v !== '0.0.0.0') {
      value = v
      break
    }
  }
  if (env.TRINITY_TEST_ROUTE_TABLE === undefined) gatewayCache = { at: Date.now(), value }
  return value
}

function blockList(entries, env) {
  const b = new net.BlockList()
  for (const e of entries) {
    if (e === 'docker-gateway') {
      const gw = defaultGateway(env)
      if (gw) b.addAddress(gw, 'ipv4')
      continue
    }
    const c = parseCidr(e)
    if (c) b.addSubnet(c.ip, c.prefix, c.family)
  }
  return b
}
const inList = (b, ip) => b.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')

/** Cùng cú pháp với `parseTrustedProxy` (client-ip.ts). Sai ⇒ throw. */
function parseTrustedProxy(raw) {
  const v = (raw || '').trim()
  if (v === '' || v === 'none') return { mode: 'none' }
  if (v === 'cloudflare' || v === 'cloudflare-tunnel') return { mode: v }
  const check = (entries, name) => {
    if (!entries.length) throw new Error(`${name}: danh sách trống`)
    for (const e of entries) if (e !== 'docker-gateway' && !parseCidr(e)) throw new Error(`${name}: "${e}" không phải IP/CIDR hợp lệ`)
  }
  if (v.startsWith('cidr:')) {
    const [list, ...opts] = v.slice(5).split(';')
    let header = 'x-forwarded-for'
    for (const o of opts.map((x) => x.trim()).filter(Boolean)) {
      const m = /^header=(x-forwarded-for|x-real-ip)$/i.exec(o)
      if (!m) throw new Error(`TRUSTED_PROXY: tuỳ chọn "${o}" không hợp lệ`)
      header = m[1].toLowerCase()
    }
    const entries = splitList(list)
    check(entries, 'TRUSTED_PROXY cidr:')
    return { mode: 'cidr', entries, header }
  }
  if (v.startsWith('cloudflare-behind:')) {
    const entries = splitList(v.slice(18))
    check(entries, 'TRUSTED_PROXY cloudflare-behind:')
    return { mode: 'cloudflare-behind', entries }
  }
  throw new Error(`TRUSTED_PROXY="${v}" không hợp lệ (none | cloudflare | cloudflare-tunnel | cidr:<danh sách> | cloudflare-behind:<danh sách>)`)
}

function headerOf(req, name) {
  const v = req.headers[name]
  return Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : undefined
}
function rightmostXff(req) {
  const x = headerOf(req, 'x-forwarded-for')
  if (!x) return null
  const hops = x.split(',').map((h) => h.trim()).filter(Boolean)
  return normalizeIp(hops[hops.length - 1])
}

/**
 * Cấu hình đã phân tích, nhớ theo giá trị biến môi trường (không phân tích lại mỗi request). Danh sách có
 * `docker-gateway` dựng lại khi cổng mặc định đổi.
 */
let configCache = null
function config(env) {
  const key = `${env.TRUSTED_PROXY || ''}\u0000${env.CLOUDFLARE_IP_RANGES || ''}`
  if (!configCache || configCache.key !== key) {
    const p = parseTrustedProxy(env.TRUSTED_PROXY)
    const cfEntries = env.CLOUDFLARE_IP_RANGES && env.CLOUDFLARE_IP_RANGES.trim() ? splitList(env.CLOUDFLARE_IP_RANGES).filter((e) => e !== 'docker-gateway') : DEFAULT_CLOUDFLARE_IP_RANGES
    configCache = { key, p, cf: blockList(cfEntries, env), list: null, listGw: undefined }
  }
  const c = configCache
  if (c.p.entries) {
    const gw = c.p.entries.includes('docker-gateway') ? defaultGateway(env) : null
    if (!c.list || c.listGw !== gw) {
      c.list = blockList(c.p.entries, env)
      c.listGw = gw
    }
  }
  return c
}

/** Peer là proxy/tiến trình phía trước mà mình khai báo: loopback hoặc thuộc danh sách của TRUSTED_PROXY. */
function fromTrustedUpstream(req, env) {
  const peer = normalizeIp(req.socket && req.socket.remoteAddress)
  if (!peer) return false
  if (peer === '::1' || peer.startsWith('127.')) return true
  const c = config(env)
  return !!c.list && inList(c.list, peer)
}

/** IP khách theo `TRUSTED_PROXY` từ peer TCP; `null` = không xác định được (gửi dấu `untrusted`). */
function determine(req, env = process.env) {
  const c = config(env)
  const p = c.p
  const peer = normalizeIp(req.socket && req.socket.remoteAddress)
  if (!peer) return null
  switch (p.mode) {
    case 'none':
      return peer
    case 'cloudflare':
      return inList(c.cf, peer) ? normalizeIp(headerOf(req, 'cf-connecting-ip')) : peer
    case 'cloudflare-tunnel':
      return normalizeIp(headerOf(req, 'cf-connecting-ip'))
    case 'cidr':
      if (!inList(c.list, peer)) return peer
      return p.header === 'x-real-ip' ? normalizeIp(headerOf(req, 'x-real-ip')) : rightmostXff(req)
    case 'cloudflare-behind': {
      if (!inList(c.list, peer)) return peer
      const hop = rightmostXff(req)
      if (!hop) return null
      return inList(c.cf, hop) ? normalizeIp(headerOf(req, 'cf-connecting-ip')) : hop
    }
  }
  return null
}

const secrets = (env = process.env) => [env.INTERNAL_SERVICE_SECRET, env.SERVICE_SECRET].filter(Boolean)
const keyOf = (secret) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32))
const mac = (key, value, ts) => crypto.createHmac('sha256', key).update(`${value}\n${ts}`).digest()

/** Giá trị header đã ký; không có bí mật ⇒ dấu `untrusted` không chữ ký. */
function sign(value, env = process.env, nowSec = Math.floor(Date.now() / 1000)) {
  const s = secrets(env)[0]
  if (!s) return UNTRUSTED
  return `${value};${nowSec};${mac(keyOf(s), value, nowSec).toString('base64url')}`
}

/** Giá trị của header có chữ ký hợp lệ (±60 s, khoá từ một trong hai bí mật); không hợp lệ ⇒ null. */
function verify(header, env = process.env, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string') return null
  const parts = header.split(';').map((x) => x.trim())
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[1])) return null
  const [value, tsRaw, sigRaw] = parts
  const ts = Number(tsRaw)
  if (Math.abs(nowSec - ts) > MAX_SKEW_SEC) return null
  const sig = Buffer.from(sigRaw, 'base64url')
  if (sig.length !== 32) return null
  const ok = secrets(env).some((s) => crypto.timingSafeEqual(mac(keyOf(s), value, ts), sig))
  if (!ok) return null
  return value === UNTRUSTED || normalizeIp(value) ? value : null
}

const als = globalThis[ALS_KEY] || (globalThis[ALS_KEY] = new AsyncLocalStorage())

/**
 * Header IP nội bộ của Trinity — xoá khi client gửi. CHỈ các header này: header `x-trinity-*` khác (vd
 * `X-Trinity-Signature` của webhook vào) phải tới API nguyên vẹn.
 */
const INTERNAL_IP_HEADERS = new Set([HEADER, 'x-trinity-peer-ip'])

/** Xử lý một request: xoá header IP nội bộ do client gửi, xác định IP, đặt header có chữ ký. Trả giá trị (IP hoặc `untrusted`). */
function prepare(req, env = process.env) {
  const incoming = headerOf(req, HEADER)
  for (const k of Object.keys(req.headers)) if (INTERNAL_IP_HEADERS.has(k)) delete req.headers[k]
  if (Array.isArray(req.rawHeaders)) {
    const raw = []
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (!INTERNAL_IP_HEADERS.has(String(req.rawHeaders[i]).toLowerCase())) raw.push(req.rawHeaders[i], req.rawHeaders[i + 1])
    }
    req.rawHeaders.length = 0
    req.rawHeaders.push(...raw)
  }
  // Header có chữ ký chỉ được giữ khi tới từ tiến trình/proxy phía trước mình khai báo (vd Rust trên loopback).
  let value = fromTrustedUpstream(req, env) ? verify(incoming, env) : null
  if (value === null) value = determine(req, env) || UNTRUSTED
  const signed = sign(value, env)
  req.headers[HEADER] = signed
  if (Array.isArray(req.rawHeaders)) req.rawHeaders.push(HEADER, signed)
  return value
}

function isLoopbackHost(h) {
  const ip = normalizeIp(h || '')
  return h === 'localhost' || (!!ip && (ip === '::1' || ip.startsWith('127.')))
}

/** `cloudflare-tunnel`: địa chỉ SẮP nghe (đối số của listen) phải là loopback. Trả lỗi hoặc null. */
function tunnelListenProblem(args, env = process.env) {
  if ((env.TRUSTED_PROXY || '').trim() !== 'cloudflare-tunnel') return null
  let host
  if (args[0] && typeof args[0] === 'object') host = args[0].host
  else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) return null // đường dẫn socket Unix
  else if (typeof args[1] === 'string') host = args[1]
  if (isLoopbackHost(host)) return null
  return 'TRUSTED_PROXY=cloudflare-tunnel nhưng web sắp nghe một địa chỉ không phải loopback: ai nối thẳng cổng web sẽ tự khai được IP. Đặt HOSTNAME=127.0.0.1 (docs/deployment.md, mục "Client IP").'
}

/** Production với bí mật nội bộ là giá trị mẫu hoặc ngắn hơn 32 ký tự (cùng luật `insecureSecrets()` của API). */
function hasInsecureSecret(env = process.env) {
  if (env.NODE_ENV !== 'production') return false
  return ['INTERNAL_SERVICE_SECRET', 'SERVICE_SECRET'].some((k) => {
    const v = (env[k] || '').trim()
    return v !== '' && (/change-me/i.test(v) || v.length < 32)
  })
}

function fatal(msg) {
  console.error(`[peer-ip] Không khởi động: ${msg}`)
  process.exit(1)
}

function install() {
  try {
    parseTrustedProxy(process.env.TRUSTED_PROXY)
  } catch {
    // Câu cố định (không lặp lại giá trị biến môi trường vào log).
    fatal('TRUSTED_PROXY không hợp lệ — dùng none | cloudflare | cloudflare-tunnel | cidr:<danh sách>[;header=x-real-ip] | cloudflare-behind:<danh sách> (docs/deployment.md, mục "Client IP").')
  }
  if (hasInsecureSecret()) {
    // Câu cố định — không đưa gì dẫn từ giá trị bí mật vào log.
    console.error('[peer-ip] Không khởi động: INTERNAL_SERVICE_SECRET/SERVICE_SECRET là giá trị mẫu change-me-* hoặc ngắn hơn 32 ký tự — sinh mới bằng: openssl rand -hex 32')
    process.exit(1)
  }
  if (!secrets().length) console.error('[peer-ip] LỖI CẤU HÌNH: web không có INTERNAL_SERVICE_SECRET/SERVICE_SECRET — API sẽ coi IP mọi khách là "không tin được".')

  const origCreate = http.createServer
  http.createServer = function createServer(...args) {
    const i = args.findIndex((a) => typeof a === 'function')
    if (i >= 0) {
      const listener = args[i]
      args[i] = function trinityPeerIp(req, res) {
        const value = prepare(req)
        return als.run({ value }, () => listener.call(this, req, res))
      }
    }
    return origCreate.apply(this, args)
  }
  const origListen = http.Server.prototype.listen
  http.Server.prototype.listen = function listen(...args) {
    const problem = tunnelListenProblem(args)
    if (problem) fatal(problem)
    return origListen.apply(this, args)
  }
  globalThis[Symbol.for('trinity.peerIp.installed')] = true
}

if (process.env.TRINITY_PEER_IP_NO_INSTALL !== '1') install()

module.exports = { HEADER, UNTRUSTED, determine, parseTrustedProxy, prepare, sign, verify, tunnelListenProblem, hasInsecureSecret, normalizeIp }
