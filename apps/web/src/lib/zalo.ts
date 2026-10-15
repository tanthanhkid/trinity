/**
 * Helper deeplink Zalo native.
 *
 * Nút "Nhắn tin" ở chi tiết khách mở `https://zalo.me/{phone}`
 * (mobile mở Zalo app native; desktop mở Zalo web).
 *
 * ⚠️ Bảo mật: chỉ dựng deeplink khi SĐT KHÔNG bị che (RBAC). SĐT bị che (BE trả
 * `0900***001` hoặc người xem không có quyền xem full số) → KHÔNG
 * mở deeplink. Nút component tự chặn bằng `isMaskedPhone`.
 */

/**
 * Chuẩn hoá SĐT về dạng local `0xxx` để ghép vào `zalo.me`.
 * Bỏ khoảng trắng/dấu gạch/ngoặc/chấm; `+84xxx` và `84xxx` (11 số) → `0xxx`.
 */
export function cleanPhone(phone: string): string {
  const stripped = (phone ?? "").replace(/[\s\-().]/g, "")
  if (stripped.startsWith("+84")) return `0${stripped.slice(3)}`
  if (stripped.startsWith("84") && stripped.length === 11) return `0${stripped.slice(2)}`
  return stripped
}

/**
 * Deeplink Zalo native cho 1 SĐT đã chuẩn hoá.
 * Chỉ gọi khi CHẮC CHẮN SĐT không bị che (xem `isMaskedPhone`).
 */
export function buildZaloDirectUrl(phone: string): string {
  return `https://zalo.me/${cleanPhone(phone)}`
}

/**
 * SĐT đang bị CHE hay không — dấu hiệu là ký tự `*` do BE mask (`0900***001`)
 * hoặc `maskPhone` FE (`xxx-xxx-**NN`). SĐT bị che → không đủ dữ liệu dựng deeplink.
 */
export function isMaskedPhone(phone: string): boolean {
  return (phone ?? "").includes("*")
}
