import type { SocialDraft, SocialMediaItem } from "@/hooks/use-social"
import { youtubeChoiceFrom, type YoutubeChoice } from "./youtube-post-options"
import type { TiktokChoice } from "./tiktok-post-options"
import { utmChoiceFromTargets, type UtmChoice } from "./social-utm"

/** Trạng thái ô soạn của web, lưu nguyên vào `ui` của nháp để mở lại đúng như cũ (máy chủ không đọc). */
export interface ComposerState {
  content: string
  selected: number[]
  captions: Record<number, string>
  openCaption: Record<number, boolean>
  ytChoice: Record<number, YoutubeChoice>
  fbFirst: Record<number, string>
  ttChoice: Record<number, TiktokChoice>
  scheduleOn: boolean
  scheduleAt: string
  /** Chọn "Vào hàng đợi" (không lưu giờ — khung trống tính lúc đăng). */
  useQueue?: boolean
  /** Gắn UTM vào liên kết. */
  utm?: UtmChoice
  /** Tệp đã tải xong (kèm tên hiển thị). */
  uploads: Array<{ name: string; item: SocialMediaItem; libId?: number }>
}

export const EMPTY_COMPOSER_STATE: ComposerState = {
  content: "", selected: [], captions: {}, openCaption: {}, ytChoice: {}, fbFirst: {}, ttChoice: {}, scheduleOn: false, scheduleAt: "", uploads: [],
}

/** `Date` → giá trị ô `datetime-local` theo giờ máy người dùng (YYYY-MM-DDTHH:mm). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * Nháp → trạng thái ô soạn. Có `ui` (nháp lưu từ web) thì khôi phục nguyên; không (nháp do AI lưu) thì suy từ nội dung/kênh/tệp:
 * caption riêng → mở ô nội dung riêng, bình luận đầu tiên → fbFirst, tuỳ chọn YouTube → ytChoice (nhận ra qua `privacy`/`category_id`).
 */
export function composerStateFrom(d: SocialDraft): ComposerState {
  const ui = d.ui
  if (isObj(ui) && typeof ui.content === "string" && Array.isArray(ui.selected)) {
    return { ...EMPTY_COMPOSER_STATE, ...(ui as unknown as Partial<ComposerState>) }
  }
  const s: ComposerState = { ...EMPTY_COMPOSER_STATE, captions: {}, openCaption: {}, ytChoice: {}, fbFirst: {}, ttChoice: {} }
  s.content = d.content
  for (const t of d.targets) {
    s.selected.push(t.account_id)
    if (t.caption) {
      s.captions[t.account_id] = t.caption
      s.openCaption[t.account_id] = true
    }
    const o = t.options ?? {}
    if (typeof o.first_comment === "string" && o.first_comment) s.fbFirst[t.account_id] = o.first_comment
    if ("title" in o || "description" in o || "privacy" in o || "category_id" in o || "made_for_kids" in o || "playlist_id" in o || "thumbnail_key" in o || "tags" in o) s.ytChoice[t.account_id] = youtubeChoiceFrom(o)
  }
  s.utm = utmChoiceFromTargets(d.targets) ?? undefined
  s.uploads = d.media.map((m) => ({ name: m.name ?? m.key.split("/").pop() ?? m.key, item: { key: m.key, type: m.type, content_type: m.content_type, size: m.size } }))
  if (d.scheduled_at) {
    s.scheduleOn = true
    s.scheduleAt = toLocalInput(new Date(d.scheduled_at))
  }
  return s
}
