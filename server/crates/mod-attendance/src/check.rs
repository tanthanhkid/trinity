//! Chấm công vào/ra (M13b): `POST /management/attendance/check-in` và `check-out`. Bản TS: `AttendanceService.checkIn/checkOut`.
//!
//! - IP khách lấy từ hàm dùng chung `trinity_http::edge::client_ip::resolve_client_ip` (không đọc header ở đây): `X-Real-IP`,
//!   `X-Forwarded-For` giả không qua được kiểm IP vì chỉ tin theo `TRUSTED_PROXY` / chữ ký của tiến trình biên.
//! - IP không tin được (`None`) thì cho qua, không so IP văn phòng, ghi dấu `unverified` vào `check_*_ip`.
//! - Văn phòng được gán: chỉ IP đúng văn phòng đó; chưa gán: IP của mọi văn phòng thật; quản trị: rơi về văn phòng demo.
//! - Ngày làm việc là ngày lịch Việt Nam (UTC+7 cố định) của thời điểm chấm, nên 23:59 và 00:01 giờ VN thuộc hai ngày khác nhau.
//! - Ảnh selfie bắt buộc (sau nhánh idempotent), lưu qua kho tệp; ghi DB lỗi thì xoá ảnh vừa tải.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::net::IpAddr;
use std::sync::Arc;

use axum::body::Bytes;
use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use mod_hr::contracts::ContractStore;
use mod_hr::employees::Ctx;
use serde::Serialize;
use sqlx::PgConnection;
use trinity_db::types::{DbDate, Timestamp};
use trinity_http::edge::client_ip::ClientIpResolver;
use trinity_http::edge::net::normalize_ip;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vn_time::{vn_clock_minutes, vn_date, vn_to_utc};

use crate::config::{self, ShiftConfig};
use crate::{R, db};

/// Dấu ghi vào `check_in_ip`/`check_out_ip` khi không xác minh được IP.
pub const IP_UNVERIFIED: &str = "unverified";
/// Cỡ tối đa của ảnh selfie (5 MB).
pub const SELFIE_MAX_SIZE: usize = 5 * 1024 * 1024;
pub const SELFIE_ALLOWED_MIME: &[&str] = &["image/jpeg", "image/jpg", "image/png", "image/webp"];
pub const SELFIE_MIME_ERROR: &str = "Định dạng ảnh không hợp lệ. Chỉ chấp nhận JPEG, PNG, WebP.";

/// Phụ thuộc của hai route chấm công: ngữ cảnh nhân sự, kho tệp, bộ xác định IP khách.
pub struct CheckCtx {
    pub ctx: Arc<Ctx>,
    pub store: ContractStore,
    pub ip: Arc<ClientIpResolver>,
}

/// Ảnh selfie đã đọc từ multipart.
pub struct Selfie {
    pub mime: String,
    pub data: Bytes,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::Http(HttpError::bad_request(msg.into()))
}

pub fn mime_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    }
}

// ───────────────────────────── tính toán thuần ─────────────────────────────

/// `hmToMinutes`: "HH:MM" thành số phút từ 00:00 (sai dạng thì 0).
pub fn hm_minutes(hm: &str) -> i64 {
    let mut it = hm.split(':');
    let h = it.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let m = it.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    h * 60 + m
}

/// Số phút đi muộn so với mốc `late_after_min` (phút từ 00:00 giờ VN).
pub fn late_minutes(check_in: DateTime<Utc>, late_after_min: i64) -> i32 {
    let past = i64::from(vn_clock_minutes(check_in));
    if past > late_after_min {
        (past - late_after_min) as i32
    } else {
        0
    }
}

/// Số phút nghỉ trưa rơi vào [vào, ra], neo vào NGÀY VN của lúc vào.
pub fn lunch_overlap_minutes(check_in: DateTime<Utc>, check_out: DateTime<Utc>, start: &str, end: &str) -> f64 {
    let (s, e) = (hm_minutes(start), hm_minutes(end));
    if e <= s {
        return 0.0;
    }
    let day = vn_to_utc(vn_date(check_in), NaiveTime::MIN);
    let ls = day + Duration::minutes(s);
    let le = day + Duration::minutes(e);
    let lo = check_in.max(ls);
    let hi = check_out.min(le);
    let ms = (hi - lo).num_milliseconds();
    if ms > 0 { ms as f64 / 60_000.0 } else { 0.0 }
}

/// `calcTotalHours`: giờ làm trừ nghỉ trưa, làm tròn 2 chữ số; ra không sau vào thì `None`.
pub fn total_hours(check_in: DateTime<Utc>, check_out: DateTime<Utc>, cfg: &ShiftConfig) -> Option<f64> {
    let mut ms = (check_out - check_in).num_milliseconds() as f64;
    if ms <= 0.0 {
        return None;
    }
    ms -= lunch_overlap_minutes(check_in, check_out, &cfg.lunch_start, &cfg.lunch_end) * 60_000.0;
    if ms <= 0.0 {
        return Some(0.0);
    }
    Some((ms / 3_600_000.0 * 100.0).round() / 100.0)
}

/// `calcStatus` khi đã có cả vào và ra: chỉ theo giờ làm, 4 bậc theo ngưỡng cấu hình.
pub fn calc_status(hours: f64, cfg: &ShiftConfig) -> &'static str {
    if hours < cfg.review_max_hours {
        "review"
    } else if hours < cfg.half_day_min_hours {
        "insufficient"
    } else if hours < cfg.full_day_min_hours {
        "half_day"
    } else {
        "present"
    }
}

/// `normalizeIp` + so khớp: IP khách (đã chuẩn hoá) có nằm trong danh sách IP văn phòng không.
pub fn ip_matches_office(client: IpAddr, office_ips: &[String]) -> bool {
    office_ips.iter().any(|raw| match normalize_ip(raw) {
        Some(ip) => ip == client,
        None => raw.trim().eq_ignore_ascii_case(&client.to_string()),
    })
}

/// Văn phòng dùng để kiểm IP.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OfficeRow {
    pub id: i32,
    pub name: String,
    pub ips: Option<Vec<String>>,
    pub is_demo: bool,
}

impl OfficeRow {
    fn ip_list(&self) -> &[String] {
        self.ips.as_deref().unwrap_or(&[])
    }
}

/// `resolveOfficeForCheck`.
pub fn pick_office(offices: &[OfficeRow], client: IpAddr, assigned: Option<i32>, is_super_admin: bool) -> R<OfficeRow> {
    let assigned_office = assigned.and_then(|id| offices.iter().filter(|o| !o.is_demo).find(|o| o.id == id));
    let mut matched = match assigned_office {
        Some(o) => ip_matches_office(client, o.ip_list()).then_some(o),
        None => offices
            .iter()
            .filter(|o| !o.is_demo)
            .find(|o| ip_matches_office(client, o.ip_list())),
    };
    if matched.is_none() && is_super_admin {
        matched = offices.iter().find(|o| o.is_demo);
    }
    match (matched, assigned_office) {
        (Some(o), _) => Ok(o.clone()),
        (None, Some(a)) => Err(bad(format!(
            "IP {client} không khớp văn phòng \"{}\" được phân công cho bạn. Vui lòng chấm công tại văn phòng của mình.",
            a.name
        ))),
        (None, None) => Err(bad(format!(
            "IP {client} không thuộc văn phòng nào đang hoạt động. Vui lòng chấm công trong mạng nội bộ văn phòng."
        ))),
    }
}

// ───────────────────────────── DB ─────────────────────────────

const COLS: &str = "id, user_id, employee_id, work_date, check_in_at, check_out_at, check_in_proof_key, check_out_proof_key, \
    check_in_lat, check_in_lng, check_out_lat, check_out_lng, check_in_note, check_out_note, total_hours, overtime_hours, \
    late_minutes, status, check_in_ip, check_out_ip, check_in_office_id, check_out_office_id, device_id, created_at, updated_at";

/// `AttendanceRecord` của Prisma (khoá theo thứ tự cột).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Record {
    pub id: i32,
    pub user_id: i32,
    pub employee_id: Option<i32>,
    pub work_date: DbDate,
    pub check_in_at: Option<Timestamp>,
    pub check_out_at: Option<Timestamp>,
    pub check_in_proof_key: Option<String>,
    pub check_out_proof_key: Option<String>,
    pub check_in_lat: Option<f64>,
    pub check_in_lng: Option<f64>,
    pub check_out_lat: Option<f64>,
    pub check_out_lng: Option<f64>,
    pub check_in_note: Option<String>,
    pub check_out_note: Option<String>,
    pub total_hours: Option<f64>,
    pub overtime_hours: Option<f64>,
    pub late_minutes: Option<i32>,
    pub status: String,
    pub check_in_ip: Option<String>,
    pub check_out_ip: Option<String>,
    pub check_in_office_id: Option<i32>,
    pub check_out_office_id: Option<i32>,
    pub device_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Kết quả của `POST check-in|check-out`.
#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub record: Record,
    pub already: bool,
    pub office: Option<String>,
}

/// Đầu vào chung của hai thao tác.
pub struct CheckInput<'a> {
    pub user_id: i32,
    pub device_id: &'a str,
    pub note: Option<&'a str>,
    pub selfie: Option<Selfie>,
    pub is_super_admin: bool,
    /// IP khách; `None` = không tin được.
    pub client_ip: Option<IpAddr>,
    pub now: DateTime<Utc>,
}

async fn employee_of(conn: &mut PgConnection, user_id: i32) -> R<(i32, Option<i32>)> {
    let row: Option<(i32, Option<i32>)> = sqlx::query_as("SELECT id, office_id FROM employees WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    row.ok_or_else(|| bad("Chưa có hồ sơ nhân viên. Liên hệ quản trị viên."))
}

async fn office_for(
    conn: &mut PgConnection,
    client_ip: Option<IpAddr>,
    is_super_admin: bool,
    assigned: Option<i32>,
) -> R<Option<OfficeRow>> {
    let Some(ip) = client_ip else {
        return Ok(None);
    };
    let offices: Vec<OfficeRow> =
        sqlx::query_as("SELECT id, name, ips, is_demo FROM attendance_offices WHERE is_active = true ORDER BY id")
            .fetch_all(conn)
            .await
            .map_err(db)?;
    pick_office(&offices, ip, assigned, is_super_admin).map(Some)
}

async fn find_record(conn: &mut PgConnection, user_id: i32, day: NaiveDate) -> R<Option<Record>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM attendance_records WHERE user_id = $1 AND work_date = $2"
    )))
    .bind(user_id)
    .bind(day)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

fn ip_text(ip: Option<IpAddr>) -> String {
    ip.map_or_else(|| IP_UNVERIFIED.to_owned(), |i| i.to_string())
}

async fn put_selfie(cc: &CheckCtx, user_id: i32, day: NaiveDate, slot: &str, s: Selfie) -> R<String> {
    let key = format!(
        "attendance/{user_id}/{day}/{slot}_{}.{}",
        Utc::now().timestamp_millis(),
        mime_ext(&s.mime)
    );
    cc.store.put(&key, s.data, &s.mime).await.map_err(AppError::internal)?;
    Ok(key)
}

/// `checkIn`.
pub async fn check_in(cc: &CheckCtx, conn: &mut PgConnection, input: CheckInput<'_>) -> R<CheckResult> {
    let (employee_id, assigned) = employee_of(conn, input.user_id).await?;
    let office = office_for(conn, input.client_ip, input.is_super_admin, assigned).await?;
    let day = vn_date(input.now);
    if let Some(rec) = find_record(conn, input.user_id, day).await?
        && rec.check_in_at.is_some()
    {
        return Ok(CheckResult {
            record: rec,
            already: true,
            office: office.map(|o| o.name),
        });
    }
    let Some(selfie) = input.selfie else {
        return Err(bad("Vui lòng chụp ảnh selfie để chấm công vào."));
    };
    let cfg = config::get_shift(conn).await?;
    let late = late_minutes(input.now, hm_minutes(&cfg.late_after));
    let key = put_selfie(cc, input.user_id, day, "in", selfie).await?;
    let ip = ip_text(input.client_ip);
    let res: Result<Record, sqlx::Error> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO attendance_records (user_id, employee_id, work_date, check_in_at, check_in_ip, check_in_office_id, device_id,
            check_in_note, check_in_proof_key, late_minutes, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'incomplete', $4)
         ON CONFLICT (user_id, work_date) DO UPDATE SET check_in_at = EXCLUDED.check_in_at, check_in_ip = EXCLUDED.check_in_ip,
            check_in_office_id = EXCLUDED.check_in_office_id, device_id = EXCLUDED.device_id,
            check_in_note = EXCLUDED.check_in_note, check_in_proof_key = EXCLUDED.check_in_proof_key,
            late_minutes = EXCLUDED.late_minutes, status = 'incomplete', updated_at = EXCLUDED.updated_at
         RETURNING {COLS}"
    )))
    .bind(input.user_id)
    .bind(employee_id)
    .bind(day)
    .bind(input.now)
    .bind(&ip)
    .bind(office.as_ref().map(|o| o.id))
    .bind(input.device_id)
    .bind(input.note)
    .bind(&key)
    .bind(late)
    .fetch_one(&mut *conn)
    .await;
    match res {
        Ok(record) => {
            tracing::info!("User {} checked in from IP {ip}", input.user_id);
            Ok(CheckResult {
                record,
                already: false,
                office: office.map(|o| o.name),
            })
        }
        Err(e) => {
            cc.store.remove(&key).await;
            Err(db(e))
        }
    }
}

/// `checkOut`.
pub async fn check_out(cc: &CheckCtx, conn: &mut PgConnection, input: CheckInput<'_>) -> R<CheckResult> {
    let (_, assigned) = employee_of(conn, input.user_id).await?;
    let office = office_for(conn, input.client_ip, input.is_super_admin, assigned).await?;
    let day = vn_date(input.now);
    let cfg = config::get_shift(conn).await?;
    let Some(existing) = find_record(conn, input.user_id, day).await? else {
        return Err(bad("Chưa có check-in hôm nay, không thể check-out."));
    };
    let Some(check_in_at) = existing.check_in_at else {
        return Err(bad("Chưa có check-in hôm nay, không thể check-out."));
    };
    if existing.check_out_at.is_some() {
        return Ok(CheckResult {
            record: existing,
            already: true,
            office: office.map(|o| o.name),
        });
    }
    let Some(selfie) = input.selfie else {
        return Err(bad("Vui lòng chụp ảnh selfie để chấm công ra."));
    };
    let key = put_selfie(cc, input.user_id, day, "out", selfie).await?;
    let hours = total_hours(check_in_at.0, input.now, &cfg);
    let late = late_minutes(check_in_at.0, hm_minutes(&cfg.late_after));
    let status = calc_status(hours.unwrap_or(0.0), &cfg);
    let ip = ip_text(input.client_ip);
    let res: Result<Record, sqlx::Error> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE attendance_records SET check_out_at = $2, check_out_ip = $3, check_out_office_id = $4, check_out_note = $5,
            check_out_proof_key = $6, total_hours = COALESCE($7, total_hours), late_minutes = $8, status = $9, updated_at = $2
         WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(existing.id)
    .bind(input.now)
    .bind(&ip)
    .bind(office.as_ref().map(|o| o.id))
    .bind(input.note)
    .bind(&key)
    .bind(hours)
    .bind(late)
    .bind(status)
    .fetch_one(&mut *conn)
    .await;
    match res {
        Ok(record) => {
            tracing::info!("User {} checked out from IP {ip}", input.user_id);
            Ok(CheckResult {
                record,
                already: false,
                office: office.map(|o| o.name),
            })
        }
        Err(e) => {
            cc.store.remove(&key).await;
            Err(db(e))
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn office(id: i32, name: &str, ips: &[&str], demo: bool) -> OfficeRow {
        OfficeRow {
            id,
            name: name.into(),
            ips: Some(ips.iter().map(|s| (*s).to_owned()).collect()),
            is_demo: demo,
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn ngay_viet_nam_quanh_nua_dem() {
        // 16:59 UTC = 23:59 giờ VN ngày 1; 17:00 UTC = 00:00 giờ VN ngày 2.
        assert_eq!(vn_date(utc(2026, 3, 1, 16, 59)).to_string(), "2026-03-01");
        assert_eq!(vn_date(utc(2026, 3, 1, 17, 0)).to_string(), "2026-03-02");
        assert_eq!(vn_date(utc(2026, 12, 31, 17, 1)).to_string(), "2027-01-01");
    }

    #[test]
    fn di_muon_theo_gio_vn() {
        // 01:15 UTC = 08:15 VN, mốc 08:10 nên muộn 5 phút.
        assert_eq!(late_minutes(utc(2026, 3, 2, 1, 15), 8 * 60 + 10), 5);
        assert_eq!(late_minutes(utc(2026, 3, 2, 1, 5), 8 * 60 + 10), 0);
    }

    #[test]
    fn tru_nghi_trua() {
        let cfg = ShiftConfig::default_config();
        // 08:00 đến 17:00 VN, nghỉ trưa 12:00 đến 13:30: 9h trừ 1.5h = 7.5h.
        assert_eq!(
            total_hours(utc(2026, 3, 2, 1, 0), utc(2026, 3, 2, 10, 0), &cfg),
            Some(7.5)
        );
        assert_eq!(total_hours(utc(2026, 3, 2, 10, 0), utc(2026, 3, 2, 1, 0), &cfg), None);
        // Làm trọn trong giờ nghỉ trưa thì 0 giờ.
        assert_eq!(
            total_hours(utc(2026, 3, 2, 5, 10), utc(2026, 3, 2, 6, 0), &cfg),
            Some(0.0)
        );
    }

    #[test]
    fn trang_thai_theo_nguong() {
        let c = ShiftConfig::default_config();
        assert_eq!(calc_status(0.5, &c), "review");
        assert_eq!(calc_status(3.0, &c), "insufficient");
        assert_eq!(calc_status(5.0, &c), "half_day");
        assert_eq!(calc_status(8.0, &c), "present");
    }

    #[test]
    fn ip_khop_van_phong() {
        let ips = vec!["::ffff:10.0.0.5".to_owned(), " 203.0.113.9 ".to_owned()];
        assert!(ip_matches_office(ip("10.0.0.5"), &ips));
        assert!(ip_matches_office(ip("203.0.113.9"), &ips));
        assert!(!ip_matches_office(ip("203.0.113.10"), &ips));
    }

    #[test]
    fn chon_van_phong() {
        let offices = vec![
            office(1, "A", &["10.0.0.1"], false),
            office(2, "B", &["10.0.0.2"], false),
            office(3, "Demo", &[], true),
        ];
        // Chưa gán: IP của mọi văn phòng thật.
        assert_eq!(pick_office(&offices, ip("10.0.0.2"), None, false).unwrap().id, 2);
        // Gán văn phòng A: IP của B bị từ chối.
        assert!(pick_office(&offices, ip("10.0.0.2"), Some(1), false).is_err());
        assert_eq!(pick_office(&offices, ip("10.0.0.1"), Some(1), false).unwrap().id, 1);
        // IP lạ: từ chối, trừ quản trị rơi về văn phòng demo.
        assert!(pick_office(&offices, ip("8.8.8.8"), None, false).is_err());
        assert_eq!(pick_office(&offices, ip("8.8.8.8"), None, true).unwrap().id, 3);
        // Văn phòng gán không còn hoạt động (không có trong danh sách): như chưa gán.
        assert_eq!(pick_office(&offices, ip("10.0.0.2"), Some(99), false).unwrap().id, 2);
    }
}
