//! Luật lặp bài (phần thuần của `social-recurrence.service.ts`): tính lần đăng kế tiếp theo giờ Việt Nam (UTC+7, không
//! giờ mùa hè), chuẩn hoá luật và khuôn bài. Không đọc đồng hồ, không đọc DB; mọi hàm nhận thời điểm hiện tại từ người gọi.

use std::collections::HashSet;

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use trinity_kernel::error::HttpError;
use trinity_kernel::vn_time::from_millis;

use crate::limits::MAX_SCHEDULE_AHEAD_MS;

pub const MINUTE_MS: i64 = 60_000;
pub const DAY_MS: i64 = 86_400_000;
/// Giờ Việt Nam = UTC+7.
pub const VN_OFFSET_MS: i64 = 7 * 3_600_000;
/// Trễ quá chừng này (máy ngủ) thì bỏ lần đó, không đăng muộn.
pub const RECURRENCE_LATE_MS: i64 = 60 * MINUTE_MS;
/// Bài hẹn giờ chỉ tạo được trong 90 ngày tới; lần đăng xa hơn thì chờ, chưa tạo.
pub const CREATE_AHEAD_MS: i64 = MAX_SCHEDULE_AHEAD_MS - DAY_MS;
/// Tối đa số bài lặp đang chạy.
pub const MAX_RECURRENCES: i64 = 50;
/// Tiền tố khoá chống lặp của bài do lịch lặp tạo: `recur:<id>:<giờ ISO>`.
pub const RECUR_SOURCE_PREFIX: &str = "recur:";

/// Số ngày từ 0001-01-01 (chrono, ngày 1) đến 1970-01-01.
const EPOCH_FROM_CE: i64 = 719_163;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecurFreq {
    Daily,
    Weekly,
    Monthly,
}

/// Luật lặp đã chuẩn hoá (`RecurrenceRule`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurrenceRule {
    pub freq: RecurFreq,
    pub interval: i64,
    /// 0 = Chủ nhật … 6 (chỉ weekly; bỏ trống = đúng thứ của ngày bắt đầu).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekdays: Option<Vec<u32>>,
    /// 1–31 (chỉ monthly; tháng ngắn lấy ngày cuối; bỏ trống = ngày của ngày bắt đầu).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month_day: Option<u32>,
    /// `HH:mm` giờ Việt Nam.
    pub time: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TemplateTarget {
    pub account_id: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateUtm {
    pub campaign: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// Khuôn bài đăng mỗi lần (`RecurrenceTemplate`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecurrenceTemplate {
    pub content: String,
    pub media_keys: Vec<String>,
    pub targets: Vec<TemplateTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utm: Option<TemplateUtm>,
}

fn bad(m: &str) -> HttpError {
    HttpError::bad_request(m)
}

/// `Number.isInteger` trên giá trị JSON (cả `3.0`); ngoài ±2^53 coi như không.
pub fn js_int(v: &Value) -> Option<i64> {
    let n = v.as_number()?;
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0).then_some(f as i64)
}

/// Số ngày (từ 1970-01-01) của giờ `ms` nhìn theo giờ Việt Nam.
pub fn day_num_of(ms: i64) -> i64 {
    (ms + VN_OFFSET_MS).div_euclid(DAY_MS)
}

/// `YYYY-MM-DD` đúng dạng và là ngày có thật (không nhận `2026-1-5`, `2026-02-30`).
pub fn is_day(s: &str) -> bool {
    parse_day(s).is_some()
}

/// Số ngày từ 1970-01-01 của chuỗi `YYYY-MM-DD`; sai dạng hoặc ngày không có thật ⇒ `None`.
pub fn parse_day(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let shape = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().chain(&b[5..7]).chain(&b[8..10]).all(u8::is_ascii_digit);
    if !shape {
        return None;
    }
    let d = NaiveDate::from_ymd_opt(s[..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?)?;
    Some(i64::from(d.num_days_from_ce()) - EPOCH_FROM_CE)
}

fn date_of(day: i64) -> Option<NaiveDate> {
    NaiveDate::from_num_days_from_ce_opt(i32::try_from(day + EPOCH_FROM_CE).ok()?)
}

/// 0 = Chủ nhật … 6 (1970-01-01 là thứ Năm).
fn weekday_of(day: i64) -> u32 {
    u32::try_from((day + 4).rem_euclid(7)).unwrap_or(0)
}

fn monday_of(day: i64) -> i64 {
    day - i64::from((weekday_of(day) + 6) % 7)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1)
        .and_then(|first_next| first_next.pred_opt())
        .map_or(28, |d| d.day())
}

/// Số phút từ 00:00 của `HH:mm` (đã chuẩn hoá).
fn minutes_of(time: &str) -> i64 {
    let h: i64 = time.get(..2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let m: i64 = time.get(3..5).and_then(|s| s.parse().ok()).unwrap_or(0);
    h * 60 + m
}

/// Lần đăng ĐẦU TIÊN sau `after` (giờ Việt Nam), tính theo mốc `starts_on` (`YYYY-MM-DD`): chu kỳ `interval` đếm từ
/// ngày/tuần/tháng của ngày bắt đầu; không có lần nào trước `starts_on`. `None` khi không tìm thấy trong ~2 năm.
pub fn next_occurrence(rule: &RecurrenceRule, after: DateTime<Utc>, starts_on: &str) -> Option<DateTime<Utc>> {
    let start = parse_day(starts_on)?;
    let start_date = date_of(start)?;
    let mins = minutes_of(&rule.time);
    let interval = rule.interval.max(1);
    let weekdays: Vec<u32> = match &rule.weekdays {
        Some(w) if !w.is_empty() => w.clone(),
        _ => vec![weekday_of(start)],
    };
    let after_ms = after.timestamp_millis();
    let mut d = day_num_of(after_ms).max(start);
    #[allow(clippy::explicit_counter_loop)]
    for _ in 0..800 {
        let dt = date_of(d)?;
        let hit = match rule.freq {
            RecurFreq::Daily => (d - start).rem_euclid(interval) == 0,
            RecurFreq::Weekly => {
                weekdays.contains(&weekday_of(d)) && ((monday_of(d) - monday_of(start)) / 7).rem_euclid(interval) == 0
            }
            RecurFreq::Monthly => {
                let months = i64::from(dt.year() - start_date.year()) * 12 + i64::from(dt.month0())
                    - i64::from(start_date.month0());
                let want = rule
                    .month_day
                    .unwrap_or_else(|| start_date.day())
                    .min(days_in_month(dt.year(), dt.month()));
                months.rem_euclid(interval) == 0 && dt.day() == want
            }
        };
        if hit {
            let at = d * DAY_MS + mins * MINUTE_MS - VN_OFFSET_MS;
            if at > after_ms {
                return from_millis(at);
            }
        }
        d += 1;
    }
    None
}

/// Lần kế tiếp còn hợp lệ: bỏ lần quá `ends_on`. (`max_count` do người gọi kiểm vì phụ thuộc số bài đã tạo.)
pub fn next_within(
    rule: &RecurrenceRule,
    after: DateTime<Utc>,
    starts_on: &str,
    ends_on: Option<&str>,
) -> Option<DateTime<Utc>> {
    let n = next_occurrence(rule, after, starts_on)?;
    if let Some(end) = ends_on.and_then(parse_day)
        && day_num_of(n.timestamp_millis()) > end
    {
        return None;
    }
    Some(n)
}

/// Lịch tối thiểu để tính [`upcoming`].
pub struct UpcomingSpec<'a> {
    pub rule: &'a RecurrenceRule,
    pub starts_on: &'a str,
    pub ends_on: Option<&'a str>,
    pub max_count: Option<i64>,
    pub count: i64,
    pub active: bool,
}

/// `n` lần đăng tới sau `now` (đã trừ số bài còn được tạo theo `max_count`). `pending`: đang có bài hẹn chờ — bài đó đã
/// tính vào `count` nhưng chưa tới giờ.
pub fn upcoming(spec: &UpcomingSpec<'_>, pending: bool, n: usize, now_ms: i64) -> Vec<DateTime<Utc>> {
    if !spec.active {
        return Vec::new();
    }
    let mut out = Vec::new();
    // Số lần còn lại: None = không giới hạn.
    let mut left = spec.max_count.map(|m| m - (spec.count - i64::from(pending)));
    let Some(mut cursor) = from_millis(now_ms) else {
        return out;
    };
    while out.len() < n && left.is_none_or(|l| l > 0) {
        let Some(nx) = next_within(spec.rule, cursor, spec.starts_on, spec.ends_on) else {
            break;
        };
        out.push(nx);
        cursor = nx;
        left = left.map(|l| l - 1);
    }
    out
}

/// Chuẩn hoá + kiểm luật lặp; sai ⇒ 400 tiếng Việt. `raw` là đối tượng đã ghép bản cũ với phần sửa.
pub fn normalize_rule(raw: &Value) -> Result<RecurrenceRule, HttpError> {
    let Some(r) = raw.as_object() else {
        return Err(bad("Thiếu luật lặp (rule)."));
    };
    let freq = match r.get("freq").and_then(Value::as_str) {
        Some("daily") => RecurFreq::Daily,
        Some("weekly") => RecurFreq::Weekly,
        Some("monthly") => RecurFreq::Monthly,
        _ => return Err(bad("freq phải là daily, weekly hoặc monthly.")),
    };
    let interval = match r.get("interval") {
        None => 1,
        Some(v) => js_int(v)
            .filter(|i| (1..=12).contains(i))
            .ok_or_else(|| bad("interval phải là số nguyên từ 1 đến 12."))?,
    };
    let time = r.get("time").and_then(Value::as_str).filter(|t| is_hhmm(t));
    let Some(time) = time else {
        return Err(bad("time phải có dạng HH:mm (giờ Việt Nam)."));
    };
    let mut out = RecurrenceRule {
        freq,
        interval,
        weekdays: None,
        month_day: None,
        time: time.to_owned(),
    };
    if freq == RecurFreq::Weekly
        && let Some(w) = r.get("weekdays").filter(|w| !w.is_null())
    {
        let err = || bad("weekdays là danh sách thứ từ 0 (Chủ nhật) đến 6 (Thứ bảy).");
        let list = w.as_array().ok_or_else(err)?;
        let mut days: Vec<u32> = Vec::new();
        for item in list {
            let d = js_int(item).filter(|d| (0..=6).contains(d)).ok_or_else(err)?;
            days.push(u32::try_from(d).map_err(|_| err())?);
        }
        days.sort_unstable();
        days.dedup();
        if !days.is_empty() {
            out.weekdays = Some(days);
        }
    }
    if freq == RecurFreq::Monthly
        && let Some(m) = r.get("month_day").filter(|m| !m.is_null())
    {
        let d = js_int(m)
            .filter(|d| (1..=31).contains(d))
            .ok_or_else(|| bad("month_day phải từ 1 đến 31."))?;
        out.month_day = u32::try_from(d).ok();
    }
    Ok(out)
}

/// `^([01]\d|2[0-3]):[0-5]\d$`.
fn is_hhmm(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
        && (b[0] < b'2' || (b[0] == b'2' && b[1] <= b'3'))
        && b[3] <= b'5'
}

/// Chuẩn hoá khuôn bài (chỉ giữ các trường biết).
pub fn normalize_template(raw: &Value) -> Result<RecurrenceTemplate, HttpError> {
    let Some(t) = raw.as_object() else {
        return Err(bad("Thiếu nội dung bài (template)."));
    };
    let content = t.get("content").and_then(Value::as_str).unwrap_or("").trim().to_owned();
    let mut seen = HashSet::new();
    let media_keys: Vec<String> = t
        .get("media_keys")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .filter(|k| seen.insert((*k).to_owned()))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let list = match t.get("targets").and_then(Value::as_array) {
        Some(a) if !a.is_empty() => a,
        _ => return Err(bad("Chọn ít nhất một kênh.")),
    };
    let mut targets = Vec::with_capacity(list.len());
    for x in list {
        let empty = Map::new();
        let o = x.as_object().unwrap_or(&empty);
        let account_id = o
            .get("account_id")
            .and_then(js_int)
            .and_then(|i| i32::try_from(i).ok())
            .ok_or_else(|| bad("Mỗi kênh cần account_id là số nguyên."))?;
        let caption = o
            .get("caption")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        let options = o.get("options").and_then(Value::as_object).cloned();
        targets.push(TemplateTarget {
            account_id,
            caption,
            options,
        });
    }
    let utm = t.get("utm").and_then(Value::as_object).and_then(|u| {
        let campaign = u.get("campaign").and_then(Value::as_str)?.to_owned();
        let content = u
            .get("content")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        Some(TemplateUtm { campaign, content })
    });
    Ok(RecurrenceTemplate {
        content,
        media_keys,
        targets,
        utm,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn vn(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(&format!("{iso}+07:00"))
            .unwrap()
            .with_timezone(&Utc)
    }

    fn iso(d: Option<DateTime<Utc>>) -> Option<String> {
        d.map(trinity_kernel::vn_time::js_iso_string)
    }

    fn at(s: &str) -> Option<String> {
        iso(Some(vn(s)))
    }

    fn daily() -> RecurrenceRule {
        RecurrenceRule {
            freq: RecurFreq::Daily,
            interval: 1,
            weekdays: None,
            month_day: None,
            time: "09:00".into(),
        }
    }

    #[test]
    fn hang_so_epoch() {
        assert_eq!(NaiveDate::from_ymd_opt(1970, 1, 1).unwrap().num_days_from_ce(), 719_163);
        assert_eq!(parse_day("1970-01-01"), Some(0));
        assert_eq!(weekday_of(0), 4);
        assert_eq!(weekday_of(-1), 3);
    }

    #[test]
    fn hang_ngay_hom_nay_hay_mai() {
        let r = daily();
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-20T08:00:00"), "2026-10-01")),
            at("2026-10-20T09:00:00")
        );
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-20T09:00:00"), "2026-10-01")),
            at("2026-10-21T09:00:00")
        );
    }

    #[test]
    fn moi_3_ngay() {
        let r = RecurrenceRule { interval: 3, ..daily() };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-02T10:00:00"), "2026-10-01")),
            at("2026-10-04T09:00:00")
        );
    }

    #[test]
    fn khong_truoc_ngay_bat_dau() {
        assert_eq!(
            iso(next_occurrence(&daily(), vn("2026-09-01T00:00:00"), "2026-10-05")),
            at("2026-10-05T09:00:00")
        );
    }

    #[test]
    fn nua_dem_gio_vn_la_hom_truoc_theo_utc() {
        let r = RecurrenceRule {
            time: "00:30".into(),
            ..daily()
        };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-20T00:00:00"), "2026-10-01")).as_deref(),
            Some("2026-10-19T17:30:00.000Z")
        );
    }

    #[test]
    fn hang_tuan_nhieu_thu() {
        let r = RecurrenceRule {
            freq: RecurFreq::Weekly,
            weekdays: Some(vec![1, 4]),
            time: "19:30".into(),
            ..daily()
        };
        // 2026-10-20 là Thứ Ba.
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-20T08:00:00"), "2026-10-01")),
            at("2026-10-22T19:30:00")
        );
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-22T20:00:00"), "2026-10-01")),
            at("2026-10-26T19:30:00")
        );
    }

    #[test]
    fn moi_2_tuan_tinh_tu_thu_hai() {
        let r = RecurrenceRule {
            freq: RecurFreq::Weekly,
            interval: 2,
            weekdays: Some(vec![2]),
            ..daily()
        };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-20T10:00:00"), "2026-10-20")),
            at("2026-11-03T09:00:00")
        );
    }

    #[test]
    fn tuan_khong_co_thu_la_thu_cua_ngay_bat_dau() {
        let r = RecurrenceRule {
            freq: RecurFreq::Weekly,
            ..daily()
        };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-21T00:00:00"), "2026-10-20")),
            at("2026-10-27T09:00:00")
        );
    }

    #[test]
    fn hang_thang_ngay_31_ket_ve_cuoi_thang() {
        let r = RecurrenceRule {
            freq: RecurFreq::Monthly,
            month_day: Some(31),
            time: "08:00".into(),
            ..daily()
        };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-01-31T09:00:00"), "2026-01-01")),
            at("2026-02-28T08:00:00")
        );
        assert_eq!(
            iso(next_occurrence(&r, vn("2028-02-01T00:00:00"), "2026-01-01")),
            at("2028-02-29T08:00:00")
        );
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-04-30T09:00:00"), "2026-01-01")),
            at("2026-05-31T08:00:00")
        );
    }

    #[test]
    fn moi_2_thang_ngay_15() {
        let r = RecurrenceRule {
            freq: RecurFreq::Monthly,
            interval: 2,
            month_day: Some(15),
            time: "08:00".into(),
            ..daily()
        };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-16T00:00:00"), "2026-10-01")),
            at("2026-12-15T08:00:00")
        );
    }

    #[test]
    fn hang_thang_khong_co_ngay_la_ngay_bat_dau() {
        let r = RecurrenceRule {
            freq: RecurFreq::Monthly,
            ..daily()
        };
        assert_eq!(
            iso(next_occurrence(&r, vn("2026-10-01T00:00:00"), "2026-09-17")),
            at("2026-10-17T09:00:00")
        );
    }

    #[test]
    fn next_within_dung_sau_ends_on() {
        let r = daily();
        assert_eq!(
            next_within(&r, vn("2026-10-20T10:00:00"), "2026-10-01", Some("2026-10-20")),
            None
        );
        assert_eq!(
            iso(next_within(
                &r,
                vn("2026-10-20T08:00:00"),
                "2026-10-01",
                Some("2026-10-20")
            )),
            at("2026-10-20T09:00:00")
        );
    }

    #[test]
    fn upcoming_tru_so_bai_con_duoc_tao() {
        let r = daily();
        let now = vn("2026-10-20T08:00:00").timestamp_millis();
        let spec = |max_count, count, active| UpcomingSpec {
            rule: &r,
            starts_on: "2026-10-01",
            ends_on: None,
            max_count,
            count,
            active,
        };
        let three = upcoming(&spec(None, 0, true), false, 3, now);
        assert_eq!(three.len(), 3);
        assert_eq!(iso(Some(three[2])), at("2026-10-22T09:00:00"));
        // max 5, đã tạo 4 trong đó 1 bài đang chờ ⇒ còn 2 lần.
        assert_eq!(upcoming(&spec(Some(5), 4, true), true, 3, now).len(), 2);
        assert_eq!(upcoming(&spec(Some(5), 4, true), false, 3, now).len(), 1);
        assert!(upcoming(&spec(None, 0, false), false, 3, now).is_empty());
    }

    #[test]
    fn chuan_hoa_thu() {
        let r = normalize_rule(&json!({"freq":"weekly","interval":2,"weekdays":[4,1,4],"time":"09:00"})).unwrap();
        assert_eq!(r.weekdays, Some(vec![1, 4]));
        assert_eq!(r.interval, 2);
        // Số thực nguyên vẫn là số nguyên như `Number.isInteger`.
        assert_eq!(
            normalize_rule(&json!({"freq":"daily","interval":3.0,"time":"09:00"}))
                .unwrap()
                .interval,
            3
        );
        // weekdays chỉ có ý nghĩa với weekly; rỗng ⇒ bỏ.
        assert_eq!(
            normalize_rule(&json!({"freq":"daily","weekdays":[9],"time":"09:00"}))
                .unwrap()
                .weekdays,
            None
        );
        assert_eq!(
            normalize_rule(&json!({"freq":"weekly","weekdays":[],"time":"09:00"}))
                .unwrap()
                .weekdays,
            None
        );
    }

    #[test]
    fn tu_choi_luat_sai() {
        for r in [
            json!({"freq":"yearly","time":"09:00"}),
            json!({"freq":"daily","interval":13,"time":"09:00"}),
            json!({"freq":"daily","interval":0,"time":"09:00"}),
            json!({"freq":"daily","interval":null,"time":"09:00"}),
            json!({"freq":"daily","interval":1.5,"time":"09:00"}),
            json!({"freq":"daily","time":"9:00"}),
            json!({"freq":"daily","time":"24:00"}),
            json!({"freq":"daily","time":"09:60"}),
            json!({"freq":"daily"}),
            json!({"freq":"weekly","weekdays":[7],"time":"09:00"}),
            json!({"freq":"weekly","weekdays":"1","time":"09:00"}),
            json!({"freq":"monthly","month_day":32,"time":"09:00"}),
            json!(null),
        ] {
            assert_eq!(normalize_rule(&r).unwrap_err().status(), 400, "{r}");
        }
    }

    #[test]
    fn chuan_hoa_khuon() {
        let t = normalize_template(&json!({
            "content": "  Xin chào ",
            "media_keys": [" a ", "a", "", 5, "b"],
            "targets": [{"account_id": 3, "caption": "  riêng ", "options": {"x": 1}}, {"account_id": 4, "caption": "  "}],
            "utm": {"campaign": "thu-10", "content": ""},
            "ghi_chu": "bỏ"
        }))
        .unwrap();
        assert_eq!(t.content, "Xin chào");
        assert_eq!(t.media_keys, vec!["a", "b"]);
        assert_eq!(t.targets[0].caption.as_deref(), Some("riêng"));
        assert_eq!(t.targets[1].caption, None);
        assert_eq!(
            t.utm,
            Some(TemplateUtm {
                campaign: "thu-10".into(),
                content: None
            })
        );
        for bad in [
            json!(null),
            json!({"targets": []}),
            json!({"content": "x"}),
            json!({"targets": [{"account_id": "1"}]}),
            json!({"targets": [{"account_id": 1.5}]}),
            json!({"targets": [{"account_id": 99_999_999_999_i64}]}),
            json!({"targets": [null]}),
        ] {
            assert_eq!(normalize_template(&bad).unwrap_err().status(), 400, "{bad}");
        }
    }

    #[test]
    fn ngay_that_su() {
        assert!(is_day("2026-10-20") && is_day("2028-02-29"));
        for bad in ["2026-02-30", "2026-1-5", "2026-10-20 ", "20261020", "", "2026-13-01"] {
            assert!(!is_day(bad), "{bad}");
        }
    }

    #[test]
    fn serde_khop_node() {
        let r = normalize_rule(&json!({"freq":"monthly","month_day":5,"time":"08:00"})).unwrap();
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"freq":"monthly","interval":1,"month_day":5,"time":"08:00"})
        );
        // trinity-lint: allow-json-value (thông báo lỗi/giá trị so sánh trong test, không phải model hay cột DB)
        let back: RecurrenceRule = serde_json::from_value(serde_json::to_value(&r).unwrap()).unwrap();
        assert_eq!(back, r);
    }
}
