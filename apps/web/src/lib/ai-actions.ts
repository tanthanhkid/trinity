/**
 * Hoạt động AI: thao tác ghi do AI (ChatGPT/Claude qua MCP) thực hiện theo quyền của người dùng (mặc định ghi thẳng, `executed`);
 * khi quản trị bật "Yêu cầu duyệt thay đổi do AI" thì AI chỉ tạo đề xuất `pending` chờ CHÍNH người dùng duyệt.
 * Mọi chuỗi từ BE (summary/details/error/client_name) là văn bản do AI/khách nhập: LUÔN hiển thị bằng text node của React
 * (không dangerouslySetInnerHTML); SĐT đã được BE che — FE không tự che/không tự suy ra SĐT.
 */
export type AiActionStatus = "pending" | "executing" | "approved" | "executed" | "rejected" | "expired" | "failed"

export interface AiActionDetail {
  label: string
  value: string
}

export interface AiAction {
  id: number
  tool: string
  tool_label: string
  client_name: string | null
  summary: string
  details: AiActionDetail[]
  status: AiActionStatus
  result: Record<string, unknown> | null
  error: string | null
  created_at: string
  decided_at: string | null
  expires_at: string
  /** ảnh hưởng của đổi cấu trúc — có `confirm_label` thì phải gõ đúng tên bảng mới duyệt được (BE kiểm). */
  impact?: AiActionImpact | null
}

export interface AiActionImpact {
  affected_records: number
  confirm_label: string | null
  lines: string[]
  tables: { key: string; label: string; records: number }[]
}

/** So tên bảng gõ lại — cùng luật BE (bỏ khoảng trắng thừa, không phân biệt hoa/thường). */
export const confirmMatches = (typed: string, label: string): boolean => {
  const n = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
  return n(typed) === n(label)
}

export interface AiActionPage {
  data: AiAction[]
  next_cursor: number | null
}

export const AI_ACTION_STATUS_LABEL: Record<AiActionStatus, string> = {
  pending: "Chờ duyệt",
  executing: "Đang thực hiện",
  approved: "Đã duyệt",
  executed: "Đã thực hiện",
  rejected: "Đã từ chối",
  expired: "Hết hạn",
  failed: "Thất bại",
}

export const AI_ACTION_STATUS_VARIANT: Record<AiActionStatus, "soft" | "success" | "secondary" | "destructive"> = {
  pending: "soft",
  executing: "soft",
  approved: "success",
  executed: "success",
  rejected: "secondary",
  expired: "secondary",
  failed: "destructive",
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null)

/** Liên kết tới thứ vừa được tạo/sửa (chỉ đường dẫn nội bộ cố định, id lấy từ `result` do BE ghi). */
export function aiActionResultLink(a: Pick<AiAction, "status" | "result">): { href: string; label: string } | null {
  if ((a.status !== "approved" && a.status !== "executed") || !a.result) return null
  const contact = num(a.result.contact_id)
  if (contact) return { href: `/contacts/${contact}`, label: "Mở khách hàng" }
  if (num(a.result.card_id)) return { href: "/kanban", label: "Mở công việc" }
  // gói dựng, màn xem, nhập dữ liệu… trả `open_at` (đường nội bộ, chỉ nhận dạng "/x/…", "/contacts", "/bat-dau").
  const open = a.result.open_at
  const href = Array.isArray(open) ? open[0] : open
  if (typeof href === "string" && /^\/(x\/[a-z0-9_/]+|contacts|bat-dau)$/.test(href)) return { href, label: "Mở màn vừa dựng" }
  return null
}

/** Thông điệp THẬT của BE — class-validator trả mảng; lỗi 403/404/409 của duyệt có lý do cụ thể. */
export function aiActionErrorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message
  if (Array.isArray(msg)) return msg.join("; ")
  return typeof msg === "string" && msg ? msg : fallback
}

export const isAiActionsDisabled = (err: unknown): boolean => (err as { response?: { status?: number } })?.response?.status === 404
