import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Mã hoá secret webhook: AES-256-GCM, khoá `INTEGRATIONS_SECRET_KEY` = 32 byte base64.
 * 🔴 Thiếu/sai khoá ⇒ ném `IntegrationsKeyError` — KHÔNG tự sinh khoá ngầm (secret đã mã hoá bằng khoá
 * ngẫu nhiên mỗi lần khởi động sẽ không bao giờ giải mã lại được).
 */
export class IntegrationsKeyError extends Error {
  readonly code = 'INTEGRATIONS_KEY_INVALID';
}

const AAD = Buffer.from('trinity-webhook-secret/v1');
const KEY_BYTES = 32;
const IV_BYTES = 12;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function loadSecretKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.INTEGRATIONS_SECRET_KEY?.trim();
  if (!raw) throw new IntegrationsKeyError('INTEGRATIONS_SECRET_KEY chưa được cấu hình (cần 32 byte base64)');
  if (!B64.test(raw)) throw new IntegrationsKeyError('INTEGRATIONS_SECRET_KEY không phải base64 hợp lệ');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new IntegrationsKeyError(`INTEGRATIONS_SECRET_KEY phải giải mã ra đúng ${KEY_BYTES} byte (hiện ${key.length})`);
  }
  return key;
}

export function isSecretKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadSecretKey(env);
    return true;
  } catch {
    return false;
  }
}

/** `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, key: Buffer): string {
  const parts = enc.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new IntegrationsKeyError('secret_enc sai định dạng');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Sai khoá / dữ liệu bị sửa: không lộ chi tiết của thư viện.
    throw new IntegrationsKeyError('Không giải mã được secret (sai INTEGRATIONS_SECRET_KEY hoặc dữ liệu hỏng)');
  }
}

/** Secret ký HMAC của endpoint — hiển thị đúng 1 lần cho người tạo. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}
