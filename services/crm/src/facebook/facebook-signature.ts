import { createHmac } from 'node:crypto';
import { safeEqual } from '../integrations/oauth/oauth-crypto';

/**
 * Kiểm `X-Hub-Signature-256` của Meta: `sha256=` + HMAC-SHA256(rawBody, appSecret) hex thường.
 * Tính trên BYTE THÔ của body (không parse lại JSON). Thiếu secret/header/sai định dạng ⇒ false.
 */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(m[1].toLowerCase(), expected);
}

export function signMetaBody(rawBody: Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
