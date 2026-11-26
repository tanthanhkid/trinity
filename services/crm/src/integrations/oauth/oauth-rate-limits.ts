import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { resolveClientIp } from '@trinity/rbac-nest';
import { FixedWindowLimiter } from '../../common/helpers/fixed-window-limiter';

/**
 * Khoá cho giới hạn tốc độ: IP khách (hàm dùng chung, TRUSTED_PROXY). IP không tin được (mọi người chung một IP peer)
 * ⇒ khoá theo thứ riêng của từng client (`own`: client_id, token băm, …) để một client không làm nghẽn tất cả; thiếu
 * `own` thì mới rơi về IP peer.
 */
export function clientIp(req: Request, own?: unknown): string {
  const c = resolveClientIp(req);
  if (c.ip) return c.ip;
  const o = typeof own === 'string' ? own.trim().slice(0, 200) : '';
  return o ? `u:${createHash('sha256').update(o).digest('hex').slice(0, 24)}` : c.rateKey;
}

/** Giới hạn trong RAM (1 process). DCR: 10 đăng ký/giờ/IP (chống spam bảng client). Token/revoke: 60 req/phút/IP. */
export const registerLimiter = new FixedWindowLimiter(10, 60 * 60 * 1000);
export const tokenLimiter = new FixedWindowLimiter(60, 60 * 1000);
/** Màn đồng ý: 30 lần/phút/người dùng. */
export const consentLimiter = new FixedWindowLimiter(30, 60 * 1000);
