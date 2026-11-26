import { INDUSTRY_KEYS, INDUSTRY_PRESETS, LOCKED_FEATURES, isIndustryKey, resolveBuildFeatures } from './industry-presets'
import { ORG_FEATURE_KEYS } from './org-features'

describe('industry-presets', () => {
  it('đủ 5 ngành: 4 mẫu có sẵn + Khác', () => {
    expect([...INDUSTRY_KEYS]).toEqual(['education_center', 'retail_service', 'clinic', 'real_estate', 'other'])
    expect(Object.keys(INDUSTRY_PRESETS).sort()).toEqual([...INDUSTRY_KEYS].sort())
    expect(INDUSTRY_PRESETS.other.template).toBeNull()
    for (const k of INDUSTRY_KEYS.filter((x) => x !== 'other')) expect(INDUSTRY_PRESETS[k].template).toBe(k)
  })

  it('mọi bộ gợi ý chỉ chứa khoá phân hệ có thật và luôn có bộ cơ bản', () => {
    for (const k of INDUSTRY_KEYS) {
      const f = INDUSTRY_PRESETS[k].features
      for (const x of f) expect(ORG_FEATURE_KEYS).toContain(x)
      for (const x of LOCKED_FEATURES) expect(f).toContain(x)
      expect(new Set(f).size).toBe(f.length)
    }
  })

  it('isIndustryKey', () => {
    expect(isIndustryKey('clinic')).toBe(true)
    expect(isIndustryKey('f_and_b')).toBe(false)
    expect(isIndustryKey(undefined)).toBe(false)
  })

  it('resolveBuildFeatures: vắng = bộ gợi ý; có chọn = chọn + bộ cơ bản; bỏ khoá lạ; thứ tự ổn định', () => {
    expect(resolveBuildFeatures('other')).toEqual(ORG_FEATURE_KEYS.filter((k) => INDUSTRY_PRESETS.other.features.includes(k)))
    const r = resolveBuildFeatures('clinic', ['payroll', 'khong_co', 'pos'])
    expect(r).toEqual(ORG_FEATURE_KEYS.filter((k) => [...LOCKED_FEATURES, 'pos', 'payroll'].includes(k)))
    expect(resolveBuildFeatures('clinic', [])).toEqual(ORG_FEATURE_KEYS.filter((k) => LOCKED_FEATURES.includes(k)))
  })
})
