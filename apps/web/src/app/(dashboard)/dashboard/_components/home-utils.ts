/* Trang chủ "AI đã làm gì hôm nay" — logic THUẦN (không React), test được riêng. */

import type { AiAction } from '@/lib/ai-actions'
import { vnDateKey } from '@/lib/format'

export type AiClientKind = 'chatgpt' | 'claude' | 'gemini' | 'other'

/**
 * Nhận diện trợ lý theo TÊN client OAuth (do ứng dụng AI tự khai lúc đăng ký — DCR/CIMD),
 * vd "ChatGPT", "Claude", "claude.ai", "Gemini". Không khớp ⇒ biểu tượng chung, không đoán.
 */
export function aiClientKind(name: string | null | undefined): AiClientKind {
  const n = (name ?? '').toLowerCase()
  if (/chatgpt|openai/.test(n)) return 'chatgpt'
  if (/claude|anthropic/.test(n)) return 'claude'
  if (/gemini/.test(n)) return 'gemini'
  return 'other'
}

export const AI_LOGO_SRC: Record<Exclude<AiClientKind, 'other'>, string> = {
  chatgpt: '/brand/ai/chatgpt.svg',
  claude: '/brand/ai/claude.svg',
  gemini: '/brand/ai/gemini.svg',
}

/** Hoạt động AI tạo trong NGÀY HÔM NAY theo giờ VN (`today` = `YYYY-MM-DD`), bỏ đề xuất đang chờ duyệt (nằm ở "Cần bạn xem"). */
export function todaysAiActions(rows: AiAction[], today: string): AiAction[] {
  return rows.filter((a) => a.status !== 'pending' && vnDateKey(a.created_at) === today)
}

/** Việc AI đã làm xong (có hiệu lực) — thứ được đếm ở thẻ "AI đã làm hôm nay". */
export const isAiActionDone = (a: Pick<AiAction, 'status'>): boolean => a.status === 'executed' || a.status === 'approved'

/**
 * Hành động AI này có thao tác HOÀN TÁC thật trên web không?
 *
 * Hiện KHÔNG có: BE `integrations/ai-actions` chỉ có list / get / approve / reject — không có endpoint hoàn tác.
 * Quay lui cấu trúc (`restore_structure_version`) chỉ là tool MCP cho chính AI gọi, không phải nút trên web.
 * Nên trả `false` cho mọi hành động ⇒ trang chủ chỉ hiện "Xem". Khi BE có đường hoàn tác thật thì sửa ở ĐÂY
 * (và test `home-ai-timeline.test.tsx` sẽ nhắc).
 */
export function canUndoAiAction(a: Pick<AiAction, 'status' | 'tool'>): boolean {
  void a
  return false
}

/** Câu tóm tắt dưới lời chào — chỉ nói điều có số THẬT; chưa tải xong phần nào thì không nói phần đó. */
export function homeSummary(doneToday: number | null, needReview: number | null): string {
  const parts: string[] = []
  if (doneToday !== null) {
    parts.push(
      doneToday > 0
        ? `Hôm nay các trợ lý AI đã làm ${doneToday.toLocaleString('vi-VN')} việc cho bạn.`
        : 'Hôm nay các trợ lý AI chưa làm việc nào cho bạn.',
    )
  }
  if (needReview !== null) {
    parts.push(needReview > 0 ? `Có ${needReview.toLocaleString('vi-VN')} chỗ cần bạn xem.` : 'Không có gì cần bạn xem lúc này.')
  }
  return parts.join(' ')
}

/** Tiền gọn cho thẻ số: "6,4 triệu", "1,2 tỷ"; dưới 1 triệu in đủ kèm ₫. */
export function formatMoneyCompact(v: number): string {
  const f = (x: number) => x.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
  if (Math.abs(v) >= 1e9) return `${f(v / 1e9)} tỷ`
  if (Math.abs(v) >= 1e6) return `${f(v / 1e6)} triệu`
  return `${v.toLocaleString('vi-VN')} ₫`
}

/** "Vừa xong" / "5 phút trước" / "2 giờ trước" / "Hôm qua" / ngày — từ nhãn tương đối sẵn có của app. */
export function agoLabel(rel: string): string {
  return /(phút|giờ)$/.test(rel) ? `${rel} trước` : rel
}
