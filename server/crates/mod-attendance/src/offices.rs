//! Văn phòng chấm công (danh sách IP hợp lệ) và đặt lại thiết bị đã đăng ký của nhân viên.

use serde::Serialize;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError};

use crate::dto::{CreateOfficeDto, UpdateOfficeDto};
use crate::{R, db};

fn http(e: HttpError) -> AppError {
    AppError::Http(e)
}

fn nf_office() -> AppError {
    http(HttpError::not_found("Không tìm thấy văn phòng."))
}

const COLS: &str = "id, name, description, ips, is_active, is_demo, created_at, updated_at";

/// Văn phòng như `AttendanceOffice` của Prisma (khoá theo thứ tự cột).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Office {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub ips: Option<Vec<String>>,
    pub is_active: bool,
    pub is_demo: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// `GET /offices`: theo tên.
pub async fn list(conn: &mut PgConnection) -> R<Vec<Office>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM attendance_offices ORDER BY name ASC, id ASC"
    )))
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `POST /offices`.
pub async fn create(conn: &mut PgConnection, dto: &CreateOfficeDto) -> R<Office> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO attendance_offices (name, description, ips, is_active, is_demo, updated_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING {COLS}"
    )))
    .bind(&dto.name)
    .bind(&dto.description)
    .bind(&dto.ips)
    .bind(dto.is_active.unwrap_or(true))
    .bind(dto.is_demo.unwrap_or(false))
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /offices/:id`: chỉ đổi trường được gửi; `description: null` xoá mô tả. Không có văn phòng ⇒ 404.
pub async fn update(conn: &mut PgConnection, id: i32, dto: &UpdateOfficeDto) -> R<Office> {
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE attendance_offices SET updated_at = now()");
    if let Some(n) = &dto.name {
        qb.push(", name = ").push_bind(n.clone());
    }
    if let Some(d) = &dto.description {
        qb.push(", description = ").push_bind(d.clone());
    }
    if let Some(i) = &dto.ips {
        qb.push(", ips = ").push_bind(i.clone());
    }
    if let Some(a) = dto.is_active {
        qb.push(", is_active = ").push_bind(a);
    }
    if let Some(d) = dto.is_demo {
        qb.push(", is_demo = ").push_bind(d);
    }
    qb.push(" WHERE id = ").push_bind(id).push(" RETURNING ").push(COLS);
    qb.build_query_as()
        .fetch_optional(conn)
        .await
        .map_err(db)?
        .ok_or_else(nf_office)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Ok1 {
    pub ok: bool,
}

/// `DELETE /offices/:id`.
pub async fn remove(conn: &mut PgConnection, id: i32) -> R<Ok1> {
    let gone: Option<i32> = sqlx::query_scalar("DELETE FROM attendance_offices WHERE id = $1 RETURNING id")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    gone.map(|_| Ok1 { ok: true }).ok_or_else(nf_office)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ResetDone {
    pub ok: bool,
    pub user_id: i32,
}

/// `POST /reset-device/:userId`: xoá thiết bị đã đăng ký để nhân viên đăng ký thiết bị mới ở lần chấm công kế tiếp.
pub async fn reset_device(conn: &mut PgConnection, user_id: i32) -> R<ResetDone> {
    let old: Option<Option<String>> = sqlx::query_scalar(
        "WITH old AS (SELECT user_id, registered_device_id FROM employees WHERE user_id = $1 FOR UPDATE)
         UPDATE employees e SET registered_device_id = NULL, device_registered_at = NULL FROM old
         WHERE e.user_id = old.user_id RETURNING old.registered_device_id",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await
    .map_err(db)?;
    let Some(old) = old else {
        return Err(http(HttpError::not_found("Không tìm thấy hồ sơ nhân viên.")));
    };
    tracing::info!(
        "Device reset for user {user_id} (was: {})",
        old.as_deref().unwrap_or("null")
    );
    Ok(ResetDone { ok: true, user_id })
}
