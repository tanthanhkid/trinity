//! Lịch thử lại: lần gửi đầu + 6 lần thử lại sau 1m, 5m, 30m, 2h, 6h, 12h = tối đa 7 lần gửi, rồi `dead`. `attempts` đếm
//! TỔNG số lần đã gửi (tăng lúc nhận việc, nên crash giữa chừng vẫn tính một lần ⇒ không thử lại vô hạn).

const MINUTE: u64 = 60;
pub const RETRY_DELAYS_SEC: [u64; 6] = [
    MINUTE,
    5 * MINUTE,
    30 * MINUTE,
    120 * MINUTE,
    360 * MINUTE,
    720 * MINUTE,
];
pub const MAX_ATTEMPTS: i32 = 7;
/// Endpoint lỗi liên tiếp từng này lần ⇒ tự tắt và báo người tạo.
pub const AUTO_DISABLE_AFTER_FAILURES: i32 = 20;

/// Sau lần gửi thứ `attempts` (từ 1) thất bại: số giây chờ tới lần kế, hoặc `None` = hết lượt (dead).
pub fn next_retry_delay_sec(attempts: i32) -> Option<u64> {
    if attempts >= MAX_ATTEMPTS {
        return None;
    }
    let i = usize::try_from(attempts.max(1) - 1).unwrap_or(0);
    RETRY_DELAYS_SEC.get(i).copied()
}
