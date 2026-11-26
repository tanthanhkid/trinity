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
  social_posting: { label: 'Đăng đa kênh', group: 'channels', description: 'Soạn một lần, đăng hoặc hẹn giờ ra một hoặc nhiều Fanpage; trợ lý AI soạn và đăng được.' },
  products: { label: 'Sản phẩm', group: 'sales', description: 'Danh mục sản phẩm, dịch vụ và giá.' },
  pos: { label: 'Bán hàng (POS)', group: 'sales', description: 'Bán hàng tại quầy, in hoá đơn.' },
  payments: { label: 'Thanh toán & đối soát', group: 'sales', description: 'Đối soát yêu cầu thanh toán cũ: tự khớp tiền về qua SePay, VNPay, MoMo (không tạo yêu cầu mới).' },
  online_store: { label: 'Trang bán hàng', group: 'sales', description: 'Trang bán hàng online: khách đặt COD hoặc chuyển khoản QR, đơn vào thẳng CRM.' },
  management: { label: 'Quản lý nhân sự', group: 'people', description: 'Nhân viên, phòng ban, team, chức danh, hợp đồng, tuyển dụng.' },
  attendance: { label: 'Chấm công', group: 'people', description: 'Nhân viên tự chấm công, quản lý ngày công.' },
  payroll: { label: 'Lương', group: 'people', description: 'Bảng lương và phiếu lương.' },
  newsfeed: { label: 'Bảng tin', group: 'people', description: 'Bảng tin nội bộ của công ty.' },
  integrations: { label: 'Kết nối & AI', group: 'advanced', description: 'Kết nối trợ lý AI (ChatGPT, Claude, Gemini…), webhook và nhật ký tích hợp.' },
  ai_briefing: { label: 'Bản tin sáng/chiều', group: 'advanced', description: 'Bản tin số liệu sáng và chiều do trợ lý AI của bạn viết.' },
  lead_scoring: { label: 'Chấm điểm khách tiềm năng', group: 'advanced', description: 'Chấm điểm khách theo quy tắc; trợ lý AI chấm thêm ý định mua.' },
  stale_reminders: { label: 'Nhắc việc treo', group: 'advanced', description: 'Nhắc nhân viên liên hệ lại khách hoặc việc quá hạn.' },
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
export const PLAN_KEYS = ['mac_dinh', 'ket_noi', 'tro_ly_giam_doc', 'tro_ly_kinh_doanh', 'tro_ly_van_hanh', 'custom'] as const
export type PlanKey = (typeof PLAN_KEYS)[number]
export const DEFAULT_PLAN: PlanKey = 'custom'

/**
 * Gói của công ty MỚI đăng ký (chế độ nhiều công ty): đủ mọi tính năng, tối đa 10 người. Chủ dự án chưa chốt giá nên
 * KHÔNG cắt tính năng — chỉ giới hạn số người. Công ty 1 và bản cài một công ty giữ `DEFAULT_PLAN` (không giới hạn).
 * Đổi ở đây khi chốt giá.
 */
export const DEFAULT_SIGNUP_PLAN: PlanKey = 'mac_dinh'

/**
 * Khoá công tắc của tính năng ĐÃ GỠ. API và AI nhận rồi bỏ qua (không lỗi) trong một bản phát hành để client cũ không
 * vỡ; JSON `org_features` cũ có khoá này cũng bị bỏ qua. Không dùng lại các khoá này cho tính năng mới.
 */
export const RETIRED_ORG_FEATURE_KEYS: readonly string[] = ['google_sheets', 'commerce_connectors']

export function isRetiredOrgFeatureKey(k: string): boolean {
  return RETIRED_ORG_FEATURE_KEYS.includes(k)
}

/** Cờ mới do gói quyết định (các cờ cũ không bị gói đụng tới). */
export const PLAN_GATED_FEATURES = ['ai_briefing', 'zalo_oa', 'lead_scoring', 'stale_reminders', 'facebook_page'] as const satisfies readonly OrgFeatureKey[]

export interface PlanDefinition {
  label: string
  /** Cờ nằm trong gói (thuộc PLAN_GATED_FEATURES). Cờ không liệt kê = gói không có. */
  features: readonly (typeof PLAN_GATED_FEATURES)[number][]
  /** null = không giới hạn. Gói KHÔNG có hạn mức AI: Trinity không chạy AI, khách trả tiền AI theo gói của chính họ. */
  maxUsers: number | null
  /** Hạn mức kênh gửi ra ngoài (chống lạm dụng app Meta/Zalo dùng chung). Chỉ áp khi chạy nhiều công ty (`MULTI_TENANT=true`). */
  channelLimits: ChannelLimits
}

/**
 * Hạn mức kênh theo công ty. Mọi công ty dùng chung MỘT app Meta/Zalo: một công ty spam ⇒ Meta hạn chế cả app.
 * Đếm ở máy chủ; vượt ⇒ từ chối kèm lời báo rõ. Gói `custom` rộng nhưng vẫn có TRẦN an toàn.
 */
export interface ChannelLimits {
  /** Tin gửi hàng loạt (Messenger broadcast + ZNS Zalo) mỗi ngày. */
  bulkMessagesPerDay: number
  /** Số người nhận tối đa của MỘT chiến dịch gửi hàng loạt. */
  recipientsPerCampaign: number
  /** Số bài đăng/hẹn giờ (tính theo từng kênh đích) tạo mỗi ngày. */
  postsPerDay: number
  /** Số lần trả lời bình luận tự động (luật bình luận) mỗi giờ. */
  autoCommentRepliesPerHour: number
}

export const CHANNEL_LIMIT_KEYS = ['bulkMessagesPerDay', 'recipientsPerCampaign', 'postsPerDay', 'autoCommentRepliesPerHour'] as const satisfies readonly (keyof ChannelLimits)[]

export const PLANS: Record<PlanKey, PlanDefinition> = {
  mac_dinh: {
    label: 'Mặc định',
    features: PLAN_GATED_FEATURES,
    maxUsers: 10,
    // Công ty mới đăng ký nhận đủ tính năng nhưng hạn mức kênh bằng gói thấp nhất (`ket_noi`) cho tới khi chốt gói.
    channelLimits: { bulkMessagesPerDay: 200, recipientsPerCampaign: 200, postsPerDay: 10, autoCommentRepliesPerHour: 60 },
  },
  ket_noi: {
    label: 'Kết nối',
    // Cùng hạn mức (người, kênh) với `mac_dinh` nhưng không có tính năng theo gói (Google Sheets đã gỡ, G03). Giá/gói do chủ
    // dự án chốt sau; giữ khoá gói cho dòng cũ.
    features: [],
    maxUsers: 10,
    channelLimits: { bulkMessagesPerDay: 200, recipientsPerCampaign: 200, postsPerDay: 10, autoCommentRepliesPerHour: 60 },
  },
  tro_ly_giam_doc: {
    label: 'Trợ lý Giám đốc',
    features: ['ai_briefing'],
    maxUsers: 10,
    channelLimits: { bulkMessagesPerDay: 300, recipientsPerCampaign: 300, postsPerDay: 15, autoCommentRepliesPerHour: 60 },
  },
  tro_ly_kinh_doanh: {
    label: 'Trợ lý Kinh doanh',
    features: ['ai_briefing', 'zalo_oa', 'lead_scoring', 'stale_reminders', 'facebook_page'],
    maxUsers: 30,
    channelLimits: { bulkMessagesPerDay: 1000, recipientsPerCampaign: 1000, postsPerDay: 40, autoCommentRepliesPerHour: 200 },
  },
  tro_ly_van_hanh: {
    label: 'Trợ lý Vận hành',
    features: ['ai_briefing', 'zalo_oa', 'lead_scoring', 'stale_reminders', 'facebook_page'],
    maxUsers: 60,
    channelLimits: { bulkMessagesPerDay: 3000, recipientsPerCampaign: 2000, postsPerDay: 100, autoCommentRepliesPerHour: 500 },
  },
  custom: {
    label: 'Tuỳ biến',
    features: PLAN_GATED_FEATURES,
    maxUsers: null,
    channelLimits: { bulkMessagesPerDay: 5000, recipientsPerCampaign: 2000, postsPerDay: 200, autoCommentRepliesPerHour: 1000 },
  },
}

export function isPlanKey(x: unknown): x is PlanKey {
  return typeof x === 'string' && (PLAN_KEYS as readonly string[]).includes(x)
}

/**
 * Gói đang áp cho một công ty. `companyId` = số công ty ở chế độ nhiều công ty, `null` = bản cài một công ty.
 * Dòng gói hợp lệ thì theo dòng đó; thiếu/rác: công ty ≥ 2 = `DEFAULT_SIGNUP_PLAN` (có giới hạn, không phải `custom`),
 * công ty 1 / một công ty = `DEFAULT_PLAN`. MỘT cách giải duy nhất cho giới hạn người dùng, tính năng và màn Cài đặt.
 */
export function resolvePlanForCompany(raw: unknown, companyId: number | null): PlanKey {
  if (isPlanKey(raw)) return raw
  return companyId !== null && companyId !== 1 ? DEFAULT_SIGNUP_PLAN : DEFAULT_PLAN
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


/** Hạn mức kênh của gói (không có gói hợp lệ = `custom`). */
export function channelLimitsFor(plan: PlanKey): ChannelLimits {
  return { ...PLANS[plan].channelLimits }
}
