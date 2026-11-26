import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { resolveClientIp } from '@trinity/rbac-nest';
import { FixedWindowLimiter } from '../../common/helpers/fixed-window-limiter';

export type LimitHit = { allowed: boolean; retryAfterSec: number };

/**
 * Trần chung theo IP peer khi IP khách KHÔNG tin được (mọi khách chung một peer): cao hơn nhiều giới hạn từng client,
 * chỉ chống dội hàng loạt; khoá riêng (`own`) do client chọn nên KHÔNG được là lớp duy nhất.
 */
export const untrustedPeerLimiter = new FixedWindowLimiter(600, 60 * 1000);

/**
 * Giới hạn tốc độ theo IP khách (hàm dùng chung, TRUSTED_PROXY). IP không tin được ⇒ kiểm CẢ HAI: trần chung theo IP
 * peer (`untrustedPeerLimiter`) VÀ khoá riêng của client (`own`: client_id, token băm, …) trên `limiter` — đổi `own`
 * không lách được trần peer, một client cũng không làm nghẽn client khác.
 */
export function hitByClient(limiter: FixedWindowLimiter, prefix: string, req: Request, own?: unknown): LimitHit {
  const c = resolveClientIp(req);
  if (c.ip) return limiter.hit(`${prefix}:${c.ip}`);
  const peer = untrustedPeerLimiter.hit(`${prefix}:${c.rateKey}`);
  const o = typeof own === 'string' ? own.trim().slice(0, 200) : '';
  const mine = limiter.hit(`${prefix}:u:${createHash('sha256').update(o).digest('hex').slice(0, 24)}`);
  return !peer.allowed ? peer : mine;
}

/** Giới hạn trong RAM (1 process). DCR: 10 đăng ký/giờ/IP (chống spam bảng client). Token/revoke: 60 req/phút/IP. */
export const registerLimiter = new FixedWindowLimiter(10, 60 * 60 * 1000);
export const tokenLimiter = new FixedWindowLimiter(60, 60 * 1000);
/** Màn đồng ý: 30 lần/phút/người dùng. */
export const consentLimiter = new FixedWindowLimiter(30, 60 * 1000);

/** Xoá mọi bộ đếm giới hạn tốc độ OAuth (API điều khiển test, C18). */
export function resetOauthLimiters(): void {
  for (const l of [untrustedPeerLimiter, registerLimiter, tokenLimiter, consentLimiter]) l.reset();
}
