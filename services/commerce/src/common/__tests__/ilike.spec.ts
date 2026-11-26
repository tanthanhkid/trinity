import { escapeIlike } from '../ilike';

describe('escapeIlike', () => {
  it('thoát ký tự đại diện của ILIKE', () => {
    expect(escapeIlike('SP_1')).toBe('SP\\_1');
    expect(escapeIlike('a%b\\c')).toBe('a\\%b\\\\c');
    expect(escapeIlike('SP-500')).toBe('SP-500');
  });
});
