//! Dự án (M28): 5 endpoint `/api/v1/projects`. Xoá là xoá mềm (`is_active = false`). Bản TS: `projects.service.ts`.
//!
//! Quyền: GET đòi `products.view`; POST/PATCH/DELETE đòi `products.manage`. JSON trả về là struct model K10
//! ([`Project`]), đúng thứ tự khoá của `toProjectDto`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::Deserialize;
use sqlx::PgConnection;
use trinity_db::models::Project;
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};

const CODE_TAKEN: &str = "Mã dự án đã tồn tại";
const NOT_FOUND: &str = "Dự án không tồn tại";

/// Body `POST /projects` (đã qua kiểm của K15: `name` 2..255, `code` 2..100 dạng `^[a-z0-9_]+$`, `color` ≤ 50).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProject {
    pub name: String,
    pub code: String,
    #[serde(default)]
    pub color: Option<String>,
}

/// Body `PATCH /projects/:id`. `color`: không gửi = giữ nguyên, `null` = xoá màu.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateProject {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Phân biệt "không có khoá" (`None`) với `null` (`Some(None)`).
pub fn some_nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// `GET /projects?include_inactive=true`: mới nhất trước.
pub async fn find_all(conn: &mut PgConnection, include_inactive: bool) -> Result<Vec<Project>, AppError> {
    let sql = if include_inactive {
        "SELECT id, name, code, color, is_active, created_by, created_at, updated_at FROM projects \
         ORDER BY created_at DESC, id DESC"
    } else {
        "SELECT id, name, code, color, is_active, created_by, created_at, updated_at FROM projects \
         WHERE is_active ORDER BY created_at DESC, id DESC"
    };
    sqlx::query_as::<_, Project>(sql).fetch_all(conn).await.map_err(db)
}

/// `GET /projects/:id`.
pub async fn find_one(conn: &mut PgConnection, id: i32) -> Result<Project, AppError> {
    sqlx::query_as::<_, Project>(
        "SELECT id, name, code, color, is_active, created_by, created_at, updated_at FROM projects WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

/// `POST /projects`. Mã trùng ⇒ 409, cả khi hai request chạy song song (thua ở unique index).
pub async fn create(conn: &mut PgConnection, input: &CreateProject, user_id: i32) -> Result<Project, AppError> {
    let taken: Option<i32> = sqlx::query_scalar("SELECT id FROM projects WHERE code = $1")
        .bind(&input.code)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if taken.is_some() {
        return Err(HttpError::conflict(CODE_TAKEN).into());
    }
    let row = sqlx::query_as::<_, Project>(
        "INSERT INTO projects (name, code, color, created_by, updated_at) VALUES ($1, $2, $3, $4, now()) \
         RETURNING id, name, code, color, is_active, created_by, created_at, updated_at",
    )
    .bind(&input.name)
    .bind(&input.code)
    .bind(&input.color)
    .bind(user_id)
    .fetch_one(conn)
    .await;
    match row {
        Ok(p) => Ok(p),
        Err(e) => {
            let e = trinity_db::pg_error::db_error(&e);
            if e.is(DbErrorKind::UniqueViolation, None) {
                Err(HttpError::conflict(CODE_TAKEN).into())
            } else {
                Err(e.into())
            }
        }
    }
}

/// `PATCH /projects/:id`: 404 nếu không có; `code` không đổi được.
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateProject) -> Result<Project, AppError> {
    find_one(&mut *conn, id).await?;
    let (set_color, color) = match &input.color {
        Some(c) => (true, c.as_deref()),
        None => (false, None),
    };
    sqlx::query_as::<_, Project>(
        "UPDATE projects SET name = COALESCE($2, name), color = CASE WHEN $3 THEN $4 ELSE color END, \
         is_active = COALESCE($5, is_active), updated_at = now() WHERE id = $1 \
         RETURNING id, name, code, color, is_active, created_by, created_at, updated_at",
    )
    .bind(id)
    .bind(input.name.as_deref())
    .bind(set_color)
    .bind(color)
    .bind(input.is_active)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

/// `DELETE /projects/:id`: xoá mềm, trả dự án đã `is_active = false`.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<Project, AppError> {
    find_one(&mut *conn, id).await?;
    update(
        conn,
        id,
        &UpdateProject {
            is_active: Some(false),
            ..UpdateProject::default()
        },
    )
    .await
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    trinity_db::pg_error::app_error(&e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_phan_biet_vang_mat_va_null() {
        let none: UpdateProject = serde_json::from_str(r#"{"name":"a"}"#).unwrap();
        assert_eq!(none.color, None);
        let null: UpdateProject = serde_json::from_str(r#"{"color":null}"#).unwrap();
        assert_eq!(null.color, Some(None));
        let set: UpdateProject = serde_json::from_str(r#"{"color":"blue"}"#).unwrap();
        assert_eq!(set.color, Some(Some("blue".to_owned())));
    }
}
