//! Khung giờ hàng đợi, phần ĐỌC cho `use_queue` của bài đăng (`social-queue.service.ts`): `slots`, `next_free`. Đặt lại khung
//! (`PUT /social/queue/slots`) và các route hàng đợi thuộc M55a.

use std::collections::HashSet;

use serde::Serialize;
use sqlx::PgConnection;
use trinity_db::pg_error::app_error;
use trinity_db::types::Timestamp;
use trinity_kernel::error::AppError;
use trinity_kernel::vn_time::from_millis;

use crate::config::MAX_SCHEDULE_AHEAD_MS;

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
/// Giờ Việt Nam = UTC+7, không có giờ mùa hè.
const VN_OFFSET_MS: i64 = 7 * 3_600_000;
/// Khung phải cách bây giờ ít nhất chừng này (đủ để bài còn sửa/huỷ được).
pub const QUEUE_MIN_LEAD_MS: i64 = 2 * MINUTE_MS;
pub const NO_QUEUE_SLOTS: &str = "Chưa đặt khung giờ hàng đợi (Đăng đa kênh › Lịch › Khung giờ)";

/// Một khung hằng tuần: thứ (0 = Chủ nhật … 6) và phút trong ngày giờ Việt Nam (0–1439).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct QueueSlot {
    pub weekday: i32,
    pub minute: i32,
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Thời điểm (mili giây UTC) ĐẦU TIÊN sau `after_ms` mà khung rơi vào (`slotAfter`).
pub fn slot_after(slot: QueueSlot, after_ms: i64) -> i64 {
    let vn = after_ms + VN_OFFSET_MS;
    let day_start = vn.div_euclid(DAY_MS) * DAY_MS;
    // Ngày 0 của epoch (1970-01-01) là thứ Năm.
    let today = (day_start.div_euclid(DAY_MS) + 4).rem_euclid(7);
    let ahead_days = (i64::from(slot.weekday) - today + 7).rem_euclid(7);
    let mut t = day_start + ahead_days * DAY_MS + i64::from(slot.minute) * MINUTE_MS;
    if t <= vn {
        t += 7 * DAY_MS;
    }
    t - VN_OFFSET_MS
}

/// Các lần xảy ra của danh sách khung, theo thứ tự thời gian, sau `after_ms` và không quá `until_ms`.
pub fn occurrences(slots: &[QueueSlot], after_ms: i64, until_ms: i64) -> Vec<i64> {
    let mut out = Vec::new();
    for s in slots {
        let mut d = slot_after(*s, after_ms);
        while d <= until_ms {
            out.push(d);
            d += 7 * DAY_MS;
        }
    }
    out.sort_unstable();
    out
}

const SLOTS_SQL: &str = "SELECT weekday, minute FROM social_queue_slots ORDER BY weekday ASC, minute ASC";
const TAKEN_SQL: &str =
    "SELECT scheduled_at FROM social_posts WHERE status = 'scheduled' AND scheduled_at >= $1 AND scheduled_at <= $2";

/// Khung giờ theo thứ rồi theo giờ.
pub async fn slots(conn: &mut PgConnection) -> Result<Vec<QueueSlot>, AppError> {
    let rows: Vec<(i32, i32)> = sqlx::query_as(SLOTS_SQL).fetch_all(conn).await.map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|(weekday, minute)| QueueSlot {
            weekday,
            minute,
        })
        .collect())
}

/// `count` khung trống gần nhất (mili giây UTC): sau now + 2 phút, trong 90 ngày, bỏ khung đã có bài hẹn cùng phút. Rỗng khi chưa có
/// khung nào. `count` bị kẹp vào 1–50.
pub async fn next_free(conn: &mut PgConnection, count: i64, now_ms: i64) -> Result<Vec<i64>, AppError> {
    let n = usize::try_from(count.clamp(1, 50)).unwrap_or(1);
    let list = slots(&mut *conn).await?;
    if list.is_empty() {
        return Ok(Vec::new());
    }
    let from = now_ms + QUEUE_MIN_LEAD_MS;
    let all = occurrences(&list, from, now_ms + MAX_SCHEDULE_AHEAD_MS);
    let (Some(first), Some(last)) = (all.first().copied(), all.last().copied()) else {
        return Ok(Vec::new());
    };
    let lo = from_millis(first - MINUTE_MS).map(Timestamp);
    let hi = from_millis(last + MINUTE_MS).map(Timestamp);
    let taken: Vec<(Timestamp,)> = sqlx::query_as(TAKEN_SQL)
        .bind(lo)
        .bind(hi)
        .fetch_all(conn)
        .await
        .map_err(db)?;
    let used: HashSet<i64> = taken
        .iter()
        .map(|(t,)| t.0.timestamp_millis().div_euclid(MINUTE_MS))
        .collect();
    Ok(all
        .into_iter()
        .filter(|d| !used.contains(&d.div_euclid(MINUTE_MS)))
        .take(n)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-11-27 00:00 UTC (thứ Sáu = 5).
    const FRI_UTC: i64 = 1_795_737_600_000;

    #[test]
    fn khung_ke_tiep() {
        // 09:00 VN thứ Sáu = 02:00 UTC cùng ngày; sau 00:00 UTC ⇒ ngay hôm đó.
        let slot = QueueSlot {
            weekday: 5,
            minute: 9 * 60,
        };
        assert_eq!(slot_after(slot, FRI_UTC), FRI_UTC + 2 * 3_600_000);
        // Đã qua giờ ⇒ tuần sau.
        let after = FRI_UTC + 3 * 3_600_000;
        assert_eq!(slot_after(slot, after), FRI_UTC + 2 * 3_600_000 + 7 * DAY_MS);
        // Thứ Bảy 01:00 VN = thứ Sáu 18:00 UTC.
        let sat = QueueSlot {
            weekday: 6,
            minute: 60,
        };
        assert_eq!(slot_after(sat, FRI_UTC), FRI_UTC + 18 * 3_600_000);
    }

    #[test]
    fn cac_lan_xay_ra() {
        let slots = [
            QueueSlot {
                weekday: 5,
                minute: 9 * 60,
            },
            QueueSlot {
                weekday: 1,
                minute: 0,
            },
        ];
        let got = occurrences(&slots, FRI_UTC, FRI_UTC + 14 * DAY_MS);
        assert_eq!(got.len(), 4);
        assert!(got.windows(2).all(|w| w[0] < w[1]));
    }
}
