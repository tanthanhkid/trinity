/**
 * So khớp path theo route cha — tầng THUẦN (không React, không DOM) để mọi
 * guard trong app dùng chung một bộ luật.
 *
 * Chỉ so khớp path — không phụ thuộc tiền tố giao diện.
 */

/**
 * `true` nếu `pathname` nằm dưới `route` — khớp chính nó hoặc route con
 * (`/x`, `/x/y`; **KHÔNG** khớp `/xy`).
 *
 * 🔴 Dùng cho MỌI guard so path theo tiền tố, đừng viết
 * `pathname.startsWith('/x')` trần: dạng trần khớp nhầm route anh em cùng tiền
 * tố (`/orders` nuốt `/orders-archive`) và mất phủ IM LẶNG — build xanh, test cũ
 * xanh, không lỗi nào phát ra.
 */
export function isUnderRoute(
  pathname: string | null | undefined,
  route: string,
): boolean {
  if (!pathname) return false
  return pathname === route || pathname.startsWith(`${route}/`)
}
