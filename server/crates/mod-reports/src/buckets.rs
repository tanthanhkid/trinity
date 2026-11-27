//! Chia kỳ báo cáo thành các bucket ngày / tuần / tháng theo giờ VN (`helpers/report-time-buckets.helper.ts`).

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Utc};
use trinity_kernel::vn_time::{vn_date, vn_to_utc};

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bucket {
    /// Nhãn hiển thị (`dd/MM` cho ngày và tuần, `MM/yyyy` cho tháng).
    pub label: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// Chọn độ chi tiết theo độ dài kỳ, tránh trả hàng trăm điểm cho biểu đồ.
pub fn pick_granularity(from: DateTime<Utc>, to: DateTime<Utc>) -> Granularity {
    let ms = (to - from).num_milliseconds();
    let days = ms.div_euclid(DAY_MS) + i64::from(ms.rem_euclid(DAY_MS) != 0); // Math.ceil
    if days <= 31 {
        Granularity::Day
    } else if days <= 180 {
        Granularity::Week
    } else {
        Granularity::Month
    }
}

fn label(d: DateTime<Utc>, g: Granularity) -> String {
    let v = vn_date(d);
    match g {
        Granularity::Month => format!("{:02}/{:04}", v.month(), v.year()),
        _ => format!("{:02}/{:02}", v.day(), v.month()),
    }
}

/// +1 tháng dương lịch, giữ ngày neo (kẹp về cuối tháng đích: 31/01 + 1 tháng = 28/02), 00:00 giờ VN.
fn add_month_vn(d: DateTime<Utc>, anchor_day: u32) -> DateTime<Utc> {
    let v = vn_date(d);
    let total = i64::from(v.year()) * 12 + i64::from(v.month0()) + 1;
    let (y, m) = (
        i32::try_from(total.div_euclid(12)).unwrap_or(v.year()),
        u32::try_from(total.rem_euclid(12)).unwrap_or(0) + 1,
    );
    let first = NaiveDate::from_ymd_opt(y, m, 1).unwrap_or(v);
    let next_first = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1)
    };
    let last = next_first.map_or(28, |n| (n - Duration::days(1)).day());
    let day = anchor_day.min(last);
    vn_to_utc(NaiveDate::from_ymd_opt(y, m, day).unwrap_or(first), NaiveTime::MIN)
}

/// Chia `[from, to]` thành các bucket liên tiếp; bucket cuối cắt đúng `to` (không tràn quá kỳ).
pub fn build_buckets(from: DateTime<Utc>, to: DateTime<Utc>, g: Granularity) -> Vec<Bucket> {
    let step = match g {
        Granularity::Day => Duration::milliseconds(DAY_MS),
        Granularity::Week => Duration::milliseconds(DAY_MS * 7),
        Granularity::Month => Duration::zero(),
    };
    let limit = to + Duration::milliseconds(1);
    let anchor = vn_date(from).day();
    let mut out = Vec::new();
    let mut cursor = from;
    while cursor <= to {
        let end = if g == Granularity::Month {
            add_month_vn(cursor, anchor)
        } else {
            (cursor + step).min(limit)
        };
        let clamped = end.min(limit);
        out.push(Bucket {
            label: label(cursor, g),
            start: cursor,
            end: clamped,
        });
        cursor = clamped;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::period::parse_period;

    /// Đồng hồ cố định: test không phụ thuộc giờ thật.
    fn fixed_now() -> DateTime<Utc> {
        "2026-06-01T00:00:00Z".parse().unwrap()
    }

    fn period(a: &str, b: &str) -> (DateTime<Utc>, DateTime<Utc>) {
        let p = parse_period(Some(a), Some(b), fixed_now()).unwrap();
        (p.from, p.to)
    }

    #[test]
    fn do_chi_tiet_theo_do_dai() {
        let (f, t) = period("2026-01-01", "2026-01-31");
        assert_eq!(pick_granularity(f, t), Granularity::Day);
        let (f, t) = period("2026-01-01", "2026-02-02");
        assert_eq!(pick_granularity(f, t), Granularity::Week);
        let (f, t) = period("2026-01-01", "2026-12-31");
        assert_eq!(pick_granularity(f, t), Granularity::Month);
    }

    #[test]
    fn bucket_ngay_tuan_thang() {
        let (f, t) = period("2026-03-01", "2026-03-03");
        let b = build_buckets(f, t, Granularity::Day);
        assert_eq!(
            b.iter().map(|x| x.label.as_str()).collect::<Vec<_>>(),
            ["01/03", "02/03", "03/03"]
        );
        assert_eq!(b[2].end, t + Duration::milliseconds(1));
        // Tuần cuối bị cắt đúng cuối kỳ.
        let (f, t) = period("2026-03-01", "2026-03-10");
        let b = build_buckets(f, t, Granularity::Week);
        assert_eq!(b.len(), 2);
        assert_eq!(b[1].end, t + Duration::milliseconds(1));
        // Tháng neo theo ngày bắt đầu: 31/01 → 28/02 → 31/03 (không trôi về 28).
        // Mốc kế tiếp 30/04 vượt cuối kỳ 15/04 nên bucket 31/03 bị cắt ở 15/04, không có bucket thứ 4.
        let (f, t) = period("2026-01-31", "2026-04-15");
        let b = build_buckets(f, t, Granularity::Month);
        assert_eq!(
            b.iter().map(|x| x.label.as_str()).collect::<Vec<_>>(),
            ["01/2026", "02/2026", "03/2026"]
        );
        assert_eq!(vn_date(b[1].start), NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        assert_eq!(vn_date(b[2].start), NaiveDate::from_ymd_opt(2026, 3, 31).unwrap());
        // Bucket liên tiếp, phủ kín kỳ.
        assert!(b.windows(2).all(|w| w[0].end == w[1].start));
        assert_eq!(b[0].start, f);
        assert_eq!(b.last().unwrap().end, t + Duration::milliseconds(1));
    }
}
