import { normalizePhone, phoneVariants } from './phone.helper';

describe('normalizePhone', () => {
  it.each([
    ['0912345678', '0912345678'],
    ['+84 912 345 678', '0912345678'],
    ['84912345678', '0912345678'],
    ['912345678', '0912345678'], // Sheet làm rụng số 0
    ['0912.345.678', '0912345678'],
  ])('%s → %s', (raw, out) => expect(normalizePhone(raw)).toBe(out));
  it.each(['', 'abc', '12345', '091234567890123'])('từ chối %s', (raw) => expect(normalizePhone(raw)).toBeNull());
});

describe('phoneVariants', () => {
  it('SĐT nội địa → 0…, 84…, +84…', () =>
    expect(phoneVariants('0912345678')).toEqual(['0912345678', '84912345678', '+84912345678']));
  it('không phải dạng nội địa → giữ nguyên', () => expect(phoneVariants('12345')).toEqual(['12345']));
});
