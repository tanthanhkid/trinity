import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Chữ ký kiểu Stripe: `X-Trinity-Signature: t=<unix giây>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * Dùng chung cho webhook RA (ký) và webhook VÀO (kiểm).
 */
export const SIGNATURE_TOLERANCE_SEC = 300;

export function computeSignature(secret: string, timestampSec: number, rawBody: string | Buffer): string {
  // Hai lần update ⇒ ký ĐÚNG byte nhận được (không qua decode UTF-8 — byte lạ không bị đổi thành U+FFFD).
  return createHmac('sha256', secret).update(`${timestampSec}.`).update(rawBody).digest('hex');
}

export function buildSignatureHeader(secret: string, rawBody: string | Buffer, nowMs: number = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${computeSignature(secret, t, rawBody)}`;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** `true` chỉ khi header đúng cú pháp, `t` trong ±tolerance, và MỘT `v1` khớp (so sánh thời gian cố định). */
export function verifySignatureHeader(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
  opts: { toleranceSec?: number; nowMs?: number } = {},
): boolean {
  if (!header || header.length > 512) return false;
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && HEX64.test(v)) sigs.push(v);
  }
  if (t === null || sigs.length === 0) return false;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - t) > (opts.toleranceSec ?? SIGNATURE_TOLERANCE_SEC)) return false;
  const expected = Buffer.from(computeSignature(secret, t, rawBody), 'hex');
  return sigs.some((s) => timingSafeEqual(expected, Buffer.from(s, 'hex')));
}
