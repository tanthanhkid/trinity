//! Hàm thuần của `notifications/helpers` (Node): giờ hành chính Việt Nam và nhóm sự kiện tin nhắn.

use chrono::{DateTime, Duration, Timelike, Utc};

/// Nhóm `event_type` của badge "tin nhắn & đề cập" (khớp `event-category.helper.ts` và web).
pub const MESSAGE_EVENT_TYPES: [&str; 2] = ["chat.tag", "internal.message"];

const VN_OFFSET: Duration = Duration::hours(7);

/// Giờ hành chính 08:00..18:00 theo UTC+7.
pub fn is_business_hours(now: DateTime<Utc>) -> bool {
    let h = (now + VN_OFFSET).hour();
    (8..18).contains(&h)
}

/// 08:00 (UTC+7) kế tiếp: hôm nay nếu chưa tới 8 giờ, ngược lại ngày mai. Trả về giờ UTC.
pub fn next_business_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let vn = now + VN_OFFSET;
    let days = if vn.hour() < 8 { 0 } else { 1 };
    let start = (vn.date_naive() + Duration::days(days))
        .and_hms_opt(8, 0, 0)
        .expect("08:00 hợp lệ")
        .and_utc();
    start - VN_OFFSET
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn gio_hanh_chinh() {
        // 01:00Z = 08:00 VN, 10:59Z = 17:59 VN.
        assert!(is_business_hours(t("2026-11-26T01:00:00Z")));
        assert!(is_business_hours(t("2026-11-26T10:59:59Z")));
        assert!(!is_business_hours(t("2026-11-26T11:00:00Z")));
        assert!(!is_business_hours(t("2026-11-26T00:59:59Z")));
    }

    #[test]
    fn gio_bat_dau_ke_tiep() {
        // Trước 8 giờ VN: cùng ngày; từ 8 giờ: ngày mai; qua nửa đêm UTC vẫn đúng.
        assert_eq!(
            next_business_start(t("2026-11-26T00:30:00Z")),
            t("2026-11-26T01:00:00Z")
        );
        assert_eq!(
            next_business_start(t("2026-11-26T01:00:00Z")),
            t("2026-11-27T01:00:00Z")
        );
        assert_eq!(
            next_business_start(t("2026-11-26T20:00:00Z")),
            t("2026-11-27T01:00:00Z")
        );
        assert_eq!(
            next_business_start(t("2026-11-26T16:59:59Z")),
            t("2026-11-27T01:00:00Z")
        );
    }
}
