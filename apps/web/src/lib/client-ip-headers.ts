import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"

/**
 * Header IP do client gửi — xoá trước khi chuyển request sang API. API xác định IP khách theo `TRUSTED_PROXY` và chữ ký
 * `x-trinity-client-ip` (docs/deployment.md, mục "Client IP"); nếu web chép nguyên các header này thì client tự khai
 * được IP (vd `X-Forwarded-For: <IP văn phòng>` qua Caddy → Next → API với `cidr:127.0.0.1/32`).
 * Thay vào đó web gửi IP đã xác định ở biên (`peer-ip.cjs`) bằng `x-trinity-client-ip` có chữ ký.
 */
const CLIENT_IP_HEADERS = new Set(['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'true-client-ip'])

export function isClientIpHeader(name: string): boolean {
  const k = name.toLowerCase()
  return CLIENT_IP_HEADERS.has(k) || k.startsWith('x-trinity-')
}

// ---------------------------------------------------------------------------------------------------------------
// Ký IP khách khi chuyển sang API (cùng định dạng với `apps/web/peer-ip.cjs` và `packages/rbac-nest/src/client-ip.ts`)
// ---------------------------------------------------------------------------------------------------------------

export const CLIENT_IP_HEADER = "x-trinity-client-ip"
export const UNTRUSTED_CLIENT_IP = "untrusted"
const HKDF_INFO = "trinity x-trinity-client-ip v1"
const ALS_KEY = Symbol.for("trinity.peerIp.als")

type Env = Record<string, string | undefined>
const secretsOf = (env: Env) => [env.INTERNAL_SERVICE_SECRET, env.SERVICE_SECRET].filter((v): v is string => Boolean(v))
const keyOf = (secret: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), HKDF_INFO, 32))
const mac = (key: Buffer, value: string, ts: number) => createHmac("sha256", key).update(`${value}\n${ts}`).digest()
const isIpValue = (v: string) => v === UNTRUSTED_CLIENT_IP || isIP(v) !== 0

/** Giá trị trong header có chữ ký hợp lệ (±60 s), hoặc null. */
export function verifyClientIpHeader(header: string | null, env: Env = process.env, nowSec = Math.floor(Date.now() / 1000)): string | null {
  if (!header) return null
  const parts = header.split(";").map((p) => p.trim())
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[1])) return null
  const [value, tsRaw, sigRaw] = parts
  const ts = Number(tsRaw)
  if (Math.abs(nowSec - ts) > 60) return null
  const sig = Buffer.from(sigRaw, "base64url")
  if (sig.length !== 32) return null
  if (!secretsOf(env).some((s) => timingSafeEqual(mac(keyOf(s), value, ts), sig))) return null
  return isIpValue(value) ? value : null
}

/** Ký giá trị NGAY trước khi gửi sang API; không có bí mật ⇒ dấu `untrusted` không chữ ký. */
export function signClientIpHeader(value: string, env: Env = process.env, nowSec = Math.floor(Date.now() / 1000)): string {
  const s = secretsOf(env)[0]
  if (!s) return UNTRUSTED_CLIENT_IP
  return `${value};${nowSec};${mac(keyOf(s), value, nowSec).toString("base64url")}`
}

let warnedNoPreload = false

/**
 * IP khách do tệp nạp trước (`peer-ip.cjs`) xác định cho request này: đọc `AsyncLocalStorage`, không có thì kiểm chữ ký
 * header nó đặt. Thiếu cả hai (chạy Next không có tệp nạp trước) ⇒ KHÔNG đọc header nào khác, trả `untrusted` + log lỗi.
 * Gọi ở ĐẦU route handler (trước khi đọc body) để body chậm không làm chữ ký hết hạn.
 */
export function clientIpFromEdge(headers: Headers, env: Env = process.env): string {
  const store = (globalThis as Record<symbol, { getStore(): { value?: string } | undefined } | undefined>)[ALS_KEY]?.getStore()
  if (store?.value && isIpValue(store.value)) return store.value
  const v = verifyClientIpHeader(headers.get(CLIENT_IP_HEADER), env)
  if (v) return v
  if (!warnedNoPreload) {
    warnedNoPreload = true
    console.error(
      "[client-ip] LỖI CẤU HÌNH: web chạy không có tệp nạp trước peer-ip.cjs (NODE_OPTIONS=--require …/apps/web/peer-ip.cjs) — API sẽ coi IP mọi khách là \"không tin được\".",
    )
  }
  return UNTRUSTED_CLIENT_IP
}
