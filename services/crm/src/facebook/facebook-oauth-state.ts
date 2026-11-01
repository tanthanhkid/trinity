import { createHmac } from 'node:crypto';
import { safeEqual } from '../integrations/oauth/oauth-crypto';
import { stateCompanyClaim, stateCompanyMatches } from '../common/helpers/tenant-hint';

const TTL_SEC = 10 * 60;

function key(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET chưa đặt');
  return createHmac('sha256', 'trinity-facebook-oauth-state-v1').update(secret).digest();
}

/**
 * `state` của OAuth Facebook: ràng buộc callback với ĐÚNG người bấm "Kết nối" (chống CSRF/login CSRF). Ký HMAC, hạn 10 phút.
 * Multi-tenant: kèm `c` = công ty mở luồng; callback chạy dưới công ty khác ⇒ state không hợp lệ.
 */
export function signFacebookState(userId: number, now = Date.now()): string {
  const claims: Record<string, unknown> = { u: userId, e: Math.floor(now / 1000) + TTL_SEC };
  const c = stateCompanyClaim();
  if (c !== undefined) claims.c = c;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}

export function verifyFacebookState(state: string, now = Date.now()): { userId: number } | null {
  const [body, mac, extra] = state.split('.');
  if (!body || !mac || extra !== undefined) return null;
  if (!safeEqual(mac, createHmac('sha256', key()).update(body).digest('base64url'))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown; c?: unknown };
    if (typeof c.u !== 'number' || typeof c.e !== 'number' || c.e * 1000 < now) return null;
    if (!stateCompanyMatches(c.c)) return null;
    return { userId: c.u };
  } catch {
    return null;
  }
}
