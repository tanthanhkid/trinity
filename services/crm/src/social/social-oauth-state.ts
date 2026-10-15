import { createHmac } from 'node:crypto';
import { safeEqual } from '../integrations/oauth/oauth-crypto';
import { isSocialNetwork, type SocialNetwork } from './social.config';

const TTL_SEC = 10 * 60;

function key(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET chưa đặt');
  return createHmac('sha256', 'trinity-social-oauth-state-v1').update(secret).digest();
}

/**
 * `state` của OAuth đăng đa kênh: gắn callback với ĐÚNG người bấm "Liên kết" và ĐÚNG mạng (chống CSRF / tráo mạng).
 * Ký HMAC, hạn 10 phút. `v` = PKCE verifier (mạng nào cần) — nằm trong state đã ký, không lưu DB.
 */
export function signSocialState(userId: number, network: SocialNetwork, verifier?: string, now = Date.now()): string {
  const claims: Record<string, unknown> = { u: userId, n: network, e: Math.floor(now / 1000) + TTL_SEC };
  if (verifier) claims.v = verifier;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', key()).update(body).digest('base64url')}`;
}

export function verifySocialState(state: string, network: SocialNetwork, now = Date.now()): { userId: number; verifier?: string } | null {
  const [body, mac, extra] = state.split('.');
  if (!body || !mac || extra !== undefined) return null;
  if (!safeEqual(mac, createHmac('sha256', key()).update(body).digest('base64url'))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; n?: unknown; e?: unknown; v?: unknown };
    if (typeof c.u !== 'number' || typeof c.e !== 'number' || c.e * 1000 < now) return null;
    if (!isSocialNetwork(c.n) || c.n !== network) return null;
    return { userId: c.u, verifier: typeof c.v === 'string' ? c.v : undefined };
  } catch {
    return null;
  }
}
