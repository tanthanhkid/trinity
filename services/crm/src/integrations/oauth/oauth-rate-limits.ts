import type { Request } from 'express';
import { FixedWindowLimiter } from '../../common/helpers/fixed-window-limiter';

/** IP client: `x-real-ip` do reverse proxy đặt = `$remote_addr` (client không ghi đè được) — cùng nguyên tắc `attendance-ip.helper`. */
export function clientIp(req: Request): string {
  const remote = (req.socket as { remoteAddress?: string })?.remoteAddress ?? '';
  // Chỉ tin `x-real-ip` khi kết nối tới từ proxy cục bộ (proxy cùng máy). Nếu cổng ứng dụng lỡ mở ra ngoài ⇒ header tự đặt bị bỏ qua.
  const fromLocalProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const real = req.headers['x-real-ip'];
  if (fromLocalProxy && typeof real === 'string' && real) return real.trim();
  return req.ip ?? (req.socket as { remoteAddress?: string })?.remoteAddress ?? 'unknown';
}

/** Giới hạn trong RAM (1 process). DCR: 10 đăng ký/giờ/IP (chống spam bảng client). Token/revoke: 60 req/phút/IP. */
export const registerLimiter = new FixedWindowLimiter(10, 60 * 60 * 1000);
export const tokenLimiter = new FixedWindowLimiter(60, 60 * 1000);
/** Màn đồng ý: 30 lần/phút/người dùng. */
export const consentLimiter = new FixedWindowLimiter(30, 60 * 1000);
