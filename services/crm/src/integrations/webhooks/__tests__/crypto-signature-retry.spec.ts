import { randomBytes } from 'node:crypto';
import {
  decryptSecret, encryptSecret, generateWebhookSecret, IntegrationsKeyError, isSecretKeyConfigured, loadSecretKey,
} from '../secret-crypto';
import { buildSignatureHeader, computeSignature, verifySignatureHeader } from '../signature';
import { AUTO_DISABLE_AFTER_FAILURES, MAX_ATTEMPTS, nextRetryDelayMs, RETRY_DELAYS_MS } from '../webhook-retry';

const KEY = randomBytes(32);
const env = (v?: string) => ({ INTEGRATIONS_SECRET_KEY: v }) as NodeJS.ProcessEnv;

describe('secret-crypto', () => {
  it('mã hoá/giải mã khứ hồi, mỗi lần ra bản mã khác nhau (IV ngẫu nhiên)', () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const a = encryptSecret(s, KEY);
    const b = encryptSecret(s, KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain(s);
    expect(decryptSecret(a, KEY)).toBe(s);
  });

  it('sai khoá hoặc bị sửa → IntegrationsKeyError (không lộ chi tiết thư viện)', () => {
    const enc = encryptSecret('whsec_x', KEY);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow(IntegrationsKeyError);
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow(IntegrationsKeyError);
    expect(() => decryptSecret('rác', KEY)).toThrow(IntegrationsKeyError);
  });

  it('loadSecretKey: thiếu / sai độ dài / không phải base64 → lỗi RÕ, không tự sinh khoá', () => {
    expect(() => loadSecretKey(env(undefined))).toThrow(/chưa được cấu hình/);
    expect(() => loadSecretKey(env('  '))).toThrow(IntegrationsKeyError);
    expect(() => loadSecretKey(env(randomBytes(16).toString('base64')))).toThrow(/32 byte/);
    expect(() => loadSecretKey(env('***không-phải-base64***'))).toThrow(/base64/);
    expect(loadSecretKey(env(KEY.toString('base64'))).equals(KEY)).toBe(true);
    expect(isSecretKeyConfigured(env(undefined))).toBe(false);
    expect(isSecretKeyConfigured(env(KEY.toString('base64')))).toBe(true);
  });
});

describe('signature (kiểu Stripe)', () => {
  const secret = 'whsec_test';
  const body = '{"id":"d1","type":"contact.created","data":{"a":1}}';
  const now = 1_700_000_000_000;

  it('header có dạng t=<unix>,v1=<hex> và khớp HMAC-SHA256("<t>.<body>")', () => {
    const h = buildSignatureHeader(secret, body, now);
    expect(h).toBe(`t=1700000000,v1=${computeSignature(secret, 1_700_000_000, body)}`);
    expect(h).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('kiểm chữ ký đúng; sai secret / body bị sửa / quá hạn / sai cú pháp → false', () => {
    const h = buildSignatureHeader(secret, body, now);
    expect(verifySignatureHeader(secret, body, h, { nowMs: now + 1000 })).toBe(true);
    expect(verifySignatureHeader('whsec_other', body, h, { nowMs: now })).toBe(false);
    expect(verifySignatureHeader(secret, body + ' ', h, { nowMs: now })).toBe(false);
    expect(verifySignatureHeader(secret, body, h, { nowMs: now + 301_000 })).toBe(false); // replay quá 5 phút
    expect(verifySignatureHeader(secret, body, h, { nowMs: now - 301_000 })).toBe(false);
    expect(verifySignatureHeader(secret, body, undefined)).toBe(false);
    expect(verifySignatureHeader(secret, body, 'v1=abc')).toBe(false);
    expect(verifySignatureHeader(secret, body, `t=${1_700_000_000},v1=${'0'.repeat(63)}`, { nowMs: now })).toBe(false);
    expect(verifySignatureHeader(secret, body, 'x'.repeat(600))).toBe(false);
  });

  it('ký trên BYTE: Buffer == string với UTF-8 hợp lệ; byte không hợp lệ KHÔNG bị đổi thành U+FFFD (không có 2 body ký trùng nhau)', () => {
    expect(computeSignature(secret, 1, Buffer.from(body, 'utf8'))).toBe(computeSignature(secret, 1, body));
    const bad1 = Buffer.from([0x7b, 0xff, 0x7d]);
    const bad2 = Buffer.from([0x7b, 0xfe, 0x7d]);
    expect(computeSignature(secret, 1, bad1)).not.toBe(computeSignature(secret, 1, bad2));
    const h = buildSignatureHeader(secret, bad1, now);
    expect(verifySignatureHeader(secret, bad1, h, { nowMs: now })).toBe(true);
    expect(verifySignatureHeader(secret, bad2, h, { nowMs: now })).toBe(false);
  });

  it('chấp nhận nhiều v1 (xoay secret): chỉ cần 1 khớp', () => {
    const good = computeSignature(secret, 1_700_000_000, body);
    const h = `t=1700000000,v1=${'a'.repeat(64)},v1=${good}`;
    expect(verifySignatureHeader(secret, body, h, { nowMs: now })).toBe(true);
  });
});

describe('lịch thử lại', () => {
  it('1m, 5m, 30m, 2h, 6h, 12h rồi dead — tổng 7 lần gửi', () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000]);
    expect(MAX_ATTEMPTS).toBe(7);
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(300_000);
    expect(nextRetryDelayMs(6)).toBe(43_200_000);
    expect(nextRetryDelayMs(7)).toBeNull();
    expect(nextRetryDelayMs(99)).toBeNull();
  });

  it('endpoint tự tắt sau 20 lỗi liên tiếp', () => expect(AUTO_DISABLE_AFTER_FAILURES).toBe(20));
});
