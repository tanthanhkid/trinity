import type { Request } from 'express';
import { resolveClientIp } from '@trinity/rbac-nest';
import { FixedWindowLimiter } from '../../common/helpers/fixed-window-limiter';

/** Khoá IP cho giới hạn tốc độ: hàm dùng chung (TRUSTED_PROXY); không tin được ⇒ IP peer (một xô chung, docs/deployment.md). */
export function clientIp(req: Request): string {
  return resolveClientIp(req).rateKey;
}

/** Giới hạn trong RAM (1 process). DCR: 10 đăng ký/giờ/IP (chống spam bảng client). Token/revoke: 60 req/phút/IP. */
export const registerLimiter = new FixedWindowLimiter(10, 60 * 60 * 1000);
export const tokenLimiter = new FixedWindowLimiter(60, 60 * 1000);
/** Màn đồng ý: 30 lần/phút/người dùng. */
export const consentLimiter = new FixedWindowLimiter(30, 60 * 1000);
