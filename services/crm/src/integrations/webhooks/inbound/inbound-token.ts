import { createHash, randomBytes } from 'node:crypto';

/** Token nguồn webhook vào: `whk_` + 32 byte ngẫu nhiên base64url (43 ký tự) — chỉ lưu SHA-256. */
export const INBOUND_TOKEN_RE = /^whk_[A-Za-z0-9_-]{43}$/;
export const INBOUND_PATH_PREFIX = '/api/v1/hooks/in/';

export function generateInboundToken(): string {
  return `whk_${randomBytes(32).toString('base64url')}`;
}

export function hashInboundToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 12 ký tự đầu để nhận diện trong giao diện (KHÔNG đủ để dùng). */
export function inboundTokenPrefix(token: string): string {
  return token.slice(0, 12);
}
