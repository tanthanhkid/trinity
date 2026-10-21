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
/** Bật đủ các mô-đun cần cho các màn có dữ liệu giả (thiếu khoá = bật; `online_store` mặc định tắt). */
const ORG_FEATURES = {
  dashboard: true, contacts: true, kanban: true, reports: true, inbox: true,
  facebook_page: true, zalo_oa: true, social_posting: true,
  products: true, pos: true, payments: true, online_store: false, commerce_connectors: false,
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

// ─── Tương tác / Hộp thư ──────────────────────────────────────
const interaction = (key, channel, type, when, customer_name, text, status, extra = {}) => ({
  key, channel, type, page_id: channel === "facebook" ? "1000001" : null, channel_name: channel === "facebook" ? "Trinity Coffee" : "Trinity Coffee OA",
  at: when, customer_name, contact_id: null, text, post_url: null, rule_name: null, auto_result: null, hidden: false, status, ref: {}, ...extra,
})
const INTERACTIONS = [
  interaction("fbc-c1", "facebook", "comment", at(TODAY, "09:05"), "Nguyễn Văn Bình", "Gói Cơ bản giá bao nhiêu vậy shop?", "unanswered",
    { contact_id: 2, post_url: "https://facebook.com/", ref: { comment_id: "c1" } }),
  interaction("fbm-1", "facebook", "message", at(TODAY, "08:52"), "Lê Quốc Huy", "Mai quán mở cửa mấy giờ ạ?", "staff", { contact_id: 4, ref: { conversation_id: 1 } }),
  interaction("zalo-1", "zalo", "message", at(TODAY, "08:30"), "Trần Thị Hoa", "Chị đặt 2 ly cold brew giao 10h nhé", "unanswered", { contact_id: 3, ref: { thread_id: 1 } }),
  interaction("fbc-c2", "facebook", "comment", at(TODAY, "07:40"), "Hồ Minh Khang", "Ib em giá nhé, sđt 0909 *** ***", "auto", {
    post_url: "https://facebook.com/", rule_name: "Hỏi giá", auto_result: "Luật “Hỏi giá” đã trả lời và ẩn bình luận có số điện thoại", hidden: true, ref: { comment_id: "c2" },
  }),
  interaction("zalo-2", "zalo", "message", at(20, "17:15"), "Võ Thị Mai", "Cảm ơn quán, cà phê ngon lắm!", "answered", { contact_id: 6, ref: { thread_id: 2 } }),
]
const INTERACTION_STATS = { messages_today: 2, comments_today: 2, auto_handled_today: 1, unanswered_7d: 2 }
const COMMENT_THREAD = {
  comments: [{ id: "c1", message: "Gói Cơ bản giá bao nhiêu vậy shop?", at: at(TODAY, "09:05"), status: "no_match", hidden: false, can_private_reply: true, actions: {} }],
  conversation: { id: 2, customer_name: "Nguyễn Văn Bình" },
  messages: [{ id: "f21", direction: "in", text: "Cho mình xin bảng giá với", at: at(TODAY, "09:06") }],
}
const zaloThread = (id, display_name, preview, last_message_at, last_inbound_at, unread_count, contact_id) => ({
  id, zalo_user_id: `84000000000${id}`, display_name, avatar_url: null, phone: null, contact_id, last_message_preview: preview, last_message_at, last_inbound_at, unread_count,
})
const ZALO_THREADS = [
  zaloThread(1, "Trần Thị Hoa", "Chị đặt 2 ly cold brew giao 10h nhé", at(TODAY, "08:30"), at(TODAY, "08:30"), 1, 3),
  zaloThread(2, "Võ Thị Mai", "Dạ quán cảm ơn chị ạ!", at(20, "17:20"), at(20, "17:15"), 0, 6),
]
const zaloMsg = (id, direction, text, created_at) => ({ id, direction, kind: "text", text, status: direction === "in" ? "received" : "sent", error: null, created_at })
const ZALO_MESSAGES = {
  1: [zaloMsg("z11", "in", "Quán ơi còn cold brew không?", at(TODAY, "08:25")), zaloMsg("z12", "out", "Dạ còn chị ạ, 45.000đ/ly.", at(TODAY, "08:27")), zaloMsg("z13", "in", "Chị đặt 2 ly cold brew giao 10h nhé", at(TODAY, "08:30"))],
  2: [zaloMsg("z21", "in", "Cảm ơn quán, cà phê ngon lắm!", at(20, "17:15")), zaloMsg("z22", "out", "Dạ quán cảm ơn chị ạ!", at(20, "17:20"))],
}
const fbConv = (id, customer_name, preview, last_message_at, last_inbound_at, unread_count, can_reply = true) => ({
  id, page_id: "1000001", page_name: "Trinity Coffee", psid: `70000000000${id}`, customer_name, last_inbound_at, last_message_at,
  last_message_preview: preview, unread_count, can_reply, reply_mode: can_reply ? "standard" : "closed",
})
const FB_CONVERSATIONS = [
  fbConv(2, "Nguyễn Văn Bình", "Cho mình xin bảng giá với", at(TODAY, "09:06"), at(TODAY, "09:06"), 1),
  fbConv(1, "Lê Quốc Huy", "Dạ 7h sáng quán mở cửa anh nhé", at(TODAY, "08:55"), at(TODAY, "08:52"), 0),
  fbConv(3, "Đặng Thu Hà", "Ok bạn, hẹn tuần sau", at(10, "15:00"), at(10, "15:00"), 0, false),
]
const fbMsg = (id, direction, text, sent_at) => ({ id, direction, text, sent_at, sent_by_user_id: direction === "out" ? 1 : null })
const FB_MESSAGES = {
  1: [fbMsg("f11", "in", "Mai quán mở cửa mấy giờ ạ?", at(TODAY, "08:52")), fbMsg("f12", "out", "Dạ 7h sáng quán mở cửa anh nhé", at(TODAY, "08:55"))],
  2: [fbMsg("f21", "in", "Cho mình xin bảng giá với", at(TODAY, "09:06"))],
  3: [fbMsg("f31", "out", "Quán gửi bạn thực đơn mới ạ", at(10, "14:50")), fbMsg("f32", "in", "Ok bạn, hẹn tuần sau", at(10, "15:00"))],
}

// ─── Sản phẩm ─────────────────────────────────────────────────
const category = (id, code, name, sort_order) => ({ id, code, name, description: null, is_active: true, sort_order, created_by: 1, created_at: at(1), updated_at: at(1) })
const PRODUCT_CATEGORIES = [category(1, "CAFE", "Cà phê", 1), category(2, "BANH", "Bánh ngọt", 2)]
const product = (id, code, name, category_id, price, extra = {}) => ({
  id, code, name, project_id: null, brand: null, color: null, tags: [], is_featured: false, image_url: null,
  category_id, attributes: {}, description: null, price, is_active: true, created_by: 1, created_at: at(2), updated_at: at(15), ...extra,
})
const PRODUCTS = [
  product(1, "CF-SUA", "Cà phê sữa đá", 1, 29_000, { is_featured: true, tags: ["bán chạy"] }),
  product(2, "CF-DEN", "Cà phê đen", 1, 25_000),
  product(3, "CF-COLD", "Cold brew cam sả", 1, 45_000, { description: "Ủ lạnh 16 giờ, thêm cam và sả tươi." }),
  product(4, "CF-BAC", "Bạc xỉu", 1, 32_000),
  product(5, "BN-CROI", "Bánh sừng bò", 2, 28_000),
  product(6, "BN-TIRA", "Bánh tiramisu", 2, 39_000, { is_active: false, description: "Tạm ngưng bán." }),
]

// ─── Bán hàng tại quầy (POS) ──────────────────────────────────
const POS_SETTINGS = {
  id: 1, store_name: "Trinity Coffee", address: "12 Lê Lợi, Q.1", phone: "0283 822 ***", receipt_footer: "Cảm ơn quý khách!",
  bank_bin: "970436", bank_account_no: "0123***789", bank_account_name: "TRINITY COFFEE", menu_category_ids: [1, 2],
}
const POS_MENU = {
  categories: PRODUCT_CATEGORIES.map(({ id, code, name }) => ({ id, code, name })),
  products: PRODUCTS.filter((p) => p.is_active).map(({ id, code, name, price, image_url, category_id }) => ({ id, code, name, price, image_url, category_id })),
}
const POS_AREAS = [{ id: 1, name: "Tầng trệt", sort_order: 1, is_active: true }]
const posTable = (id, name, open_order = null) => ({ id, area_id: 1, name, sort_order: id, is_active: true, open_order })
const POS_TABLES = [posTable(1, "1", { id: 3, code: "20261021-0003", total: 86_000 }), posTable(2, "2"), posTable(3, "3"), posTable(4, "4")]
const POS_MODIFIERS = [
  { id: 1, group_name: "Đường", name: "Ít đường", price_delta: 0, sort_order: 1, is_active: true },
  { id: 2, group_name: "Thêm", name: "Thêm shot espresso", price_delta: 10_000, sort_order: 2, is_active: true },
]
const POS_SHIFT = { id: 7, opened_by: 1, opened_at: at(TODAY, "07:00"), status: "open", opening_cash: 500_000, closed_at: null, closing_cash_counted: null, expected_cash: null, cash_diff: null, note: null }
const POS_SUMMARY = { paid_orders: 1, void_orders: 1, cash_sales: 86_000, transfer_sales: 0, expected_cash: 586_000 }
const posItem = (id, p, quantity) => ({ id, product_id: p.id, product_name: p.name, unit_price: p.price, quantity, options: [], note: null, line_total: p.price * quantity })
const posOrder = (id, status, hm, items, extra = {}) => {
  const subtotal = items.reduce((s, i) => s + i.line_total, 0)
  return {
    id, code: `20261021-${String(id).padStart(4, "0")}`, shift_id: 7, table_id: null, order_type: "takeaway", status, note: null,
    subtotal, discount_type: "none", discount_value: 0, discount_amount: 0, total: subtotal, created_by: 1, created_at: at(TODAY, hm),
    paid_by: null, paid_at: null, void_reason: null, items, payments: [], ...extra,
  }
}
/** 3 đơn trong ca: 1 đang mở (Bàn 1), 1 đã huỷ, 1 đã thanh toán tiền mặt. */
const POS_ORDERS = [
  posOrder(3, "open", "08:40", [posItem(31, PRODUCTS[0], 2), posItem(32, PRODUCTS[4], 1)], { table_id: 1, order_type: "dine_in" }),
  posOrder(2, "void", "08:10", [posItem(21, PRODUCTS[2], 1)], { void_reason: "Khách đổi ý, chưa pha" }),
  posOrder(1, "paid", "07:15", [posItem(11, PRODUCTS[0], 1), posItem(12, PRODUCTS[3], 1), posItem(13, PRODUCTS[1], 1)], {
    paid_by: 1, paid_at: at(TODAY, "07:20"),
    payments: [{ id: 1, method: "cash", amount: 86_000, tendered: 100_000, change: 14_000, reference: null, shift_id: 7, created_at: at(TODAY, "07:20") }],
  }),
]
const POS_REPORT = {
  date: "2026-10-21", order_count: 1, revenue: 86_000, subtotal: 86_000, discount: 0, avg_order_value: 86_000,
  by_method: [{ method: "cash", amount: 86_000 }, { method: "bank_transfer", amount: 0 }],
  by_product: [
    { product_id: 4, product_name: "Bạc xỉu", quantity: 1, revenue: 32_000 },
    { product_id: 1, product_name: "Cà phê sữa đá", quantity: 1, revenue: 29_000 },
    { product_id: 2, product_name: "Cà phê đen", quantity: 1, revenue: 25_000 },
  ],
  by_hour: [{ hour: 7, orders: 1, revenue: 86_000 }], by_product_truncated: false,
}

// ─── Nhân viên ────────────────────────────────────────────────
const DEPARTMENTS = ["Kinh doanh", "Pha chế"]
const jobTitle = (id, category, rank_code, name, symbol, base_salary) => ({
  id, category, rank_code, name, symbol, base_salary: String(base_salary), standard_target: "0", default_insurance_salary: null,
  review_cycle_months: 6, is_active: true, sort_order: id, created_at: at(1), updated_at: at(1),
})
const JOB_TITLES = [
  jobTitle(1, "Quản lý", "QL1", "Quản lý cửa hàng", "QL", 15_000_000),
  jobTitle(2, "Kinh doanh", "KD1", "Nhân viên kinh doanh", "KD", 8_000_000),
  jobTitle(3, "Pha chế", "PC1", "Nhân viên pha chế", "PC", 7_000_000),
]
const TEAMS = [
  { id: 1, name: "Kinh doanh", department: "Kinh doanh", team_lead_id: 1 },
  { id: 2, name: "Quầy pha chế", department: "Pha chế", team_lead_id: 3 },
]
const employee = (id, code, full_name, email, jt, team, status, joined, extra = {}) => ({
  id, user_id: id, employee_code: code, full_name, email, phone: `09${id}0 123 ***`, avatar_url: null,
  position: jt.name, department: team.department, gender: null, education_level: null, recruitment_source: null,
  status, user_status: "active", role: "sales", team_id: team.id, manager_id: team.team_lead_id === id ? null : team.team_lead_id,
  manager_name: team.team_lead_id === 1 ? "Chị Lan" : "Anh Phúc", team_name: team.name, team_lead_id: team.team_lead_id,
  salary_rule_id: null, insurance_salary: null, job_title_id: jt.id, job_title_name: jt.name, job_title_category: jt.category,
  job_title_rank_code: jt.rank_code, job_title_symbol: jt.symbol, joined_at: joined,
  birth_date: null, id_card_number: null, id_card_issued_date: null, id_card_issued_place: null, permanent_address: null, current_address: null,
  bank_account_number: null, bank_name: null, bank_account_holder: null, office_id: null, office_name: null, registered_device_id: null, device_registered_at: null,
  created_at: joined, ...extra,
})
const [JT_QL, JT_KD, JT_PC] = JOB_TITLES
const [TEAM_KD, TEAM_PC] = TEAMS
/** 5 nhân viên: 1 đã nghỉ (tài khoản khoá — chỉ hiện khi lọc "Nghỉ việc"/"Tất cả"). */
const EMPLOYEES = [
  employee(1, "NV001", "Chị Lan", "demo@example.com", JT_QL, TEAM_KD, "active", "2024-03-01", { role: "admin" }),
  employee(2, "NV002", "Anh Tuấn", "tuan@example.com", JT_KD, TEAM_KD, "active", "2025-06-15"),
  employee(3, "NV003", "Anh Phúc", "phuc@example.com", JT_PC, TEAM_PC, "active", "2024-09-01"),
  employee(4, "NV004", "Bùi Ngọc Ánh", "anh@example.com", JT_PC, TEAM_PC, "probation", "2026-09-20"),
  employee(5, "NV005", "Đỗ Minh Quân", "quan@example.com", JT_KD, TEAM_KD, "resigned", "2025-01-10", { user_status: "locked" }),
]
const employeesPage = (q) => {
  const state = q.employment_state ?? "all"
  const rows = EMPLOYEES.filter((e) => state === "all" || (state === "resigned") === (e.user_status === "locked"))
  return { data: rows, pagination: { total: rows.length, page: Number(q.page ?? 1), page_size: Number(q.page_size ?? 10), total_pages: 1 } }
}

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

  // Tương tác / Hộp thư (Zalo OA + Messenger)
  ["GET /interactions/stats", () => INTERACTION_STATS],
  ["GET /interactions", (req) => ({
    data: INTERACTIONS.filter((i) => (!req.query.type || i.type === req.query.type) && (!req.query.channel || i.channel === req.query.channel) && (!req.query.status || i.status === req.query.status)),
    next_before: null,
  })],
  [/^GET \/interactions\/comments\/[^/]+\/thread$/, () => COMMENT_THREAD],
  ["GET /zalo-oa/threads", () => ({ data: ZALO_THREADS, meta: { next_cursor: null } })],
  [/^GET \/zalo-oa\/threads\/\d+\/messages$/, (req) => ({ data: ZALO_MESSAGES[req.path.split("/")[3]] ?? [] })],
  [/^POST \/zalo-oa\/threads\/\d+\/read$/, () => ({ ok: true })],
  ["GET /facebook/conversations", () => ({ data: FB_CONVERSATIONS })],
  [/^GET \/facebook\/conversations\/\d+\/messages$/, (req) => {
    const id = Number(req.path.split("/")[3])
    return { conversation: FB_CONVERSATIONS.find((c) => c.id === id) ?? FB_CONVERSATIONS[0], messages: FB_MESSAGES[id] ?? [] }
  }],

  // Sản phẩm (danh sách trả mảng trần)
  ["GET /product-categories", () => PRODUCT_CATEGORIES],
  [/^GET \/product-categories\/\d+\/attribute-defs$/, () => []],
  ["GET /products", (req) => PRODUCTS.filter((p) =>
    (req.query.is_active === undefined || String(p.is_active) === req.query.is_active) && (!req.query.category_id || p.category_id === Number(req.query.category_id)))],

  // Bán hàng tại quầy
  ["GET /pos/settings", () => POS_SETTINGS],
  ["GET /pos/menu", () => POS_MENU],
  ["GET /pos/areas", () => POS_AREAS],
  ["GET /pos/tables", () => POS_TABLES],
  ["GET /pos/modifiers", () => POS_MODIFIERS],
  ["GET /pos/shifts/current", () => ({ shift: POS_SHIFT, summary: POS_SUMMARY })],
  ["GET /pos/shifts", () => ({ data: [POS_SHIFT] })],
  [/^GET \/pos\/shifts\/\d+\/summary$/, () => ({ shift: POS_SHIFT, summary: POS_SUMMARY })],
  ["GET /pos/orders", (req) => ({ data: POS_ORDERS.filter((o) => !req.query.status || o.status === req.query.status) })],
  [/^GET \/pos\/orders\/\d+$/, (req) => POS_ORDERS.find((o) => o.id === Number(req.path.split("/")[3])) ?? POS_ORDERS[0]],
  ["GET /pos/reports/daily", () => POS_REPORT],

  // Nhân viên
  ["GET /settings/departments", () => ({ departments: DEPARTMENTS })],
  ["GET /management/teams/for-filter", () => TEAMS],
  ["GET /management/teams", () => TEAMS.map((t) => ({
    ...t, description: null, team_lead_name: t.team_lead_id === 1 ? "Chị Lan" : "Anh Phúc", member_count: EMPLOYEES.filter((e) => e.team_id === t.id).length,
  }))],
  ["GET /management/job-titles", () => JOB_TITLES],
  ["GET /management/employees", (req) => employeesPage(req.query)],
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
