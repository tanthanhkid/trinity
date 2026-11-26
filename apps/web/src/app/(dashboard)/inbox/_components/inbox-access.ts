import { can, type Grants, type OrgFeatures, type Permission } from "@trinity/rbac"
import type { InboxChannel } from "@/components/inbox/inbox-ui"

/**
 * Kênh nào hiện ở màn Hộp thư `/inbox` — ĐÚNG luật của hai hộp thư sẵn có trong Cài đặt > Kết nối & AI
 * (`integrations-meta.ts`), không nới thêm:
 *   - cả khung "Kết nối & AI" tắt theo công tắc tổ chức `integrations` ⇒ không kênh nào;
 *   - Zalo OA: quyền `contacts.update` + công tắc `zalo_oa` (BE `@RequireOrgFeature('zalo_oa')` trả 403 khi tắt);
 *   - Facebook Messenger: quyền `integrations.webhooks` + công tắc `facebook_page` (mục "Fanpage Facebook").
 * `features` không truyền (đang tải) ⇒ coi như bật, giống sidebar (fail-open chỉ cho việc ẩn/hiện; BE vẫn kiểm quyền).
 */
export const INBOX_CHANNEL_PERMISSION: Record<InboxChannel, Permission> = {
  zalo: "contacts.update",
  facebook: "integrations.webhooks",
}

export function inboxChannels(grants: Grants, features?: OrgFeatures): InboxChannel[] {
  // Công tắc riêng của Hộp thư (Cài đặt › Tính năng); từng kênh còn theo công tắc của kênh đó.
  if (features && features.inbox === false) return []
  const out: InboxChannel[] = []
  if (can(grants, INBOX_CHANNEL_PERMISSION.zalo) && !(features && features.zalo_oa === false)) out.push("zalo")
  if (can(grants, INBOX_CHANNEL_PERMISSION.facebook) && !(features && features.facebook_page === false)) out.push("facebook")
  return out
}

export type InboxTab = "interactions" | "all" | InboxChannel

/** Tab hiển thị: có từ 2 kênh TIN NHẮN (Zalo, Messenger) thì thêm "Tất cả" đứng đầu. */
export function inboxTabs(channels: readonly InboxChannel[]): InboxTab[] {
  const chat = channels
  // "Tương tác" (bình luận + tin nhắn gộp) đứng đầu, là tab mặc định khi có Facebook hoặc Zalo.
  const head: InboxTab[] = chat.length > 0 ? ["interactions"] : []
  return [...head, ...(chat.length > 1 ? ["all" as const] : []), ...channels]
}

/** `?kenh=` trên URL → tab hợp lệ (không có quyền / sai giá trị ⇒ tab đầu). */
export function pickInboxTab(param: string | null, tabs: readonly InboxTab[]): InboxTab | null {
  if (tabs.length === 0) return null
  const wanted: InboxTab | null = param === "zalo" || param === "facebook" ? param : param === "tat-ca" ? "all" : param === "tuong-tac" ? "interactions" : null
  return wanted && tabs.includes(wanted) ? wanted : tabs[0]
}

export const INBOX_TAB_LABEL: Record<InboxTab, string> = { interactions: "Tương tác", all: "Tất cả hội thoại", zalo: "Zalo", facebook: "Facebook" }
export const INBOX_TAB_PARAM: Record<InboxTab, string> = { interactions: "tuong-tac", all: "tat-ca", zalo: "zalo", facebook: "facebook" }
