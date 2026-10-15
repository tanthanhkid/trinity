import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Chữ ký webhook Zalo OA: header `X-ZEvent-Signature: mac=<hex>` với
 * `mac = sha256(app_id + <body thô> + timestamp + OA secret key)` — ghép chuỗi rồi băm SHA-256, KHÔNG phải HMAC.
 * `timestamp` lấy từ body. Thiếu secret/app_id ⇒ luôn từ chối (không bao giờ "mở" khi chưa cấu hình).
 */
export function computeZaloMac(appId: string, rawBody: string | Buffer, timestamp: string, secret: string): string {
  return createHash('sha256').update(appId).update(rawBody).update(timestamp).update(secret).digest('hex');
}

export function verifyZaloSignature(opts: {
  appId: string | null;
  secret: string | null;
  rawBody: Buffer | undefined;
  header: string | undefined;
}): boolean {
  const { appId, secret, rawBody, header } = opts;
  if (!appId || !secret || !rawBody || rawBody.length === 0 || !header || header.length > 200) return false;
  let ts: string;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as { timestamp?: unknown; app_id?: unknown };
    if (parsed.timestamp === undefined || parsed.timestamp === null || String(parsed.app_id ?? appId) !== appId) return false;
    ts = String(parsed.timestamp);
  } catch {
    return false;
  }
  const got = header.trim().replace(/^mac=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(computeZaloMac(appId, rawBody, ts, secret), 'hex'));
}
