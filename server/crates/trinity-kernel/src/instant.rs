//! Đọc chuỗi ngày giờ như `new Date(str)` của V8 cho mọi dạng `@IsDateString` cho qua (dùng chung M10, M19).

use chrono::{DateTime, NaiveDate, Utc};

/// `new Date(str)` của V8 cho mọi chuỗi mà `@IsDateString` (validator.js `isISO8601`) cho qua và V8 đọc được: `YYYY`,
/// `YYYY-MM`, `YYYY-MM-DD` (UTC), `…T` hoặc dấu cách rồi `hh:mm[:ss[.fff…]]` kèm `Z`, `±hh:mm` hoặc `±hhmm` (không múi giờ =
/// giờ máy chủ: `naive_offset_min` phút so với UTC, 0 với `TZ=UTC`, 420 với giờ Việt Nam). Như V8: ngày 1 đến 31 ở mọi tháng (`2026-02-30` thành `2026-03-02`), `24:00` là nửa đêm hôm sau,
/// phần thập phân cắt ở mili giây. Dạng V8 không đọc được (tuần ISO, ngày thứ tự, `YYYYMMDD`, `T01` thiếu phút…) ⇒ `None`
/// (Node: `Invalid Date`, Prisma lỗi 500). Đối chiếu bằng `tests/fixtures/dates.json` sinh từ `new Date()` thật.
pub fn parse_instant_with(v: &str, naive_offset_min: i64) -> Option<DateTime<Utc>> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)? ?$",
        )
        .expect("regex hợp lệ")
    });
    let c = RE.captures(v)?;
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
        Some("Z") => 0,
        // Chỉ ngày (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) luôn là UTC; có giờ mà không múi giờ mới theo giờ máy chủ.
        None if c.get(4).is_some() => naive_offset_min,
        None => 0,
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
    let date = NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_days(chrono::Days::new(u64::from(day - 1)))?;
    let local =
        date.and_time(chrono::NaiveTime::MIN) + chrono::Duration::milliseconds(((h * 60 + mi) * 60 + sec) * 1000 + ms);
    Some((local - chrono::Duration::minutes(offset_min)).and_utc())
}
