// Dữ liệu giả cho bộ chạy "cố tình phá": một công ty mẫu, đăng nhập bằng quản trị viên.
// `handle(req, scenario)` trả { status, json } theo đường dẫn; `scenario` ghi đè từng tình huống (lỗi, trống, hết hạn token…).
import { ALL_PERMISSIONS, PERMISSIONS } from "@trinity/rbac"

// Mốc thời gian: "hôm nay" là 21/10/2026 (giờ Việt Nam, +07:00).
const at = (day, hm = "09:00") => `2026-10-${String(day).padStart(2, "0")}T${hm}:00+07:00`
const TODAY = 21

/** Quản trị = mọi quyền, phạm vi `all` (FE chỉ đọc `permissions`; `isAdmin` không tự mở quyền). */
const ADMIN_GRANTS = Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, PERMISSIONS[p].scoped ? "all" : true]))

export const ME = {
  user: { id: 1, email: "demo@example.com", full_name: "Chị Lan", avatar_url: null, manager_id: null },
  roles: [{ id: 1, name: "Quản trị", is_system: true }],
  permissions: ADMIN_GRANTS,
  isAdmin: true,
}

// ─── Khung ứng dụng (mọi trang) ───────────────────────────────
const WIZARD = {
  enabled: true,
  completed: true,
  current: null,
  steps: ["ai", "build", "data", "channels", "post"].map((key) => ({ key, done: true, skipped: false, can_skip: true, needs_admin: false })),
}
const SETUP_STATUS = {
  status: "da_dung",
  mcp_url: "https://crm.example.com/api/v1/mcp",
  ai_connected: true,
  ai_granted: true,
  ai_last_active_at: at(TODAY, "08:40"),
  ai_connected_anyone: true,
  can_build: true,
}
/** Bật đủ các mô-đun cần cho 5 màn (thiếu khoá = bật; `online_store` mặc định tắt). */
const ORG_FEATURES = {
  dashboard: true, contacts: true, kanban: true, reports: true, inbox: true,
  facebook_page: true, zalo_oa: true, social_posting: true,
  products: true, pos: false, payments: true, online_store: false, commerce_connectors: false,
  management: true, attendance: false, payroll: false, newsfeed: true,
  integrations: true, ai_briefing: true, lead_scoring: true, stale_reminders: true, google_sheets: false,
}

// ─── Thông báo ────────────────────────────────────────────────
const NOTIFICATIONS = [
  { id: "n1", title: "Khách mới từ Fanpage", body: "Nguyễn Văn Bình vừa nhắn tin hỏi giá gói Cơ bản.", event_type: "contact_assigned", action_url: "/contacts/2", is_read: false, created_at: at(TODAY, "08:15") },
  { id: "n2", title: "Thẻ sắp đến hạn", body: "“Gửi báo giá cho Minh Phát” đến hạn chiều nay.", event_type: "kanban_due_soon", action_url: "/kanban", is_read: false, created_at: at(TODAY, "07:30") },
]

// ─── Hoạt động AI ─────────────────────────────────────────────
const aiAction = (id, status, tool, tool_label, summary, hm, extra = {}) => ({
  id, tool, tool_label, client_name: "Claude", summary, details: [], status, result: null, error: null,
  created_at: at(TODAY, hm), decided_at: status === "pending" ? null : at(TODAY, hm), expires_at: at(TODAY + 1, hm), ...extra,
})
const AI_ACTIONS = [
  aiAction(105, "pending", "create_social_post", "Soạn bài đăng", "Soạn bài “Ưu đãi cuối tháng 10” cho Fanpage", "09:10",
    { details: [{ label: "Kênh", value: "Fanpage Trinity Coffee" }, { label: "Giờ đăng", value: "25/10/2026 19:00" }] }),
  aiAction(104, "executed", "create_contact", "Thêm khách hàng", "Thêm khách hàng Trần Thị Hoa", "08:50", { result: { contact_id: 3 } }),
  aiAction(103, "executed", "create_card", "Tạo công việc", "Tạo việc “Gọi lại chị Hoa” trong bảng Bán hàng", "08:45", { result: { card_id: 4 } }),
  aiAction(102, "executed", "update_contact", "Sửa khách hàng", "Chuyển Lê Quốc Huy sang giai đoạn Đang tư vấn", "08:20", { result: { contact_id: 4 } }),
]

// ─── Tổng quan ────────────────────────────────────────────────
const DASHBOARD_CHANNELS = {
  channels: [
    { key: "fb-1", kind: "facebook_page", network: "facebook", name: "Trinity Coffee", state: "ok", note: "Đang nhận tin nhắn", today: { label: "tin nhắn", value: 12 }, href: "/connections" },
    { key: "zalo-1", kind: "zalo_oa", network: "zalo", name: "Trinity Coffee OA", state: "attention", note: "Cần kết nối lại", today: null, href: "/connections" },
    { key: "yt-1", kind: "social", network: "youtube", name: "Trinity Coffee TV", state: "ok", note: "Đã đăng 1 bài tuần này", today: { label: "bài đăng", value: 0 }, href: "/social" },
  ],
  available: [{ kind: "payment", label: "Thanh toán", href: "/connections" }],
}

const DASHBOARD_OVERVIEW = {
  scope_label: "toàn hệ thống",
  customers: { total: 6, new_this_month: 4, new_last_month: 2 },
  opportunities: { open: 3, new_this_month: 2, new_last_month: 1 },
  revenue: { this_month: 18_500_000, last_month: 12_000_000 },
  deal_status: { open: 3, won: 2, lost: 1 },
  months: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
  customers_by_month: [0, 0, 0, 0, 2, 4],
  opportunities_by_month: [0, 0, 0, 1, 1, 2],
  revenue_by_month: [null, null, null, 4_000_000, 12_000_000, 18_500_000],
}
const DASHBOARD_TASKS = {
  total: 2,
  due_today: 1,
  overdue: 1,
  items: [
    { key: "kanban-2", kind: "kanban", id: 2, title: "Gửi báo giá cho Minh Phát", contact_id: 5, contact_name: "Công ty Minh Phát", due_at: at(TODAY, "17:00"), priority: "high", overdue: false },
    { key: "kanban-4", kind: "kanban", id: 4, title: "Gọi lại chị Hoa", contact_id: 3, contact_name: "Trần Thị Hoa", due_at: at(20, "16:00"), priority: "normal", overdue: true },
  ],
}

// ─── Khách hàng ───────────────────────────────────────────────
const opt = (id, group_key, value, label, sort_order) => ({ id, group_key, value, label, sort_order, is_active: true, is_system: false, metadata: null })
const OPTIONS = {
  contact_stage: [opt(11, "contact_stage", "new", "Mới", 1), opt(12, "contact_stage", "consulting", "Đang tư vấn", 2), opt(13, "contact_stage", "won", "Đã mua", 3)],
  contact_detail_status: [opt(21, "contact_detail_status", "called", "Đã gọi", 1), opt(22, "contact_detail_status", "no_answer", "Không nghe máy", 2)],
  contact_source: [opt(31, "contact_source", "facebook", "Fanpage", 1), opt(32, "contact_source", "zalo", "Zalo OA", 2), opt(33, "contact_source", "referral", "Giới thiệu", 3)],
}
const lite = (o) => ({ id: o.id, value: o.value, label: o.label })
const [ST_NEW, ST_CONSULT, ST_WON] = OPTIONS.contact_stage
const [SRC_FB, SRC_ZALO, SRC_REF] = OPTIONS.contact_source
const USERS = [
  { id: 1, full_name: "Chị Lan", email: "demo@example.com" },
  { id: 2, full_name: "Anh Tuấn", email: "tuan@example.com" },
]
const contact = (id, full_name, phone, stage, source, assignee, day, extra = {}) => ({
  id: String(id), full_name, phone, avatar_url: null,
  source: lite(source), source_locked: false,
  stage_option: lite(stage), contact_status: null, stage: stage.label, stage_source: "stage",
  lead_score: null, lead_label: null,
  assigned_to: String(assignee.id), assignee_name: assignee.full_name, assignee_email: assignee.email,
  team_id: "1", team_name: "Kinh doanh",
  created_at: at(day, "10:00"), latest_deal: null, creator: { id: 1, full_name: "Chị Lan", role: "Quản trị" },
  ...extra,
})
const CONTACTS = [
  contact(1, "Phạm Thu Trang", "0901 234 ***", ST_WON, SRC_REF, USERS[0], 15, { lead_score: 82, lead_label: "hot" }),
  contact(2, "Nguyễn Văn Bình", "0912 345 ***", ST_NEW, SRC_FB, USERS[1], TODAY, { lead_score: 55, lead_label: "warm" }),
  contact(3, "Trần Thị Hoa", "0987 654 ***", ST_CONSULT, SRC_ZALO, USERS[0], 20),
  contact(4, "Lê Quốc Huy", "0935 111 ***", ST_CONSULT, SRC_FB, USERS[1], 18, { lead_score: 30, lead_label: "cold" }),
  contact(5, "Công ty Minh Phát", "0283 822 ***", ST_CONSULT, SRC_REF, USERS[0], 16,
    { latest_deal: { id: 7, title: "Gói Cơ bản 12 tháng", status: "open", creator_name: "Chị Lan", creator_email: "demo@example.com" } }),
  contact(6, "Võ Thị Mai", "0978 222 ***", ST_NEW, SRC_ZALO, USERS[1], 19),
]

// ─── Công việc (Kanban) ───────────────────────────────────────
const BOARD = {
  id: 1, name: "Bán hàng", description: "Theo dõi việc chăm sóc khách", icon: null, color: "#0079bf", is_active: true,
  visibility_role_ids: [], card_prefix: "CV", created_by: 1, created_at: at(1), updated_at: at(TODAY), column_count: 3, card_count: 5,
}
const column = (id, name, position, is_done = false) => ({ id, board_id: 1, name, color: null, position, wip_limit: null, is_done, is_archived: false, created_at: at(1), updated_at: at(1) })
const COLUMNS = [column(1, "Cần làm", 1), column(2, "Đang làm", 2), column(3, "Xong", 3, true)]
const LABEL_DEFS = [{ id: "l1", name: "Gấp", color: "#eb5a46" }, { id: "l2", name: "Báo giá", color: "#0079bf" }]
const card = (id, column_id, position, title, extra = {}) => ({
  id, code: `CV${String(id).padStart(3, "0")}`, board_id: 1, column_id, position, title, description: null,
  contact_id: null, assignee_id: 1, assignee_ids: [1], created_by: 1, due_at: null, due_completed_at: null,
  priority: "normal", labels: [], attributes: {}, completed_at: null, created_at: at(18), updated_at: at(TODAY),
  contact: null, is_overdue: false, checklist_total: 0, checklist_done: 0, comment_count: 0, attachment_count: 0, ...extra,
})
const cardContact = (c) => ({ id: Number(c.id), full_name: c.full_name, phone: c.phone, masked: true })
const CARDS = [
  card(1, 1, 1, "Tư vấn gói cho anh Bình", { contact_id: 2, contact: cardContact(CONTACTS[1]), due_at: at(22, "10:00") }),
  card(2, 1, 2, "Gửi báo giá cho Minh Phát", { contact_id: 5, contact: cardContact(CONTACTS[4]), priority: "high", labels: ["l1", "l2"], due_at: at(TODAY, "17:00"), checklist_total: 3, checklist_done: 1 }),
  card(3, 2, 1, "Chuẩn bị hợp đồng chị Trang", { contact_id: 1, contact: cardContact(CONTACTS[0]), assignee_id: 2, assignee_ids: [2, 1], comment_count: 2 }),
  card(4, 2, 2, "Gọi lại chị Hoa", { contact_id: 3, contact: cardContact(CONTACTS[2]), due_at: at(20, "16:00"), is_overdue: true }),
  card(5, 3, 1, "Gửi lời cảm ơn khách tháng 9", { priority: "low", completed_at: at(19, "15:00") }),
]
const cardsPage = (cards) => ({ cards, next_cursor: null, has_more: false })

// ─── Đăng đa kênh ─────────────────────────────────────────────
const SOCIAL_ACCOUNTS = [
  { id: 1, network: "facebook", name: "Trinity Coffee", avatar_url: null, status: "active", last_error: null, inbox: "on" },
  { id: 2, network: "youtube", name: "Trinity Coffee TV", avatar_url: null, status: "reauth", last_error: "Quyền truy cập YouTube đã hết hạn, cần kết nối lại." },
]
const target = (id, acc, status, extra = {}) => ({
  id, account_id: acc.id, account_name: acc.name, network: acc.network, caption: null, status, attempts: status === "queued" ? 0 : 1,
  url: null, last_error: null, published_at: null, options: null, metrics: null, metrics_at: null, ...extra,
})
const [FB, YT] = SOCIAL_ACCOUNTS
const SOCIAL_POSTS = [
  { id: 3, content: "Ưu đãi cuối tuần: mua 2 tặng 1 cho mọi món cà phê sữa ☕", media: [], scheduled_at: at(25, "19:00"), status: "scheduled", source: "web", created_at: at(TODAY, "08:00"),
    targets: [target(31, FB, "queued")] },
  { id: 2, content: "Video hướng dẫn pha cold brew tại nhà", media: [], scheduled_at: at(20, "20:00"), status: "partial", source: "web", created_at: at(20, "14:00"),
    targets: [
      target(21, FB, "published", { url: "https://facebook.com/", published_at: at(20, "20:00"), metrics: { views: 1240, reactions: 86, comments: 12, shares: 5 }, metrics_at: at(TODAY, "06:00") }),
      target(22, YT, "failed", { attempts: 3, last_error: "YouTube từ chối: phiên đăng nhập đã hết hạn, hãy kết nối lại kênh." }),
    ] },
  { id: 1, content: "Chào tháng 10 — menu mùa thu đã có mặt tại quán!", media: [], scheduled_at: null, status: "published", source: "ai", created_at: at(1, "09:00"),
    targets: [target(11, FB, "published", { url: "https://facebook.com/", published_at: at(1, "09:00"), metrics: { views: 3100, reactions: 210, comments: 34, shares: 18 }, metrics_at: at(TODAY, "06:00") })] },
]
const SOCIAL_DRAFTS = [
  { id: 1, title: "Khai trương chi nhánh Quận 3", content: "Sắp khai trương chi nhánh mới, giảm 30% tuần đầu…", media: [], targets: [{ account_id: 1 }], scheduled_at: null, ui: null, source: "web", created_at: at(19), updated_at: at(20) },
  { id: 2, title: null, content: "Ý tưởng: chuỗi video giới thiệu hạt cà phê Cầu Đất", media: [], targets: [], scheduled_at: null, ui: null, source: "ai", created_at: at(TODAY, "07:45"), updated_at: at(TODAY, "07:45") },
]
const SOCIAL_NETWORKS = [
  ["facebook", "Facebook"], ["instagram", "Instagram"], ["youtube", "YouTube"], ["tiktok", "TikTok"], ["google_business", "Google Business"],
].map(([network, label]) => ({ network, label, supported: true, configured: network === "facebook" || network === "youtube", env: [], scopes: [], redirect_uri: null }))

// ─── Kết nối ──────────────────────────────────────────────────
const FACEBOOK_STATUS = {
  configured: true, app_id_set: true, app_secret_set: true, base_url_set: true, verify_token_set: true, secret_key_configured: true,
  graph_version: "v21.0", webhook_url: "https://crm.example.com/api/v1/facebook/webhook", oauth_redirect_uri: "https://crm.example.com/api/v1/facebook/callback",
  scopes: ["pages_messaging", "pages_manage_posts"], comment_automation: true,
}
const fbPage = (id, page_id, name, token_status, extra = {}) => ({
  id, page_id, name, token_status, token_checked_at: at(TODAY, "06:00"), token_expires_at: null, data_access_expires_at: "2026-12-20T09:00:00+07:00",
  subscribed: true, default_assignee_id: 1, contact_source_id: 31, is_active: true, created_at: at(1), posting: "on", disconnected: false, ...extra,
})
const FACEBOOK_PAGES = [
  fbPage(1, "1000001", "Trinity Coffee", "active"),
  fbPage(2, "1000002", "Trinity Coffee Quận 3", "expired", { posting: null, token_expires_at: at(19) }),
]
const ZALO_STATUS = {
  configured: true, webhook_secret_configured: true, secret_key_configured: true, connected: true, oa_id: "4321098765",
  status: "needs_reauth", access_expires_at: at(18), refresh_expires_at: at(19),
  last_error: "Mã làm mới của Zalo đã hết hạn, cần kết nối lại OA.", redirect_uri: "https://crm.example.com/api/v1/zalo-oa/callback", webhook_path: "/api/v1/zalo-oa/webhook",
}
const connector = (provider, extra = {}) => ({ provider, connected: false, status: "not_connected", settings: null, last_event_at: null, last_error: null, webhook_path: `/api/v1/connectors/${provider}/webhook`, secret_key_configured: true, server_configured: true, ...extra })
const CONNECTORS = [
  connector("sepay", { connected: true, status: "active", settings: { bank: "Vietcombank", account_number: "0123***789", account_name: "TRINITY COFFEE", code_prefix: "TC" }, last_event_at: at(TODAY, "08:05") }),
  connector("vnpay"),
  connector("momo"),
]
const INTEGRATIONS_STATUS = { webhooks_enabled: true, mcp_enabled: true, secret_key_configured: true, mcp_base_url_configured: true, mcp_url: "https://crm.example.com/api/v1/mcp" }

/** Bảng trả lời mặc định: khoá = "METHOD /đường-dẫn" (khớp đúng) hoặc RegExp trên "METHOD /đường-dẫn". */
export const ROUTES = [
  // Khung ứng dụng
  ["GET /auth/me", () => ME],
  ["GET /setup/wizard", () => WIZARD],
  ["GET /setup/status", () => SETUP_STATUS],
  ["GET /settings/org-features", () => ORG_FEATURES],
  ["GET /telemetry/config", () => ({ sentry: null, posthog: null })],
  ["GET /users/me/pinned-menu", () => ({ keys: [] })],

  // Thông báo (chuông + trang chủ)
  ["GET /notifications/unread-count", (req) => ({ count: req.query.category === "message" ? 0 : NOTIFICATIONS.length })],
  ["GET /notifications", (req) => ({ data: NOTIFICATIONS.filter((n) => req.query.read === undefined || String(n.is_read) === req.query.read), next_cursor: null })],

  // Hoạt động AI
  ["GET /integrations/ai-actions/pending-count", () => ({ pending: AI_ACTIONS.filter((a) => a.status === "pending").length })],
  ["GET /integrations/ai-actions", (req) => ({ data: AI_ACTIONS.filter((a) => !req.query.status || a.status === req.query.status), next_cursor: null })],
  ["GET /integrations/ai-connections", () => ({
    data: [{ id: "c1", client_id: "claude", client_name: "Claude", client_kind: "dcr", user: { id: 1, full_name: "Chị Lan", email: "demo@example.com" }, scopes: ["crm"], connected_at: at(14), last_used_at: at(TODAY, "09:10"), refresh_expires_at: at(31) }],
  })],

  // Menu: bảng tuỳ biến (không có) + khách xem gần đây
  ["GET /custom-objects/nav", () => []],
  ["GET /contacts/recent", () => CONTACTS.slice(0, 3).map((c, i) => ({ id: Number(c.id), full_name: c.full_name, viewed_at: at(TODAY, `0${8 - i}:00`) }))],

  // Tổng quan
  ["GET /reports/dashboard-channels", () => DASHBOARD_CHANNELS],
  ["GET /reports/dashboard-overview", () => DASHBOARD_OVERVIEW],
  ["GET /reports/dashboard-tasks", () => DASHBOARD_TASKS],
  ["GET /reports/dashboard-filter-roster", () => ({ dept_heads: [{ id: 1, full_name: "Chị Lan", manager_id: null }], team_leads: [], sales: [{ id: 2, full_name: "Anh Tuấn", manager_id: 1 }] })],

  // Khách hàng (danh sách phân trang {data, meta})
  ["GET /contacts", () => ({ data: CONTACTS, meta: { total: CONTACTS.length, page: 1, pages: 1, limit: 50 } })],
  ["GET /contacts/assignable-users", () => USERS],
  ["GET /settings/options", (req) => ({ data: OPTIONS[req.query.group] ?? [] })],
  ["GET /projects", () => []],
  ["GET /users", () => ({ data: USERS })],

  // Công việc
  ["GET /kanban/boards", () => [BOARD]],
  ["GET /kanban/boards/templates", () => []],
  [/^GET \/kanban\/boards\/\d+$/, () => ({ ...BOARD, columns: COLUMNS, field_defs: [], label_defs: LABEL_DEFS })],
  ["GET /kanban/cards", (req) => cardsPage(CARDS.filter((c) => !req.query.column_id || c.column_id === Number(req.query.column_id)))],

  // Đăng đa kênh (mọi danh sách bọc trong {data})
  ["GET /social/accounts", () => ({ data: SOCIAL_ACCOUNTS })],
  ["GET /social/networks", () => ({ data: SOCIAL_NETWORKS })],
  ["GET /social/posts", () => ({ data: SOCIAL_POSTS, next_cursor: null })],
  ["GET /social/drafts", () => ({ data: SOCIAL_DRAFTS })],
  ["GET /social/snippets", () => ({ data: [{ id: 1, kind: "signature", name: "Chữ ký quán", content: "— Trinity Coffee, 12 Lê Lợi, Q.1", is_default: true, position: 1 }] })],
  ["GET /social/queue/slots", () => ({ data: [{ weekday: 2, minute: 19 * 60 }, { weekday: 5, minute: 19 * 60 }] })],
  ["GET /social/recurrences", () => ({ data: [] })],
  ["POST /social/posts/sync", () => ({ checked: 2, removed: 0 })],

  // Kết nối
  ["GET /integrations/status", () => INTEGRATIONS_STATUS],
  ["GET /facebook/status", () => FACEBOOK_STATUS],
  ["GET /facebook/pages", () => ({ data: FACEBOOK_PAGES })],
  ["GET /zalo-oa/status", () => ZALO_STATUS],
  ["GET /connectors", () => CONNECTORS],
  ["GET /integrations/webhooks/endpoints", () => ({ data: [] })],
  ["GET /integrations/webhooks/inbound-sources", () => ({ data: [] })],
]

export function handle(req, scenario = {}) {
  const key = `${req.method} ${req.path}`
  for (const [pattern, fn] of Object.entries(scenario)) {
    if (pattern === key || (pattern.startsWith("/") && new RegExp(pattern.slice(1, -1)).test(key))) return fn(req)
  }
  for (const [pattern, fn] of ROUTES) {
    if (typeof pattern === "string" ? pattern === key : pattern.test(key)) return { status: 200, json: fn(req) }
  }
  return undefined
}
