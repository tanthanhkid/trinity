import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** So sánh hằng-thời-gian hai chuỗi bất kỳ (băm trước để độ dài không rò). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** PKCE S256: BASE64URL(SHA256(verifier)) (RFC 7636 §4.2). */
export const pkceS256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');
export const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Token consent (CSRF + ràng buộc quyết định với ĐÚNG người + ĐÚNG tham số đã hiển thị). Ký HMAC, hạn ngắn. */
function consentKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET chưa đặt');
  return createHmac('sha256', 'trinity-oauth-consent-v1').update(secret).digest();
}

export interface ConsentClaims {
  /** user id */
  u: number;
  /** băm tham số yêu cầu */
  h: string;
  /** hạn (epoch giây) */
  e: number;
}

export function signConsent(claims: ConsentClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', consentKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyConsent(token: string, now = Date.now()): ConsentClaims | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', consentKey()).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConsentClaims;
    if (typeof c.u !== 'number' || typeof c.h !== 'string' || typeof c.e !== 'number' || c.e * 1000 < now) return null;
    return c;
  } catch {
    return null;
  }
}
