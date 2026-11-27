//! Khung giờ đăng hàng đợi hằng tuần (`social-queue.service.ts`, M55a): đọc, thay toàn bộ, tìm khung trống gần nhất.
//! Thứ (0 = Chủ nhật … 6) và phút trong ngày tính theo giờ Việt Nam (UTC+7, không có giờ mùa hè); thời điểm là mili giây UTC.
//! Hàm nhận `&mut PgConnection` đã gắn công ty; không gọi mạng nên giữ kết nối trong một hàm là an toàn.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{Connection, PgConnection};
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::from_millis;

const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;
/// Giờ Việt Nam = UTC+7.
const VN_OFFSET_MS: i64 = 7 * 3_600_000;
pub const MAX_QUEUE_SLOTS: usize = 100;
/// Khung phải cách bây giờ ít nhất chừng này (đủ để bài còn sửa/huỷ được).
pub const QUEUE_MIN_LEAD_MS: i64 = 2 * MINUTE;
/// Hẹn giờ không quá 90 ngày (`MAX_SCHEDULE_AHEAD_MS` của `social.config.ts`).
pub const MAX_SCHEDULE_AHEAD_MS: i64 = 90 * DAY;
pub const NO_QUEUE_SLOTS: &str = "Chưa đặt khung giờ hàng đợi (Đăng đa kênh › Lịch › Khung giờ)";
/// Khoá advisory: hai lượt `PUT queue/slots` cùng lúc không đụng ràng buộc duy nhất `(weekday, minute)`.
const SLOTS_LOCK: i64 = 7_524_002;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn bad(m: &str) -> AppError {
    HttpError::bad_request(m).into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct QueueSlot {
    pub weekday: i32,
    pub minute: i32,
}

/// Thứ + phút trong ngày giờ Việt Nam ⇒ thời điểm UTC ĐẦU TIÊN sau `after` (mili giây).
pub fn slot_after(slot: QueueSlot, after: i64) -> i64 {
    let vn = after + VN_OFFSET_MS;
    let day_index = vn.div_euclid(DAY);
    let day_start = day_index * DAY;
    // 1970-01-01 là thứ Năm; `getUTCDay()` của JS: 0 = Chủ nhật.
    let today = (day_index + 4).rem_euclid(7);
    let mut t = day_start + (i64::from(slot.weekday) - today + 7).rem_euclid(7) * DAY + i64::from(slot.minute) * MINUTE;
    if t <= vn {
        t += 7 * DAY;
    }
    t - VN_OFFSET_MS
}

/// Các lần xảy ra của danh sách khung, theo thứ tự thời gian, sau `after` và không quá `until` (mili giây).
pub fn occurrences(slots: &[QueueSlot], after: i64, until: i64) -> Vec<i64> {
    let mut out = Vec::new();
    for s in slots {
        let mut d = slot_after(*s, after);
        while d <= until {
            out.push(d);
            d += 7 * DAY;
        }
    }
    out.sort_unstable();
    out
}

/// `GET /social/queue/next?count=`: chỉ chuỗi toàn chữ số mới tính, kẹp 1 đến 20, còn lại là 1 (bản `social.controller.ts`).
pub fn next_count_param(count: Option<&str>) -> usize {
    match count {
        Some(c) if !c.is_empty() && c.bytes().all(|b| b.is_ascii_digit()) => {
            c.parse::<u64>().map_or(20, |n| n.clamp(1, 20) as usize)
        }
        _ => 1,
    }
}

// ───────────────────────────── DTO ─────────────────────────────

/// Số nguyên trong khoảng `[0, max]` đúng như `@IsInt() @Min(0) @Max(max)`; thông điệp theo thứ tự class-validator
/// (decorator khai sau chạy trước: Max, Min, IsInt).
fn bounded_int(v: Option<&Value>, path: &str, field: &str, max: i64, errs: &mut Vec<String>) -> Option<i32> {
    let n = v.and_then(Value::as_f64);
    let int = n.filter(|x| x.fract() == 0.0);
    if n.is_none_or(|x| x > max as f64) {
        errs.push(format!("{path}.{field} must not be greater than {max}"));
    }
    if n.is_none_or(|x| x < 0.0) {
        errs.push(format!("{path}.{field} must not be less than 0"));
    }
    if int.is_none() {
        errs.push(format!("{path}.{field} must be an integer number"));
    }
    int.filter(|x| (0.0..=max as f64).contains(x)).map(|x| x as i32)
}

/// Body `PUT /social/queue/slots` (`SocialQueueSlotsDto`): `slots` là mảng ≤ 100 phần tử `{weekday 0–6, minute 0–1439}`.
/// Thuộc tính lạ ⇒ "property x should not exist" (whitelist). Phần tử trùng gộp một.
pub fn parse_slots(body: &Value) -> Result<Vec<QueueSlot>, HttpError> {
    let mut errs: Vec<String> = Vec::new();
    if let Some(o) = body.as_object() {
        for k in o.keys().filter(|k| k.as_str() != "slots") {
            errs.push(format!("property {k} should not exist"));
        }
    }
    let list = body.get("slots");
    let mut out = Vec::new();
    match list {
        Some(Value::Array(a)) => {
            if a.len() > MAX_QUEUE_SLOTS {
                errs.push(format!("slots must contain no more than {MAX_QUEUE_SLOTS} elements"));
            }
            for (i, item) in a.iter().enumerate() {
                let path = format!("slots.{i}");
                if let Some(o) = item.as_object() {
                    for k in o.keys().filter(|k| !matches!(k.as_str(), "weekday" | "minute")) {
                        errs.push(format!("{path}.property {k} should not exist"));
                    }
                }
                let w = bounded_int(item.get("weekday"), &path, "weekday", 6, &mut errs);
                let m = bounded_int(item.get("minute"), &path, "minute", 1439, &mut errs);
                if let (Some(weekday), Some(minute)) = (w, m) {
                    out.push(QueueSlot { weekday, minute });
                }
            }
        }
        _ => errs.push("slots must be an array".to_owned()),
    }
    if !errs.is_empty() {
        return Err(HttpError::validation(errs));
    }
    Ok(out)
}

// ───────────────────────────── DB ─────────────────────────────

/// Khung giờ theo thứ rồi theo giờ.
pub async fn slots(conn: &mut PgConnection) -> Result<Vec<QueueSlot>, AppError> {
    let rows: Vec<(i32, i32)> =
        sqlx::query_as("SELECT weekday, minute FROM social_queue_slots ORDER BY weekday ASC, minute ASC")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    Ok(rows
        .into_iter()
        .map(|(weekday, minute)| QueueSlot { weekday, minute })
        .collect())
}

/// `PUT /social/queue/slots`: thay toàn bộ danh sách khung trong một giao dịch; trả danh sách đã sắp, bỏ trùng.
pub async fn set_slots(conn: &mut PgConnection, list: &[QueueSlot]) -> Result<Vec<QueueSlot>, AppError> {
    let mut seen: HashSet<QueueSlot> = HashSet::new();
    for s in list {
        if !(0..=6).contains(&s.weekday) {
            return Err(bad("Thứ phải từ 0 (Chủ nhật) đến 6 (Thứ bảy)."));
        }
        if !(0..=1439).contains(&s.minute) {
            return Err(bad("Giờ phải từ 00:00 đến 23:59."));
        }
        seen.insert(*s);
    }
    if seen.len() > MAX_QUEUE_SLOTS {
        return Err(bad(&format!("Tối đa {MAX_QUEUE_SLOTS} khung giờ.")));
    }
    let mut data: Vec<QueueSlot> = seen.into_iter().collect();
    data.sort_by_key(|s| (s.weekday, s.minute));
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SLOTS_LOCK)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query("DELETE FROM social_queue_slots")
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if !data.is_empty() {
        let weekdays: Vec<i32> = data.iter().map(|s| s.weekday).collect();
        let minutes: Vec<i32> = data.iter().map(|s| s.minute).collect();
        sqlx::query("INSERT INTO social_queue_slots (weekday, minute) SELECT w, m FROM UNNEST($1::int4[], $2::int4[]) AS u(w, m)")
            .bind(&weekdays)
            .bind(&minutes)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(db)?;
    Ok(data)
}

fn minute_of(ms: i64) -> i64 {
    ms.div_euclid(MINUTE)
}

/// `count` khung trống gần nhất: sau `now + 2 phút`, trong 90 ngày, bỏ khung đã có bài hẹn cùng phút. Rỗng khi chưa có khung.
pub async fn next_free(conn: &mut PgConnection, count: usize, now_ms: i64) -> Result<Vec<DateTime<Utc>>, AppError> {
    let n = count.clamp(1, 50);
    let list = slots(conn).await?;
    if list.is_empty() {
        return Ok(Vec::new());
    }
    let all = occurrences(&list, now_ms + QUEUE_MIN_LEAD_MS, now_ms + MAX_SCHEDULE_AHEAD_MS);
    let (Some(&first), Some(&last)) = (all.first(), all.last()) else {
        return Ok(Vec::new());
    };
    let (Some(lo), Some(hi)) = (from_millis(first - MINUTE), from_millis(last + MINUTE)) else {
        return Ok(Vec::new());
    };
    let taken: Vec<(DateTime<Utc>,)> = sqlx::query_as(
        "SELECT scheduled_at FROM social_posts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL \
         AND scheduled_at >= $1 AND scheduled_at <= $2",
    )
    .bind(lo)
    .bind(hi)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let used: HashSet<i64> = taken.iter().map(|(t,)| minute_of(t.timestamp_millis())).collect();
    Ok(all
        .into_iter()
        .filter(|d| !used.contains(&minute_of(*d)))
        .take(n)
        .filter_map(from_millis)
        .collect())
}

/// Khung `at` còn dùng được: còn ≥ 1 phút nữa mới tới và chưa có bài hẹn cùng phút (kiểm lại lúc chạy đề xuất đã duyệt).
pub async fn is_free(conn: &mut PgConnection, at_ms: i64, now_ms: i64) -> Result<bool, AppError> {
    if at_ms < now_ms + MINUTE {
        return Ok(false);
    }
    let start = minute_of(at_ms) * MINUTE;
    let (Some(lo), Some(hi)) = (from_millis(start), from_millis(start + MINUTE)) else {
        return Ok(false);
    };
    let taken: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM social_posts WHERE status = 'scheduled' AND scheduled_at >= $1 AND scheduled_at < $2",
    )
    .bind(lo)
    .bind(hi)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    Ok(taken == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 2026-11-27 (thứ Sáu) 10:00 giờ Việt Nam = 03:00 UTC.
    const NOW: i64 = 1_795_748_400_000;

    fn iso(ms: i64) -> String {
        trinity_kernel::vn_time::js_iso_string(from_millis(ms).unwrap())
    }

    #[test]
    fn khung_ke_tiep_theo_gio_viet_nam() {
        // Thứ Sáu (5) 11:00 VN: cùng ngày, 04:00 UTC.
        assert_eq!(
            iso(slot_after(
                QueueSlot {
                    weekday: 5,
                    minute: 660
                },
                NOW
            )),
            "2026-11-27T04:00:00.000Z"
        );
        // Thứ Sáu 09:00 VN đã qua ⇒ tuần sau.
        assert_eq!(
            iso(slot_after(
                QueueSlot {
                    weekday: 5,
                    minute: 540
                },
                NOW
            )),
            "2026-12-04T02:00:00.000Z"
        );
        // Chủ nhật (0) 00:00 VN = thứ Bảy 17:00 UTC.
        assert_eq!(
            iso(slot_after(QueueSlot { weekday: 0, minute: 0 }, NOW)),
            "2026-11-28T17:00:00.000Z"
        );
        // Đúng bằng thời điểm hiện tại ⇒ tuần sau (nghiêm ngặt "sau").
        assert_eq!(
            slot_after(
                QueueSlot {
                    weekday: 5,
                    minute: 600
                },
                NOW
            ),
            NOW + 7 * DAY
        );
    }

    #[test]
    fn cac_lan_xay_ra_co_thu_tu_va_gioi_han() {
        let s = [
            QueueSlot {
                weekday: 1,
                minute: 480,
            },
            QueueSlot {
                weekday: 5,
                minute: 660,
            },
        ];
        let o = occurrences(&s, NOW, NOW + 15 * DAY);
        assert!(o.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(o.len(), 5);
        assert!(o.iter().all(|t| *t > NOW && *t <= NOW + 15 * DAY));
        assert!(occurrences(&[], NOW, NOW + DAY).is_empty());
    }

    #[test]
    fn tham_so_count() {
        assert_eq!(next_count_param(None), 1);
        assert_eq!(next_count_param(Some("")), 1);
        assert_eq!(next_count_param(Some("abc")), 1);
        assert_eq!(next_count_param(Some("-3")), 1);
        assert_eq!(next_count_param(Some("2.5")), 1);
        assert_eq!(next_count_param(Some("0")), 1);
        assert_eq!(next_count_param(Some("7")), 7);
        assert_eq!(next_count_param(Some("99")), 20);
        assert_eq!(next_count_param(Some("99999999999999999999999")), 20);
    }

    fn msgs(v: &Value) -> Vec<String> {
        let e = parse_slots(v).unwrap_err();
        let (s, b) = AppError::from(e).response(true);
        assert_eq!(s, 400);
        // trinity-lint: allow-json-value (thông báo lỗi/giá trị so sánh trong test, không phải model hay cột DB)
        serde_json::from_value(serde_json::to_value(&b.message).unwrap()).unwrap()
    }

    #[test]
    fn kiem_body_slots() {
        let ok = parse_slots(&json!({"slots":[{"weekday":1,"minute":0},{"weekday":6,"minute":1439}]})).unwrap();
        assert_eq!(ok.len(), 2);
        assert!(parse_slots(&json!({"slots":[]})).unwrap().is_empty());
        assert_eq!(msgs(&json!({})), ["slots must be an array"]);
        assert_eq!(msgs(&json!({"slots":null})), ["slots must be an array"]);
        assert_eq!(msgs(&json!({"slots":"x"})), ["slots must be an array"]);
        assert_eq!(msgs(&json!({"slots":[],"x":1})), ["property x should not exist"]);
        assert_eq!(
            msgs(&json!({"slots":[{"weekday":7,"minute":0}]})),
            ["slots.0.weekday must not be greater than 6"]
        );
        assert_eq!(
            msgs(&json!({"slots":[{"weekday":1,"minute":-1}]})),
            ["slots.0.minute must not be less than 0"]
        );
        assert_eq!(
            msgs(&json!({"slots":[{"weekday":1.5,"minute":0}]})),
            ["slots.0.weekday must be an integer number"]
        );
        assert_eq!(
            msgs(&json!({"slots":[{"weekday":"1","minute":0}]})),
            [
                "slots.0.weekday must not be greater than 6",
                "slots.0.weekday must not be less than 0",
                "slots.0.weekday must be an integer number"
            ]
        );
        assert_eq!(
            msgs(&json!({"slots":[{"weekday":1,"minute":1440,"z":1}]})),
            [
                "slots.0.property z should not exist",
                "slots.0.minute must not be greater than 1439"
            ]
        );
        let many: Vec<Value> = (0..101).map(|i| json!({"weekday":0,"minute":i})).collect();
        assert_eq!(
            msgs(&json!({ "slots": many })),
            ["slots must contain no more than 100 elements"]
        );
    }
}
