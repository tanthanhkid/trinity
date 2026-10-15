import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'

/**
 * Chống SSRF cho kênh webhook: `webhook_url` đến từ metadata của request, nên không được trỏ vào
 * hạ tầng nội bộ (127.0.0.1, 10.x, 169.254.169.254, …). Chỉ https, không tài khoản trong URL,
 * cổng 443/8443, MỌI địa chỉ phân giải được phải là IP công cộng. Việc kiểm và việc kết nối dùng
 * CÙNG kết quả DNS (`createSafeLookup` là hàm lookup của socket) nên DNS rebinding vô tác dụng.
 */
export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED'
}

const BLOCKED_V4 = new BlockList()
for (const [base, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(base, bits, 'ipv4')
}

/** `true` nếu KHÔNG được kết nối tới địa chỉ này. Không phải IP hợp lệ ⇒ `true`. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return BLOCKED_V4.check(ip, 'ipv4')
  if (kind !== 6) return true
  const lower = ip.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return isBlockedIp(mapped[1])
  // Chỉ cho global unicast 2000::/3, trừ 6to4 (2002::/16), 2001::/23 (IETF/Teredo) và 2001:db8::/32 (tài liệu).
  const groups = lower.split(':')
  const first = parseInt(groups[0] || '0', 16)
  if ((first & 0xe000) !== 0x2000) return true
  if (first === 0x2002) return true
  if (first === 0x2001) {
    const second = parseInt(groups[1] || '0', 16)
    if (second < 0x0200 || second === 0x0db8) return true
  }
  return false
}

/** Kiểm cú pháp URL + giao thức/cổng (chưa phân giải DNS). */
export function parseSafeWebhookUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfBlockedError('URL khong hop le')
  }
  if (url.protocol !== 'https:') throw new SsrfBlockedError('Chi chap nhan dia chi https://')
  if (url.username || url.password) throw new SsrfBlockedError('URL khong duoc chua tai khoan/mat khau')
  if (!['', '443', '8443'].includes(url.port)) throw new SsrfBlockedError('Chi chap nhan cong 443 hoac 8443')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new SsrfBlockedError('URL thieu ten mien')
  if (isIP(host) !== 0 && isBlockedIp(host)) throw new SsrfBlockedError('Dia chi IP noi bo bi chan')
  return url
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
type LookupOptions = { all?: boolean; family?: number | string } | number | undefined

/** `lookup` truyền cho `https.request({ lookup })`: phân giải, chặn nếu BẤT KỲ địa chỉ nào không công cộng. */
export function createSafeLookup() {
  return (hostname: string, options: LookupOptions, cb: LookupCb): void => {
    const opts = typeof options === 'object' && options !== null ? options : {}
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err)
      if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
        return cb(new SsrfBlockedError('Khong phan giai duoc ten mien hoac dia chi khong phai IP cong cong') as NodeJS.ErrnoException)
      }
      const want = opts.family === 4 || opts.family === 6 ? opts.family : 0
      const usable = want ? addrs.filter((a) => a.family === want) : addrs
      if (usable.length === 0) return cb(new SsrfBlockedError('Khong co dia chi phu hop') as NodeJS.ErrnoException)
      if (opts.all) cb(null, usable)
      else cb(null, usable[0].address, usable[0].family)
    })
  }
}
