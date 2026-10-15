import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { promises as dnsPromises } from 'node:dns';

/**
 * Chống SSRF cho webhook ra. Máy chủ thường chạy chung Postgres/Redis ⇒ một URL trỏ vào
 * 127.0.0.1/10.x/169.254.169.254 là đường vào hạ tầng nội bộ.
 *
 * Phòng thủ:
 *  1. Chỉ `https://`, không `user:pass@`, cổng 443/8443.
 *  2. Phân giải DNS rồi chặn TỪNG địa chỉ (mọi địa chỉ phải công cộng, không chỉ cái đầu tiên).
 *  3. Chống DNS rebinding: lúc gửi KHÔNG phân giải rồi kiểm rồi để thư viện phân giải lần nữa — `createSafeLookup`
 *     là hàm `lookup` của chính socket: kiểm và kết nối dùng CÙNG kết quả. SNI/Host vẫn là hostname gốc.
 *  4. IP literal (kể cả dạng thập phân/hex/octal — WHATWG URL đã chuẩn hoá về a.b.c.d) và IPv6 (kể cả
 *     IPv4-mapped, NAT64, 6to4) được kiểm bằng đúng bảng chặn.
 *  5. Redirect không bao giờ được theo (xem webhook-http-client).
 */
/** Cùng một thông điệp cho "không phân giải được" và "phân giải về IP nội bộ" — không để người dùng dò mạng nội bộ qua khác biệt thông điệp. */
const UNREACHABLE_MSG = 'Không phân giải được tên miền hoặc địa chỉ không phải IP công cộng';

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
}

/** Chỉ bật khi NODE_ENV là test/development VÀ cờ tường minh — production KHÔNG BAO GIỜ mở. */
export function allowPrivateTargets(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.INTEGRATIONS_ALLOW_PRIVATE_TARGETS ?? '').trim().toLowerCase();
  return (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') && (flag === 'true' || flag === '1');
}

type Cidr4 = readonly [string, number];
const BLOCKED_V4: readonly Cidr4[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(b: readonly number[]): number {
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 → 16 byte; hỗ trợ `::`, đuôi IPv4 nhúng. Có zone-id (`%`) hoặc sai cú pháp → null (⇒ bị chặn). */
function parseV6(ip: string): number[] | null {
  if (ip.includes('%')) return null;
  let head = ip;
  let tail4: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail4 = v4;
    head = `${ip.slice(0, lastColon)}:0:0`;
  }
  const dbl = head.split('::');
  if (dbl.length > 2) return null;
  const toGroups = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const left = toGroups(dbl[0]);
  const right = dbl.length === 2 ? toGroups(dbl[1]) : [];
  const missing = 8 - left.length - right.length;
  if ((dbl.length === 1 && missing !== 0) || (dbl.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array<string>(dbl.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail4.length === 4) bytes.splice(12, 4, ...tail4);
  return bytes;
}

function blockedV4(b: readonly number[]): boolean {
  const n = v4ToInt(b);
  return BLOCKED_V4.some(([base, bits]) => {
    const baseN = v4ToInt(parseV4(base) as number[]);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (baseN & mask);
  });
}

function blockedV6(b: readonly number[]): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  // IPv4-mapped (::ffff:a.b.c.d) → áp luật IPv4 cho địa chỉ nhúng.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12));
  // NAT64 64:ff9b::/96 → luật IPv4 của địa chỉ nhúng; 64:ff9b:1::/48 (local-use) → chặn.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return zeros(4, 12) ? blockedV4(b.slice(12)) : true;
  }
  // Chỉ cho global unicast 2000::/3 — chặn ::, ::1, ::/96, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64…
  if ((b[0] & 0xe0) !== 0x20) return true;
  if (b[0] === 0x20 && b[1] === 0x01) {
    // 2001::/23 (IETF/Teredo), 2001:db8::/32 (tài liệu)
    if (b[2] < 0x02) return true;
    if (b[2] === 0x0d && b[3] === 0xb8) return true;
  }
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6)); // 6to4 nhúng IPv4
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return true; // 3fff::/20 tài liệu
  return false;
}

/** `true` nếu KHÔNG được kết nối tới địa chỉ này. Chuỗi không phải IP hợp lệ ⇒ `true` (từ chối khi nghi ngờ). */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(parseV4(ip) as number[]);
  if (kind === 6) {
    const b = parseV6(ip);
    return b === null ? true : blockedV6(b);
  }
  return true;
}

export interface ValidatedTarget {
  url: URL;
  /** hostname không ngoặc `[]`, không dấu chấm cuối. */
  hostname: string;
}

const PROD_PORTS = new Set(['', '443', '8443']);

/** Kiểm cú pháp URL + chính sách giao thức/cổng (CHƯA phân giải DNS). Ném `SsrfBlockedError`. */
export function parseWebhookUrl(raw: string, env: NodeJS.ProcessEnv = process.env): ValidatedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('URL không hợp lệ');
  }
  const permissive = allowPrivateTargets(env);
  if (url.protocol !== 'https:' && !(permissive && url.protocol === 'http:')) {
    throw new SsrfBlockedError('Chỉ chấp nhận địa chỉ https://');
  }
  if (url.username || url.password) throw new SsrfBlockedError('URL không được chứa tài khoản/mật khẩu');
  if (!permissive && !PROD_PORTS.has(url.port)) throw new SsrfBlockedError('Chỉ chấp nhận cổng 443 hoặc 8443');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) throw new SsrfBlockedError('URL thiếu tên miền');
  if (!permissive && isIP(hostname) !== 0 && isBlockedIp(hostname)) {
    throw new SsrfBlockedError('Địa chỉ IP nội bộ/không công cộng bị chặn');
  }
  return { url, hostname };
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
const defaultResolver: Resolver = (h) => dnsPromises.lookup(h, { all: true, verbatim: true });

/** Chặn nếu BẤT KỲ địa chỉ nào không công cộng (kẻ tấn công trộn 1 IP nội bộ vào danh sách A). */
export function assertPublicAddresses(addrs: readonly LookupAddress[], env: NodeJS.ProcessEnv = process.env): void {
  if (addrs.length === 0) throw new SsrfBlockedError(UNREACHABLE_MSG);
  if (allowPrivateTargets(env)) return;
  if (addrs.some((a) => isBlockedIp(a.address))) throw new SsrfBlockedError(UNREACHABLE_MSG);
}

/** Kiểm lúc TẠO/SỬA endpoint (và trước mỗi lần gửi, để báo lỗi sớm). */
export async function assertSafeUrl(
  raw: string,
  opts: { env?: NodeJS.ProcessEnv; resolver?: Resolver } = {},
): Promise<ValidatedTarget> {
  const env = opts.env ?? process.env;
  const target = parseWebhookUrl(raw, env);
  if (isIP(target.hostname) === 0) {
    let addrs: LookupAddress[];
    try {
      addrs = await (opts.resolver ?? defaultResolver)(target.hostname);
    } catch {
      throw new SsrfBlockedError(UNREACHABLE_MSG);
    }
    assertPublicAddresses(addrs, env);
  }
  return target;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;
type LookupOptions = { all?: boolean; family?: number | string } | number | undefined;

/**
 * `lookup` truyền cho `http(s).request({ lookup })`: phân giải + kiểm + trả đúng các địa chỉ đã kiểm.
 * Socket kết nối thẳng tới địa chỉ này nên DNS rebinding (đổi đáp án giữa lúc kiểm và lúc nối) vô tác dụng.
 * Hỗ trợ cả `all:true` (autoSelectFamily của Node ≥ 20) lẫn dạng 1 địa chỉ.
 */
export function createSafeLookup(env: NodeJS.ProcessEnv = process.env, resolver?: Resolver) {
  const resolve: Resolver =
    resolver ??
    ((h) => new Promise((ok, fail) => dnsLookup(h, { all: true, verbatim: true }, (e, a) => (e ? fail(e) : ok(a)))));
  return (hostname: string, options: LookupOptions, cb: LookupCb): void => {
    const opts = typeof options === 'object' && options !== null ? options : {};
    resolve(hostname)
      .then((addrs) => {
        assertPublicAddresses(addrs, env);
        const want = opts.family === 4 || opts.family === 6 ? opts.family : 0;
        const usable = want ? addrs.filter((a) => a.family === want) : addrs;
        if (usable.length === 0) throw new SsrfBlockedError('Không có địa chỉ phù hợp');
        if (opts.all) cb(null, usable);
        else cb(null, usable[0].address, usable[0].family);
      })
      .catch((err: unknown) => cb(err as NodeJS.ErrnoException));
  };
}
