import { columnLetter, parseSpreadsheetId, a1Tab } from '../google-sheets-api';
import { contactPatch } from '../sheet-import-contacts';
import { dedupeValue, dropDuplicateRows, mapRows, normalizeEmail, normalizePhone } from '../sheet-mapping';
import { validateColumnMap, validateDedupe } from '../sync-validation';

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

describe('normalizeEmail', () => {
  it('chữ thường + kiểm định dạng', () => {
    expect(normalizeEmail(' A@B.com ')).toBe('a@b.com');
    expect(normalizeEmail('khong-phai-email')).toBeNull();
  });
});

describe('mapRows', () => {
  const values = [['SĐT', 'Họ tên', 'Ghi chú'], ['0912345678', 'An', 'x'], ['', '', 'chỉ ghi chú'], ['0987654321', 'Bình']];
  it('ánh xạ theo tên cột (không phân biệt hoa/thường), bỏ dòng trống ở cột đã ánh xạ, giữ số dòng thật', () => {
    const r = mapRows(values, { phone: 'sđt', full_name: 'Họ tên' });
    expect(r.missingColumns).toEqual([]);
    expect(r.rows).toEqual([
      { row: 2, fields: { phone: '0912345678', full_name: 'An' } },
      { row: 4, fields: { phone: '0987654321', full_name: 'Bình' } },
    ]);
  });
  it('báo cột ánh xạ không còn trong Sheet', () => {
    expect(mapRows(values, { phone: 'SĐT', email: 'Email' }).missingColumns).toEqual(['Email']);
  });
});

describe('khử trùng', () => {
  it('trùng SĐT sau chuẩn hoá bị gộp (giữ dòng đầu); dòng không có khoá = invalid', () => {
    const rows = [
      { row: 2, fields: { phone: '0912345678' } },
      { row: 3, fields: { phone: '+84912345678' } },
      { row: 4, fields: { phone: 'abc' } },
      { row: 5, fields: { phone: '0987654321' } },
    ];
    const r = dropDuplicateRows(rows, 'phone');
    expect(r.kept.map((x) => x.row)).toEqual([2, 5]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid.map((x) => x.row)).toEqual([4]);
  });
  it('khoá tuỳ biến so không phân biệt hoa/thường', () => {
    expect(dedupeValue('ma_hs', { ma_hs: ' HS01 ' })).toBe('hs01');
    expect(dedupeValue('ma_hs', { ma_hs: '' })).toBeNull();
  });
});

describe('contactPatch — ô trống không xoá dữ liệu CRM', () => {
  it('chỉ giữ trường có giá trị hợp lệ', () => {
    expect(contactPatch({ phone: '912345678', full_name: ' ', email: 'X@Y.vn', phone_2: 'bậy', job_title: 'Kế toán' })).toEqual({
      phone: '0912345678', email: 'x@y.vn', job_title: 'Kế toán',
    });
  });
});

describe('validateColumnMap / validateDedupe', () => {
  it('từ chối trường lạ, cột trùng, map rỗng', () => {
    expect(() => validateColumnMap({ hack: 'A' }, ['phone'])).toThrow(/không được ánh xạ/);
    expect(() => validateColumnMap({ phone: 'A', email: 'a' }, ['phone', 'email'])).toThrow(/hai trường/);
    expect(() => validateColumnMap({}, ['phone'])).toThrow(/ít nhất một cột/);
    expect(validateColumnMap({ phone: ' SĐT ', email: '' }, ['phone', 'email'])).toEqual({ phone: 'SĐT' });
  });
  it('khách: khoá chỉ phone/email và phải được ánh xạ; xuất không cần khoá', () => {
    expect(validateDedupe('contact', undefined, { phone: 'SĐT' }, 'import')).toBe('phone');
    expect(() => validateDedupe('contact', 'email', { phone: 'SĐT' }, 'import')).toThrow();
    expect(() => validateDedupe('contact', 'full_name', { phone: 'SĐT' }, 'import')).toThrow();
    expect(() => validateDedupe('contact', 'email', { email: 'E' }, 'import')).toThrow(/Số điện thoại/);
    expect(validateDedupe('contact', undefined, { phone: 'SĐT' }, 'export')).toBe('id');
  });
});

describe('google-sheets-api helpers', () => {
  it('parseSpreadsheetId: URL, ID trần, rác', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(parseSpreadsheetId(id)).toBe(id);
    expect(parseSpreadsheetId('https://example.com')).toBeNull();
  });
  it('columnLetter + a1Tab', () => {
    expect([1, 26, 27, 52].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ']);
    expect(a1Tab("Khách 'VIP'")).toBe("'Khách ''VIP'''");
  });
});
