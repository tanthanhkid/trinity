import {
  validateFormula,
  evaluateFormula,
  FormulaContext,
} from '../formula-evaluator'

describe('FormulaEvaluator', () => {
  const defaultContext: FormulaContext = {
    base: 7_000_000,
    achievement_rate: 120,
    revenue: 1_500_000_000,
  }

  describe('validateFormula', () => {
    it('accepts valid fixed amount', () => {
      expect(validateFormula('7000000')).toBe(true)
    })

    it('rejects identifiers with trailing digits (base2, min2(...))', () => {
      expect(validateFormula('base2 * 2')).toBe(false)
      expect(validateFormula('min2(base, 5)')).toBe(false)
    })

    it('accepts valid variable formula', () => {
      expect(validateFormula('base * achievement_rate / 100')).toBe(true)
    })

    it('accepts formulas with functions', () => {
      expect(
        validateFormula('max(0, (achievement_rate - 100) * base * 0.01)'),
      ).toBe(true)
    })

    it('accepts revenue formula', () => {
      expect(validateFormula('revenue * 0.005')).toBe(true)
    })

    it('rejects formulas with disallowed identifiers', () => {
      expect(validateFormula('process.exit(1)')).toBe(false)
    })

    it('rejects formulas with broken syntax (compile-only check)', () => {
      expect(validateFormula('base *')).toBe(false)
      expect(validateFormula('max(1, ')).toBe(false)
      expect(validateFormula('1 2')).toBe(false)
    })

    it('rejects formulas with require', () => {
      expect(validateFormula('require("fs")')).toBe(false)
    })
  })

  describe('evaluateFormula', () => {
    it('chia cho 0 hoặc 0/0 → lỗi nghiệp vụ rõ ràng, không phải RangeError', () => {
      expect(() => evaluateFormula('base / 0', defaultContext)).toThrow('chia cho 0')
      expect(() => evaluateFormula('0 / 0', defaultContext)).toThrow('chia cho 0')
    })

    it('evaluates fixed amount', () => {
      const result = evaluateFormula('7000000', defaultContext)
      expect(result).toBe(7_000_000n)
    })

    it('evaluates proportional KPI bonus', () => {
      const result = evaluateFormula(
        'base * achievement_rate / 100',
        defaultContext,
      )
      // 7M * 120 / 100 = 8.4M
      expect(result).toBe(8_400_000n)
    })

    it('evaluates revenue-based amount', () => {
      const result = evaluateFormula('revenue * 0.005', defaultContext)
      // 1.5B * 0.5% = 7.5M
      expect(result).toBe(7_500_000n)
    })

    it('evaluates formula with max()', () => {
      const result = evaluateFormula(
        'max(0, (achievement_rate - 100) * base * 0.01)',
        defaultContext,
      )
      // (120 - 100) * 7M * 0.01 = 1.4M
      expect(result).toBe(1_400_000n)
    })

    it('clamps negative results to zero', () => {
      const lowContext = { ...defaultContext, achievement_rate: 50 }
      const result = evaluateFormula(
        'max(0, (achievement_rate - 100) * base * 0.01)',
        lowContext,
      )
      expect(result).toBe(0n)
    })

    it('throws on invalid formula', () => {
      expect(() =>
        evaluateFormula('process.exit(1)', defaultContext),
      ).toThrow('Công thức không hợp lệ')
    })
  })
})
