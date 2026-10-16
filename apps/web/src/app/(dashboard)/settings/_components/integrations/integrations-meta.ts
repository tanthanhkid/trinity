import type { OrgFeatureKey, Permission } from "@trinity/rbac"

/** Kênh / trạng thái nhật ký tích hợp — khớp BE (`IntegrationChannel`, `IntegrationAuditStatus`). */
export type IntegrationChannel = "mcp" | "webhook_out" | "webhook_in"
export type IntegrationAuditStatus = "ok" | "denied" | "error"

export const CHANNEL_LABELS: Record<IntegrationChannel, string> = {
  mcp: "Trợ lý AI",
  webhook_out: "Webhook ra",
  webhook_in: "Webhook vào",
}

export const STATUS_LABELS: Record<IntegrationAuditStatus, string> = {
  ok: "Thành công",
  denied: "Bị từ chối",
  error: "Lỗi",
}

export type IntegrationSection = "extensions" | "webhook-out" | "webhook-in" | "facebook" | "google-sheets" | "ai" | "audit" | "zalo-oa" | "payments" | "ban-hang" | "ban-online"

/** Nhóm ở cột trái trang Kết nối (thứ tự = thứ tự hiện). */
export const INTEGRATION_GROUPS = [
  { key: "ai", label: "Trợ lý AI" },
  { key: "channels", label: "Kênh khách" },
  { key: "payments", label: "Thanh toán" },
  { key: "commerce", label: "Bán hàng" },
  { key: "data", label: "Dữ liệu & tự động" },
  { key: "log", label: "Nhật ký" },
] as const
export type IntegrationGroup = (typeof INTEGRATION_GROUPS)[number]["key"]

/** Mục con của trang Kết nối: nhãn + nhóm + quyền nào được thấy + cờ máy chủ nào phải bật. */
export const INTEGRATION_SECTIONS: ReadonlyArray<{
  value: IntegrationSection
  label: string
  group: IntegrationGroup
  anyOf: readonly Permission[]
  flag: "webhooks" | "mcp" | "any" | "always"
  /** Công tắc tổ chức: tắt/không có trong gói ⇒ ẩn mục. */
  feature?: OrgFeatureKey
}> = [
  { value: "webhook-out", label: "Webhook ra", group: "data", anyOf: ["integrations.webhooks"], flag: "webhooks" },
  { value: "webhook-in", label: "Webhook vào", group: "data", anyOf: ["integrations.webhooks"], flag: "webhooks" },
  { value: "facebook", label: "Fanpage Facebook", group: "channels", anyOf: ["integrations.webhooks"], flag: "always", feature: "facebook_page" },
  // Google Sheets: không có cờ env riêng — trạng thái cấu hình (client id/secret) do chính mục này báo.
  { value: "google-sheets", label: "Google Sheets", group: "data", anyOf: ["integrations.webhooks"], flag: "always", feature: "google_sheets" },
  { value: "ai", label: "Trợ lý AI", group: "ai", anyOf: ["integrations.ai_connect", "integrations.ai_admin"], flag: "mcp" },
  { value: "zalo-oa", label: "Zalo OA", group: "channels", anyOf: ["integrations.webhooks", "contacts.update"], flag: "always", feature: "zalo_oa" },
  { value: "payments", label: "Thanh toán", group: "payments", anyOf: ["integrations.webhooks", "deals.view"], flag: "always", feature: "payments" },
  { value: "ban-hang", label: "Phần mềm bán hàng", group: "commerce", anyOf: ["integrations.webhooks", "deals.view"], flag: "always", feature: "commerce_connectors" },
  { value: "ban-online", label: "Trang bán hàng", group: "commerce", anyOf: ["pos.manage", "deals.view"], flag: "always", feature: "online_store" },
  // Chương trình con: không có cờ trong `/integrations/status` — chính màn hình tự báo "chưa bật" khi máy chủ trả 404.
  { value: "extensions", label: "Chương trình con", group: "data", anyOf: ["extensions.view"], flag: "always" },
  { value: "audit", label: "Nhật ký tích hợp", group: "log", anyOf: ["integrations.ai_admin"], flag: "any" },
]

export interface IntegrationsStatus {
  webhooks_enabled: boolean
  mcp_enabled: boolean
  /** `INTEGRATIONS_SECRET_KEY` hợp lệ? Thiếu ⇒ webhook bật cờ vẫn KHÔNG gửi/tạo được. */
  secret_key_configured?: boolean
  /** đã đặt `INTEGRATIONS_PUBLIC_BASE_URL`? Thiếu ⇒ OAuth/MCP vẫn 404 dù cờ MCP bật. */
  mcp_base_url_configured?: boolean
  /** URL dán vào ChatGPT/Claude — `null` khi MCP chưa chạy được. */
  mcp_url?: string | null
}

/** 1 kết nối AI (= 1 chuỗi token OAuth còn hiệu lực) — khớp `GET /integrations/ai-connections`. */
export interface AiConnection {
  id: string
  client_id: string
  client_name: string
  /** 'dcr' (ứng dụng tự đăng ký) | 'cimd' (client_id là URL metadata) */
  client_kind: string
  user: { id: number; full_name: string | null; email: string }
  scopes: string[]
  connected_at: string | null
  last_used_at: string | null
  refresh_expires_at: string
}

export interface IntegrationAuditRow {
  id: string
  created_at: string
  channel: IntegrationChannel
  client_id: string | null
  user_id: number | null
  action: string
  resource: string | null
  resource_id: string | null
  status: IntegrationAuditStatus
  http_status: number | null
  duration_ms: number | null
  error: string | null
  metadata: Record<string, unknown> | null
}

export interface IntegrationAuditPage {
  data: IntegrationAuditRow[]
  meta: { next_cursor: string | null }
}

/** Mục con có chạy được trên máy chủ không (cờ env). `any` = ít nhất một kênh bật. */
export function isSectionEnabled(flag: "webhooks" | "mcp" | "any" | "always", s: IntegrationsStatus | undefined): boolean {
  if (!s) return false
  if (flag === "always") return true
  if (flag === "webhooks") return s.webhooks_enabled
  if (flag === "mcp") return s.mcp_enabled
  return s.webhooks_enabled || s.mcp_enabled
}

/** Tên cờ env để quản trị biết cần bật gì (hiện trong thông báo "chưa bật"). */
export function flagEnvName(flag: "webhooks" | "mcp" | "any" | "always"): string {
  if (flag === "always") return ""
  if (flag === "webhooks") return "INTEGRATIONS_WEBHOOKS_ENABLED"
  if (flag === "mcp") return "INTEGRATIONS_MCP_ENABLED"
  return "INTEGRATIONS_WEBHOOKS_ENABLED hoặc INTEGRATIONS_MCP_ENABLED"
}

/** Ngày (yyyy-mm-dd, giờ VN) → mốc ISO đầu/cuối ngày để lọc nhật ký. */
export function vnDayStartIso(day: string): string {
  return `${day}T00:00:00+07:00`
}
export function vnDayEndIso(day: string): string {
  return `${day}T23:59:59.999+07:00`
}
