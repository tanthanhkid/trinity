//! Ngày giờ của giá trị bản ghi: đọc chuỗi như `Date.parse` của V8 (dạng ISO), kiểm ngày lịch, định dạng ngày giờ Việt Nam
//! cho tệp xuất (chuyển từ `field-values.ts` `validYmd`, `csv-format.ts` `vnDate`/`vnDateTime`).

use std::sync::LazyLock;

use chrono::{DateTime, Days, Duration, NaiveDate, NaiveTime, Utc};
use regex::Regex;

static INSTANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)? ?$",
    )
    .expect("regex hợp lệ")
});

static YMD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$").expect("regex hợp lệ"));

/// `Date.parse` cho dạng ISO của V8 (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, kèm giờ và múi giờ): ngày 1 đến 31 ở mọi tháng (tràn
/// sang tháng sau), `24:00` là nửa đêm hôm sau; không có múi giờ = UTC (máy chủ chạy `TZ=UTC`). Dạng không phải ISO mà V8
/// còn đọc được ("March 7, 2026") trả `None`: bản Node nhận, bản Rust từ chối bằng câu "phải là ngày giờ hợp lệ".
pub fn parse_instant(v: &str) -> Option<DateTime<Utc>> {
    let c = INSTANT.captures(v)?;
    let num = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().unwrap_or(0));
    let year = i32::try_from(num(1)?).ok()?;
    let month = u32::try_from(num(2).unwrap_or(1)).ok()?;
    let day = u32::try_from(num(3).unwrap_or(1)).ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (h, mi, sec) = (num(4).unwrap_or(0), num(5).unwrap_or(0), num(6).unwrap_or(0));
    let ms = c.get(7).map_or(0, |m| {
        format!("{:0<3}", &m.as_str()[..m.as_str().len().min(3)])
            .parse::<i64>()
            .unwrap_or(0)
    });
    if mi > 59 || sec > 59 || h > 24 || (h == 24 && (mi, sec, ms) != (0, 0, 0)) {
        return None;
    }
    let offset_min = match c.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(z) => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits: String = z[1..].chars().filter(char::is_ascii_digit).collect();
            let (oh, om) = (digits[..2].parse::<i64>().ok()?, digits[2..].parse::<i64>().ok()?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 60 + om)
        }
    };
    let date = NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(Days::new(u64::from(day - 1)))?;
    let local = date.and_time(NaiveTime::MIN) + Duration::milliseconds(((h * 60 + mi) * 60 + sec) * 1000 + ms);
    Some((local - Duration::minutes(offset_min)).and_utc())
}

/// `validYmd`: `YYYY-MM-DD` là ngày lịch thật. Năm 0 đến 99 sai (`Date.UTC` đổi thành 1900 đến 1999 nên không khớp lại).
pub fn valid_ymd(s: &str) -> bool {
    let Some(c) = YMD.captures(s) else { return false };
    let p = |i: usize| c[i].parse::<u32>().unwrap_or(0);
    let y = p(1);
    y >= 100 && NaiveDate::from_ymd_opt(i32::try_from(y).unwrap_or(0), p(2), p(3)).is_some()
}

/// `toISOString()` của một thời điểm.
pub fn iso(at: DateTime<Utc>) -> String {
    trinity_kernel::vn_time::js_iso_string(at)
}

/// `vnDate`: `YYYY-MM-DD…` thành `dd/mm/yyyy`; không đúng dạng giữ nguyên.
pub fn vn_date(ymd: &str) -> String {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})").expect("regex hợp lệ"));
    match RE.captures(ymd) {
        Some(c) => format!("{}/{}/{}", &c[3], &c[2], &c[1]),
        None => ymd.to_owned(),
    }
}

/// `vnDateTime`: ISO thành `dd/mm/yyyy HH:mm` giờ Việt Nam (UTC+7); không đọc được giữ nguyên.
pub fn vn_date_time(raw: &str) -> String {
    match parse_instant(raw) {
        Some(t) => (t + Duration::hours(7)).format("%d/%m/%Y %H:%M").to_string(),
        None => raw.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ngay_gio() {
        assert!(valid_ymd("2026-02-28"));
        assert!(!valid_ymd("2026-02-30"));
        assert!(!valid_ymd("0099-01-01"));
        assert!(!valid_ymd("2026-2-3"));
        assert_eq!(vn_date("2026-11-27"), "27/11/2026");
        assert_eq!(vn_date_time("2026-11-27T17:30:00.000Z"), "28/11/2026 00:30");
        assert_eq!(vn_date_time("khong"), "khong");
        assert_eq!(iso(parse_instant("2026-02-30").unwrap()), "2026-03-02T00:00:00.000Z");
        assert!(parse_instant("2026-13-01").is_none());
    }
}
