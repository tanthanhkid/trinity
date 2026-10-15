import { computeZaloMac, verifyZaloSignature } from '../zalo-oa-signature';
import { toLocalPhone, toZaloPhone } from '../zalo-oa.config';

const APP = '1234567890';
const SECRET = 'oa-secret';
const body = (o: object) => Buffer.from(JSON.stringify(o));

describe('verifyZaloSignature', () => {
  const raw = body({ app_id: APP, event_name: 'user_send_text', timestamp: '1700000000000' });
  const mac = computeZaloMac(APP, raw, '1700000000000', SECRET);

  it('chấp nhận mac đúng, có hoặc không tiền tố mac=', () => {
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: raw, header: `mac=${mac}` })).toBe(true);
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: raw, header: mac })).toBe(true);
  });
  it('khớp công thức sha256(appId + body + timestamp + secret) viết tay', () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHash('sha256').update(APP + raw.toString() + '1700000000000' + SECRET).digest('hex');
    expect(mac).toBe(expected);
  });
  it('từ chối: sai mac, sai secret, body bị sửa, thiếu header', () => {
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: raw, header: `mac=${'0'.repeat(64)}` })).toBe(false);
    expect(verifyZaloSignature({ appId: APP, secret: 'khac', rawBody: raw, header: mac })).toBe(false);
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: Buffer.concat([raw, Buffer.from(' ')]), header: mac })).toBe(false);
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: raw, header: undefined })).toBe(false);
  });
  it('fail-closed khi chưa cấu hình secret/app_id hoặc không có timestamp / app_id lạ', () => {
    expect(verifyZaloSignature({ appId: APP, secret: null, rawBody: raw, header: mac })).toBe(false);
    expect(verifyZaloSignature({ appId: null, secret: SECRET, rawBody: raw, header: mac })).toBe(false);
    const noTs = body({ app_id: APP });
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: noTs, header: computeZaloMac(APP, noTs, 'undefined', SECRET) })).toBe(false);
    const other = body({ app_id: 'x', timestamp: '1' });
    expect(verifyZaloSignature({ appId: APP, secret: SECRET, rawBody: other, header: computeZaloMac(APP, other, '1', SECRET) })).toBe(false);
  });
});

describe('chuẩn hoá SĐT', () => {
  it('về dạng 84…', () => {
    expect(toZaloPhone('0912 345 678')).toBe('84912345678');
    expect(toZaloPhone('+84912345678')).toBe('84912345678');
    expect(toZaloPhone('84912345678')).toBe('84912345678');
    expect(toZaloPhone('12345')).toBeNull();
    expect(toLocalPhone('84912345678')).toBe('0912345678');
  });
});
