import { BLANK_SYSTEM_FEATURES, ORG_FEATURE_KEYS, resolveOrgFeatures, resolveSetupStatus } from './org-features'

describe('setup_status', () => {
  it('vắng / rác = da_dung (fail-open: bản cài cũ không bị khoá)', () => {
    for (const raw of [undefined, null, '', 'xyz', 3, {}]) expect(resolveSetupStatus(raw)).toBe('da_dung')
  })
  it('đọc đúng ba trạng thái', () => {
    expect(resolveSetupStatus('chua_dung')).toBe('chua_dung')
    expect(resolveSetupStatus(' dang_dung ')).toBe('dang_dung')
    expect(resolveSetupStatus('da_dung')).toBe('da_dung')
  })
  it('hệ thống trống: module cứng TẮT, chỉ "Kết nối & AI" bật', () => {
    const f = resolveOrgFeatures(undefined, BLANK_SYSTEM_FEATURES)
    expect(ORG_FEATURE_KEYS.filter((k) => f[k])).toEqual(['integrations'])
  })
  it('giá trị đã lưu thắng mặc định trống', () => {
    const f = resolveOrgFeatures({ kanban: true, integrations: false }, BLANK_SYSTEM_FEATURES)
    expect(f.kanban).toBe(true)
    expect(f.integrations).toBe(false)
    expect(f.payroll).toBe(false)
  })
  it('có Tổng quan + Khách hàng để tắt được', () => {
    expect(ORG_FEATURE_KEYS).toEqual(expect.arrayContaining(['dashboard', 'contacts']))
  })
})
