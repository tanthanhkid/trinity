/**
 * Bảng ca dùng chung TS ↔ Rust của bộ công thức bảng tuỳ biến (M57): `server/contracts/cases/formula.json`.
 * Phía TS là chuẩn: spec này tính lại mọi ca bằng `formula-parser.ts` rồi so với cột kết quả trong bảng; Rust chạy cùng
 * bảng ở `server/crates/trinity-kernel/tests/formula_cases.rs`. Sinh lại cột kết quả sau khi thêm ca:
 * `UPDATE_FORMULA_CASES=1 npx jest formula-cases` (trong services/crm).
 */
import * as fs from 'fs';
import * as path from 'path';
import { FormulaError, checkFormula, collectRefs, evaluateFormula, parseFormula, type RefKind } from '../formula/formula-parser';

const FILE = path.resolve(__dirname, '../../../../../server/contracts/cases/formula.json');

const KINDS: Record<string, RefKind> = {
  gia_goc: 'num', uu_dai: 'num', so_buoi: 'num', don_gia: 'num', so_luong: 'num',
  bat_dau: 'date', ket_thuc: 'date', ngay_sinh: 'date',
}
const refKind = (k: string): RefKind | undefined => (Object.hasOwn(KINDS, k) ? KINDS[k] : undefined)

type Vals = Record<string, number | string | null>
type Table = {
  formula: { expr: string; vals: Vals; out?: unknown }[]
  js_round: { in: number | string; out?: unknown }[]
  collect_refs: { expr: string; out?: unknown }[]
  [k: string]: unknown
}

/** JSON không có NaN/±Infinity/-0: các giá trị này ghi dạng chuỗi. */
const enc = (n: number): number | string => {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  return Object.is(n, -0) ? '-0' : n
}
/** JSON ghi -0 thành 0; Rust so bằng `==` nên hai bên coi như nhau. */
const noNegZero = (v: number | null): number | null => (v === 0 ? 0 : v)
const dec = (v: number | string): number => (typeof v === 'string' ? (v === '-0' ? -0 : Number(v)) : v)

function compute(t: Table): Table {
  return {
    ...t,
    formula: t.formula.map((r) => {
      try {
        const ast = parseFormula(r.expr)
        checkFormula(ast, refKind)
        return { expr: r.expr, vals: r.vals, out: { value: noNegZero(evaluateFormula(ast, (k) => r.vals[k])) } }
      } catch (e) {
        if (!(e instanceof FormulaError)) throw e
        return { expr: r.expr, vals: r.vals, out: { error: e.message } }
      }
    }),
    js_round: t.js_round.map((r) => ({ in: r.in, out: enc(Math.round(dec(r.in))) })),
    collect_refs: t.collect_refs.map((r) => ({ expr: r.expr, out: [...collectRefs(parseFormula(r.expr))].sort() })),
  }
}

describe('bảng ca dùng chung công thức (TS ↔ Rust)', () => {
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table
  const fresh = compute(table)
  if (process.env.UPDATE_FORMULA_CASES === '1') fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`)

  it('đủ ≥ 300 ca công thức', () => {
    expect(table.formula.length).toBeGreaterThanOrEqual(300)
  })

  it.each(['formula', 'js_round', 'collect_refs'] as const)('nhóm %s khớp bảng', (key) => {
    expect(fresh[key]).toEqual(table[key])
  })
})
