/* Cột "Tín hiệu" của bảng Khách hàng — logic THUẦN, chỉ từ dữ liệu THẬT đã có:
 *  - Việc AI làm trên khách (nhật ký Hoạt động AI của CHÍNH người đăng nhập, `GET /integrations/ai-actions`, `result.contact_id`).
 *  - Thương vụ mới nhất (`latest_deal` của `GET /contacts`).
 *  - Nguồn khách (`source.label`).
 * Không có dữ liệu ⇒ không có chip. Không đoán, không bịa. */

import type { AiAction } from "@/lib/ai-actions"
import type { Contact } from "@/hooks/use-contacts"
import { formatTimeVn, vnDateKey } from "@/lib/format"

export type ContactSignalTone = "ai" | "deal-open" | "deal-won" | "deal-lost" | "plain"

export interface ContactSignal {
  key: string
  text: string
  tone: ContactSignalTone
  /** Câu đầy đủ khi rê chuột (văn bản do AI/người dùng soạn ⇒ chỉ dùng làm text/title). */
  title?: string
  href?: string
}

/** Nhãn ngắn theo tool MCP — tool lạ dùng nhãn BE trả (`tool_label`). */
const AI_TOOL_SHORT: Record<string, string> = {
  create_contact: "AI thêm",
  add_contact_note: "AI ghi chú",
  update_contact_stage: "AI đổi giai đoạn",
  assign_contact: "AI chuyển phụ trách",
}

const contactIdOf = (a: Pick<AiAction, "result">): string | null => {
  const v = a.result?.contact_id
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? String(v) : null
}

/**
 * Gom hoạt động AI ĐÃ CÓ HIỆU LỰC (executed/approved) theo khách: mỗi khách lấy hoạt động MỚI NHẤT
 * (danh sách BE trả mới nhất trước — vẫn so `created_at` để không phụ thuộc thứ tự).
 */
export function latestAiActionByContact(rows: readonly AiAction[]): Map<string, AiAction> {
  const out = new Map<string, AiAction>()
  for (const a of rows) {
    if (a.status !== "executed" && a.status !== "approved") continue
    const id = contactIdOf(a)
    if (!id) continue
    const prev = out.get(id)
    if (!prev || Date.parse(a.created_at) > Date.parse(prev.created_at)) out.set(id, a)
  }
  return out
}

/** "09:42" nếu trong hôm nay (giờ VN), ngược lại "dd/mm". */
function whenLabel(iso: string, today: string): string {
  if (vnDateKey(iso) === today) return formatTimeVn(iso)
  const [, m, d] = vnDateKey(iso).split("-")
  return d && m ? `${d}/${m}` : ""
}

const DEAL_TONE: Record<"open" | "won" | "lost", ContactSignalTone> = { open: "deal-open", won: "deal-won", lost: "deal-lost" }
const DEAL_PREFIX: Record<"open" | "won" | "lost", string> = { open: "Thương vụ", won: "Đã chốt", lost: "Mất" }

export function contactSignals(
  c: Pick<Contact, "id" | "source" | "latest_deal">,
  ai: AiAction | undefined,
  today: string,
): ContactSignal[] {
  const out: ContactSignal[] = []
  if (ai) {
    const short = AI_TOOL_SHORT[ai.tool] ?? `AI · ${ai.tool_label}`
    const when = whenLabel(ai.created_at, today)
    out.push({
      key: `ai-${ai.id}`,
      tone: "ai",
      text: when ? `${short} ${when}` : short,
      title: `${ai.client_name ?? "Ứng dụng AI"}: ${ai.summary}`,
      href: `/ai-actions?id=${ai.id}`,
    })
  }
  if (c.latest_deal) {
    const d = c.latest_deal
    out.push({ key: `deal-${d.id}`, tone: DEAL_TONE[d.status], text: `${DEAL_PREFIX[d.status]}: ${d.title}`, title: d.title })
  }
  if (c.source?.label) out.push({ key: "source", tone: "plain", text: `Từ ${c.source.label}` })
  return out
}
