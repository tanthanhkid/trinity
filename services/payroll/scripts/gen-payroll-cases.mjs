#!/usr/bin/env node
/**
 * Sinh bảng ca dùng chung TS ↔ Rust của bộ tính lương và thuế (M30a): `server/contracts/cases/payroll.json`.
 * Kết quả là của MÃ TS THẬT: script cắt nguyên văn các engine (`insurance`, `tax`, `salary-components`), các hàm
 * `prorateBase`/`buildPayslipData`/`calculateKpiBonus` của `payslips.service.ts` và `formula-evaluator.ts`, bỏ kiểu và
 * decorator rồi chạy với một Prisma giả (kiểm câu `where`/`orderBy` đúng như mã TS gọi). Không cần cài node_modules.
 * Chạy lại: `node services/payroll/scripts/gen-payroll-cases.mjs` (Node ≥ 22.13). Bộ ca cố định theo hạt giống nên chạy lại
 * ra đúng cùng tệp; Rust chạy cùng bảng ở `server/crates/mod-payroll/tests/payroll_cases.rs`.
 */
import fs from 'node:fs'
import module from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (p) => fs.readFileSync(path.resolve(here, '../src', p), 'utf8')
const OUT = path.resolve(here, '../../../server/contracts/cases/payroll.json')

// ---------------------------------------------------------------- nạp mã TS thật

const compile = (ts) => module.stripTypeScriptTypes(ts, { mode: 'transform' })
const stripNest = (ts) => ts.replace(/^import [^;]*?from [^\n]*\n/gms, '').replace(/^\s*@Injectable\(\)\s*$/gm, '')
const load = async (js) => import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

/** Cắt nguyên văn một method của class theo tên (khớp ngoặc nhọn). */
function method(ts, name) {
  const m = new RegExp(`^  (?:private |public )?(?:async )?${name}\\(`, 'm').exec(ts)
  assert(m, `không thấy method ${name}`)
  // `{` mở thân: dấu `{` đầu tiên sau danh sách tham số (tham số không chứa `{`).
  const paramsEnd = Math.min(...[') {', '): '].map((t) => ts.indexOf(t, m.index)).filter((x) => x >= 0))
  const i = ts.indexOf('{', paramsEnd + 1)
  let depth = 0
  let j = i
  for (; j < ts.length; j++) {
    if (ts[j] === '{') depth++
    else if (ts[j] === '}' && --depth === 0) break
  }
  return ts.slice(m.index, j + 1)
}

const insTs = src('insurance/insurance.engine.ts')
const taxTs = src('tax/tax.engine.ts')
const cmpTs = src('salary-components/salary-components-engine.service.ts')
const slipTs = src('payslips/payslips.service.ts')
const frmTs = src('salary-rules/formula-evaluator.ts')

const { InsuranceEngine } = await load(compile(stripNest(insTs)))
const { TaxEngine } = await load(compile(stripNest(taxTs)))
const { SalaryComponentsEngine } = await load(compile(stripNest(cmpTs)))
const { validateFormula, evaluateFormula } = await load(compile(frmTs))
const slipMethods = ['prorateBase', 'calculateKpiBonus', 'buildPayslipData'].map((n) => method(slipTs, n)).join('\n')
const { Slip } = await load(
  compile(`export class Slip { constructor(insuranceEngine, taxEngine) { this.insuranceEngine = insuranceEngine; this.taxEngine = taxEngine; this.logger = { warn() {} } }\n${slipMethods}\n}`),
)

// ---------------------------------------------------------------- Prisma giả (kiểm câu truy vấn đúng như mã TS gọi)

const asc = (f) => (a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0)
const desc = (f) => (a, b) => asc(f)(b, a)

/** Câu `where` hiệu lực theo tháng mà cả 4 engine dùng; lệch dạng này là test hỏng ngay. */
function activeWhere(where, month) {
  assert.deepEqual(where, {
    is_active: true,
    effective_from: { lte: month },
    OR: [{ effective_to: null }, { effective_to: { gte: month } }],
  })
  return (r) => r.is_active && r.effective_from <= month && (r.effective_to === null || r.effective_to >= month)
}

function table(rows, month, orderExpect) {
  const run = ({ where, orderBy }) => {
    assert.deepEqual(orderBy, orderExpect)
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy]
    const cmp = keys.map((o) => {
      const [f, d] = Object.entries(o)[0]
      return d === 'desc' ? desc(f) : asc(f)
    })
    return rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => activeWhere(where, month)(r))
      .sort((a, b) => {
        for (const c of cmp) {
          const v = c(a.r, b.r)
          if (v) return v
        }
        return a.i - b.i // ổn định theo thứ tự đầu vào (Prisma không bảo đảm; Rust sắp theo `id`)
      })
      .map(({ r }) => r)
  }
  return { findMany: async (a) => run(a), findFirst: async (a) => run(a)[0] ?? null }
}

const dec = (s) => ({ toString: () => s })
const toRow = (r) => ({ ...r, ...('employee_rate' in r ? { employee_rate: dec(r.employee_rate) } : {}), ...('rate' in r ? { rate: dec(r.rate) } : {}), ...('percent_value' in r ? { percent_value: r.percent_value === null ? null : dec(r.percent_value) } : {}) })
const big = (r, keys) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, r[k] === null || r[k] === undefined ? r[k] : BigInt(r[k])])) })

const insRows = (c) => c.insurance.map((r) => big(toRow(r), ['base_cap']))
const taxSettings = (c) => c.tax_settings.map((r) => big(r, ['personal_deduction', 'dependent_deduction']))
const taxBrackets = (c) => c.brackets.map((r) => big(toRow(r), ['lower_bound', 'upper_bound']))
const cmpRows = (c) => c.components.map((r) => big(toRow(r), ['fixed_amount']))

const prismaFor = (c, month) => ({
  insuranceSetting: table(insRows(c), month, { sort_order: 'asc' }),
  payrollTaxSetting: table(taxSettings(c), month, { effective_from: 'desc' }),
  taxBracket: table(taxBrackets(c), month, [{ effective_from: 'desc' }, { bracket_order: 'asc' }]),
  salaryComponent: table(cmpRows(c), month, { sort_order: 'asc' }),
})

// ---------------------------------------------------------------- hạt giống và dữ liệu

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const R = rng(20261127)
const int = (a, b) => a + Math.floor(R() * (b - a + 1))
const pick = (xs) => xs[int(0, xs.length - 1)]

const VN_BRACKETS = [
  [0, 5_000_000, '5'], [5_000_000, 10_000_000, '10'], [10_000_000, 18_000_000, '15'], [18_000_000, 32_000_000, '20'],
  [32_000_000, 52_000_000, '25'], [52_000_000, 80_000_000, '30'], [80_000_000, null, '35'],
]
const bracketSet = (from, rates = null, active = true, to = null) =>
  VN_BRACKETS.map(([lo, up, rate], i) => ({ bracket_order: i + 1, lower_bound: lo, upper_bound: up, rate: rates?.[i] ?? rate, effective_from: from, effective_to: to, is_active: active }))
const taxSetting = (from, p = 11_000_000, d = 4_400_000, active = true, to = null) => ({ personal_deduction: p, dependent_deduction: d, effective_from: from, effective_to: to, is_active: active })
const ins = (code, rate, cap, from = '2024-01', to = null, active = true, sort = 0) => ({ code, name: `Bảo hiểm ${code}`, employee_rate: rate, base_cap: cap, effective_from: from, effective_to: to, is_active: active, sort_order: sort })
const comp = (code, type, calc, fixed, pct, applies = 'all', taxable = true, sort = 0, from = '2024-01', to = null, active = true) => ({
  code, name: `TP ${code}`, component_type: type, calc_method: calc, fixed_amount: fixed, percent_value: pct, applies_to: applies, is_taxable: taxable, effective_from: from, effective_to: to, is_active: active, sort_order: sort,
})

const STD_INS = [ins('bhxh', '8', 46_800_000, '2024-01', null, true, 1), ins('bhyt', '1.5', 46_800_000, '2024-01', null, true, 2), ins('bhtn', '1', 99_200_000, '2024-01', null, true, 3)]
const STD_CFG = {
  insurance: STD_INS,
  tax_settings: [taxSetting('2020-07', 11_000_000, 4_400_000), taxSetting('2026-01', 15_500_000, 6_200_000)],
  brackets: [...bracketSet('2020-07'), ...bracketSet('2026-01', ['4', '9', '14', '19', '24', '29', '34'])],
  components: [
    comp('phone', 'allowance', 'fixed', 500_000, null, 'all', true, 1),
    comp('lunch', 'allowance', 'fixed', 730_000, null, 'all', false, 2),
    comp('kpi_pct', 'bonus', 'percent_base', null, '10.5', 'rank:A1', true, 3),
    comp('sen', 'bonus', 'percent_base', null, '2.25', 'all', false, 4),
    comp('union', 'deduction', 'fixed', 100_000, null, 'all', true, 5),
    comp('late', 'deduction', 'percent_base', null, '0.5', 'rank:B2', true, 6),
    comp('zero', 'allowance', 'fixed', 0, null, 'all', true, 7),
    comp('neg_pct', 'bonus', 'percent_base', null, '0', 'all', true, 8),
    comp('off', 'allowance', 'fixed', 999_000, null, 'all', true, 9, '2024-01', null, false),
    comp('old', 'allowance', 'fixed', 111_000, null, 'all', true, 10, '2020-01', '2025-12'),
    comp('future', 'allowance', 'fixed', 222_000, null, 'all', true, 11, '2027-01'),
  ],
}

// ---------------------------------------------------------------- tính bằng mã TS thật

/** Cấu hình giống bộ chuẩn thì ghi "std" (bộ chuẩn nằm ở khoá `std` của bảng) để tệp gọn. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const P = (v, key) => (same(v, STD_CFG[key]) ? 'std' : v)

const J = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? Number(v) : v)))
const MONTHS = ['2019-12', '2020-07', '2024-06', '2025-12', '2026-01', '2026-06', '2027-03']

async function insCase(month, base, cfg) {
  const r = await new InsuranceEngine(prismaFor(cfg, month)).compute(BigInt(base), month)
  return { month, insurance_base: base, insurance: P(cfg.insurance, 'insurance'), out: J({ total: r.total, snapshot: r.snapshot }) }
}
async function taxCase(month, gross, insurance, deps, cfg) {
  const r = await new TaxEngine(prismaFor(cfg, month)).compute(BigInt(gross), BigInt(insurance), deps, month)
  return { month, taxable_gross: gross, insurance, dependents_count: deps, tax_settings: P(cfg.tax_settings, 'tax_settings'), brackets: P(cfg.brackets, 'brackets'), out: J({ tax: r.tax, snapshot: r.snapshot }) }
}
async function cmpCase(month, base, rank, cfg) {
  const r = await new SalaryComponentsEngine(prismaFor(cfg, month)).computeForEmployee(BigInt(base), month, rank)
  return { month, base_salary: base, rank_code: rank, components: P(cfg.components, 'components'), out: J(r) }
}
async function slipCase(c) {
  const prisma = prismaFor(c.config, c.month)
  const ie = new InsuranceEngine(prisma)
  const te = new TaxEngine(prisma)
  const slip = new Slip(ie, te)
  const config = await new SalaryComponentsEngine(prisma).computeForEmployee(BigInt(c.engine_base), c.month, c.emp.rank_code)
  const kpi_bonus = slip.calculateKpiBonus(Array.from({ length: c.kpi_achieved }, () => ({ achieved: true, achievement_rate: null })).concat(Array.from({ length: c.kpi_missed }, () => ({ achieved: false, achievement_rate: null }))))
  const m = c.manual
  const manual = { ...m, base_salary: BigInt(m.base_salary), training_salary: BigInt(m.training_salary), probation_allowance: BigInt(m.probation_allowance), bonus_sales_personal: BigInt(m.bonus_sales_personal), bonus_cskh_team: BigInt(m.bonus_cskh_team), bonus_milestone: BigInt(m.bonus_milestone), bonus_referral: BigInt(m.bonus_referral), holiday_bonus: BigInt(m.holiday_bonus), advances: BigInt(m.advances), personal_income_tax: BigInt(m.personal_income_tax) }
  const emp = {
    id: 1, insurance_salary: c.emp.insurance_salary === null ? null : BigInt(c.emp.insurance_salary), dependents_count: c.emp.dependents_count,
    jobTitle: c.emp.default_insurance_salary === undefined ? null : { default_insurance_salary: c.emp.default_insurance_salary === null ? null : BigInt(c.emp.default_insurance_salary) },
  }
  const out = await slip.buildPayslipData(emp, c.month, { base_salary: BigInt(c.engine_base), kpi_bonus, config }, manual)
  return {
    ...c,
    config: Object.fromEntries(Object.keys(c.config).map((k) => [k, P(c.config[k], k)])),
    out: J({
      base_salary: out.base_salary, kpi_bonus: out.kpi_bonus, deductions: out.deductions, total: out.total, insurance_base: out.insurance_base,
      base_salary_actual: out.base_salary_actual, components_json: out.components_json, insurance_json: out.insurance_json, tax_json: out.tax_json,
    }),
  }
}

// ---------------------------------------------------------------- sinh ca

const cases = { std: STD_CFG, insurance: [], tax: [], components: [], payslip: [], formula: [], validate: [], round: [] }

// Giá trị quanh ngưỡng: x,5 đồng cho (base × rate / 100), trần bảo hiểm, ngưỡng bậc thuế.
function halfBase(rate, near) {
  const r = Number(rate)
  for (let d = 0; d < 400; d++) {
    for (const b of [near + d, near - d]) {
      const x = (b * r) / 100
      if (Math.abs(x - Math.floor(x) - 0.5) < 1e-9) return b
    }
  }
  return near
}

for (let i = 0; i < 700; i++) {
  const month = pick(MONTHS)
  const rate = pick(['8', '1.5', '1', '10.5', '12.25', '0', '0.33', '7.5', '3'])
  const cap = pick([null, 46_800_000, 0, 20_000_000, 99_200_000])
  const near = pick([1_000_000, 5_000_000, 20_000_000, 46_800_000, 99_200_000])
  const base = pick([halfBase(rate, near), near, near - 1, near + 1, int(0, 120_000_000), 0, -5])
  const rows = [ins('a', rate, cap, pick(['2024-01', '2025-06', '2026-02']), pick([null, '2025-12', '2026-06']), R() < 0.9, 1), ...STD_INS.map((r, k) => ({ ...r, sort_order: k + 2 }))]
  cases.insurance.push(await insCase(month, base, { ...STD_CFG, insurance: R() < 0.5 ? rows : STD_INS }))
}

for (let i = 0; i < 800; i++) {
  const month = pick(MONTHS)
  const edge = pick([0, 5_000_000, 10_000_000, 18_000_000, 32_000_000, 52_000_000, 80_000_000])
  const deps = int(-1, 5)
  const pers = month >= '2026-01' ? 15_500_000 : 11_000_000
  const depd = month >= '2026-01' ? 6_200_000 : 4_400_000
  const insurance = pick([0, 0, 1_000_000, 4_914_000, 10_000_000])
  const target = edge + pers + insurance + Math.max(0, deps) * depd
  const gross = pick([target, target - 1, target + 1, target + 2, int(0, 200_000_000), 0, target + 1_000_000_000])
  const cfg = R() < 0.15 ? { ...STD_CFG, tax_settings: [], brackets: STD_CFG.brackets } : R() < 0.1 ? { ...STD_CFG, brackets: [] } : R() < 0.1 ? { ...STD_CFG, brackets: [...STD_CFG.brackets.filter((b) => b.bracket_order !== 3 || b.effective_from !== '2026-01')] } : STD_CFG
  cases.tax.push(await taxCase(month, gross, insurance, deps, cfg))
}

for (let i = 0; i < 400; i++) {
  const month = pick(MONTHS)
  const base = pick([0, 1, 7_000_000, 7_000_001, 12_345_678, 9_999_999, halfBase('10.5', 8_000_000), halfBase('2.25', 20_000_000), halfBase('0.5', 15_000_000), int(0, 60_000_000)])
  cases.components.push(await cmpCase(month, base, pick([null, 'A1', 'B2', 'C3', ''] ), STD_CFG))
}

for (let i = 0; i < 100; i++) {
  const base = pick([7_000_000, 12_000_000, 25_000_000, 46_800_000, 60_000_000, 0, int(3_000_000, 90_000_000)])
  const days = pick([null, 0, 10, 12.5, 24, 22.5, 26, 31])
  const std = pick([24, 26, 22, 0, 30])
  const mn = (v) => (R() < 0.5 ? 0 : v)
  cases.payslip.push(
    await slipCase({
      month: pick(MONTHS), config: STD_CFG, engine_base: base,
      kpi_achieved: int(0, 4), kpi_missed: int(0, 3),
      emp: {
        rank_code: pick([null, 'A1', 'B2']),
        insurance_salary: pick([null, null, 0, 3_000_000, 52_000_000]),
        default_insurance_salary: pick([undefined, null, 0, 5_000_000, 8_000_000]),
        dependents_count: int(0, 4),
      },
      manual: {
        working_days: days, standard_working_days: std, base_salary: pick([base, base, base + 1_000_000]),
        training_salary: mn(int(0, 3_000_000)), probation_allowance: mn(int(0, 1_000_000)),
        bonus_sales_personal: mn(int(0, 20_000_000)), bonus_cskh_team: mn(int(0, 5_000_000)), bonus_milestone: mn(pick([500_000, 1_500_000, int(0, 4_000_000)])),
        bonus_referral: mn(int(0, 2_000_000)), holiday_bonus: mn(int(0, 1_000_000)),
        advances: mn(pick([0, 1_000_000, 80_000_000])), personal_income_tax: mn(pick([0, 250_000, 5_000_000])),
      },
    }),
  )
}

// Công thức: ca viết tay + sinh từ văn phạm quanh tập ký tự của validateFormula.
const FORMULAS = [
  '7000000', 'base * achievement_rate / 100', 'revenue * 0.005', 'max(0, (achievement_rate - 100) * base * 0.01)', 'min(base, revenue)',
  'floor(base / 3)', 'ceil(base / 3)', 'abs(-5)', '.5 * base', '5. * base', '-base', 'base / 0', '0 / 0', 'max()', 'min()', 'abs()', 'floor()',
  'base ** 2', '2 ** 3 ** 2', '2 ** -1', '(-2) ** 2', '-2 ** 2', 'base ++ + 1', '++base + base', 'base-- - base', '(base, revenue)', 'max(1, 2,)', 'max(...base)',
  'min.max', 'base.base', 'min(base)(1)', '5(3)', 'base /* base */ + 1', 'base // base\n + 1', 'base // base', 'base /* x */', '1e5', '0x10', '010', '5base', 'foo', '',
  '   ', 'base *', '* base', '(base', 'base)', 'base % 2', 'base > 1', '((base))++', '++(base)', '++1', 'base\n++ + 1', 'max(base, 1/0)', 'min(1/0, 5)', 'max(0, 0/0)',
  '1.5.2', '1..2', '2..toString', 'base - - base', 'base + + base', 'base - -base', '- - 5', 'revenue / achievement_rate', '1000000000000 * 1000000000000', '9007199254740993',
  // Biên JS của evaluator: member trên undefined, ++ trên member, spread chuỗi/regex.
  'base.base', 'base.base.base', 'min.max.base', 'base.base.base.base', '(min + 1).base', '(min + 1).base.base', '(/1/).base', '(/1/).base.base', '(/1/).max.max',
  'min.max++', '++min.max', 'base.base++', '++base.base', 'min.max.max++', '++min.max.max', '(min + 1).base++', '++(min + 1).base', '(/1/).base++', '++(/1/).base', '++(/1/ + 1).base',
  'max(...(min + 1))', 'min(...(min + 1))', 'floor(...(min + 1))', 'ceil(...(min + 1))', 'abs(...(min + 1))', 'abs(...(min + 1), 5)', 'floor(5, ...(min + 1))', 'max(1, ...(min + 1))',
  'floor(...(/1/ + 1))', 'max(...(/1/))', 'floor(...min)', 'floor(...base)', 'floor(...base.base)', 'abs(...(base, min))', 'max(...(min + base))',
  'min + 1', '/1/ + 1', '/1/ * 2', '-/1/', 'min - 1', 'floor(min)', 'floor(/1/)', '(min).base', '(base).min.max', 'min()', 'base()', '(min + 1)()', '/1/()', 'min.max()',
  '1 / 3 * 3', '0.1 + 0.2', 'floor(0.1 + 0.7) * 10', 'ceil(-0.5)', 'floor(-0.5)', '-0', 'abs(-0)', 'max(-0, 0)',
]
const ATOMS = ['base', 'revenue', 'achievement_rate', '0', '1', '2', '3.5', '.5', '100', '1000000', '0.01', 'min', 'max', 'abs', 'floor', 'ceil']
const OPS = ['+', '-', '*', '/', '**', ',', '++', '--', ' ', '(', ')', '.', '//', '/*', '*/', '\n', '..', '...']
function randomFormula() {
  const n = int(1, 9)
  let s = ''
  for (let k = 0; k < n; k++) s += (R() < 0.55 ? pick(ATOMS) : pick(OPS)) + (R() < 0.5 ? ' ' : '')
  return s
}
// Sinh theo văn phạm (phần lớn hợp lệ, thỉnh thoảng chèn chú thích / toán tử một ngôi / lời gọi lạ).
const NUMS = ['0', '1', '2', '3.5', '.5', '100', '1000000', '0.01', '7', '12.25']
const VARS = ['base', 'revenue', 'achievement_rate']
const FUNS = ['min', 'max', 'abs', 'floor', 'ceil']
const SPREADS = ['(min + 1)', '(/1/ + 1)', '(/1/)', 'min', 'base', '(base, min)']
const ws = () => pick(['', ' ', ' ', '  ', ' /* base */ ', '\n', ' // revenue\n '])
function grammar(d) {
  const r = R()
  if (d <= 0 || r < 0.22) return pick(R() < 0.5 ? NUMS : VARS)
  if (r < 0.34) return `(${grammar(d - 1)})`
  if (r < 0.42) return `${pick(['-', '+', '- ', '--', '++'])}${grammar(d - 1)}`
  if (r < 0.5) return `${pick(VARS)}${pick(['++', '--', ' ++', '.base', '.min', '.base.base', '.max++', '.base--'])}`
  if (r < 0.62) return `${pick(FUNS)}(${Array.from({ length: int(0, 3) }, () => (R() < 0.12 ? `...${pick(SPREADS)}` : grammar(d - 1))).join(`,${ws()}`)}${R() < 0.05 ? ',' : ''})`
  if (r < 0.66) return `${pick(['min', 'max', 'floor'])}${pick(['.base', '.max.max', '++', '--'])}`
  if (r < 0.7) return `${grammar(d - 1)}${ws()}**${ws()}${grammar(d - 1)}`
  if (r < 0.74) return `(${grammar(d - 1)}, ${grammar(d - 1)})`
  return `${grammar(d - 1)}${ws()}${pick(['+', '-', '*', '/', '*', '+'])}${ws()}${grammar(d - 1)}`
}
const all = [...FORMULAS]
for (let i = 0; i < 2600; i++) all.push(randomFormula())
for (let i = 0; i < 2400; i++) all.push(grammar(int(1, 4)))
// `min.max++` gán thuộc tính vào chính `Math.min` (đối tượng dùng chung toàn tiến trình) nên lần chạy sau thấy `min.max = NaN`
// thay vì `undefined`. Rust mỗi lần tính một môi trường mới, nên bảng so với lần chạy SẠCH: dọn thuộc tính lạ sau mỗi ca.
const MATH_FNS = [Math.min, Math.max, Math.abs, Math.floor, Math.ceil]
const BASE_PROPS = new Map(MATH_FNS.map((f) => [f, new Set(Reflect.ownKeys(f))]))
const cleanMath = () => {
  for (const f of MATH_FNS) for (const k of Reflect.ownKeys(f)) if (!BASE_PROPS.get(f).has(k)) delete f[k]
}
const CTXS = [{ base: 7_000_000, achievement_rate: 120, revenue: 500_000_000 }, { base: 0, achievement_rate: 0, revenue: 0 }, { base: 12_345_678, achievement_rate: 99.5, revenue: 1_000_001 }]
for (const f of all) {
  const valid = validateFormula(f)
  cases.validate.push({ formula: f, out: valid })
  if (!valid) continue
  for (const ctx of CTXS) {
    let out
    try {
      out = { value: Number(evaluateFormula(f, ctx)) }
    } catch (e) {
      out = { error: /Công thức cho kết quả không hợp lệ/.test(e.message) ? 'nonfinite' : /không hợp lệ/.test(e.message) ? 'invalid' : 'runtime' }
    }
    cleanMath()
    cases.formula.push({ formula: f, ctx, out })
  }
}

// Math.round
for (const x of [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, 4503599627370495.5, 1e21, -1e21, 123456.4999999, 8.5 * 1.5 * 100 / 100]) cases.round.push({ in: x, out: Math.round(x) })

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(cases)}\n`)
console.log(Object.fromEntries(Object.entries(cases).filter(([k]) => k !== 'std').map(([k, v]) => [k, v.length])), 'valid:', cases.validate.filter((c) => c.out).length)
