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
  google: "social.post",
}

/**
 * Đánh giá Google Business Profile: quyền `social.post` + công tắc `social_posting` (cùng mục Đăng đa kênh) và đã liên kết
 * ít nhất một địa điểm (`hasGoogle` — địa điểm chỉ liên kết được khi máy chủ đã bật quyền API của Google).
 */
export function inboxChannels(grants: Grants, features?: OrgFeatures, opts: { hasGoogle?: boolean } = {}): InboxChannel[] {
  // Công tắc riêng của Hộp thư (Cài đặt › Tính năng); từng kênh còn theo công tắc của kênh đó.
  if (features && features.inbox === false) return []
  const out: InboxChannel[] = []
  if (can(grants, INBOX_CHANNEL_PERMISSION.zalo) && !(features && features.zalo_oa === false)) out.push("zalo")
  if (can(grants, INBOX_CHANNEL_PERMISSION.facebook) && !(features && features.facebook_page === false)) out.push("facebook")
  if (opts.hasGoogle && can(grants, INBOX_CHANNEL_PERMISSION.google) && !(features && features.social_posting === false)) out.push("google")
  return out
}

export type InboxTab = "all" | InboxChannel

/** Tab hiển thị: có từ 2 kênh TIN NHẮN (Zalo, Messenger) thì thêm "Tất cả" đứng đầu; đánh giá Google luôn là tab riêng. */
export function inboxTabs(channels: readonly InboxChannel[]): InboxTab[] {
  const chat = channels.filter((c) => c !== "google")
  return chat.length > 1 ? ["all", ...channels] : [...channels]
}

/** `?kenh=` trên URL → tab hợp lệ (không có quyền / sai giá trị ⇒ tab đầu). */
export function pickInboxTab(param: string | null, tabs: readonly InboxTab[]): InboxTab | null {
  if (tabs.length === 0) return null
  const wanted: InboxTab | null = param === "zalo" || param === "facebook" || param === "google" ? param : param === "tat-ca" ? "all" : null
  return wanted && tabs.includes(wanted) ? wanted : tabs[0]
}

export const INBOX_TAB_LABEL: Record<InboxTab, string> = { all: "Tất cả", zalo: "Zalo", facebook: "Facebook", google: "Đánh giá Google" }
export const INBOX_TAB_PARAM: Record<InboxTab, string> = { all: "tat-ca", zalo: "zalo", facebook: "facebook", google: "google" }
