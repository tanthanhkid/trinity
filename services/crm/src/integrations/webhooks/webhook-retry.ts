/**
 * Lịch thử lại webhook: lần gửi đầu + 6 lần thử lại sau 1m, 5m, 30m, 2h, 6h, 12h = tối đa 7 lần
 * gửi, rồi `dead`. `attempts` đếm TỔNG số lần đã gửi (tăng lúc nhận việc, nên crash giữa chừng vẫn tính 1 lần
 * ⇒ không thể thử lại vô hạn).
 */
const MINUTE = 60_000;
export const RETRY_DELAYS_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 360 * MINUTE, 720 * MINUTE] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Endpoint lỗi liên tiếp từng này lần ⇒ tự tắt + báo người tạo. */
export const AUTO_DISABLE_AFTER_FAILURES = 20;

/** Sau lần gửi thứ `attempts` (1-based) thất bại: ms chờ tới lần kế, hoặc null = hết lượt (dead). */
export function nextRetryDelayMs(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[Math.max(attempts, 1) - 1];
}
