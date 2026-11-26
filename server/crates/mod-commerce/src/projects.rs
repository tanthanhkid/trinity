//! Dự án (M28): 5 endpoint `/api/v1/projects`. Xoá là xoá mềm (`is_active = false`). Bản TS: `projects.service.ts`.
//!
//! Quyền: GET đòi `products.view`; POST/PATCH/DELETE đòi `products.manage`. JSON trả về là struct model K10
//! ([`Project`]), đúng thứ tự khoá của `toProjectDto`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::Deserialize;

use crate::nullable::some_nullable;
use sqlx::PgConnection;
use trinity_db::models::Project;
use trinity_db::pg_error::db_error;
use trinity_db::types::Timestamp;
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

/// Độ dài như `String.length` của JS (đơn vị UTF-16), cho `@MinLength`/`@MaxLength`.
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn name_errors(name: &str, out: &mut Vec<String>) {
    // class-validator báo theo thứ tự decorator từ dưới lên: MaxLength, MinLength.
    if len16(name) > 255 {
        out.push("name must be shorter than or equal to 255 characters".to_owned());
    }
    if len16(name) < 2 {
        out.push("name must be longer than or equal to 2 characters".to_owned());
    }
}

fn color_errors(color: &str, out: &mut Vec<String>) {
    if len16(color) > 50 {
        out.push("color must be shorter than or equal to 50 characters".to_owned());
    }
}

fn finish(errors: Vec<String>) -> Result<(), HttpError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(HttpError::validation(errors))
    }
}

impl CreateProject {
    /// Luật của `CreateProjectDto` (K15 áp cùng luật khi `contracts/dto/schema.json` có DTO này): `name` 2..255, `code`
    /// 2..100 dạng `^[a-z0-9_]+$`, `color` ≤ 50. Lỗi 400 cùng câu và thứ tự với class-validator.
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        name_errors(&self.name, &mut e);
        if !self
            .code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || self.code.is_empty()
        {
            e.push("Mã chỉ gồm chữ thường, số và dấu gạch dưới".to_owned());
        }
        if len16(&self.code) > 100 {
            e.push("code must be shorter than or equal to 100 characters".to_owned());
        }
        if len16(&self.code) < 2 {
            e.push("code must be longer than or equal to 2 characters".to_owned());
        }
        if let Some(c) = &self.color {
            color_errors(c, &mut e);
        }
        finish(e)
    }
}

impl UpdateProject {
    /// Luật của `UpdateProjectDto`: `name` 2..255, `color` ≤ 50 (`null` được, xoá màu).
    pub fn validate(&self) -> Result<(), HttpError> {
        let mut e = Vec::new();
        if let Some(n) = &self.name {
            name_errors(n, &mut e);
        }
        if let Some(Some(c)) = &self.color {
            color_errors(c, &mut e);
        }
        finish(e)
    }
}

/// `GET /projects?include_inactive=true`: mới nhất trước.
pub async fn find_all(conn: &mut PgConnection, include_inactive: bool) -> Result<Vec<Project>, AppError> {
    sqlx::query_as!(
        Project,
        r#"SELECT id, name, code, color, is_active, created_by,
                  created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp"
           FROM projects WHERE $1 OR is_active ORDER BY created_at DESC, id DESC"#,
        include_inactive
    )
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `GET /projects/:id`.
pub async fn find_one(conn: &mut PgConnection, id: i32) -> Result<Project, AppError> {
    sqlx::query_as!(
        Project,
        r#"SELECT id, name, code, color, is_active, created_by,
                  created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp"
           FROM projects WHERE id = $1"#,
        id
    )
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

/// `POST /projects`. Mã trùng ⇒ 409, cả khi hai request chạy song song (thua ở unique index `projects_code_key`).
/// Gọi sau [`CreateProject::validate`].
pub async fn create(conn: &mut PgConnection, input: &CreateProject, user_id: i32) -> Result<Project, AppError> {
    let taken = sqlx::query_scalar!("SELECT id FROM projects WHERE code = $1", input.code)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if taken.is_some() {
        return Err(HttpError::conflict(CODE_TAKEN).into());
    }
    let row = sqlx::query_as!(
        Project,
        r#"INSERT INTO projects (name, code, color, created_by, updated_at) VALUES ($1, $2, $3, $4, now())
           RETURNING id, name, code, color, is_active, created_by,
                     created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp""#,
        input.name,
        input.code,
        input.color,
        user_id
    )
    .fetch_one(conn)
    .await;
    row.map_err(|e| {
        let d = db_error(&e);
        if d.is(DbErrorKind::UniqueViolation, Some("projects_code_key")) {
            HttpError::conflict(CODE_TAKEN).into()
        } else {
            d.into()
        }
    })
}

/// `PATCH /projects/:id`: 404 nếu không có; `code` không đổi được. Gọi sau [`UpdateProject::validate`].
pub async fn update(conn: &mut PgConnection, id: i32, input: &UpdateProject) -> Result<Project, AppError> {
    let (set_color, color) = match &input.color {
        Some(c) => (true, c.as_deref()),
        None => (false, None),
    };
    sqlx::query_as!(
        Project,
        r#"UPDATE projects SET name = COALESCE($2, name), color = CASE WHEN $3 THEN $4 ELSE color END,
                  is_active = COALESCE($5, is_active), updated_at = now()
           WHERE id = $1
           RETURNING id, name, code, color, is_active, created_by,
                     created_at AS "created_at: Timestamp", updated_at AS "updated_at: Timestamp""#,
        id,
        input.name.as_deref(),
        set_color,
        color,
        input.is_active
    )
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(NOT_FOUND).into())
}

/// `DELETE /projects/:id`: xoá mềm, trả dự án đã `is_active = false`.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<Project, AppError> {
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
    fn validate_nhu_class_validator() {
        let mk = |n: &str, c: &str| CreateProject {
            name: n.into(),
            code: c.into(),
            color: None,
        };
        assert!(mk("Bán lẻ", "retail_1").validate().is_ok());
        let msgs = |p: CreateProject| match p.validate().unwrap_err().body().message {
            trinity_kernel::error::Message::Many(m) => m,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            msgs(mk("a", "A")),
            [
                "name must be longer than or equal to 2 characters",
                "Mã chỉ gồm chữ thường, số và dấu gạch dưới",
                "code must be longer than or equal to 2 characters",
            ]
        );
        assert_eq!(
            msgs(mk(&"x".repeat(256), &"a".repeat(101)))[..],
            [
                "name must be shorter than or equal to 255 characters",
                "code must be shorter than or equal to 100 characters",
            ]
        );
        // 2 emoji = 4 đơn vị UTF-16: đủ dài như `String.length` của JS.
        assert!(mk("😀", "ab").validate().is_ok());
        assert!(
            UpdateProject {
                color: Some(Some("c".repeat(51))),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            UpdateProject {
                color: Some(None),
                ..Default::default()
            }
            .validate()
            .is_ok()
        );
    }

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
