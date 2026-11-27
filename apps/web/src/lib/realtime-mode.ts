/**
 * Chế độ thông báo thời gian thực.
 * - `realtime_mode` của `GET /site-config` (máy chủ đọc `REALTIME_MODE` lúc chạy, nạp sẵn bởi script `<head>`);
 *   chưa có cấu hình thì lùi về `NEXT_PUBLIC_REALTIME_MODE` lúc build;
 * - không phải `poll` → dùng Socket.IO như cũ (pm2/VPS);
 * - `poll` → KHÔNG mở socket (vd proxy không cho WebSocket): hỏi API mỗi 30s + khi tab được focus.
 */
import { resolvePollMode } from './site-config'

export const NOTIFICATION_POLL_INTERVAL_MS = 60_000

export function isPollMode(): boolean {
  return resolvePollMode()
}

/**
 * Nhịp làm mới hộp thư ở chế độ poll: danh sách 60 giây, hội thoại đang mở 20 giây. Chế độ socket giữ nhịp cũ. Tab ẩn không hỏi (react-query mặc định `refetchIntervalInBackground: false`).
 */
export function inboxPollMs(kind: "list" | "thread", vpsMs: number): number {
  if (!isPollMode()) return vpsMs
  return kind === "list" ? 60_000 : 20_000
}

/**
 * Lượt "nhắc máy chủ chạy việc đến giờ" kế tiếp (chế độ poll): máy chủ trả `next_at` (giờ việc chờ sớm nhất).
 * Có việc ⇒ hẹn đúng giờ đó (ít nhất 20 giây, nhiều nhất 10 phút); việc đang chạy ⇒ 60 giây; không còn gì chờ ⇒ 10 phút
 * (đề phòng việc do người khác / trợ lý AI tạo trong lúc tab đang mở). Chưa có dữ liệu (lỗi mạng, chưa trả lời) ⇒ 60 giây.
 */
export function nextTickMs(data: { due?: boolean; next_at?: string | null } | undefined, now = Date.now()): number {
  const MIN = 20_000
  const MAX = 10 * 60_000
  if (!data || data.due) return 60_000
  if (!data.next_at) return MAX
  const at = Date.parse(data.next_at)
  if (Number.isNaN(at)) return MAX
  return Math.min(MAX, Math.max(MIN, at - now + 2_000))
}
