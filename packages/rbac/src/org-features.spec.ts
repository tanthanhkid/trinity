import {
  ORG_FEATURE_KEYS,
  applyFeatureLocks,
  isServerlessRuntime,
  lockedFeatureReasons,
  resolveOrgFeatures, PLANS, PLAN_KEYS, CHANNEL_LIMIT_KEYS, channelLimitsFor, PLAN_GATED_FEATURES, DEFAULT_PLAN, DEFAULT_SIGNUP_PLAN, resolvePlan, resolvePlanForCompany, applyPlanToFeatures, DEFAULT_OFF_FEATURES } from './org-features'
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
  it('Mặc định (công ty đăng ký mới): đủ mọi tính năng của gói, tối đa 10 người; thiếu dòng gói giải cùng một cách ở mọi nơi', () => {
    expect(DEFAULT_SIGNUP_PLAN).toBe('mac_dinh')
    expect(PLANS.mac_dinh.label).toBe('Mặc định')
    expect(PLANS.mac_dinh.maxUsers).toBe(10)
    expect([...PLANS.mac_dinh.features].sort()).toEqual([...PLAN_GATED_FEATURES].sort())
    const f = applyPlanToFeatures(resolveOrgFeatures({}), 'mac_dinh')
    expect(f.facebook_page && f.zalo_oa && f.ai_briefing && f.google_sheets && f.lead_scoring && f.stale_reminders).toBe(true)
    expect(resolvePlanForCompany(undefined, 3)).toBe('mac_dinh')
    expect(resolvePlanForCompany('rác', 2)).toBe('mac_dinh')
    expect(resolvePlanForCompany(undefined, 1)).toBe('custom')
    expect(resolvePlanForCompany(undefined, null)).toBe('custom')
    expect(resolvePlanForCompany('custom', 3)).toBe('custom')
    expect(resolvePlanForCompany('ket_noi', 1)).toBe('ket_noi')
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

  it('hạn mức kênh: mọi gói đủ khoá, số nguyên dương, tăng dần theo gói, custom vẫn có trần', () => {
    for (const k of PLAN_KEYS) {
      for (const key of CHANNEL_LIMIT_KEYS) {
        const v = PLANS[k].channelLimits[key]
        expect(Number.isInteger(v) && v > 0).toBe(true)
      }
    }
    expect(PLANS.ket_noi.channelLimits.bulkMessagesPerDay).toBeLessThan(PLANS.tro_ly_kinh_doanh.channelLimits.bulkMessagesPerDay)
    expect(PLANS.tro_ly_kinh_doanh.channelLimits.postsPerDay).toBeLessThan(PLANS.tro_ly_van_hanh.channelLimits.postsPerDay)
    expect(Number.isFinite(PLANS.custom.channelLimits.bulkMessagesPerDay)).toBe(true)
    // Gói đăng ký mặc định (công ty mới) có hạn mức kênh bằng `ket_noi`.
    expect(PLANS.mac_dinh.channelLimits).toEqual(PLANS.ket_noi.channelLimits)
    expect(channelLimitsFor(DEFAULT_SIGNUP_PLAN)).toEqual(PLANS.ket_noi.channelLimits)
    expect(channelLimitsFor('custom')).toEqual(PLANS.custom.channelLimits)
    expect(channelLimitsFor('custom')).not.toBe(PLANS.custom.channelLimits)
  })
})
