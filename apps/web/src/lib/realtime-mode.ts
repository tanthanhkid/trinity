/**
 * Chế độ thông báo thời gian thực.
 * - không đặt `NEXT_PUBLIC_REALTIME_MODE` → dùng Socket.IO như cũ (pm2/VPS);
 * - `poll` → KHÔNG mở socket (Vercel serverless không giữ được kết nối bền): hỏi API mỗi 30s + khi tab được focus.
 * Biến NEXT_PUBLIC_* được nhúng lúc build nên đọc trực tiếp `process.env` (không đọc qua biến trung gian).
 */
export const NOTIFICATION_POLL_INTERVAL_MS = 60_000

export function isPollMode(): boolean {
  return process.env.NEXT_PUBLIC_REALTIME_MODE === 'poll'
}

/**
 * Nhịp làm mới hộp thư. Bản serverless (Vercel) tính CPU theo từng lượt gọi nên giãn ra: danh sách 60 giây, hội thoại đang mở
 * 20 giây. Bản VPS giữ nhịp cũ. Tab ẩn không hỏi (react-query mặc định `refetchIntervalInBackground: false`).
 */
export function inboxPollMs(kind: "list" | "thread", vpsMs: number): number {
  if (!isPollMode()) return vpsMs
  return kind === "list" ? 60_000 : 20_000
}

/**
 * Lượt "nhắc máy chủ chạy việc đến giờ" kế tiếp trên bản serverless: máy chủ trả `next_at` (giờ việc chờ sớm nhất).
 * Có việc ⇒ hẹn đúng giờ đó (ít nhất 20 giây, nhiều nhất 10 phút); việc đang chạy ⇒ 60 giây; không còn gì chờ ⇒ 10 phút
 * (đề phòng việc do người khác / trợ lý AI tạo trong lúc tab đang mở). Chưa có dữ liệu (lỗi mạng, chưa trả lời) ⇒ 60 giây —
 * lượt tick này là thứ khởi động việc đến giờ trên Vercel nên không được chờ lâu khi lỗi.
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
