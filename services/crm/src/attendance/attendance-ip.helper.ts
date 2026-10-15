import type { Request } from 'express';

export interface AttendanceOfficeIp {
  id: number;
  ips: string[];
  name: string;
}

/**
 * Chuẩn hoá IP: bỏ prefix ::ffff: (IPv4-mapped IPv6) và trim khoảng trắng.
 */
export function normalizeIp(raw: string): string {
  return raw.replace(/^::ffff:/i, '').trim();
}

/**
 * Lấy client IP từ request để chấm công.
 *
 * ⚠️ BẢO MẬT: chỉ tin header do PROXY TIN CẬY đặt — KHÔNG tin header client tự gửi.
 * - `x-real-ip` do reverse proxy đặt = `$remote_addr` (IP thật, client KHÔNG ghi đè được) → NGUỒN CHÍNH.
 * - `cf-connecting-ip` CHỈ đáng tin khi đứng sau Cloudflare. Nếu không có proxy đó thì client
 *   TỰ GỬI được header này → giả mạo IP văn phòng. Vì vậy CHỈ tin khi env
 *   `ATTENDANCE_TRUST_CF_IP=true` (đặt riêng cho môi trường thật sự sau Cloudflare).
 * - `x-real-ip` / `x-forwarded-for` chỉ được tin khi socket tới từ proxy nội bộ (loopback/mạng riêng)
 *   hoặc `ATTENDANCE_TRUST_PROXY_HEADERS=true`; nếu không dùng IP socket.
 */
/** Loopback / mạng riêng / link-local / ULA: địa chỉ của một reverse proxy nội bộ, không phải client Internet. */
export function isPrivateOrLoopbackIp(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const ip = normalizeIp(raw).toLowerCase();
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Chỉ tin `x-real-ip` / `x-forwarded-for` khi kết nối tới từ một proxy nội bộ (loopback/mạng riêng),
 * hoặc khi vận hành tự khẳng định bằng `ATTENDANCE_TRUST_PROXY_HEADERS=true` (vd Vercel/PaaS không lộ IP proxy).
 * Gọi thẳng từ Internet thì client tự gửi header được → bỏ qua, dùng IP socket.
 */
function trustsProxyHeaders(req: Request): boolean {
  if (process.env.ATTENDANCE_TRUST_PROXY_HEADERS === 'true') return true;
  const remote = (req.socket as { remoteAddress?: string })?.remoteAddress;
  return isPrivateOrLoopbackIp(remote);
}

export function extractClientIp(req: Request): string | null {
  if (process.env.ATTENDANCE_TRUST_CF_IP === 'true') {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return normalizeIp(cf);
  }

  if (trustsProxyHeaders(req)) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return normalizeIp(real);

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
      // Proxy nối thêm IP của client vào CUỐI danh sách; phần đầu do client tự gửi nên không tin.
      const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean);
      const hop = [...hops].reverse().find((h) => !isPrivateOrLoopbackIp(h)) ?? hops[hops.length - 1];
      if (hop) return normalizeIp(hop);
    }
  }

  const remote = (req.socket as { remoteAddress?: string })?.remoteAddress;
  if (remote) return normalizeIp(remote);

  if (req.ip) return normalizeIp(req.ip);

  return null;
}

/**
 * Kiểm tra IP đã chuẩn hoá có khớp với danh sách IP văn phòng không.
 */
export function ipMatchesOffice(clientIp: string, officeIps: string[]): boolean {
  const normalized = normalizeIp(clientIp);
  return officeIps.map(normalizeIp).includes(normalized);
}
