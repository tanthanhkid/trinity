import { FixedWindowLimiter } from '../../../common/helpers/fixed-window-limiter';
import { MAX_EXTRA_BYTES, normalizeVnPhone, parseInboundPayload } from '../inbound/inbound-payload';
import { generateInboundToken, hashInboundToken, INBOUND_TOKEN_RE, inboundTokenPrefix } from '../inbound/inbound-token';

describe('normalizeVnPhone', () => {
  it.each([
    ['0912345678', '0912345678'], ['+84912345678', '0912345678'], ['84912345678', '0912345678'], ['912345678', '0912345678'],
    ['0912 345 678', '0912345678'], ['0912.345.678', '0912345678'], ['(091) 234-5678', '0912345678'], ['  +84 912 345 678 ', '0912345678'],
  ])('%s → %s', (raw, want) => expect(normalizeVnPhone(raw)).toBe(want));

  it.each(['', 'abc', '12345', '091234567', '09123456789', '+1 415 555 2671', '0912345678x', '8491234567', '++84912345678', '0912-345-678-9'])(
    'từ chối %j', (raw) => expect(normalizeVnPhone(raw)).toBeNull());
});

describe('parseInboundPayload', () => {
  const ok = { name: '  Nguyễn Văn A ', phone: '+84 912 345 678', email: ' a@x.vn ', note: 'quan tâm gói A', source: 'FB form', external_id: 'lead-123', extra: { utm: 'x' } };

  it('hợp lệ: cắt khoảng trắng, chuẩn hoá SĐT', () => {
    const r = parseInboundPayload(ok);
    expect(r).toEqual({ ok: true, value: { name: 'Nguyễn Văn A', phone: '0912345678', email: 'a@x.vn', note: 'quan tâm gói A', source: 'FB form', external_id: 'lead-123', extra: { utm: 'x' } } });
  });

  it('chỉ name + phone là đủ; trường thừa bị bỏ', () => {
    const r = parseInboundPayload({ name: 'A', phone: '0912345678', password: 'x', assigned_to: 1 });
    expect(r.ok && Object.keys(r.value).filter((k) => (r.value as never)[k] !== undefined).sort()).toEqual(['name', 'phone']);
  });

  it.each([
    [{ phone: '0912345678' }, /name/], [{ name: 'A' }, /phone/], [{ name: '', phone: '0912345678' }, /name/],
    [{ name: 'A', phone: 'xyz' }, /phone/], [{ name: 'A', phone: '0912345678', email: 'sai' }, /email/],
    [{ name: 'A', phone: '0912345678', external_id: 'có dấu cách' }, /external_id/], [{ name: 'A', phone: '0912345678', external_id: 'x'.repeat(129) }, /external_id/],
    [{ name: 'A', phone: '0912345678', note: 'x'.repeat(2001) }, /note/], [{ name: 'A', phone: '0912345678', extra: 'str' }, /extra/],
    [{ name: 'A', phone: '0912345678', extra: { big: 'x'.repeat(MAX_EXTRA_BYTES) } }, /extra tối đa/],
    [{ name: 123, phone: '0912345678' }, /name/], [{ name: 'A'.repeat(101), phone: '0912345678' }, /name/],
  ])('từ chối %j', (body, re) => {
    const r = parseInboundPayload(body);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join(';')).toMatch(re);
  });

  it('body không phải object → lỗi; thông điệp lỗi KHÔNG chép lại SĐT', () => {
    expect(parseInboundPayload(null).ok).toBe(false);
    expect(parseInboundPayload([1]).ok).toBe(false);
    expect(parseInboundPayload('x').ok).toBe(false);
    const r = parseInboundPayload({ name: 'A', phone: '0912345678999' });
    expect(!r.ok && JSON.stringify(r.errors)).not.toContain('0912345678999');
  });
});

describe('token nguồn', () => {
  it('whk_ + 43 ký tự, ngẫu nhiên, hash SHA-256 hex, prefix 12 ký tự', () => {
    const a = generateInboundToken();
    const b = generateInboundToken();
    expect(a).toMatch(INBOUND_TOKEN_RE);
    expect(a).not.toBe(b);
    expect(hashInboundToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInboundToken(a)).not.toBe(hashInboundToken(b));
    expect(inboundTokenPrefix(a)).toBe(a.slice(0, 12));
    expect(INBOUND_TOKEN_RE.test('whk_short')).toBe(false);
    expect(INBOUND_TOKEN_RE.test(`${a}x`)).toBe(false);
    expect(INBOUND_TOKEN_RE.test(a.replace('whk_', 'xxx_'))).toBe(false);
  });
});

describe('FixedWindowLimiter', () => {
  it('cho tới max, chặn vượt, reset khi hết cửa sổ, khoá độc lập, tự dọn bucket', () => {
    const l = new FixedWindowLimiter(3, 1000);
    const t = 1_000_000;
    expect([1, 2, 3].map(() => l.hit('a', t).allowed)).toEqual([true, true, true]);
    const blocked = l.hit('a', t + 10);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
    expect(l.hit('b', t + 10).allowed).toBe(true);
    expect(l.hit('a', t + 1500).allowed).toBe(true); // cửa sổ mới
    l.hit('c', t + 5000); // quét: 'a' (hết hạn t+2500) và 'b' (hết hạn t+1010) bị dọn
    const keys = [...(l as unknown as { buckets: Map<string, unknown> }).buckets.keys()];
    expect(keys).toEqual(['c']);
  });
});
