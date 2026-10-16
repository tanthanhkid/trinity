/**
 * "Tính năng của tổ chức" — công tắc BẬT/TẮT theo TỔ CHỨC (toàn
 * công ty), ĐỘC LẬP với RBAC. Tắt = ẩn UI với MỌI người; quyền vẫn do RBAC
 * quyết định, BE KHÔNG dùng công tắc này thay kiểm quyền.
 *
 * Nguồn DUY NHẤT của danh sách khoá: BE (validate PUT) và FE (menu, widget,
 * tab Cài đặt) cùng import từ đây — thêm tính năng = thêm 1 dòng ở đây.
 * Thiếu khoá trong cấu hình đã lưu = BẬT (mặc định bật hết).
 */
/** Nhóm hiển thị ở Cài đặt › Tính năng (thứ tự = thứ tự trên màn). */
export const ORG_FEATURE_GROUPS = [
  { key: 'core', label: 'Cơ bản' },
  { key: 'channels', label: 'Kênh & hộp thư' },
  { key: 'sales', label: 'Bán hàng' },
  { key: 'people', label: 'Nhân sự' },
  { key: 'advanced', label: 'Nâng cao' },
] as const
export type OrgFeatureGroup = (typeof ORG_FEATURE_GROUPS)[number]['key']

export const ORG_FEATURES = {
  dashboard: { label: 'Tổng quan', group: 'core', description: 'Trang đầu: trợ lý AI đang làm gì, kênh đã kết nối, số liệu chính.' },
  contacts: { label: 'Khách hàng', group: 'core', description: 'Danh bạ khách hàng, nguồn khách, giai đoạn chăm sóc.' },
  kanban: { label: 'Công việc', group: 'core', description: 'Bảng công việc dạng thẻ (Kanban), giao việc và hạn chót.' },
  reports: { label: 'Báo cáo', group: 'core', description: 'Báo cáo khách hàng, nhân viên, kênh.' },
  inbox: { label: 'Hộp thư', group: 'channels', description: 'Gom tin Messenger và Zalo OA vào một chỗ để trả lời khách.' },
  facebook_page: { label: 'Fanpage Facebook', group: 'channels', description: 'Nhận và trả lời tin Messenger, bình luận, lead từ Lead Ads vào khách hàng.' },
  zalo_oa: { label: 'Zalo OA', group: 'channels', description: 'Nhận và trả lời tin Zalo OA, gửi thông báo ZNS.' },
  social_posting: { label: 'Đăng đa kênh', group: 'channels', description: 'Soạn một lần, đăng hoặc hẹn giờ ra Fanpage và YouTube; trợ lý AI soạn và đăng được.' },
  products: { label: 'Sản phẩm', group: 'sales', description: 'Danh mục sản phẩm, dịch vụ và giá.' },
  pos: { label: 'Bán hàng (POS)', group: 'sales', description: 'Bán hàng tại quầy, in hoá đơn.' },
  payments: { label: 'Thanh toán & đối soát', group: 'sales', description: 'SePay, VNPay, MoMo: mã QR, link thanh toán, tự khớp tiền chuyển khoản.' },
  online_store: { label: 'Trang bán hàng', group: 'sales', description: 'Trang bán hàng online: khách đặt COD hoặc chuyển khoản QR, đơn vào thẳng CRM.' },
  commerce_connectors: { label: 'Kết nối bán hàng', group: 'sales', description: 'Đồng bộ khách, đơn, hàng hoá từ KiotViet, Sapo, iPOS, WooCommerce, Shopee, Lazada.' },
  management: { label: 'Quản lý nhân sự', group: 'people', description: 'Nhân viên, phòng ban, team, chức danh, hợp đồng, tuyển dụng.' },
  attendance: { label: 'Chấm công', group: 'people', description: 'Nhân viên tự chấm công, quản lý ngày công.' },
  payroll: { label: 'Lương', group: 'people', description: 'Bảng lương và phiếu lương.' },
  newsfeed: { label: 'Bảng tin', group: 'people', description: 'Bảng tin nội bộ của công ty.' },
  integrations: { label: 'Kết nối & AI', group: 'advanced', description: 'Kết nối trợ lý AI (ChatGPT, Claude, Gemini…), webhook và nhật ký tích hợp.' },
  ai_briefing: { label: 'Bản tin sáng/chiều', group: 'advanced', description: 'Bản tin số liệu sáng và chiều do trợ lý AI của bạn viết.' },
  lead_scoring: { label: 'Chấm điểm khách tiềm năng', group: 'advanced', description: 'Chấm điểm khách theo quy tắc; trợ lý AI chấm thêm ý định mua.' },
  stale_reminders: { label: 'Nhắc việc treo', group: 'advanced', description: 'Nhắc nhân viên liên hệ lại khách hoặc việc quá hạn.' },
  google_sheets: { label: 'Google Sheets', group: 'advanced', description: 'Đồng bộ khách hàng với Google Sheets.' },
} as const satisfies Record<string, { label: string; group: OrgFeatureGroup; description: string }>

export type OrgFeatureKey = keyof typeof ORG_FEATURES

/**
 * Bộ cơ bản: luôn bật khi hệ thống mới được dựng (cộng với những tính năng trợ lý AI chọn theo ngành).
 * Hệ thống đang chạy không bị đụng: khoá chưa lưu vẫn tính là BẬT (`resolveOrgFeatures`).
 */
export const BASIC_FEATURES: readonly OrgFeatureKey[] = ['dashboard', 'contacts', 'kanban', 'reports', 'inbox', 'integrations']
export const ORG_FEATURE_KEYS = Object.keys(ORG_FEATURES) as OrgFeatureKey[]
export type OrgFeatures = Record<OrgFeatureKey, boolean>

export function isOrgFeatureKey(x: string): x is OrgFeatureKey {
  return Object.prototype.hasOwnProperty.call(ORG_FEATURES, x)
}

/**
 * Cấu hình thô (JSON đã lưu, có thể thiếu khoá/rác) → đủ khoá. Khoá thiếu/không phải boolean lấy theo `defaults`
 * (không truyền = BẬT — hành vi cũ cho hệ thống đã dựng). Hệ thống CHƯA dựng quy trình truyền `BLANK_SYSTEM_FEATURES`.
 */
/** Tính năng mới cần bật tay (vd tốn tài nguyên máy chủ, mở trang công khai) — khoá vắng = TẮT thay vì BẬT. */
export const DEFAULT_OFF_FEATURES: ReadonlySet<OrgFeatureKey> = new Set<OrgFeatureKey>(['online_store'])

export function resolveOrgFeatures(raw: unknown, defaults?: Partial<OrgFeatures>): OrgFeatures {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = {} as OrgFeatures
  for (const key of ORG_FEATURE_KEYS) {
    const v = src[key]
    out[key] = typeof v === 'boolean' ? v : (defaults?.[key] ?? !DEFAULT_OFF_FEATURES.has(key))
  }
  return out
}

// ─── Trạng thái dựng quy trình (CRM "mở ra trống") ──────────────
/**
 * `chua_dung`: hệ thống mới — chỉ 3 menu Bắt đầu · Chờ duyệt · Cài đặt, mọi trang khác chuyển về Bắt đầu.
 * `dang_dung`: đã duyệt gói dựng của AI, đang nhập dữ liệu — menu đủ theo gói + mục Bắt đầu.
 * `da_dung`: dùng bình thường. Khoá `setup_status` VẮNG = `da_dung` (fail-open: bản cài cũ không bao giờ bị khoá).
 */
export const SETUP_STATUSES = ['chua_dung', 'dang_dung', 'da_dung'] as const
export type SetupStatus = (typeof SETUP_STATUSES)[number]
export const SETUP_STATUS_SETTING_KEY = 'setup_status'

export function resolveSetupStatus(raw: unknown): SetupStatus {
  const v = typeof raw === 'string' ? raw.trim() : ''
  return (SETUP_STATUSES as readonly string[]).includes(v) ? (v as SetupStatus) : 'da_dung'
}

/** Mặc định của hệ thống CHƯA dựng: module cứng TẮT hết, chỉ giữ "Kết nối & AI" (để nối AI dựng quy trình). */
export const BLANK_SYSTEM_FEATURES: OrgFeatures = Object.fromEntries(
  ORG_FEATURE_KEYS.map((k) => [k, k === 'integrations']),
) as OrgFeatures

/** Có bật tính năng `key` không. */
export function isOrgFeatureOn(features: OrgFeatures, key: OrgFeatureKey): boolean {
  return features[key]
}

/**
 * Bản chạy serverless (Vercel, `TRINITY_RUNTIME=serverless`): một số
 * tính năng cần tiến trình sống lâu (nếu có) có thể bị KHOÁ TẮT cố định — không bật được từ Cài đặt. Nguồn duy nhất cho BE
 * (GET/PUT org-features) và FE (hiện lý do ở Cài đặt > Tính năng).
 */
export const SERVERLESS_LOCKED_FEATURES = {} as const satisfies Partial<Record<OrgFeatureKey, string>>

export type LockedFeatureReasons = Partial<Record<OrgFeatureKey, string>>

/** Cờ chạy serverless: `TRINITY_RUNTIME` = `serverless` (bỏ khoảng trắng, không phân biệt hoa/thường — cùng cách đọc với web/monolith/rbac-nest); không đặt = hành vi VPS cũ. */
export function isServerlessRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.TRINITY_RUNTIME?.trim().toLowerCase() === 'serverless'
}

/** Khoá → lý do bị khoá ở runtime hiện tại (rỗng khi không phải serverless). */
export function lockedFeatureReasons(serverless: boolean): LockedFeatureReasons {
  return serverless ? { ...SERVERLESS_LOCKED_FEATURES } : {}
}

/** Ép các khoá bị khoá về TẮT (ghi đè cấu hình đã lưu). */
export function applyFeatureLocks(features: OrgFeatures, locked: LockedFeatureReasons): OrgFeatures {
  const out = { ...features }
  for (const key of Object.keys(locked) as OrgFeatureKey[]) out[key] = false
  return out
}

// ─── Gói dịch vụ ────────────────────────────────────────────────

/** Khoá gói bán. `custom` = không ràng buộc gì (mặc định cho bản cài đã có, để không vỡ khách đang chạy). */
export const PLAN_KEYS = ['ket_noi', 'tro_ly_giam_doc', 'tro_ly_kinh_doanh', 'tro_ly_van_hanh', 'custom'] as const
export type PlanKey = (typeof PLAN_KEYS)[number]
export const DEFAULT_PLAN: PlanKey = 'custom'

/** Cờ mới do gói quyết định (các cờ cũ không bị gói đụng tới). */
export const PLAN_GATED_FEATURES = ['ai_briefing', 'zalo_oa', 'lead_scoring', 'google_sheets', 'stale_reminders', 'facebook_page'] as const satisfies readonly OrgFeatureKey[]

export interface PlanDefinition {
  label: string
  /** Cờ nằm trong gói (thuộc PLAN_GATED_FEATURES). Cờ không liệt kê = gói không có. */
  features: readonly (typeof PLAN_GATED_FEATURES)[number][]
  /** null = không giới hạn. Gói KHÔNG có hạn mức AI: Trinity không chạy AI, khách trả tiền AI theo gói của chính họ. */
  maxUsers: number | null
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  ket_noi: {
    label: 'Kết nối',
    features: ['google_sheets'],
    maxUsers: 10,
  },
  tro_ly_giam_doc: {
    label: 'Trợ lý Giám đốc',
    features: ['google_sheets', 'ai_briefing'],
    maxUsers: 10,
  },
  tro_ly_kinh_doanh: {
    label: 'Trợ lý Kinh doanh',
    features: ['google_sheets', 'ai_briefing', 'zalo_oa', 'lead_scoring', 'stale_reminders', 'facebook_page'],
    maxUsers: 30,
  },
  tro_ly_van_hanh: {
    label: 'Trợ lý Vận hành',
    features: ['google_sheets', 'ai_briefing', 'zalo_oa', 'lead_scoring', 'stale_reminders', 'facebook_page'],
    maxUsers: 60,
  },
  custom: {
    label: 'Tuỳ biến',
    features: PLAN_GATED_FEATURES,
    maxUsers: null,
  },
}

export function isPlanKey(x: unknown): x is PlanKey {
  return typeof x === 'string' && (PLAN_KEYS as readonly string[]).includes(x)
}

/** Giá trị thô đã lưu (JSON/chuỗi/rác) → khoá gói; không hợp lệ = `custom`. */
export function resolvePlan(raw: unknown): PlanKey {
  return isPlanKey(raw) ? raw : DEFAULT_PLAN
}

/**
 * Cờ hiệu lực = (gói có cờ đó) VÀ (không bị admin tắt tay). Gói chỉ HẠ cờ mới,
 * không bật được cờ gói không có; cờ cũ giữ nguyên như đã lưu.
 */
export function applyPlanToFeatures(features: OrgFeatures, plan: PlanKey): OrgFeatures {
  const allowed = new Set<string>(PLANS[plan].features)
  const out = { ...features }
  for (const key of PLAN_GATED_FEATURES) if (!allowed.has(key)) out[key] = false
  return out
}

