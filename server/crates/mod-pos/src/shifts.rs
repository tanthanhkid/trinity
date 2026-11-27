//! Ca làm việc (`/pos/shifts`). Bản TS: `pos-shifts.service.ts`. Mọi route đòi `pos.sell`; xem/đóng ca của người khác
//! theo phạm vi `pos.sell` (K13): ngoài phạm vi ⇒ 404, không 403.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::{Deserialize, Serialize};
use sqlx::{Acquire, PgConnection, Postgres, QueryBuilder};
use trinity_db::models::PosShift;
use trinity_db::pg_error::{app_error, db_error};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_rbac::{OwnerIds, assert_in_scope, push_scope};

use crate::{MAX_MONEY, finish, range, trim_opt};

const INT4_MAX: i64 = 2_147_483_647;
const SHIFT_COLS: &str = "id, opened_by, opened_at, opening_cash, status, closed_by, closed_at, \
                          closing_cash_counted, expected_cash, cash_diff, note";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

/// Body `POST /pos/shifts/open` (`OpenShiftDto`): `opening_cash` 0..[`MAX_MONEY`].
#[derive(Debug, Clone, Deserialize)]
pub struct OpenShift {
    pub opening_cash: i64,
}

impl OpenShift {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        range("opening_cash", self.opening_cash, 0, MAX_MONEY, &mut e);
        finish(e)
    }
}

/// Body `POST /pos/shifts/:id/close` (`CloseShiftDto`): `closing_cash_counted` 0..[`MAX_MONEY`], `note` ≤ 500 (đã trim).
#[derive(Debug, Clone, Deserialize)]
pub struct CloseShift {
    pub closing_cash_counted: i64,
    #[serde(default)]
    pub note: Option<String>,
}

impl CloseShift {
    pub fn normalize(&mut self) {
        trim_opt(&mut self.note);
    }
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        range("closing_cash_counted", self.closing_cash_counted, 0, MAX_MONEY, &mut e);
        if self.note.as_deref().is_some_and(|n| crate::len16(n) > 500) {
            e.push("note must be shorter than or equal to 500 characters".to_owned());
        }
        finish(e)
    }
}

/// Query `GET /pos/shifts` (`ListShiftsQueryDto`): `cursor` 1..INT4_MAX, `limit` 1..100 (mặc định 30).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ListShifts {
    #[serde(default)]
    pub cursor: Option<i32>,
    #[serde(default)]
    pub limit: Option<i64>,
}

impl ListShifts {
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(c) = self.cursor {
            range("cursor", c.into(), 1, INT4_MAX, &mut e);
        }
        if let Some(l) = self.limit {
            range("limit", l, 1, 100, &mut e);
        }
        finish(e)
    }
}

/// Tổng kết tiền của ca: chỉ đơn ĐÃ THU (loại đơn huỷ).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShiftSummary {
    pub paid_orders: i64,
    pub void_orders: i64,
    pub cash_sales: i64,
    pub transfer_sales: i64,
    pub expected_cash: i64,
}

/// `GET /pos/shifts/current`, `GET /pos/shifts/:id/summary`: ca + tổng kết (`shift`/`summary` là `null` khi không có ca).
#[derive(Debug, Clone, Serialize)]
pub struct ShiftWithSummary {
    pub shift: Option<PosShift>,
    pub summary: Option<ShiftSummary>,
}

/// `GET /pos/shifts`: trang mới nhất trước; `next_cursor` = id ca cuối trang nếu còn.
#[derive(Debug, Clone, Serialize)]
pub struct ShiftPage {
    pub data: Vec<PosShift>,
    pub next_cursor: Option<i32>,
}

/// Ca đang mở của người dùng, hoặc `None`. Dùng chung cho tạo/thu đơn (M27).
pub async fn find_open_shift(conn: &mut PgConnection, user_id: i32) -> Result<Option<PosShift>, AppError> {
    sqlx::query_as::<_, PosShift>(sqlx::AssertSqlSafe(format!(
        "SELECT {SHIFT_COLS} FROM pos_shifts WHERE opened_by = $1 AND status = 'open' ORDER BY id LIMIT 1"
    )))
    .bind(user_id)
    .fetch_optional(conn)
    .await
    .map_err(db)
}

/// Như [`find_open_shift`] nhưng chưa mở ca ⇒ 400.
pub async fn require_open_shift(conn: &mut PgConnection, user_id: i32) -> Result<PosShift, AppError> {
    find_open_shift(conn, user_id)
        .await?
        .ok_or_else(|| HttpError::bad_request("Chưa mở ca. Hãy mở ca (nhập tiền đầu ca) trước khi bán hàng.").into())
}

/// Kiểu khoá dòng ca.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockMode {
    /// `FOR SHARE`: nhiều đơn được tạo song song, nhưng đóng ca phải chờ.
    Share,
    /// `FOR UPDATE`: thu tiền và đóng ca nối tiếp nhau.
    Update,
}

/// Khoá dòng ca đang mở của người dùng trong giao dịch hiện tại và trả id ca; không có ca mở (kể cả ca vừa bị đóng ở
/// giao dịch khác trong lúc chờ khoá) ⇒ 400. PHẢI gọi trong giao dịch (khoá nhả khi commit/rollback).
pub async fn lock_open_shift(conn: &mut PgConnection, user_id: i32, mode: LockMode) -> Result<i32, AppError> {
    let clause = if mode == LockMode::Update {
        "FOR UPDATE"
    } else {
        "FOR SHARE"
    };
    let id: Option<i32> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT id FROM pos_shifts WHERE opened_by = $1 AND status = 'open' ORDER BY id LIMIT 1 {clause}"
    )))
    .bind(user_id)
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    id.ok_or_else(|| HttpError::bad_request("Chưa mở ca. Hãy mở ca (nhập tiền đầu ca) trước khi bán hàng.").into())
}

/// `POST /pos/shifts/open`: đã có ca mở ⇒ 409 (kể cả hai request đồng thời nhờ unique từng phần `pos_shifts_one_open_per_user`).
pub async fn open(conn: &mut PgConnection, user_id: i32, input: &OpenShift) -> Result<PosShift, AppError> {
    sqlx::query_as::<_, PosShift>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO pos_shifts (opened_by, opening_cash) VALUES ($1, $2) RETURNING {SHIFT_COLS}"
    )))
    .bind(user_id)
    .bind(input.opening_cash)
    .fetch_one(conn)
    .await
    .map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, None) {
            HttpError::conflict("Bạn đang có một ca mở").into()
        } else {
            d.into()
        }
    })
}

/// `GET /pos/shifts/current`.
pub async fn current(conn: &mut PgConnection, user_id: i32) -> Result<ShiftWithSummary, AppError> {
    match find_open_shift(&mut *conn, user_id).await? {
        None => Ok(ShiftWithSummary {
            shift: None,
            summary: None,
        }),
        Some(shift) => {
            let summary = summarize(conn, &shift).await?;
            Ok(ShiftWithSummary {
                shift: Some(shift),
                summary: Some(summary),
            })
        }
    }
}

/// `GET /pos/shifts`: ca trong phạm vi `pos.sell` (own = của mình; rộng hơn = thêm người trong phạm vi).
pub async fn list(conn: &mut PgConnection, q: &ListShifts, owner: &OwnerIds) -> Result<ShiftPage, AppError> {
    let take = q.limit.unwrap_or(30);
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new(format!("SELECT {SHIFT_COLS} FROM pos_shifts WHERE "));
    push_scope(&mut qb, owner, &["opened_by"]);
    if let Some(c) = q.cursor {
        qb.push(" AND id < ").push_bind(c);
    }
    qb.push(" ORDER BY id DESC LIMIT ").push_bind(take + 1);
    let mut rows = qb.build_query_as::<PosShift>().fetch_all(conn).await.map_err(db)?;
    let more = i64::try_from(rows.len()).is_ok_and(|n| n > take);
    rows.truncate(usize::try_from(take).unwrap_or(0));
    let next_cursor = if more { rows.last().map(|s| s.id) } else { None };
    Ok(ShiftPage {
        data: rows,
        next_cursor,
    })
}

/// Ca theo id trong phạm vi: không có hoặc ngoài phạm vi ⇒ 404.
async fn get_owned(conn: &mut PgConnection, id: i32, owner: &OwnerIds) -> Result<PosShift, AppError> {
    let shift = sqlx::query_as::<_, PosShift>(sqlx::AssertSqlSafe(format!(
        "SELECT {SHIFT_COLS} FROM pos_shifts WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy ca"))?;
    assert_in_scope(Some(owner), &[Some(shift.opened_by)]).map_err(|e| *e)?;
    Ok(shift)
}

/// `GET /pos/shifts/:id/summary`.
pub async fn summary(conn: &mut PgConnection, id: i32, owner: &OwnerIds) -> Result<ShiftWithSummary, AppError> {
    let shift = get_owned(&mut *conn, id, owner).await?;
    let s = summarize(conn, &shift).await?;
    Ok(ShiftWithSummary {
        shift: Some(shift),
        summary: Some(s),
    })
}

/// Tiền theo phương thức của các đơn ĐÃ THU (loại đơn huỷ) + số đơn; tiền mặt dự kiến = đầu ca + tiền mặt đã thu.
pub async fn summarize(conn: &mut PgConnection, shift: &PosShift) -> Result<ShiftSummary, AppError> {
    let (cash, transfer): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'cash'), 0)::int8, \
                COALESCE(SUM(p.amount) FILTER (WHERE p.method = 'bank_transfer'), 0)::int8 \
         FROM pos_payments p JOIN pos_orders o ON o.id = p.order_id WHERE p.shift_id = $1 AND o.status = 'paid'",
    )
    .bind(shift.id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let paid_orders: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pos_orders o WHERE o.status = 'paid' \
         AND EXISTS (SELECT 1 FROM pos_payments p WHERE p.order_id = o.id AND p.shift_id = $1)",
    )
    .bind(shift.id)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let void_orders: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pos_orders WHERE status = 'void' AND shift_id = $1")
            .bind(shift.id)
            .fetch_one(conn)
            .await
            .map_err(db)?;
    Ok(ShiftSummary {
        paid_orders,
        void_orders,
        cash_sales: cash,
        transfer_sales: transfer,
        expected_cash: shift.opening_cash.0 + cash,
    })
}

/// `POST /pos/shifts/:id/close`: ca đã đóng ⇒ 409; còn đơn chưa thu ⇒ 400; chênh lệch = tiền đếm − dự kiến.
/// Chạy trong giao dịch của người gọi; `WHERE status = 'open'` chặn đóng đôi.
pub async fn close(
    conn: &mut PgConnection,
    id: i32,
    input: &CloseShift,
    user_id: i32,
    owner: &OwnerIds,
) -> Result<ShiftWithSummary, AppError> {
    // Kiểm phạm vi trước khi khoá: người ngoài phạm vi nhận 404 mà không chiếm khoá dòng ca của người khác.
    get_owned(&mut *conn, id, owner).await?;
    // Khoá dòng ca trước khi đọc tổng kết: thu tiền và tạo đơn (M27) khoá cùng dòng này, nên tổng kết và các đơn `open`
    // đọc ở đây không đổi cho tới khi đóng xong.
    let mut tx = conn.begin().await.map_err(db)?;
    let conn = &mut *tx;
    sqlx::query("SELECT id FROM pos_shifts WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let shift = get_owned(&mut *conn, id, owner).await?;
    if shift.status != "open" {
        return Err(HttpError::conflict("Ca đã đóng").into());
    }
    let open_orders: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pos_orders WHERE shift_id = $1 AND status = 'open'")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
    if open_orders > 0 {
        return Err(HttpError::bad_request(format!(
            "Còn {open_orders} đơn chưa thanh toán trong ca. Thu tiền hoặc huỷ trước khi đóng ca."
        ))
        .into());
    }
    let expected = summarize(&mut *conn, &shift).await?.expected_cash;
    let res = sqlx::query(
        "UPDATE pos_shifts SET status = 'closed', closed_by = $2, closed_at = now(), closing_cash_counted = $3, \
         expected_cash = $4, cash_diff = $5, note = $6 WHERE id = $1 AND status = 'open'",
    )
    .bind(id)
    .bind(user_id)
    .bind(input.closing_cash_counted)
    .bind(expected)
    .bind(input.closing_cash_counted - expected)
    .bind(input.note.as_deref())
    .execute(&mut *conn)
    .await
    .map_err(db)?;
    if res.rows_affected() != 1 {
        return Err(HttpError::conflict("Ca đã đóng").into());
    }
    let out = summary(&mut *conn, id, owner).await?;
    tx.commit().await.map_err(db)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiem_luat_dto_ca() {
        assert!(OpenShift { opening_cash: 0 }.validate().is_ok());
        assert!(OpenShift { opening_cash: -1 }.validate().is_err());
        assert!(
            OpenShift {
                opening_cash: MAX_MONEY + 1
            }
            .validate()
            .is_err()
        );
        assert!(
            ListShifts {
                cursor: Some(0),
                limit: None
            }
            .validate()
            .is_err()
        );
        assert!(
            ListShifts {
                cursor: None,
                limit: Some(101)
            }
            .validate()
            .is_err()
        );
        assert!(
            ListShifts {
                cursor: Some(5),
                limit: Some(100)
            }
            .validate()
            .is_ok()
        );
        let mut c = CloseShift {
            closing_cash_counted: 10,
            note: Some("  ok ".into()),
        };
        c.normalize();
        assert_eq!(c.note.as_deref(), Some("ok"));
    }
}
