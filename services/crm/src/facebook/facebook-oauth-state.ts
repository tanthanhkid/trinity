import { createHmac } from 'node:crypto';
import { safeEqual } from '../integrations/oauth/oauth-crypto';

const TTL_SEC = 10 * 60;

function key(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET chưa đặt');
  return createHmac('sha256', 'trinity-facebook-oauth-state-v1').update(secret).digest();
}

/** `state` của OAuth Facebook: ràng buộc callback với ĐÚNG người bấm "Kết nối" (chống CSRF/login CSRF). Ký HMAC, hạn 10 phút. */
export function signFacebookState(userId: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(now / 1000) + TTL_SEC })).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}

export function verifyFacebookState(state: string, now = Date.now()): { userId: number } | null {
  const [body, mac, extra] = state.split('.');
  if (!body || !mac || extra !== undefined) return null;
  if (!safeEqual(mac, createHmac('sha256', key()).update(body).digest('base64url'))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; e?: unknown };
    if (typeof c.u !== 'number' || typeof c.e !== 'number' || c.e * 1000 < now) return null;
    return { userId: c.u };
  } catch {
    return null;
  }
}
