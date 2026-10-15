/**
 * Safe formula evaluator for salary rule components.
 *
 * Supported variables (injected at evaluation time):
 *   base            - base salary amount (bigint as number)
 *   achievement_rate - KPI achievement percentage (0-200+)
 *   revenue         - actual revenue
 *
 * Supported operators: +, -, *, /, (), min(), max(), if()
 * All intermediate math uses number; final result cast to BigInt.
 *
 * Examples:
 *   "7000000"                              -> fixed 7M
 *   "base * achievement_rate / 100"        -> proportional KPI bonus
 *   "revenue * 0.005"                      -> 0.5% of revenue
 *   "max(0, (achievement_rate - 100) * base * 0.01)"
 */

const ALLOWED_IDENTIFIERS = new Set([
  'base',
  'achievement_rate',
  'revenue',
])

const ALLOWED_FUNCTIONS = new Set(['min', 'max', 'abs', 'floor', 'ceil'])

const SYNTAX_CHECK_CONTEXT = { base: 0, achievement_rate: 0, revenue: 0 }

/** Validate formula contains only safe tokens (và cú pháp hợp lệ) */
export function validateFormula(formula: string): boolean {
  // Extract all identifiers (letter/underscore + digits — `base2` không được tách thành `base`)
  const identifiers = formula.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? []
  for (const token of identifiers) {
    if (!ALLOWED_IDENTIFIERS.has(token) && !ALLOWED_FUNCTIONS.has(token)) {
      return false
    }
  }

  // Ensure only safe characters remain
  const stripped = formula.replace(/[a-zA-Z_0-9+\-*/(),.\s]/g, '')
  if (stripped.length !== 0) return false

  // Kiểm cú pháp: chỉ BIÊN DỊCH (không chạy) — công thức như "base *" nếu lưu được sẽ ném SyntaxError thô lúc tính lương.
  try {
    new Function(...Object.keys(SYNTAX_CHECK_CONTEXT), ...ALLOWED_FUNCTIONS, `"use strict"; return (${formula});`)
  } catch {
    return false
  }
  return true
}

export interface FormulaContext {
  base: number
  achievement_rate: number
  revenue: number
}

/**
 * Evaluate a formula string with the given context.
 * Returns result as BigInt (VND, no fractions).
 */
export function evaluateFormula(
  formula: string,
  context: FormulaContext,
): bigint {
  if (!validateFormula(formula)) {
    throw new Error(`Công thức không hợp lệ: ${formula}`)
  }

  // Build a safe evaluation function
  const fn = new Function(
    ...Object.keys(context),
    'min',
    'max',
    'abs',
    'floor',
    'ceil',
    `"use strict"; return (${formula});`,
  )

  const result = fn(
    ...Object.values(context),
    Math.min,
    Math.max,
    Math.abs,
    Math.floor,
    Math.ceil,
  ) as number

  // Chia cho 0 (Infinity) hoặc 0/0 (NaN) không đổi được sang BigInt: báo lỗi nghiệp vụ rõ ràng thay vì RangeError.
  if (!Number.isFinite(result)) {
    throw new Error(`Công thức cho kết quả không hợp lệ (chia cho 0?): ${formula}`)
  }

  // Clamp to non-negative and convert to BigInt
  return BigInt(Math.max(0, Math.floor(result)))
}
