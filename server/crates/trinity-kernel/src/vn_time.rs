//! Giờ Việt Nam tường minh: Rust không dùng múi giờ của máy (PLAN mục 6.4). Hai cách tính, theo đúng bản TS:
//! - chỗ TS gọi `Intl`/`toLocale*` với `timeZone: 'Asia/Ho_Chi_Minh'` dùng cơ sở dữ liệu múi giờ ([`to_vn`]): trước
//!   13/06/1975 miền Nam dùng UTC+8, nên ngày cũ (năm sinh, 1970) mới khớp từng byte;
//! - chỗ TS viết cứng `+07:00` hay cộng 7 giờ (khoảng ngày lọc, giờ làm việc) dùng UTC+7 cố định ([`vn_to_utc`]).
//!
//! Chuyển từ `services/crm/src/common/helpers/parse-vn-date-range.helper.ts`,
//! `services/notification/src/notifications/helpers/timezone.helper.ts` và các chỗ gọi `toLocale*`/`Intl.DateTimeFormat`
//! với `timeZone: 'Asia/Ho_Chi_Minh'` (danh sách: [`VnDateStyle`]).

use std::fmt;

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Asia::Ho_Chi_Minh;
use chrono_tz::Tz;

/// Độ lệch giờ Việt Nam so với UTC, tính bằng giây.
pub const VN_OFFSET_SECS: i32 = 7 * 3600;

/// Múi giờ cố định UTC+7.
pub fn vn_offset() -> FixedOffset {
    // 7 giờ luôn nằm trong khoảng hợp lệ (±24 giờ) của FixedOffset.
    FixedOffset::east_opt(VN_OFFSET_SECS).expect("UTC+7 hợp lệ")
}

/// Thời điểm `at` nhìn theo múi `Asia/Ho_Chi_Minh` (như `Intl.DateTimeFormat` với `timeZone` đó).
pub fn to_vn(at: DateTime<Utc>) -> DateTime<Tz> {
    at.with_timezone(&Ho_Chi_Minh)
}

/// Ngày lịch Việt Nam của thời điểm `at` (ngày của hạn mức kênh, chấm công, báo cáo).
pub fn vn_date(at: DateTime<Utc>) -> NaiveDate {
    to_vn(at).date_naive()
}

/// Số phút từ 00:00 giờ Việt Nam của `at` (giờ vào/ra ca của chấm công).
pub fn vn_clock_minutes(at: DateTime<Utc>) -> u32 {
    let t = to_vn(at);
    t.hour() * 60 + t.minute()
}

/// Thời điểm UTC của `date` lúc `time` theo UTC+7 cố định (như chuỗi `…T00:00:00+07:00` của bản TS).
pub fn vn_to_utc(date: NaiveDate, time: NaiveTime) -> DateTime<Utc> {
    vn_to_utc_checked(date, time).unwrap_or(DateTime::<Utc>::MIN_UTC)
}

/// Chuỗi ISO 8601 giống `Date.prototype.toISOString` của JS: mili giây 3 chữ số, `Z`; năm ngoài 0000–9999 viết
/// `±YYYYYY`.
pub fn js_iso_string(at: DateTime<Utc>) -> String {
    let y = at.year();
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -i64::from(y))
    } else {
        format!("+{y:06}")
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.month(),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.timestamp_subsec_millis()
    )
}

/// Các kiểu hiển thị ngày giờ Việt Nam, mỗi kiểu ứng với một cách gọi `toLocale*`/`Intl.DateTimeFormat` của bản TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VnDateStyle {
    /// `5/3/2026`: `toLocaleDateString('vi-VN', { timeZone })` (xuất danh bạ).
    DayMonthYear,
    /// `05/03/2026`: phần `en-GB` dd/mm/yyyy (xuất nhân viên, sinh nhật).
    DayMonthYear2,
    /// `14:30`: `en-GB` giờ:phút 24 giờ (xuất chấm công, bảng công).
    HourMinute,
    /// `14:30 05/03/2026`: `toLocaleString('vi-VN', 2-digit…)` (`formatDateTime` của `packages/utils`).
    HourMinuteDayMonthYear2,
    /// `14:30 5/3/26`: `dateStyle: 'short', timeStyle: 'short'` của `vi-VN` (tool MCP).
    ShortDateTime,
    /// `2026-03-05`: `en-CA` năm-tháng-ngày (ngày hôm nay theo giờ VN).
    IsoDate,
    /// `2026-03`: `en-CA` năm-tháng (kỳ lương, bảng công tháng).
    IsoMonth,
    /// `05/03`: nhãn ngày của báo cáo theo mốc thời gian.
    DayMonth2,
    /// `03/2026`: nhãn tháng của báo cáo theo mốc thời gian.
    MonthYear2,
}

/// Định dạng `at` theo giờ Việt Nam, khớp từng byte với cách gọi tương ứng của bản TS (xem [`VnDateStyle`]). Năm
/// không đệm số 0 (`year: 'numeric'` của `Intl` in năm 999 là `999`).
pub fn format_vn_date(at: DateTime<Utc>, style: VnDateStyle) -> String {
    let t = to_vn(at);
    let (y, m, d, hh, mm) = (t.year(), t.month(), t.day(), t.hour(), t.minute());
    match style {
        VnDateStyle::DayMonthYear => format!("{d}/{m}/{y}"),
        VnDateStyle::DayMonthYear2 => format!("{d:02}/{m:02}/{y}"),
        VnDateStyle::HourMinute => format!("{hh:02}:{mm:02}"),
        VnDateStyle::HourMinuteDayMonthYear2 => format!("{hh:02}:{mm:02} {d:02}/{m:02}/{y}"),
        VnDateStyle::ShortDateTime => format!("{hh:02}:{mm:02} {d}/{m}/{:02}", y.rem_euclid(100)),
        VnDateStyle::IsoDate => format!("{y}-{m:02}-{d:02}"),
        VnDateStyle::IsoMonth => format!("{y}-{m:02}"),
        VnDateStyle::DayMonth2 => format!("{d:02}/{m:02}"),
        VnDateStyle::MonthYear2 => format!("{m:02}/{y}"),
    }
}

/// Lỗi của bộ đọc khoảng ngày; `Display` là câu trả người dùng (400).
///
/// Khác bản TS có chủ đích: chuỗi đúng dạng mà không thành ngày (tháng 13, ngày 32…) bản TS để lọt `Invalid Date`
/// xuống truy vấn (500); Rust trả [`Self::InvalidFrom`]/[`Self::InvalidTo`] với cùng câu sai định dạng (400).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VnRangeError {
    /// `date_from` sai dạng `YYYY-MM-DD`.
    BadFrom,
    /// `date_to` sai dạng `YYYY-MM-DD`.
    BadTo,
    /// Ngày bắt đầu sau ngày kết thúc.
    Reversed,
    /// `date_from` đúng dạng nhưng không thành ngày.
    InvalidFrom,
    /// `date_to` đúng dạng nhưng không thành ngày.
    InvalidTo,
}

impl fmt::Display for VnRangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BadFrom | Self::InvalidFrom => "date_from phải đúng định dạng YYYY-MM-DD",
            Self::BadTo | Self::InvalidTo => "date_to phải đúng định dạng YYYY-MM-DD",
            Self::Reversed => "Khoảng ngày không hợp lệ: ngày bắt đầu sau ngày kết thúc",
        })
    }
}

impl std::error::Error for VnRangeError {}

/// Khoảng thời gian lọc (biên gồm cả hai đầu).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct VnRange {
    /// 00:00:00.000 giờ VN của ngày bắt đầu.
    pub from: Option<DateTime<Utc>>,
    /// 23:59:59.999 giờ VN của ngày kết thúc.
    pub to: Option<DateTime<Utc>>,
}

/// Đúng dạng `YYYY-MM-DD` (chỉ kiểm hình dạng, như regex `^\d{4}-\d{2}-\d{2}$` của bản TS).
pub fn is_date_only(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Ngày lịch của chuỗi `YYYY-MM-DD` theo cách `new Date('YYYY-MM-DDT…+07:00')` của V8: tháng 1–12, ngày 1–31 với mọi
/// tháng, ngày vượt cuối tháng thì tràn sang tháng sau (`2026-02-30` là 02/03/2026).
fn js_calendar_date(s: &str) -> Option<NaiveDate> {
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=31).contains(&d) {
        return None;
    }
    NaiveDate::from_ymd_opt(y, m, 1)?.checked_add_signed(Duration::try_days(i64::from(d) - 1)?)
}

/// 00:00:00.000 giờ VN của ngày `s` (`None` nếu không thành ngày).
fn day_start(s: &str) -> Option<DateTime<Utc>> {
    vn_to_utc_checked(js_calendar_date(s)?, NaiveTime::MIN)
}

/// 23:59:59.999 giờ VN của ngày `s` (`None` nếu không thành ngày).
fn day_end(s: &str) -> Option<DateTime<Utc>> {
    vn_to_utc_checked(js_calendar_date(s)?, NaiveTime::from_hms_milli_opt(23, 59, 59, 999)?)
}

fn vn_to_utc_checked(date: NaiveDate, time: NaiveTime) -> Option<DateTime<Utc>> {
    Some(
        date.and_time(time)
            .checked_sub_signed(Duration::try_seconds(i64::from(VN_OFFSET_SECS))?)?
            .and_utc(),
    )
}

/// Khoảng ngày lọc theo giờ VN, KHÔNG ép khoảng mặc định: biên nào không chọn (thiếu hoặc chuỗi rỗng) là `None`
/// (`parseVnDateRangeOptional`). Màn danh sách dùng hàm này để không âm thầm cắt bản ghi cũ.
pub fn parse_vn_date_range_optional(from: Option<&str>, to: Option<&str>) -> Result<VnRange, VnRangeError> {
    let from = from.filter(|s| !s.is_empty());
    let to = to.filter(|s| !s.is_empty());
    if from.is_some_and(|s| !is_date_only(s)) {
        return Err(VnRangeError::BadFrom);
    }
    if to.is_some_and(|s| !is_date_only(s)) {
        return Err(VnRangeError::BadTo);
    }
    let range = VnRange {
        from: from
            .map(|s| day_start(s).ok_or(VnRangeError::InvalidFrom))
            .transpose()?,
        to: to.map(|s| day_end(s).ok_or(VnRangeError::InvalidTo)).transpose()?,
    };
    if let (Some(a), Some(b)) = (range.from, range.to)
        && a > b
    {
        return Err(VnRangeError::Reversed);
    }
    Ok(range)
}

/// Khoảng ngày cho báo cáo (`parseVnDateRange`): luôn đủ hai biên. Thiếu, sai dạng hoặc không thành ngày ở `from` →
/// `now - default_days` ngày; ở `to` → `now`. `strict` thì sai dạng hoặc không thành ngày là lỗi 400 (câu không dấu như
/// bản TS); bản TS để lọt `Invalid Date` ở cả hai chế độ, Rust không.
pub fn parse_vn_date_range(
    from: Option<&str>,
    to: Option<&str>,
    default_days: i64,
    strict: bool,
    now: DateTime<Utc>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), StrictRangeError> {
    let from = from.filter(|s| !s.is_empty());
    let to = to.filter(|s| !s.is_empty());
    let date_from = from.filter(|s| is_date_only(s)).and_then(day_start);
    let date_to = to.filter(|s| is_date_only(s)).and_then(day_end);
    if strict {
        if from.is_some() && date_from.is_none() {
            return Err(StrictRangeError::BadFrom);
        }
        if to.is_some() && date_to.is_none() {
            return Err(StrictRangeError::BadTo);
        }
    }
    let default_from = Duration::try_days(default_days)
        .and_then(|d| now.checked_sub_signed(d))
        .unwrap_or(DateTime::<Utc>::MIN_UTC);
    Ok((date_from.unwrap_or(default_from), date_to.unwrap_or(now)))
}

/// Lỗi của [`parse_vn_date_range`] ở chế độ `strict` (câu không dấu, giữ nguyên bản TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrictRangeError {
    /// `date_from` sai dạng hoặc không thành ngày.
    BadFrom,
    /// `date_to` sai dạng hoặc không thành ngày.
    BadTo,
}

impl fmt::Display for StrictRangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BadFrom => "date_from phai dung dinh dang YYYY-MM-DD",
            Self::BadTo => "date_to phai dung dinh dang YYYY-MM-DD",
        })
    }
}

impl std::error::Error for StrictRangeError {}

/// Đang trong giờ làm việc Việt Nam (08:00–18:00) (`isBusinessHours`).
pub fn is_business_hours(at: DateTime<Utc>) -> bool {
    (8..18).contains(&fixed_vn(at).hour())
}

/// `at` cộng 7 giờ cố định (`getVietnamTime` của bản TS).
fn fixed_vn(at: DateTime<Utc>) -> DateTime<FixedOffset> {
    at.with_timezone(&vn_offset())
}

/// 08:00 giờ VN kế tiếp (hôm nay nếu chưa tới 8 giờ, không thì ngày mai) (`getNextBusinessStart`).
pub fn next_business_start(at: DateTime<Utc>) -> DateTime<Utc> {
    let t = fixed_vn(at);
    let day = if t.hour() < 8 {
        t.date_naive()
    } else {
        t.date_naive() + Duration::days(1)
    };
    vn_to_utc(day, NaiveTime::from_hms_opt(8, 0, 0).unwrap_or(NaiveTime::MIN))
}

/// Thời điểm UTC từ mili giây kể từ epoch, như `new Date(ms)`.
pub fn from_millis(ms: i64) -> Option<DateTime<Utc>> {
    Utc.timestamp_millis_opt(ms).single()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).expect("rfc3339").with_timezone(&Utc)
    }

    #[test]
    fn khoang_bao_cao_mac_dinh_va_strict() {
        let now = at("2026-05-10T03:00:00Z");
        let (a, b) = parse_vn_date_range(None, None, 7, false, now).expect("ok");
        assert_eq!(a, at("2026-05-03T03:00:00Z"));
        assert_eq!(b, now);
        let (a, b) = parse_vn_date_range(Some("2026/05/01"), Some("2026-05-10"), 30, false, now).expect("ok");
        assert_eq!(a, at("2026-04-10T03:00:00Z"));
        assert_eq!(js_iso_string(b), "2026-05-10T16:59:59.999Z");
        let e = parse_vn_date_range(Some("2026/05/01"), None, 7, true, now).expect_err("strict");
        assert_eq!(e.to_string(), "date_from phai dung dinh dang YYYY-MM-DD");
        let e = parse_vn_date_range(None, Some("x"), 7, true, now).expect_err("strict");
        assert_eq!(e.to_string(), "date_to phai dung dinh dang YYYY-MM-DD");
        // Không thành ngày: strict là lỗi 400, không strict rơi về khoảng mặc định.
        let e = parse_vn_date_range(Some("2026-13-01"), None, 7, true, now).expect_err("strict");
        assert_eq!(e, StrictRangeError::BadFrom);
        let (a, b) = parse_vn_date_range(Some("2026-13-01"), Some("2026-05-32"), 7, false, now).expect("ok");
        assert_eq!((a, b), (at("2026-05-03T03:00:00Z"), now));
        // Số ngày mặc định quá lớn không làm tràn.
        assert_eq!(
            parse_vn_date_range(None, None, i64::MAX, false, now).expect("ok").0,
            DateTime::<Utc>::MIN_UTC
        );
    }

    // Ca từ services/notification/src/notifications/__tests__/timezone.helper.spec.ts.
    #[test]
    fn gio_lam_viec() {
        assert!(is_business_hours(at("2026-03-05T01:00:00Z"))); // 08:00 VN
        assert!(!is_business_hours(at("2026-03-05T00:59:59Z"))); // 07:59 VN
        assert!(is_business_hours(at("2026-03-05T10:59:59Z"))); // 17:59 VN
        assert!(!is_business_hours(at("2026-03-05T11:00:00Z"))); // 18:00 VN
        assert_eq!(
            next_business_start(at("2026-03-04T20:00:00Z")),
            at("2026-03-05T01:00:00Z")
        ); // 03:00 VN
        assert_eq!(
            next_business_start(at("2026-03-05T01:00:00Z")),
            at("2026-03-06T01:00:00Z")
        ); // 08:00 VN
        assert_eq!(
            next_business_start(at("2026-03-05T16:59:00Z")),
            at("2026-03-06T01:00:00Z")
        ); // 23:59 VN
    }

    #[test]
    fn iso_nam_ngoai_khoang() {
        assert_eq!(
            js_iso_string(at("0000-01-01T00:00:00Z") - Duration::days(1)),
            "-000001-12-31T00:00:00.000Z"
        );
        assert_eq!(vn_clock_minutes(at("2026-03-05T07:30:09Z")), 14 * 60 + 30);
        assert_eq!(
            from_millis(0).map(js_iso_string).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
    }
}
