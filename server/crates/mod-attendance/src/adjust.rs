//! «Sửa giờ công kèm lý do» (quản lý sửa giờ vào/ra của một ngày công, bắt buộc ghi lý do, lưu lịch sử).
//!
//! - `POST /management/attendance/:id/edits` (`attendance.manage`, 201): đổi giờ vào/ra theo giờ Việt Nam trên đúng `work_date` của
//!   bản ghi, tính lại tổng giờ, đi muộn, trạng thái, ghi một dòng `attendance_edits` (ai sửa, lý do, giờ cũ, giờ mới). Cập nhật bản
//!   ghi và ghi lịch sử nằm CÙNG một giao dịch (lịch sử là chính chức năng, không phải ghi phụ): lỗi một bên thì cả hai hoàn tác.
//! - `GET /management/attendance/:id/edits` (`attendance.view`): lịch sử sửa của một bản ghi, mới nhất trước.
//! - `PATCH /:id` cũ giữ nguyên (trang Quản lý chấm công dùng); sửa qua đường đó KHÔNG vào lịch sử vì không có lý do.
//!
//! Phạm vi chủ bản ghi lấy từ `ScopeService` TRƯỚC khi lấy kết nối; bản ghi ngoài phạm vi ⇒ 404. Lõi ([`adjust`], [`list_edits`],
//! [`find_record_id`]) nhận kết nối + `OwnerIds` nên tool MCP dùng chung đúng một đường với route.
//!
//! Body kiểm bằng hàm [`parse_input`] (DTO không có trong `contracts/dto/schema.json`): trường lạ ⇒ `property x should not exist`,
//! `reason` bắt buộc (cắt khoảng trắng, 1..=500 ký tự), `check_in`/`check_out` tuỳ chọn dạng `H:MM`/`HH:MM` 24 giờ, `null` ⇒ 400,
//! ít nhất một giờ phải có.

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use mod_hr::employees::Ctx;
use mod_users::guards::Actor;
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::types::Timestamp;
use trinity_kernel::error::HttpError;
use trinity_kernel::vn_time::vn_to_utc;
use trinity_rbac::OwnerIds;

use crate::check::{hm_minutes, total_hours};
use crate::records::{COLS, Rec, bad, in_owner, late_of, manual_status, not_found};
use crate::requests::owner_of;
use crate::{R, config, db};

/// Độ dài tối đa của lý do (ký tự, đơn vị UTF-16 như `String.length`).
pub const REASON_MAX: usize = 500;

/// Body đã kiểm: giờ `HH:MM` (đã chuẩn hoá) và lý do đã cắt khoảng trắng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdjustInput {
    pub check_in: Option<String>,
    pub check_out: Option<String>,
    pub reason: String,
}

/// `H:MM`/`HH:MM` 24 giờ ⇒ `HH:MM`.
fn hm_of(s: &str) -> Option<String> {
    let (h, m) = s.split_once(':')?;
    let digits = |x: &str, n: &[usize]| n.contains(&x.len()) && x.bytes().all(|b| b.is_ascii_digit());
    if !digits(h, &[1, 2]) || !digits(m, &[2]) {
        return None;
    }
    let (h, m) = (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?);
    (h < 24 && m < 60).then(|| format!("{h:02}:{m:02}"))
}

fn time_field(o: &Map<String, Value>, key: &str, errors: &mut Vec<String>) -> Option<String> {
    match o.get(key) {
        None => None,
        Some(Value::String(s)) => {
            let hm = hm_of(s.trim());
            if hm.is_none() {
                errors.push(format!("{key} phải có dạng HH:MM (24 giờ), ví dụ 08:05"));
            }
            hm
        }
        Some(_) => {
            errors.push(format!("{key} phải là chuỗi giờ HH:MM"));
            None
        }
    }
}

/// Kiểm body `POST /:id/edits` như ValidationPipe strict: lỗi gom thành danh sách câu, 400.
pub fn parse_input(body: &Value) -> Result<AdjustInput, HttpError> {
    let empty = Map::new();
    let o = body.as_object().unwrap_or(&empty);
    let mut errors: Vec<String> = o
        .keys()
        .filter(|k| !["check_in", "check_out", "reason"].contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect();
    let check_in = time_field(o, "check_in", &mut errors);
    let check_out = time_field(o, "check_out", &mut errors);
    let reason = match o.get("reason") {
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                errors.push("reason không được rỗng".to_owned());
            } else if t.encode_utf16().count() > REASON_MAX {
                errors.push(format!("reason tối đa {REASON_MAX} ký tự"));
            }
            t.to_owned()
        }
        Some(_) => {
            errors.push("reason phải là chuỗi".to_owned());
            String::new()
        }
        None => {
            errors.push("reason không được rỗng".to_owned());
            String::new()
        }
    };
    if errors.is_empty() && check_in.is_none() && check_out.is_none() {
        errors.push("Cần sửa ít nhất một trong check_in, check_out".to_owned());
    }
    if errors.is_empty() {
        Ok(AdjustInput {
            check_in,
            check_out,
            reason,
        })
    } else {
        Err(HttpError::validation(errors))
    }
}

/// Một dòng lịch sử sửa giờ công.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct EditOut {
    pub id: i32,
    pub record_id: i32,
    pub editor_id: Option<i32>,
    pub editor_name: Option<String>,
    pub old_check_in_at: Option<Timestamp>,
    pub old_check_out_at: Option<Timestamp>,
    pub new_check_in_at: Option<Timestamp>,
    pub new_check_out_at: Option<Timestamp>,
    pub reason: String,
    pub created_at: Timestamp,
}

/// Kết quả `POST /:id/edits`: bản ghi sau khi sửa và dòng lịch sử vừa ghi.
#[derive(Debug, Clone, Serialize)]
pub struct Adjusted {
    pub record: Rec,
    pub edit: EditOut,
}

const EDIT_SELECT: &str = "SELECT e.id, e.record_id, e.editor_id, u.full_name AS editor_name,
        e.old_check_in_at, e.old_check_out_at, e.new_check_in_at, e.new_check_out_at, e.reason, e.created_at
     FROM attendance_edits e LEFT JOIN users u ON u.id = e.editor_id";

/// Giờ `HH:MM` giờ VN trên ngày `day` ⇒ UTC.
fn vn_instant(day: NaiveDate, hm: &str) -> R<DateTime<Utc>> {
    let t = NaiveTime::parse_from_str(hm, "%H:%M").map_err(|_| bad(format!("giờ không hợp lệ: {hm}")))?;
    Ok(vn_to_utc(day, t))
}

/// Sửa giờ vào/ra của bản ghi `record_id` (ngoài phạm vi `owner` ⇒ 404) và ghi lịch sử, trong một giao dịch.
pub async fn adjust(
    conn: &mut PgConnection,
    owner: &OwnerIds,
    editor: i32,
    record_id: i32,
    input: &AdjustInput,
) -> R<Adjusted> {
    let mut tx = conn.begin().await.map_err(db)?;
    let found: Option<Rec> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {} FROM attendance_records WHERE id = $1 FOR UPDATE",
        COLS.join(", ")
    )))
    .bind(record_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let rec = found.filter(|r| in_owner(owner, r.user_id)).ok_or_else(not_found)?;
    let cfg = config::get_shift(&mut tx).await?;
    let day = rec.work_date.0;

    let old_in = rec.check_in_at.map(|t| t.0);
    let old_out = rec.check_out_at.map(|t| t.0);
    let new_in = match &input.check_in {
        Some(hm) => Some(vn_instant(day, hm)?),
        None => old_in,
    };
    let new_out = match &input.check_out {
        Some(hm) => Some(vn_instant(day, hm)?),
        None => old_out,
    };
    if let Some((i, o)) = new_in.zip(new_out)
        && o <= i
    {
        return Err(bad("Giờ ra phải sau giờ vào."));
    }
    if new_in == old_in && new_out == old_out {
        return Err(bad("Giờ vào/ra không thay đổi so với hiện tại."));
    }

    let total = new_in.zip(new_out).and_then(|(i, o)| total_hours(i, o, &cfg));
    let late = late_of(new_in, hm_minutes(&cfg.late_after));
    let status = manual_status(&cfg, new_in, new_out);
    let record: Rec = sqlx::query_as(AssertSqlSafe(format!(
        "UPDATE attendance_records SET check_in_at = $1, check_out_at = $2, total_hours = $3, late_minutes = $4,
            status = $5, updated_at = now() WHERE id = $6 RETURNING {}",
        COLS.join(", ")
    )))
    .bind(new_in)
    .bind(new_out)
    .bind(total)
    .bind(late)
    .bind(status)
    .bind(record_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;

    let edit_id: i32 = sqlx::query_scalar(
        "INSERT INTO attendance_edits (record_id, user_id, editor_id, old_check_in_at, old_check_out_at,
            new_check_in_at, new_check_out_at, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(record_id)
    .bind(rec.user_id)
    .bind(editor)
    .bind(old_in)
    .bind(old_out)
    .bind(new_in)
    .bind(new_out)
    .bind(&input.reason)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let edit: EditOut = sqlx::query_as(AssertSqlSafe(format!("{EDIT_SELECT} WHERE e.id = $1")))
        .bind(edit_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Adjusted { record, edit })
}

/// Lịch sử sửa của một bản ghi, mới nhất trước; bản ghi ngoài phạm vi `owner` ⇒ 404.
pub async fn list_edits(conn: &mut PgConnection, owner: &OwnerIds, record_id: i32) -> R<Vec<EditOut>> {
    let user: Option<i32> = sqlx::query_scalar("SELECT user_id FROM attendance_records WHERE id = $1")
        .bind(record_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    user.filter(|u| in_owner(owner, *u)).ok_or_else(not_found)?;
    sqlx::query_as(AssertSqlSafe(format!(
        "{EDIT_SELECT} WHERE e.record_id = $1 ORDER BY e.created_at DESC, e.id DESC"
    )))
    .bind(record_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)
}

/// Id bản ghi của một nhân viên trong một ngày (cho tool MCP không biết id); không có hoặc ngoài phạm vi ⇒ 404.
pub async fn find_record_id(conn: &mut PgConnection, owner: &OwnerIds, user_id: i32, work_date: NaiveDate) -> R<i32> {
    if !in_owner(owner, user_id) {
        return Err(not_found());
    }
    let id: Option<i32> = sqlx::query_scalar("SELECT id FROM attendance_records WHERE user_id = $1 AND work_date = $2")
        .bind(user_id)
        .bind(work_date)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    id.ok_or_else(not_found)
}

/// `POST /:id/edits` của route: phạm vi `attendance.manage`.
pub async fn adjust_for(ctx: &Ctx, actor: &Actor, id: i32, input: &AdjustInput) -> R<Adjusted> {
    let owner = owner_of(ctx, actor, "attendance.manage").await?;
    let mut conn = ctx.conn(actor.company).await?;
    adjust(&mut conn, &owner, actor.user_id, id, input).await
}

/// `GET /:id/edits` của route: phạm vi `attendance.view`.
pub async fn edits_for(ctx: &Ctx, actor: &Actor, id: i32) -> R<Vec<EditOut>> {
    let owner = owner_of(ctx, actor, "attendance.view").await?;
    let mut conn = ctx.conn(actor.company).await?;
    list_edits(&mut conn, &owner, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gio_chuan_hoa() {
        assert_eq!(hm_of("8:05").as_deref(), Some("08:05"));
        assert_eq!(hm_of("17:30").as_deref(), Some("17:30"));
        for bad in ["24:00", "08:60", "8", "08:5", "0805", "ab:cd", "", "08:05:00", "-1:00"] {
            assert!(hm_of(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn body_hop_le() {
        let ok = parse_input(&json!({ "check_in": "8:05", "reason": "  đối chiếu camera  " })).unwrap();
        assert_eq!(
            ok,
            AdjustInput {
                check_in: Some("08:05".into()),
                check_out: None,
                reason: "đối chiếu camera".into()
            }
        );
        assert!(parse_input(&json!({ "check_out": "17:30", "reason": "x" })).is_ok());
    }

    #[test]
    fn body_sai() {
        let cases = [
            json!({}),
            json!({ "reason": "x" }),
            json!({ "check_in": "08:00" }),
            json!({ "check_in": "08:00", "reason": "   " }),
            json!({ "check_in": "08:00", "reason": null }),
            json!({ "check_in": "08:00", "reason": 5 }),
            json!({ "check_in": null, "reason": "x" }),
            json!({ "check_in": "25:00", "reason": "x" }),
            json!({ "check_out": 1730, "reason": "x" }),
            json!({ "check_in": "08:00", "reason": "x", "la": 1 }),
            json!({ "check_in": "08:00", "reason": "a".repeat(REASON_MAX + 1) }),
            json!([]),
        ];
        for c in cases {
            assert!(parse_input(&c).is_err(), "{c}");
        }
        assert!(parse_input(&json!({ "check_in": "08:00", "reason": "a".repeat(REASON_MAX) })).is_ok());
    }
}
