/**
 * Constants UI của Danh bạ.
 * - Nhãn trạng thái / nguồn lấy từ SettingOption, không hardcode ở đây.
 * - RBAC quyền + phạm vi: KHÔNG còn set theo vai trò ở đây — mọi gate
 *   (vào trang, lọc người, xuất, chuyển, xoá) đọc `usePermissions()`/`<Can>`
 *   (`contacts.view|export|transfer|delete`).
 */

export type SortField = "created_at" | "full_name" | "lead_score"

/** Giới hạn số lượng contact có thể xoá cùng lúc — tránh vượt rate limit bulk 10 req/min. */
export const BULK_DELETE_MAX = 10

/** Khớp `CONTACT_BULK_TRANSFER_MAX` trong `contact-transfer.service.ts` (BE). */
export const BULK_TRANSFER_MAX = 500
