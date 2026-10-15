import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `state` OAuth không cần lưu DB: `base64url(json{p,u,exp}).hmac` ký bằng INTEGRATIONS_SECRET_KEY.
 * Chống giả mạo/CSRF (đúng người bắt đầu, đúng sàn) và hết hạn sau 15 phút.
 */
const TTL_MS = 15 * 60_000;

export function signState(provider: string, userId: number, key: Buffer, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ p: provider, u: userId, exp: now + TTL_MS })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function verifyState(state: string, provider: string, key: Buffer, now = Date.now()): { userId: number } | null {
  const [body, mac] = String(state ?? '').split('.');
  if (!body || !mac) return null;
  const want = createHmac('sha256', key).update(body).digest('base64url');
  if (want.length !== mac.length || !timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p?: string; u?: number; exp?: number };
    if (j.p !== provider || typeof j.u !== 'number' || typeof j.exp !== 'number' || j.exp < now) return null;
    return { userId: j.u };
  } catch {
    return null;
  }
}
