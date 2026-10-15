/**
 * Công thức của trường `formula` — bộ phân tích + thẩm định + tính TỰ VIẾT, KHÔNG `eval`/`new Function`.
 *
 * Cú pháp (whitelist, ký tự lạ → lỗi):
 *   số            12   3.5
 *   tham chiếu    {ten_truong}            (trường number/currency/percent/date/datetime của CHÍNH thực thể)
 *   toán tử       +  -  *  /   dấu trừ đơn ngôi
 *   hàm           round(x, n)             n = số nguyên 0..6 viết thẳng
 *                 months_between(d1, d2)  số tháng (cả phần lẻ) từ ngày d1 đến d2: tháng lịch + (chênh ngày / 30)
 *                 days_between(d1, d2)    số ngày từ d1 đến d2
 * `percent` đọc ra PHÂN SỐ (5 → 0.05) để viết `{gia_goc}*(1-{uu_dai})`. Thiếu giá trị (null) hoặc chia cho 0 → kết quả null.
 */

export class FormulaError extends Error {}

export type FormulaNode =
  | { k: 'num'; v: number }
  | { k: 'ref'; key: string }
  | { k: 'neg'; a: FormulaNode }
  | { k: 'bin'; op: '+' | '-' | '*' | '/'; a: FormulaNode; b: FormulaNode }
  | { k: 'call'; fn: FormulaFn; args: FormulaNode[] }

export type FormulaFn = 'round' | 'months_between' | 'days_between'
const FUNCTIONS: readonly FormulaFn[] = ['round', 'months_between', 'days_between']

export const FORMULA_LIMITS = { maxLength: 300, maxNodes: 100, maxDepth: 20 } as const

type Tok =
  | { t: 'num'; v: number }
  | { t: 'ref'; key: string }
  | { t: 'fn'; name: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' }
  | { t: 'lp' } | { t: 'rp' } | { t: 'comma' }

const REF_KEY = /^[a-z][a-z0-9_]{0,47}$/

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++
      if (src[j] === '.') {
        j++
        const startFrac = j
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j++
        if (j === startFrac) throw new FormulaError('Số thập phân không hợp lệ (thiếu chữ số sau dấu chấm)')
      }
      out.push({ t: 'num', v: Number(src.slice(i, j)) })
      i = j
      continue
    }
    if (c === '{') {
      const end = src.indexOf('}', i)
      if (end === -1) throw new FormulaError('Thiếu dấu } đóng tham chiếu trường')
      const key = src.slice(i + 1, end).trim()
      if (!REF_KEY.test(key)) throw new FormulaError(`Tên trường tham chiếu không hợp lệ: {${key.slice(0, 30)}}`)
      out.push({ t: 'ref', key })
      i = end + 1
      continue
    }
    if (c >= 'a' && c <= 'z') {
      let j = i
      while (j < src.length && ((src[j] >= 'a' && src[j] <= 'z') || src[j] === '_')) j++
      out.push({ t: 'fn', name: src.slice(i, j) })
      i = j
      continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') { out.push({ t: 'op', v: c }); i++; continue }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue }
    if (c === ',') { out.push({ t: 'comma' }); i++; continue }
    throw new FormulaError(`Ký tự không được phép trong công thức: "${c}"`)
  }
  return out
}

class Parser {
  private pos = 0
  private nodes = 0
  constructor(private readonly toks: Tok[]) {}

  parse(): FormulaNode {
    if (this.toks.length === 0) throw new FormulaError('Công thức đang trống')
    const n = this.expr(0)
    if (this.pos < this.toks.length) throw new FormulaError('Công thức thừa ký tự ở cuối')
    return n
  }

  private bump(): void {
    if (++this.nodes > FORMULA_LIMITS.maxNodes) throw new FormulaError('Công thức quá dài/phức tạp')
  }

  private peek(): Tok | undefined { return this.toks[this.pos] }

  private expr(depth: number): FormulaNode {
    if (depth > FORMULA_LIMITS.maxDepth) throw new FormulaError('Công thức lồng quá sâu')
    let left = this.term(depth)
    for (let t = this.peek(); t && t.t === 'op' && (t.v === '+' || t.v === '-'); t = this.peek()) {
      this.pos++
      const right = this.term(depth)
      this.bump()
      left = { k: 'bin', op: t.v, a: left, b: right }
    }
    return left
  }

  private term(depth: number): FormulaNode {
    let left = this.unary(depth)
    for (let t = this.peek(); t && t.t === 'op' && (t.v === '*' || t.v === '/'); t = this.peek()) {
      this.pos++
      const right = this.unary(depth)
      this.bump()
      left = { k: 'bin', op: t.v, a: left, b: right }
    }
    return left
  }

  private unary(depth: number): FormulaNode {
    if (depth > FORMULA_LIMITS.maxDepth) throw new FormulaError('Công thức lồng quá sâu')
    const t = this.peek()
    if (t && t.t === 'op' && t.v === '-') {
      this.pos++
      this.bump()
      return { k: 'neg', a: this.unary(depth + 1) }
    }
    return this.primary(depth)
  }

  private primary(depth: number): FormulaNode {
    const t = this.peek()
    if (!t) throw new FormulaError('Công thức chưa hoàn chỉnh')
    this.pos++
    this.bump()
    if (t.t === 'num') return { k: 'num', v: t.v }
    if (t.t === 'ref') return { k: 'ref', key: t.key }
    if (t.t === 'lp') {
      const inner = this.expr(depth + 1)
      this.expectRp()
      return inner
    }
    if (t.t === 'fn') return this.call(t.name, depth)
    throw new FormulaError('Công thức sai cú pháp')
  }

  private call(name: string, depth: number): FormulaNode {
    if (!(FUNCTIONS as readonly string[]).includes(name)) throw new FormulaError(`Hàm không được hỗ trợ: ${name}`)
    const lp = this.peek()
    if (!lp || lp.t !== 'lp') throw new FormulaError(`Thiếu dấu ( sau hàm ${name}`)
    this.pos++
    const args: FormulaNode[] = [this.expr(depth + 1)]
    while (this.peek()?.t === 'comma') {
      this.pos++
      args.push(this.expr(depth + 1))
    }
    this.expectRp()
    if (args.length !== 2) throw new FormulaError(`Hàm ${name} cần đúng 2 đối số`)
    return { k: 'call', fn: name as FormulaFn, args }
  }

  private expectRp(): void {
    if (this.peek()?.t !== 'rp') throw new FormulaError('Thiếu dấu ) đóng')
    this.pos++
  }
}

const cache = new Map<string, FormulaNode>()

/** Phân tích cú pháp (có cache nhỏ). Ném `FormulaError` khi sai. */
export function parseFormula(expression: string): FormulaNode {
  if (typeof expression !== 'string') throw new FormulaError('Công thức phải là chuỗi')
  if (expression.length > FORMULA_LIMITS.maxLength) {
    throw new FormulaError(`Công thức tối đa ${FORMULA_LIMITS.maxLength} ký tự`)
  }
  const hit = cache.get(expression)
  if (hit) return hit
  const ast = new Parser(tokenize(expression)).parse()
  if (cache.size >= 500) cache.clear()
  cache.set(expression, ast)
  return ast
}

/** Mọi khoá trường được tham chiếu (không trùng). */
export function collectRefs(node: FormulaNode, out: Set<string> = new Set()): Set<string> {
  switch (node.k) {
    case 'ref': out.add(node.key); break
    case 'neg': collectRefs(node.a, out); break
    case 'bin': collectRefs(node.a, out); collectRefs(node.b, out); break
    case 'call': node.args.forEach((a) => collectRefs(a, out)); break
    default: break
  }
  return out
}

export type RefKind = 'num' | 'date'

/**
 * Thẩm định kiểu: số học chỉ trên số; hàm ngày chỉ nhận tham chiếu ngày; `round` nhận biểu thức số + số nguyên 0..6;
 * kết quả cuối PHẢI là số. `refKind(key)` trả `undefined` nếu trường không tồn tại / không được phép tham chiếu.
 */
export function checkFormula(node: FormulaNode, refKind: (key: string) => RefKind | undefined): void {
  const kind = typeOf(node, refKind)
  if (kind !== 'num') throw new FormulaError('Kết quả công thức phải là số (dùng months_between/days_between cho ngày)')
}

function typeOf(node: FormulaNode, refKind: (key: string) => RefKind | undefined): RefKind {
  switch (node.k) {
    case 'num': return 'num'
    case 'ref': {
      const k = refKind(node.key)
      if (!k) throw new FormulaError(`Trường {${node.key}} không tồn tại hoặc không dùng được trong công thức (chỉ số, tiền, %, ngày)`)
      return k
    }
    case 'neg':
      if (typeOf(node.a, refKind) !== 'num') throw new FormulaError('Không thể đổi dấu một ngày')
      return 'num'
    case 'bin':
      if (typeOf(node.a, refKind) !== 'num' || typeOf(node.b, refKind) !== 'num') {
        throw new FormulaError('Phép + − × ÷ chỉ dùng với số; dùng months_between/days_between để so sánh ngày')
      }
      return 'num'
    case 'call': return callType(node, refKind)
  }
}

function callType(node: Extract<FormulaNode, { k: 'call' }>, refKind: (key: string) => RefKind | undefined): RefKind {
  const [a, b] = node.args
  if (node.fn === 'round') {
    if (typeOf(a, refKind) !== 'num') throw new FormulaError('round(x, n): x phải là số')
    if (b.k !== 'num' || !Number.isInteger(b.v) || b.v < 0 || b.v > 6) {
      throw new FormulaError('round(x, n): n phải là số nguyên từ 0 đến 6 viết thẳng')
    }
    return 'num'
  }
  if (a.k !== 'ref' || b.k !== 'ref' || typeOf(a, refKind) !== 'date' || typeOf(b, refKind) !== 'date') {
    throw new FormulaError(`${node.fn}(d1, d2): cả hai đối số phải là trường ngày, ví dụ ${node.fn}({bat_dau}, {ket_thuc})`)
  }
  return 'num'
}

type Val = number | string | null

const YMD = /^(\d{4})-(\d{2})-(\d{2})/

function parseYmd(v: string): { y: number; m: number; d: number } | null {
  let s = v
  if (v.includes('T')) {
    const t = Date.parse(v)
    if (!Number.isFinite(t)) return null
    s = new Date(t + 7 * 3_600_000).toISOString() // lịch Việt Nam (UTC+7)
  }
  const m = YMD.exec(s)
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null
}

function round(x: number, n: number): number {
  const f = 10 ** n
  const r = Math.round(Math.abs(x) * f + Number.EPSILON * f) / f
  return x < 0 ? -r : r
}

function clean(x: number): number | null {
  if (!Number.isFinite(x) || Math.abs(x) > 1e15) return null
  return Math.round(x * 1e6) / 1e6
}

function evalNode(node: FormulaNode, getRef: (key: string) => Val | undefined): Val {
  switch (node.k) {
    case 'num': return node.v
    case 'ref': return getRef(node.key) ?? null
    case 'neg': {
      const a = evalNode(node.a, getRef)
      return typeof a === 'number' ? -a : null
    }
    case 'bin': {
      const a = evalNode(node.a, getRef)
      const b = evalNode(node.b, getRef)
      if (typeof a !== 'number' || typeof b !== 'number') return null
      if (node.op === '+') return a + b
      if (node.op === '-') return a - b
      if (node.op === '*') return a * b
      return b === 0 ? null : a / b
    }
    case 'call': return evalCall(node, getRef)
  }
}

function evalCall(node: Extract<FormulaNode, { k: 'call' }>, getRef: (key: string) => Val | undefined): Val {
  const a = evalNode(node.args[0], getRef)
  const b = evalNode(node.args[1], getRef)
  if (node.fn === 'round') return typeof a === 'number' && typeof b === 'number' ? round(a, b) : null
  if (typeof a !== 'string' || typeof b !== 'string') return null
  const d1 = parseYmd(a)
  const d2 = parseYmd(b)
  if (!d1 || !d2) return null
  if (node.fn === 'months_between') return (d2.y - d1.y) * 12 + (d2.m - d1.m) + (d2.d - d1.d) / 30
  return Math.round((Date.UTC(d2.y, d2.m - 1, d2.d) - Date.UTC(d1.y, d1.m - 1, d1.d)) / 86_400_000)
}

/**
 * Tính công thức. `getRef(key)` trả số (percent ĐÃ chia 100) / chuỗi ngày / null. Kết quả `null` khi thiếu dữ liệu,
 * chia cho 0, hoặc ngoài phạm vi an toàn — KHÔNG ném lỗi lúc đọc.
 */
export function evaluateFormula(node: FormulaNode, getRef: (key: string) => Val | undefined): number | null {
  const v = evalNode(node, getRef)
  return typeof v === 'number' ? clean(v) : null
}
