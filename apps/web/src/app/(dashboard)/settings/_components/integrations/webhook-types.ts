import { errorMessage } from "@/lib/error-messages"
/** Kiểu + hằng cho Webhook ra/vào. Khớp BE `services/crm/src/integrations/webhooks/**`. */

export interface WebhookEventDef {
  type: string
  resource: string
  label: string
}

export interface WebhookEndpoint {
  id: number
  name: string
  url: string
  events: string[]
  is_active: boolean
  disabled_reason: string | null
  created_by: number
  created_at: string
  updated_at: string
  last_success_at: string | null
  last_failure_at: string | null
  consecutive_failures: number
}

/** Phản hồi tạo / tạo lại secret: secret chỉ có ở đây, MỘT lần. */
export type WebhookEndpointWithSecret = WebhookEndpoint & { secret: string }

export type DeliveryStatus = "pending" | "success" | "failed" | "dead"

export interface WebhookDelivery {
  id: string
  endpoint_id: number
  event_id: string | null
  event_type: string
  status: DeliveryStatus
  attempts: number
  next_attempt_at: string
  last_status_code: number | null
  last_error: string | null
  created_at: string
  delivered_at: string | null
}

export interface DeliveriesPage {
  data: WebhookDelivery[]
  meta: { next_cursor: string | null }
}

export interface PingResult {
  delivery_id: string
  ok: boolean
  status_code: number | null
  error: string | null
  duration_ms: number
}

export interface InboundSource {
  id: number
  name: string
  token_prefix: string
  signed: boolean
  default_assignee_id: number
  contact_source_id: number
  project_id: number | null
  is_active: boolean
  created_by: number
  created_at: string
  updated_at: string
  last_received_at: string | null
}

/** Phản hồi tạo / tạo lại token: `token`, `path` (+ `signing_secret`) chỉ có ở đây, MỘT lần. */
export type InboundSourceWithToken = InboundSource & { token: string; path: string; signing_secret?: string }

export interface SimpleOption {
  id: number
  label: string
}

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  pending: "Đang chờ",
  success: "Thành công",
  failed: "Lỗi — sẽ thử lại",
  dead: "Đã dừng",
}

/** Nhóm sự kiện theo tài nguyên (checkbox nhóm trong form). */
export const RESOURCE_GROUP_LABELS: Record<string, string> = {
  contact: "Khách hàng",
  deal: "Deal",
  pos_order: "Bán hàng (POS)",
  zalo_oa_thread: "Zalo OA",
  messenger_conversation: "Messenger",
  messenger_broadcast: "Gửi tin hàng loạt",
  facebook_comment: "Bình luận Fanpage",
  social_post: "Đăng bài mạng xã hội",
}

export const DISABLED_REASON_LABELS: Record<string, string> = {
  manual: "Đã tắt thủ công",
  consecutive_failures: "Tự tắt vì lỗi liên tiếp 20 lần",
  creator_unauthorized: "Tự tắt: người tạo không còn quyền / bị khoá",
}

/** Mã lỗi ngắn từ BE → câu tiếng Việt (BE không bao giờ trả nội dung phản hồi của bên nhận). */
export function deliveryErrorText(code: string | null, status: number | null): string {
  if (!code) return status ? `HTTP ${status}` : "—"
  const map: Record<string, string> = {
    timeout: "Quá 10 giây không phản hồi",
    dns_error: "Không phân giải được tên miền",
    connection_refused: "Bên nhận từ chối kết nối",
    connection_reset: "Kết nối bị ngắt",
    unreachable: "Không tới được máy chủ nhận",
    tls_error: "Lỗi chứng chỉ HTTPS",
    blocked_target: "Địa chỉ bị chặn (không phải IP công cộng)",
    redirect_not_followed: "Bên nhận trả chuyển hướng (3xx) — Trinity không theo chuyển hướng",
    network_error: "Lỗi mạng",
    secret_unavailable: "Máy chủ không giải mã được secret (kiểm tra INTEGRATIONS_SECRET_KEY)",
    secret_error: "Lỗi secret",
    creator_unauthorized: "Người tạo không còn quyền",
    no_longer_visible: "Người tạo không còn xem được bản ghi này",
    endpoint_changed: "Đã huỷ vì endpoint bị đổi URL",
    endpoint_disabled: "Đã huỷ vì endpoint bị tắt",
    endpoint_inactive: "Endpoint đang tắt",
    attempts_exhausted: "Hết lượt thử",
  }
  if (map[code]) return map[code]
  const http = /^http_(\d{3})$/.exec(code)
  return http ? `Bên nhận trả HTTP ${http[1]}` : code
}

/** Lấy thông điệp lỗi THẬT từ BE — class-validator trả mảng. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  return errorMessage(err, fallback)
}

/** Gom sự kiện theo tài nguyên, giữ thứ tự BE trả. */
export function groupEvents(events: WebhookEventDef[]): Array<{ resource: string; label: string; items: WebhookEventDef[] }> {
  const out = new Map<string, { resource: string; label: string; items: WebhookEventDef[] }>()
  for (const e of events) {
    const g = out.get(e.resource) ?? { resource: e.resource, label: RESOURCE_GROUP_LABELS[e.resource] ?? e.resource, items: [] }
    g.items.push(e)
    out.set(e.resource, g)
  }
  return [...out.values()]
}

/** Đường dẫn công khai đầy đủ của webhook vào (đường dẫn BE bắt đầu bằng `/api/v1/…`, web proxy cùng origin). */
export function inboundUrl(path: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin
  return `${origin}${path}`
}

export function curlExample(url: string, signed: boolean): string {
  const body = `'{"name":"Nguyễn Văn A","phone":"0900000001","email":"a@example.com","note":"quan tâm gói A","source":"Landing page","external_id":"lead-123"}'`
  const sig = signed ? ` \\\n  -H "X-Trinity-Signature: t=<unix>,v1=<hmac>"` : ""
  return `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json'${sig} \\\n  -d ${body}`
}
