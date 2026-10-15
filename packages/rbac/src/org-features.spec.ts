import {
  ORG_FEATURE_KEYS,
  applyFeatureLocks,
  isServerlessRuntime,
  lockedFeatureReasons,
  resolveOrgFeatures, PLANS, PLAN_KEYS, PLAN_GATED_FEATURES, DEFAULT_PLAN, resolvePlan, applyPlanToFeatures, DEFAULT_OFF_FEATURES } from './org-features'
import { PERMISSIONS } from './catalog'

describe('org-features', () => {
  it('thiếu khoá / rác / null = BẬT hết', () => {
    for (const raw of [undefined, null, 'x', [], {}, { kanban: 'no' }]) {
      const f = resolveOrgFeatures(raw)
      // Cờ mặc định tắt (DEFAULT_OFF_FEATURES, vd online_store) là ngoại lệ có chủ đích.
      expect(ORG_FEATURE_KEYS.every((k) => f[k] === !DEFAULT_OFF_FEATURES.has(k))).toBe(true)
    }
  })
  it('chỉ false thật mới tắt', () => {
    const f = resolveOrgFeatures({ kanban: false, newsfeed: true })
    expect(f.kanban).toBe(false)
    expect(f.newsfeed).toBe(true)
  })
  it('khoá không còn tồn tại (email) trong cấu hình cũ → bỏ qua, không crash', () => {
    const f = resolveOrgFeatures({ email: false, kanban: false }) as Record<string, boolean>
    expect('email' in f).toBe(false)
    expect(f.kanban).toBe(false)
  })
  it('quyền settings.features có trong danh mục', () => {
    expect(PERMISSIONS['settings.features'].group).toBe('Hệ thống')
  })
  it('isServerlessRuntime chuẩn hoá giống web/monolith/rbac-nest; không đặt = server thường', () => {
    expect(isServerlessRuntime({})).toBe(false)
    expect(isServerlessRuntime({ TRINITY_RUNTIME: 'pm2' })).toBe(false)
    expect(isServerlessRuntime({ TRINITY_RUNTIME: 'serverless' })).toBe(true)
    expect(isServerlessRuntime({ TRINITY_RUNTIME: ' Serverless\n' })).toBe(true)
  })
})

describe('Gói dịch vụ', () => {
  it('mặc định = custom (không vỡ bản đang chạy), custom bật hết và không giới hạn', () => {
    expect(DEFAULT_PLAN).toBe('custom')
    expect(resolvePlan(undefined)).toBe('custom')
    expect(resolvePlan('rác')).toBe('custom')
    expect(resolvePlan('ket_noi')).toBe('ket_noi')
    const f = applyPlanToFeatures(resolveOrgFeatures({}), 'custom')
    expect(ORG_FEATURE_KEYS.every((k) => f[k] === !DEFAULT_OFF_FEATURES.has(k))).toBe(true)
    expect(PLANS.custom.maxUsers).toBeNull()
    expect(PLANS.custom).not.toHaveProperty('quotas')
  })
  it('mọi gói đủ khoá, cờ thuộc danh mục', () => {
    for (const k of PLAN_KEYS) {
      for (const f of PLANS[k].features) expect(PLAN_GATED_FEATURES).toContain(f)
    }
  })
  it('Kết nối: chỉ sheets, 10 user; không gói nào có hạn mức AI (Trinity không chạy AI)', () => {
    const f = applyPlanToFeatures(resolveOrgFeatures({}), 'ket_noi')
    expect(f.google_sheets).toBe(true)
    expect(f.zalo_oa).toBe(false)
    expect(f.ai_briefing).toBe(false)
    expect(PLANS.ket_noi.maxUsers).toBe(10)
    for (const k of PLAN_KEYS) expect(PLANS[k]).not.toHaveProperty('quotas')
    expect(ORG_FEATURE_KEYS).not.toContain('ai_chat')
  })
  it('gói chỉ hạ cờ: cờ cũ giữ nguyên, admin tắt tay vẫn tắt', () => {
    const f = applyPlanToFeatures(resolveOrgFeatures({ lead_scoring: false, google_sheets: false }), 'tro_ly_van_hanh')
    expect(f.lead_scoring).toBe(false)
    expect(f.google_sheets).toBe(false)
    expect(f.zalo_oa).toBe(true)
    expect(f.payroll).toBe(true)
  })
})

describe('DEFAULT_OFF_FEATURES', () => {
  it('trang bán hàng mặc định TẮT; lưu bật thì bật', () => {
    expect(resolveOrgFeatures(undefined).online_store).toBe(false)
    expect(resolveOrgFeatures({ online_store: true }).online_store).toBe(true)
  })
})
