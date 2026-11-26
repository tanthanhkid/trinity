//! Hàm thuần của `notifications/helpers` (Node): giờ hành chính Việt Nam và nhóm sự kiện tin nhắn.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Timelike, Utc};

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

/// Chuỗi ISO 8601 như `@IsISO8601` + `new Date(s)` của bản Node: chỉ ngày (`2026-11-26`, nửa đêm UTC), có giờ không múi
/// giờ (tính là UTC, như máy chủ chạy UTC), `Z`, `+07:00`, `+0700`, `+07`; giờ `T` hoặc cách; giây và phần thập phân tuỳ chọn.
/// Không đúng dạng ⇒ `None`.
pub fn parse_iso8601(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc());
    }
    let norm = s.replacen(' ', "T", 1);
    let norm = norm
        .strip_suffix(['Z', 'z'])
        .map_or(norm.clone(), |h| format!("{h}+00:00"));
    for f in ["%Y-%m-%dT%H:%M:%S%.f%#z", "%Y-%m-%dT%H:%M%#z"] {
        if let Ok(d) = DateTime::parse_from_str(&norm, f) {
            return Some(d.with_timezone(&Utc));
        }
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s.replacen(' ', "T", 1).as_str(), f) {
            return Some(d.and_utc());
        }
    }
    None
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

    #[test]
    fn iso8601_nhieu_dang() {
        let u = |s: &str| parse_iso8601(s).map(|d| d.to_rfc3339());
        assert_eq!(u("2026-11-26").as_deref(), Some("2026-11-26T00:00:00+00:00"));
        assert_eq!(u("2026-11-26T10:30:15Z").as_deref(), Some("2026-11-26T10:30:15+00:00"));
        assert_eq!(
            u("2026-11-26T10:30:15.123Z").as_deref(),
            Some("2026-11-26T10:30:15.123+00:00")
        );
        assert_eq!(u("2026-11-26T10:30:15").as_deref(), Some("2026-11-26T10:30:15+00:00"));
        assert_eq!(u("2026-11-26T10:30").as_deref(), Some("2026-11-26T10:30:00+00:00"));
        assert_eq!(
            u("2026-11-26T17:00:00+0700").as_deref(),
            Some("2026-11-26T10:00:00+00:00")
        );
        assert_eq!(
            u("2026-11-26T17:00:00+07:00").as_deref(),
            Some("2026-11-26T10:00:00+00:00")
        );
        assert_eq!(
            u("2026-11-26T17:00:00+07").as_deref(),
            Some("2026-11-26T10:00:00+00:00")
        );
        assert_eq!(
            u("2026-11-26 17:00:00+07:00").as_deref(),
            Some("2026-11-26T10:00:00+00:00")
        );
        assert_eq!(u("2026-11-26T17:00+0700").as_deref(), Some("2026-11-26T10:00:00+00:00"));
        for bad in [
            "",
            "abc",
            "2026-13-01",
            "2026-11-26T25:00:00Z",
            "26/11/2026",
            "2026-11-26T10",
            "1700000000",
        ] {
            assert_eq!(parse_iso8601(bad), None, "{bad}");
        }
    }
}
