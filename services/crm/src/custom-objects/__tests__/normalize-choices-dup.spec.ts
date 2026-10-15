import { normalizeChoices } from '../field-values';

describe('normalizeChoices — trùng mã', () => {
  it('hai lựa chọn cùng value dài 64 ký tự không treo và ra mã khác nhau', () => {
    const value = 'a'.repeat(64);
    const out = normalizeChoices([
      { label: 'A', value },
      { label: 'B', value },
      { label: 'C', value },
    ]);
    const values = out.map((c) => c.value);
    expect(new Set(values).size).toBe(3);
    expect(values.every((v) => v.length <= 64)).toBe(true);
  });
  it('mã ngắn trùng vẫn được thêm hậu tố', () => {
    const out = normalizeChoices([{ label: 'A', value: 'x' }, { label: 'B', value: 'x' }]);
    expect(out.map((c) => c.value)).toEqual(['x', 'x_2']);
  });
});
