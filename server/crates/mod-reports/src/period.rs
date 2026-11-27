//! Khoảng ngày báo cáo, kỳ trước, chỉ số chênh lệch và các mốc ngày/tháng theo giờ VN (chuyển từ
//! `helpers/report-date-range.helper.ts` và `dashboard-overview.util.ts`).

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Utc};
use serde_json::{Value, json};
use trinity_kernel::error::HttpError;
use trinity_kernel::vn_time::{parse_vn_date_range, vn_date, vn_to_utc};

use crate::R;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Period {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
}

fn date_only(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `parseReportPeriod`: cả hai biên bắt buộc dạng `YYYY-MM-DD`, theo giờ VN (đầu ngày → cuối ngày), bắt đầu không sau kết thúc.
pub fn parse_period(from: Option<&str>, to: Option<&str>, now: DateTime<Utc>) -> R<Period> {
    let from = from
        .filter(|s| date_only(s))
        .ok_or_else(|| HttpError::bad_request("date_from phải đúng định dạng YYYY-MM-DD"))?;
    let to = to
        .filter(|s| date_only(s))
        .ok_or_else(|| HttpError::bad_request("date_to phải đúng định dạng YYYY-MM-DD"))?;
    let (a, b) =
        parse_vn_date_range(Some(from), Some(to), 0, true, now).map_err(|e| HttpError::bad_request(e.to_string()))?;
    if a > b {
        return Err(HttpError::bad_request("Khoảng ngày không hợp lệ: ngày bắt đầu sau ngày kết thúc").into());
    }
    Ok(Period { from: a, to: b })
}

/// Kỳ liền trước, cùng độ dài (mili giây, cả hai biên tính).
pub fn previous_period(p: Period) -> Period {
    let len = p.to - p.from + Duration::milliseconds(1);
    let to = p.from - Duration::milliseconds(1);
    Period {
        from: to - len + Duration::milliseconds(1),
        to,
    }
}

/// `toFixed(1)` của JS rồi `Number(...)`: nửa thì làm tròn ra xa số 0 (Rust `{:.1}` làm tròn nửa về chẵn).
pub fn to_fixed_1(x: f64) -> f64 {
    let a = x.abs();
    let quarter = a * 4.0;
    let tie = quarter.fract() == 0.0 && (quarter as i64) % 2 == 1;
    let r = if tie {
        ((a * 10.0).floor() + 1.0) / 10.0
    } else {
        format!("{a:.1}").parse().unwrap_or(a)
    };
    if x < 0.0 { -r } else { r }
}

/// `buildDeltaMetric`: `{ current, previous, delta_abs, delta_pct }` (`delta_pct` null khi kỳ trước bằng 0).
pub fn delta_metric(current: i64, previous: i64) -> Value {
    let delta = current - previous;
    let pct = (previous != 0).then(|| to_fixed_1(delta as f64 / previous as f64 * 100.0));
    json!({ "current": current, "previous": previous, "delta_abs": delta, "delta_pct": pct.map(crate::period::num) })
}

/// Số JS: nguyên thì không có `.0`.
pub fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// Khoảng `[start, end)` theo giờ VN.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VnRange {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

fn month_start(y: i32, m0: i32) -> DateTime<Utc> {
    // `m0` có thể âm hoặc vượt 11 như `Date.UTC(y, m, 1)`.
    let total = y * 12 + m0;
    let (yy, mm) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    vn_to_utc(
        NaiveDate::from_ymd_opt(yy, mm, 1).unwrap_or(NaiveDate::MIN),
        NaiveTime::MIN,
    )
}

/// `vnMonthRange(monthsAgo)`: từ 00:00 ngày 1 tháng đó tới 00:00 ngày 1 tháng sau, giờ VN.
pub fn month_range(months_ago: i32, now: DateTime<Utc>) -> VnRange {
    let d = vn_date(now);
    let m0 = d.month0() as i32 - months_ago;
    VnRange {
        start: month_start(d.year(), m0),
        end: month_start(d.year(), m0 + 1),
    }
}

/// `vnMonthLabel(monthsAgo)`: `MM/YYYY`.
pub fn month_label(months_ago: i32, now: DateTime<Utc>) -> String {
    let d = vn_date(now);
    let total = d.year() * 12 + d.month0() as i32 - months_ago;
    format!("{:02}/{}", total.rem_euclid(12) + 1, total.div_euclid(12))
}

/// `vnTodayRange`: hôm nay theo giờ VN.
pub fn today_range(now: DateTime<Utc>) -> VnRange {
    let start = vn_to_utc(vn_date(now), NaiveTime::MIN);
    VnRange {
        start,
        end: start + Duration::days(1),
    }
}

/// Ngày VN `days_ago` ngày trước: `[start, end)`.
pub fn day_range(days_ago: i64, now: DateTime<Utc>) -> VnRange {
    let start = today_range(now).start - Duration::days(days_ago);
    VnRange {
        start,
        end: start + Duration::days(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn ky_bao_cao_va_ky_truoc() {
        let now = at("2026-11-27T05:00:00Z");
        let p = parse_period(Some("2026-11-01"), Some("2026-11-10"), now).unwrap();
        assert_eq!(p.from, at("2026-10-31T17:00:00Z"));
        assert_eq!(p.to, at("2026-11-10T16:59:59.999Z"));
        let prev = previous_period(p);
        assert_eq!(
            (prev.from, prev.to),
            (at("2026-10-21T17:00:00Z"), at("2026-10-31T16:59:59.999Z"))
        );
        for (a, b, m) in [
            (None, Some("2026-11-01"), "date_from phải đúng định dạng YYYY-MM-DD"),
            (
                Some("2026-11-01"),
                Some("1/2"),
                "date_to phải đúng định dạng YYYY-MM-DD",
            ),
        ] {
            assert!(parse_period(a, b, now).unwrap_err().to_string().ends_with(m), "{m}");
        }
        assert!(
            parse_period(Some("2026-11-10"), Some("2026-11-01"), now)
                .unwrap_err()
                .to_string()
                .contains("ngày bắt đầu sau ngày kết thúc")
        );
    }

    #[test]
    fn chenh_lech_va_lam_tron() {
        assert_eq!(
            delta_metric(5, 0),
            json!({ "current": 5, "previous": 0, "delta_abs": 5, "delta_pct": null })
        );
        assert_eq!(
            delta_metric(3, 4),
            json!({ "current": 3, "previous": 4, "delta_abs": -1, "delta_pct": -25 })
        );
        assert_eq!(delta_metric(1, 3)["delta_pct"], json!(-66.7));
        assert_eq!(to_fixed_1(0.25), 0.3);
        assert_eq!(to_fixed_1(-0.25), -0.3);
        assert_eq!(to_fixed_1(1.25), 1.3);
        assert_eq!(to_fixed_1(33.333), 33.3);
        assert_eq!(to_fixed_1(100.0), 100.0);
    }

    #[test]
    fn moc_thang_va_ngay_gio_vn() {
        let now = at("2026-01-31T18:00:00Z"); // 01:00 ngày 1/2 giờ VN
        assert_eq!(month_label(0, now), "02/2026");
        assert_eq!(month_label(1, now), "01/2026");
        assert_eq!(month_label(2, now), "12/2025");
        let r = month_range(0, now);
        assert_eq!(
            (r.start, r.end),
            (at("2026-01-31T17:00:00Z"), at("2026-02-28T17:00:00Z"))
        );
        let t = today_range(now);
        assert_eq!(t.start, at("2026-01-31T17:00:00Z"));
        assert_eq!(day_range(1, now).start, at("2026-01-30T17:00:00Z"));
        assert_eq!(month_range(13, now).start, at("2024-12-31T17:00:00Z"));
    }
}
