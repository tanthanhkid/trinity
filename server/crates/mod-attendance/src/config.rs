//! Cấu hình chấm công lưu ở `settings` (JSON): ca làm việc, thứ 7 đi làm, giới hạn đơn. Đọc lỗi/rác ⇒ mặc định; ghi kiểm lại
//! như bản TS.

use std::sync::LazyLock;

use chrono::{Datelike, NaiveDate, Weekday};
use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_kernel::error::{AppError, HttpError};

use crate::dto::{UpdateAttendanceSettingsDto, UpdateRequestConfigDto, UpdateWorkingSaturdaysDto};
use crate::{R, js_num, put_setting, setting};

const SHIFT_KEY: &str = "attendance_shift_config";
const REQUEST_KEY: &str = "attendance_request_config";
const SAT_KEY: &str = "attendance_working_saturdays";

#[allow(clippy::expect_used)]
static HM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):[0-5]\d$").expect("regex HH:MM"));
#[allow(clippy::expect_used)]
static SAT_DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("regex ngày"));

fn bad(msg: &str) -> AppError {
    AppError::Http(HttpError::bad_request(msg))
}

// ───────────────────────────── ca làm việc ─────────────────────────────

/// Cấu hình ca (`ShiftConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct ShiftConfig {
    pub work_start: String,
    pub work_end: String,
    pub late_after: String,
    pub lunch_start: String,
    pub lunch_end: String,
    pub review_max_hours: f64,
    pub half_day_min_hours: f64,
    pub full_day_min_hours: f64,
}

impl ShiftConfig {
    fn default_config() -> Self {
        Self {
            work_start: "08:00".into(),
            work_end: "17:00".into(),
            late_after: "08:10".into(),
            lunch_start: "12:00".into(),
            lunch_end: "13:30".into(),
            review_max_hours: 1.0,
            half_day_min_hours: 4.0,
            full_day_min_hours: 8.0,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "work_start": self.work_start,
            "work_end": self.work_end,
            "late_after": self.late_after,
            "lunch_start": self.lunch_start,
            "lunch_end": self.lunch_end,
            "review_max_hours": js_num(self.review_max_hours),
            "half_day_min_hours": js_num(self.half_day_min_hours),
            "full_day_min_hours": js_num(self.full_day_min_hours),
        })
    }
}

/// Chuỗi `HH:MM` hợp lệ, không thì giá trị dự phòng.
fn pick(v: Option<&Value>, fallback: &str) -> String {
    v.and_then(Value::as_str)
        .filter(|s| HM.is_match(s))
        .unwrap_or(fallback)
        .to_owned()
}

/// Ngưỡng giờ: số hữu hạn trong `[0, 24]`, ngoài khoảng/không phải số ⇒ dự phòng.
fn pick_num(v: Option<&Value>, fallback: f64) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (0.0..=24.0).contains(n))
        .unwrap_or(fallback)
}

/// `GET /settings`.
pub async fn get_shift(conn: &mut PgConnection) -> R<ShiftConfig> {
    let d = ShiftConfig::default_config();
    let Some(text) = setting(conn, SHIFT_KEY).await? else {
        return Ok(d);
    };
    let Ok(Value::Object(p)) = serde_json::from_str::<Value>(&text) else {
        return Ok(d);
    };
    let g = |k: &str| p.get(k);
    Ok(ShiftConfig {
        work_start: pick(g("work_start"), &d.work_start),
        work_end: pick(g("work_end"), &d.work_end),
        late_after: pick(g("late_after"), &d.late_after),
        lunch_start: pick(g("lunch_start"), &d.lunch_start),
        lunch_end: pick(g("lunch_end"), &d.lunch_end),
        review_max_hours: pick_num(g("review_max_hours"), d.review_max_hours),
        half_day_min_hours: pick_num(g("half_day_min_hours"), d.half_day_min_hours),
        full_day_min_hours: pick_num(g("full_day_min_hours"), d.full_day_min_hours),
    })
}

/// `PATCH /settings`: trộn với cấu hình hiện có (nghỉ trưa và ngưỡng giờ không gửi thì giữ cũ), chặn nghỉ trưa đảo ngược và
/// ba ngưỡng giờ không tăng dần.
pub async fn update_shift(conn: &mut PgConnection, dto: &UpdateAttendanceSettingsDto, user: i32) -> R<ShiftConfig> {
    let cur = get_shift(conn).await?;
    let next = ShiftConfig {
        work_start: dto.work_start.clone(),
        work_end: dto.work_end.clone(),
        late_after: dto.late_after.clone(),
        lunch_start: dto.lunch_start.clone().unwrap_or(cur.lunch_start),
        lunch_end: dto.lunch_end.clone().unwrap_or(cur.lunch_end),
        review_max_hours: dto.review_max_hours.unwrap_or(cur.review_max_hours),
        half_day_min_hours: dto.half_day_min_hours.unwrap_or(cur.half_day_min_hours),
        full_day_min_hours: dto.full_day_min_hours.unwrap_or(cur.full_day_min_hours),
    };
    // So chuỗi `HH:MM` zero-pad cố định.
    if next.lunch_end <= next.lunch_start {
        return Err(bad("Giờ kết thúc nghỉ trưa phải sau giờ bắt đầu."));
    }
    if next.review_max_hours >= next.half_day_min_hours || next.half_day_min_hours >= next.full_day_min_hours {
        return Err(bad(
            "Ngưỡng giờ phải tăng dần: \"Xem xét\" < \"Chưa đủ nửa ngày\" < \"Đủ công\".",
        ));
    }
    let text = serde_json::to_string(&next.to_json()).map_err(AppError::internal)?;
    put_setting(conn, SHIFT_KEY, &text, user).await?;
    tracing::info!("Attendance shift config updated by user {user}: {text}");
    Ok(next)
}

// ───────────────────────────── thứ 7 đi làm ─────────────────────────────

/// `GET /working-saturdays`: các chuỗi `YYYY-MM-DD` trong danh sách đã lưu (rác ⇒ rỗng).
pub async fn get_saturdays(conn: &mut PgConnection) -> R<Vec<String>> {
    let Some(text) = setting(conn, SAT_KEY).await? else {
        return Ok(Vec::new());
    };
    Ok(match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter(|d| SAT_DATE.is_match(d))
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    })
}

/// `new Date('<d>T00:00:00Z').getUTCDay() === 6`: ngày dạng `YYYY-MM-DD`; ngày vượt số ngày của tháng (tới 31) tràn sang
/// tháng sau như V8; tháng hoặc ngày ngoài `1..` thì không hợp lệ.
fn is_saturday(d: &str) -> bool {
    let p = |r: std::ops::Range<usize>| d.get(r).and_then(|s| s.parse::<u32>().ok());
    let (Some(y), Some(m), Some(day)) = (p(0..4), p(5..7), p(8..10)) else {
        return false;
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return false;
    }
    let Some(first) = i32::try_from(y).ok().and_then(|y| NaiveDate::from_ymd_opt(y, m, 1)) else {
        return false;
    };
    first
        .checked_add_days(chrono::Days::new(u64::from(day - 1)))
        .is_some_and(|dt| dt.weekday() == Weekday::Sat)
}

/// `PATCH /working-saturdays`: chỉ nhận ngày `YYYY-MM-DD` hợp lệ và ĐÚNG là thứ 7; bỏ trùng và sắp xếp.
pub async fn set_saturdays(conn: &mut PgConnection, dto: &UpdateWorkingSaturdaysDto, user: i32) -> R<Value> {
    let mut valid: Vec<String> = dto
        .dates
        .iter()
        .filter(|d| SAT_DATE.is_match(d) && is_saturday(d))
        .cloned()
        .collect();
    valid.sort();
    valid.dedup();
    let text = serde_json::to_string(&valid).map_err(AppError::internal)?;
    put_setting(conn, SAT_KEY, &text, user).await?;
    tracing::info!("Working saturdays updated by user {user}: {text}");
    Ok(json!({ "dates": valid }))
}

// ───────────────────────────── giới hạn đơn ─────────────────────────────

/// Cấu hình đơn chấm công (`RequestConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct RequestConfig {
    pub default_check_in: String,
    pub default_check_out: String,
    pub monthly_forgot_limit: i64,
    pub monthly_late_early_limit: i64,
}

impl RequestConfig {
    fn default_config() -> Self {
        Self {
            default_check_in: "08:00".into(),
            default_check_out: "17:30".into(),
            monthly_forgot_limit: 2,
            monthly_late_early_limit: 3,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("default_check_in".into(), self.default_check_in.clone().into());
        m.insert("default_check_out".into(), self.default_check_out.clone().into());
        m.insert("monthly_forgot_limit".into(), self.monthly_forgot_limit.into());
        m.insert("monthly_late_early_limit".into(), self.monthly_late_early_limit.into());
        Value::Object(m)
    }
}

/// Số lượt tối đa: số không âm; số thực được giữ nguyên phần nguyên cắt xuống (bản TS giữ cả số lẻ, nhưng DTO chỉ cho số nguyên).
fn pick_limit(v: Option<&Value>, fallback: i64) -> i64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= f64::from(i32::MAX))
        .map_or(fallback, |n| n as i64)
}

/// `GET /request-config`.
pub async fn get_request_config(conn: &mut PgConnection) -> R<RequestConfig> {
    let d = RequestConfig::default_config();
    let Some(text) = setting(conn, REQUEST_KEY).await? else {
        return Ok(d);
    };
    let Ok(Value::Object(p)) = serde_json::from_str::<Value>(&text) else {
        return Ok(d);
    };
    Ok(RequestConfig {
        default_check_in: pick(p.get("default_check_in"), &d.default_check_in),
        default_check_out: pick(p.get("default_check_out"), &d.default_check_out),
        monthly_forgot_limit: pick_limit(p.get("monthly_forgot_limit"), d.monthly_forgot_limit),
        monthly_late_early_limit: pick_limit(p.get("monthly_late_early_limit"), d.monthly_late_early_limit),
    })
}

/// Số nguyên trong `[0, i32::MAX]`; ngoài khoảng ⇒ 400 (không lưu số vô nghĩa).
fn limit_of(v: f64, name: &str) -> R<i64> {
    if v.is_finite() && v.fract() == 0.0 && (0.0..=f64::from(i32::MAX)).contains(&v) {
        Ok(v as i64)
    } else {
        Err(bad(&format!(
            "{name} phải là số nguyên không âm không quá {}",
            i32::MAX
        )))
    }
}

/// `PATCH /request-config`.
pub async fn update_request_config(
    conn: &mut PgConnection,
    dto: &UpdateRequestConfigDto,
    user: i32,
) -> R<RequestConfig> {
    let next = RequestConfig {
        default_check_in: dto.default_check_in.clone(),
        default_check_out: dto.default_check_out.clone(),
        monthly_forgot_limit: limit_of(dto.monthly_forgot_limit, "monthly_forgot_limit")?,
        monthly_late_early_limit: limit_of(dto.monthly_late_early_limit, "monthly_late_early_limit")?,
    };
    let text = serde_json::to_string(&next.to_json()).map_err(AppError::internal)?;
    put_setting(conn, REQUEST_KEY, &text, user).await?;
    tracing::info!("Attendance request config updated by user {user}: {text}");
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thu_bay_nhu_v8() {
        assert!(is_saturday("2026-06-06"));
        assert!(!is_saturday("2026-06-07"));
        // 31/02 tràn sang tháng sau như V8: 2026-02-31 = 2026-03-03 (thứ Ba); 2026-02-35 không hợp lệ (ngày > 31).
        assert!(!is_saturday("2026-02-31"));
        assert!(is_saturday("2026-02-28"));
        assert!(!is_saturday("2026-13-01") && !is_saturday("2026-00-10") && !is_saturday("2026-06-00"));
        assert!(!is_saturday("2026-06-32"));
    }

    #[test]
    fn chon_gia_tri_ca() {
        let v = json!("08:05");
        assert_eq!(pick(Some(&v), "09:00"), "08:05");
        assert_eq!(pick(Some(&json!("8:05")), "09:00"), "09:00");
        assert_eq!(pick(Some(&json!(5)), "09:00"), "09:00");
        assert_eq!(pick_num(Some(&json!(25)), 8.0), 8.0);
        assert_eq!(pick_num(Some(&json!(-1)), 8.0), 8.0);
        assert_eq!(pick_num(Some(&json!(0.5)), 8.0), 0.5);
        assert_eq!(pick_limit(Some(&json!(-1)), 2), 2);
        assert_eq!(pick_limit(Some(&json!(0)), 2), 0);
        assert!(limit_of(-1.0, "x").is_err() && limit_of(1.5, "x").is_err() && limit_of(3.0e9, "x").is_err());
        assert_eq!(limit_of(7.0, "x").unwrap(), 7);
    }

    #[test]
    fn json_so_nguyen() {
        let c = ShiftConfig::default_config().to_json();
        assert_eq!(c["half_day_min_hours"].to_string(), "4");
        assert_eq!(c["work_start"], "08:00");
    }
}
