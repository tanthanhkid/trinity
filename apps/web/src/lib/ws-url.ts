/**
 * Suy ra origin để mở socket thông báo (`/notif-ws`) từ `NEXT_PUBLIC_API_URL`.
 *
 * Tách khỏi `components/notification-socket.tsx` để test chạy trên ĐÚNG hàm
 * production. Test (`__tests__/components/notification-socket.test.tsx`)
 * không chép lại thân hàm vào file test — chép lại thì không khoá được hành
 * vi thật (xem docblock dưới).
 *
 * 🔴 Vì sao không dùng thẳng `new URL(apiUrl, base).origin`:
 * `new URL()` **KHÔNG throw** với chuỗi có dạng scheme nhưng không phải
 * http/https — vd `"localhost:8080"`, `"api-host:8080"`, `"not-a-valid-url-:::/"`.
 * WHATWG URL coi phần trước dấu `:` là scheme lạ (non-special) ⇒ URL có
 * **opaque origin** ⇒ `.origin` trả về CHUỖI `"null"` (7 ký tự), không phải
 * `null` và không ném lỗi. Nhánh `catch` vì vậy INERT hoàn toàn.
 *
 * Hậu quả đo được: `io("null/notifications/ws")` — socket.io thấy chuỗi không
 * có scheme nên tự ghép protocol của trang thành `https://null/...`, host
 * `null` không bao giờ phân giải được ⇒ treo tới timeout:
 *
 * ```
 * [NotificationSocket] Connection error: timeout
 * ```
 *
 * Socket chết ⇒ badge chuông
 * chỉ nhúc nhích theo `refetchInterval` 30s và danh sách chỉ nạp khi MỞ dropdown
 * (`enabled: open`) ⇒ user thấy đúng triệu chứng "bấm vào chuông mới có thông
 * báo", và KHÔNG có tiếng vì `play()` chỉ chạy trong handler
 * `notification:new`.
 *
 * Quy tắc: chỉ chấp nhận origin http/https; mọi thứ khác → `origin` của trang
 * (fail-safe, socket vẫn nối được vì web và BE đứng sau cùng reverse proxy).
 */

/** Chỉ 2 protocol này cho ra origin dùng được để mở socket. */
const USABLE_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * @param apiUrl  giá trị `NEXT_PUBLIC_API_URL` (absolute, relative, hoặc rỗng)
 * @param origin  `window.location.origin` ('' khi SSR)
 * @param onReject nhận lý do khi `apiUrl` có giá trị nhưng KHÔNG dùng được —
 *   để caller log ra console. Cấu hình sai env là nguyên nhân im lặng nhất của
 *   lỗi này, phải nói ra chứ không nuốt.
 */
export function resolveWsBaseUrl(
  apiUrl: string | null | undefined,
  origin: string,
  onReject?: (reason: string) => void,
): string {
  // Chính TRANG cũng có thể mang origin opaque (`about:blank`, iframe sandbox,
  // `file://` trên Firefox) — khi đó `window.location.origin` LÀ chuỗi "null".
  // Trả nó ra là đúng lại lỗi đang sửa, chỉ khác nguồn. Rơi về chuỗi rỗng để
  // socket.io hiểu `/notifications/ws` là namespace trên origin hiện tại.
  const safeOrigin = origin === 'null' ? '' : origin

  if (!apiUrl) return safeOrigin

  // `URL(input, base)` cần base absolute; khi SSR chưa có origin thì mượn
  // localhost để hàm không ném — kết quả vẫn rơi về `origin` ('') như cũ.
  const base = safeOrigin || 'http://localhost'

  let parsed: URL
  try {
    parsed = new URL(apiUrl, base)
  } catch {
    onReject?.(`NEXT_PUBLIC_API_URL="${apiUrl}" không parse được`)
    return safeOrigin
  }

  if (!USABLE_PROTOCOLS.has(parsed.protocol)) {
    onReject?.(
      `NEXT_PUBLIC_API_URL="${apiUrl}" có protocol "${parsed.protocol}" (không phải http/https)`,
    )
    return safeOrigin
  }

  // Chốt chặn 2: origin opaque vẫn ra chuỗi "null" ở một số engine dù protocol
  // hợp lệ. Không bao giờ trả chuỗi này ra ngoài — nó là host không tồn tại.
  if (!parsed.origin || parsed.origin === 'null') {
    onReject?.(`NEXT_PUBLIC_API_URL="${apiUrl}" cho origin rỗng/opaque`)
    return safeOrigin
  }

  return parsed.origin
}
