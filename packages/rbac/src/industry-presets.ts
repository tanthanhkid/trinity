/**
 * Loại doanh nghiệp → bộ phân hệ gợi ý + mẫu tính năng dựng sẵn. Nguồn DUY NHẤT cho wizard bắt đầu
 * (web hiện thẻ ngành và tick sẵn phân hệ) và máy chủ (API/tool dựng hệ thống kiểm đầu vào).
 *
 * `template` là khoá mẫu ở `services/crm/src/custom-objects/templates` (null = CRM cơ bản, không có bảng tuỳ biến).
 */
import { ORG_FEATURE_KEYS, isOrgFeatureKey, type OrgFeatureKey } from './org-features'

export const INDUSTRY_KEYS = ['education_center', 'retail_service', 'clinic', 'real_estate', 'other'] as const
export type IndustryKey = (typeof INDUSTRY_KEYS)[number]

export interface IndustryPreset {
  label: string
  description: string
  /** Tên icon (lucide) cho thẻ chọn ngành ở web. */
  icon: string
  /** Khoá mẫu bảng tuỳ biến; null = không có. */
  template: string | null
  /** Phân hệ tick sẵn (đã gồm bộ cơ bản). */
  features: readonly OrgFeatureKey[]
}

/** Bộ cơ bản của wizard: luôn bật, không tắt được. */
export const LOCKED_FEATURES: readonly OrgFeatureKey[] = ['dashboard', 'contacts', 'kanban', 'reports']

const base = (...more: OrgFeatureKey[]): readonly OrgFeatureKey[] => [...new Set<OrgFeatureKey>([...LOCKED_FEATURES, ...more])]

export const INDUSTRY_PRESETS: Record<IndustryKey, IndustryPreset> = {
  education_center: {
    label: 'Trung tâm giáo dục',
    description: 'Phụ huynh, học sinh, khoá học, hoá đơn, ghi danh, thanh toán học phí.',
    icon: 'GraduationCap',
    template: 'education_center',
    features: base('inbox', 'facebook_page', 'zalo_oa', 'social_posting', 'payments', 'lead_scoring', 'stale_reminders', 'integrations'),
  },
  retail_service: {
    label: 'Bán lẻ và dịch vụ',
    description: 'Sản phẩm, khách thân thiết, đơn hàng; bán tại quầy và bán online.',
    icon: 'Store',
    template: 'retail_service',
    features: base('inbox', 'facebook_page', 'zalo_oa', 'social_posting', 'products', 'pos', 'payments', 'stale_reminders', 'integrations'),
  },
  clinic: {
    label: 'Phòng khám, spa, thú y',
    description: 'Bệnh nhân hoặc khách, lịch hẹn, hồ sơ điều trị.',
    icon: 'Stethoscope',
    template: 'clinic',
    features: base('inbox', 'facebook_page', 'zalo_oa', 'products', 'payments', 'stale_reminders', 'integrations'),
  },
  real_estate: {
    label: 'Bất động sản',
    description: 'Dự án, sản phẩm (căn, lô), giữ chỗ, lịch dẫn khách xem.',
    icon: 'Building2',
    template: 'real_estate',
    features: base('inbox', 'facebook_page', 'zalo_oa', 'social_posting', 'lead_scoring', 'stale_reminders', 'google_sheets', 'integrations'),
  },
  other: {
    label: 'Khác',
    description: 'CRM cơ bản: khách hàng, công việc, báo cáo. Thêm bảng riêng sau khi dùng.',
    icon: 'Briefcase',
    template: null,
    features: base('inbox', 'integrations'),
  },
}

export function isIndustryKey(x: unknown): x is IndustryKey {
  return typeof x === 'string' && (INDUSTRY_KEYS as readonly string[]).includes(x)
}

/**
 * Phân hệ sẽ bật khi dựng: danh sách người dùng chọn (khoá lạ bị bỏ) + bộ cơ bản bắt buộc.
 * `chosen` vắng = dùng bộ gợi ý của ngành.
 */
export function resolveBuildFeatures(industry: IndustryKey, chosen?: readonly string[] | null): OrgFeatureKey[] {
  const picked = chosen ? chosen.filter(isOrgFeatureKey) : INDUSTRY_PRESETS[industry].features
  const set = new Set<OrgFeatureKey>([...LOCKED_FEATURES, ...picked])
  return ORG_FEATURE_KEYS.filter((k) => set.has(k))
}

