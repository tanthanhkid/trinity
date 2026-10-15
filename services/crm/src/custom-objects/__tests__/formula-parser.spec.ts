import {
  FormulaError, checkFormula, collectRefs, evaluateFormula, parseFormula, type RefKind,
} from '../formula/formula-parser';

const kinds: Record<string, RefKind> = { gia_goc: 'num', uu_dai: 'num', so_buoi: 'num', bat_dau: 'date', ket_thuc: 'date' };
const refKind = (k: string) => kinds[k];
const run = (expr: string, vals: Record<string, number | string | null>) => {
  const ast = parseFormula(expr);
  checkFormula(ast, refKind);
  return evaluateFormula(ast, (k) => vals[k]);
};

describe('formula-parser', () => {
  it('số học + thứ tự ưu tiên + ngoặc + dấu trừ đơn ngôi', () => {
    expect(run('1+2*3', {})).toBe(7);
    expect(run('(1+2)*3', {})).toBe(9);
    expect(run('-2*-3', {})).toBe(6);
    expect(run('10/4', {})).toBe(2.5);
    expect(run('2 - 3 - 4', {})).toBe(-5);
  });

  it('thanh toán = gia_goc*(1-uu_dai) với percent đã quy phân số', () => {
    expect(run('{gia_goc}*(1-{uu_dai})', { gia_goc: 9_600_000, uu_dai: 0.05 })).toBe(9_120_000);
    expect(run('round({gia_goc}*(1-{uu_dai})/{so_buoi}, 0)', { gia_goc: 9_600_000, uu_dai: 0.05, so_buoi: 24 })).toBe(380_000);
  });

  it('months_between / days_between', () => {
    expect(run('months_between({bat_dau},{ket_thuc})', { bat_dau: '2025-01-01', ket_thuc: '2025-04-01' })).toBe(3);
    expect(run('round(months_between({bat_dau},{ket_thuc}), 1)', { bat_dau: '2025-01-01', ket_thuc: '2025-02-16' })).toBe(1.5);
    expect(run('days_between({bat_dau},{ket_thuc})', { bat_dau: '2025-01-01', ket_thuc: '2025-01-31' })).toBe(30);
    expect(run('days_between({bat_dau},{ket_thuc})', { bat_dau: '2025-01-31', ket_thuc: '2025-01-01' })).toBe(-30);
  });

  it('datetime tính theo lịch Việt Nam (UTC+7)', () => {
    // 2025-01-01T18:00Z = 02/01 01:00 giờ VN
    expect(run('days_between({bat_dau},{ket_thuc})', { bat_dau: '2025-01-01T18:00:00.000Z', ket_thuc: '2025-01-03' })).toBe(1);
  });

  it('thiếu dữ liệu / chia 0 → null, không ném', () => {
    expect(run('{gia_goc}*2', { gia_goc: null })).toBeNull();
    expect(run('{gia_goc}*2', {})).toBeNull();
    expect(run('1/0', {})).toBeNull();
    expect(run('months_between({bat_dau},{ket_thuc})', { bat_dau: '2025-01-01', ket_thuc: null })).toBeNull();
    expect(run('months_between({bat_dau},{ket_thuc})', { bat_dau: 'rác', ket_thuc: '2025-01-01' })).toBeNull();
  });

  it('round half away from zero', () => {
    expect(run('round(2.5, 0)', {})).toBe(3);
    expect(run('round(-2.5, 0)', {})).toBe(-3);
    expect(run('round(1.005, 2)', {})).toBe(1.01);
  });

  it('collectRefs', () => {
    expect([...collectRefs(parseFormula('{a}+{b}*{a}+round({c},2)'))].sort()).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['process.exit(1)'],
    ['constructor'],
    ['__proto__'],
    ['{gia_goc}.toString()'],
    ['1; 2'],
    ['1 + '],
    ['(1+2'],
    ['1+2)'],
    ['"x"'],
    ["'x'"],
    ['`x`'],
    ['{a b}'],
    ['{A}'],
    ['{}'],
    ['{constructor.prototype}'],
    ['sin(1)'],
    ['round(1)'],
    ['round(1,2,3)'],
    ['1 ? 2 : 3'],
    ['1 == 1'],
    ['2 ** 3'],
    ['1e3'],
    ['0x10'],
    ['ROUND(1,2)'],
    [''],
    ['  '],
    ['1.'],
    ['()'],
    ['x'],
  ])('từ chối cú pháp lạ/injection: %s', (expr) => {
    expect(() => parseFormula(expr)).toThrow(FormulaError);
  });

  it('chặn công thức quá dài / quá sâu / quá nhiều nút', () => {
    expect(() => parseFormula('1+'.repeat(200) + '1')).toThrow(FormulaError);
    expect(() => parseFormula('('.repeat(40) + '1' + ')'.repeat(40))).toThrow(FormulaError);
    expect(() => parseFormula(Array.from({ length: 70 }, () => '1').join('+'))).toThrow(FormulaError);
    expect(() => parseFormula('-'.repeat(60) + '1')).toThrow(FormulaError);
  });

  it('thẩm định kiểu', () => {
    const bad = (expr: string) => () => checkFormula(parseFormula(expr), refKind);
    expect(bad('{khong_co}+1')).toThrow(/không tồn tại/);
    expect(bad('{bat_dau}+1')).toThrow(FormulaError);
    expect(bad('{bat_dau}')).toThrow(/phải là số/);
    expect(bad('-{bat_dau}')).toThrow(FormulaError);
    expect(bad('months_between({gia_goc},{ket_thuc})')).toThrow(FormulaError);
    expect(bad('months_between({bat_dau}, 5)')).toThrow(FormulaError);
    expect(bad('round({gia_goc}, {uu_dai})')).toThrow(/n phải là số nguyên/);
    expect(bad('round({gia_goc}, 9)')).toThrow(FormulaError);
    expect(bad('round({gia_goc}, 1.5)')).toThrow(FormulaError);
    expect(bad('round({bat_dau}, 1)')).toThrow(FormulaError);
    expect(bad('1+1')).not.toThrow();
  });

  it('kết quả vượt ngưỡng an toàn → null', () => {
    expect(run('999999999999*999999999999', {})).toBeNull();
  });
});
