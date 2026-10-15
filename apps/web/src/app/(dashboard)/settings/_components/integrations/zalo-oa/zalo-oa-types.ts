/** Khớp BE `services/crm/src/zalo-oa`. */
export interface ZaloOaStatus {
  configured: boolean
  webhook_secret_configured: boolean
  secret_key_configured: boolean
  connected: boolean
  oa_id: string | null
  status: "active" | "needs_reauth" | "disconnected"
  access_expires_at: string | null
  refresh_expires_at: string | null
  last_error: string | null
  redirect_uri: string | null
  webhook_path: string
}

export interface ZaloOaThread {
  id: number
  zalo_user_id: string
  display_name: string | null
  avatar_url: string | null
  phone: string | null
  contact_id: number | null
  last_message_preview: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  unread_count: number
}

export interface ZaloOaMessage {
  id: string
  direction: "in" | "out"
  kind: "text" | "attachment" | "zns"
  text: string | null
  status: "received" | "sent" | "failed"
  error: string | null
  created_at: string
}

export const CONSULT_WINDOW_MS = 48 * 60 * 60 * 1000

/** Còn trong cửa sổ trả lời 48h kể từ tin gần nhất của khách? */
export function inConsultWindow(lastInboundAt: string | null, now = Date.now()): boolean {
  return lastInboundAt !== null && now - new Date(lastInboundAt).getTime() <= CONSULT_WINDOW_MS
}

export const threadTitle = (t: Pick<ZaloOaThread, "display_name" | "zalo_user_id">): string =>
  t.display_name?.trim() || `Người dùng Zalo ${t.zalo_user_id.slice(-6)}`
