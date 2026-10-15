import { normalizeChoices, normalizeOptions, normalizeValue, normalizeVnPhone, slugifyKey, ValueError } from '../field-values';
import type { FieldDef } from '../field-types';

const f = (type: FieldDef['type'], options: FieldDef['options'] = {}): Pick<FieldDef, 'label' | 'type' | 'options'> => ({ label: 'F', type, options });
const choices = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];

describe('normalizeValue', () => {
  it('rỗng → null (xoá giá trị)', () => {
    for (const v of [undefined, null, '', '   ', []]) expect(normalizeValue(f('text'), v)).toBeNull();
  });

  it('text: cắt khoảng trắng, giới hạn độ dài, cấm ký tự điều khiển', () => {
    expect(normalizeValue(f('text'), '  Lan ')).toBe('Lan');
    expect(() => normalizeValue(f('text'), 'x'.repeat(501))).toThrow(ValueError);
    expect(() => normalizeValue(f('text'), 'a\u0000b')).toThrow(ValueError);
    expect(() => normalizeValue(f('text'), 5)).toThrow(ValueError);
    expect(normalizeValue(f('long_text'), 'x'.repeat(10_000))).toHaveLength(10_000);
  });

  it('number / currency / percent', () => {
    expect(normalizeValue(f('number'), '12.5')).toBe(12.5);
    expect(() => normalizeValue(f('number'), 'abc')).toThrow(ValueError);
    expect(() => normalizeValue(f('number'), Infinity)).toThrow(ValueError);
    expect(() => normalizeValue(f('number'), 1e16)).toThrow(ValueError);
    expect(normalizeValue(f('currency'), 3_200_000)).toBe(3_200_000);
    expect(() => normalizeValue(f('currency'), 1.5)).toThrow(/số nguyên/);
    expect(() => normalizeValue(f('currency'), -1)).toThrow(/không được âm/);
    expect(normalizeValue(f('currency'), 0)).toBe(0);
    expect(() => normalizeValue(f('currency'), 1e14)).toThrow(ValueError);
    expect(normalizeValue(f('percent'), 5)).toBe(5);
    expect(() => normalizeValue(f('percent'), 1001)).toThrow(ValueError);
  });

  it('date / datetime', () => {
    expect(normalizeValue(f('date'), '2025-02-28')).toBe('2025-02-28');
    for (const bad of ['2025-02-30', '2025-13-01', '28/02/2025', '2025-2-3', 'hôm nay']) expect(() => normalizeValue(f('date'), bad)).toThrow(ValueError);
    expect(normalizeValue(f('datetime'), '2025-02-28T10:00:00+07:00')).toBe('2025-02-28T03:00:00.000Z');
    expect(() => normalizeValue(f('datetime'), 'xx')).toThrow(ValueError);
    expect(() => normalizeValue(f('datetime'), '1500-01-01T00:00:00Z')).toThrow(ValueError);
  });

  it('boolean', () => {
    expect(normalizeValue(f('boolean'), true)).toBe(true);
    expect(normalizeValue(f('boolean'), 'false')).toBe(false);
    expect(() => normalizeValue(f('boolean'), 'yes')).toThrow(ValueError);
  });

  it('select / multi_select phải thuộc danh sách', () => {
    expect(normalizeValue(f('select', { choices }), 'a')).toBe('a');
    expect(() => normalizeValue(f('select', { choices }), 'z')).toThrow(ValueError);
    expect(normalizeValue(f('multi_select', { choices }), ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(() => normalizeValue(f('multi_select', { choices }), ['a', 'z'])).toThrow(ValueError);
    expect(() => normalizeValue(f('multi_select', { choices }), 'a')).toThrow(ValueError);
  });

  it('email / phone / url', () => {
    expect(normalizeValue(f('email'), ' A@X.VN ')).toBe('a@x.vn');
    for (const bad of ['a', 'a@b', '@x.vn', 'a b@x.vn']) expect(() => normalizeValue(f('email'), bad)).toThrow(ValueError);
    expect(normalizeValue(f('phone'), '0912 345 678')).toBe('0912345678');
    expect(normalizeValue(f('phone'), '+84912345678')).toBe('0912345678');
    expect(normalizeValue(f('phone'), '(091) 234-5678')).toBe('0912345678');
    for (const bad of ['123', '091234567', '09123456789', 'abc']) expect(() => normalizeValue(f('phone'), bad)).toThrow(ValueError);
    expect(normalizeValue(f('url'), 'https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.vn', 'khong phai url', 'vbscript:x']) expect(() => normalizeValue(f('url'), bad)).toThrow(ValueError);
  });

  it('relation / user: chỉ mã nguyên dương', () => {
    expect(normalizeValue(f('relation', { target_object_id: 1 }), 7)).toBe(7);
    expect(normalizeValue(f('relation', { target_object_id: 1 }), '7')).toBe(7);
    expect(normalizeValue(f('relation', { target_object_id: 1, multiple: true }), [3, 3, 4])).toEqual([3, 4]);
    for (const bad of [0, -1, 1.5, 'x', {}, [1, 'a']]) expect(() => normalizeValue(f('relation', { target_object_id: 1, multiple: true }), bad)).toThrow(ValueError);
    expect(() => normalizeValue(f('relation', { target_object_id: 1, multiple: true }), Array.from({ length: 51 }, (_, i) => i + 1))).toThrow(ValueError);
    expect(normalizeValue(f('user'), 5)).toBe(5);
    expect(() => normalizeValue(f('user'), '5; DROP')).toThrow(ValueError);
  });

  it('formula không nhập được', () => {
    expect(() => normalizeValue(f('formula', { expression: '1' }), 5)).toThrow(/công thức/);
  });
});

describe('normalizeVnPhone', () => {
  it('chuẩn hoá về 0xxxxxxxxx', () => {
    expect(normalizeVnPhone('+84 912 345 678')).toBe('0912345678');
    expect(normalizeVnPhone('84912345678')).toBe('0912345678');
    expect(normalizeVnPhone('912345678')).toBeNull();
  });
});

describe('normalizeChoices / normalizeOptions / slugifyKey', () => {
  it('sinh mã từ nhãn tiếng Việt, tránh trùng', () => {
    expect(normalizeChoices([{ label: 'Đang học' }, { label: 'Dang hoc' }, { label: 'Nữ', color: 'red' }, { label: 'X', color: 'evil' }]))
      .toEqual([{ value: 'dang_hoc', label: 'Đang học' }, { value: 'dang_hoc_2', label: 'Dang hoc' }, { value: 'nu', label: 'Nữ', color: 'red' }, { value: 'x', label: 'X' }]);
    expect(() => normalizeChoices([])).toThrow(ValueError);
    expect(() => normalizeChoices([{ label: '' }])).toThrow(ValueError);
    expect(() => normalizeChoices(Array.from({ length: 101 }, (_, i) => ({ label: `c${i}` })))).toThrow(ValueError);
  });

  it('options theo kiểu; bỏ khoá lạ', () => {
    expect(normalizeOptions('text', { hack: 1 })).toEqual({});
    expect(normalizeOptions('relation', { target_object_id: 3, multiple: true, hack: 1 })).toEqual({ target_object_id: 3, multiple: true });
    expect(normalizeOptions('relation', { target: 'contact' })).toEqual({ target: 'contact', multiple: false });
    expect(() => normalizeOptions('relation', {})).toThrow(ValueError);
    expect(() => normalizeOptions('relation', { target_object_id: '3' })).toThrow(ValueError);
    expect(normalizeOptions('formula', { expression: ' 1+1 ', format: 'currency', decimals: 2 })).toEqual({ expression: '1+1', format: 'currency', decimals: 2 });
    expect(normalizeOptions('formula', { expression: '1', format: 'evil', decimals: 99 })).toEqual({ expression: '1', format: 'number' });
    expect(() => normalizeOptions('formula', {})).toThrow(ValueError);
  });

  it('slugifyKey', () => {
    expect(slugifyKey('Họ và tên học sinh')).toBe('ho_va_ten_hoc_sinh');
    expect(slugifyKey('Đơn giá / buổi')).toBe('don_gia_buoi');
    expect(slugifyKey('2025 năm')).toBe('f_2025_nam');
    expect(slugifyKey('x'.repeat(100))).toHaveLength(48);
  });
});
