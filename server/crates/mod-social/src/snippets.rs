//! Bộ hashtag và chữ ký dùng lại khi soạn bài (`social-snippets.service.ts`, M55a). Tối đa 100 mẫu; chữ ký mặc định chỉ một.
//! Đếm giới hạn và "một chữ ký mặc định" đúng cả khi lưu đồng thời nhờ khoá advisory trong giao dịch.
//!
//! Đầu vào giữ phân biệt "vắng" (`None`) với `null` (`Some(Value::Null)`): `@IsOptional()` bỏ qua cả hai ở tầng DTO, nhưng
//! service TS coi `null` là có gửi (`!== undefined`) và trả câu lỗi riêng; bản này giữ đúng như vậy.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashSet;

use mod_facebook::graph::utf16_prefix;
use serde_json::Value;
use sqlx::{Connection, PgConnection};
use trinity_db::models::SocialSnippet;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::{is_js_whitespace, nfc, trim_js};

pub const SNIPPET_KINDS: [&str; 2] = ["hashtags", "signature"];
pub const MAX_SNIPPETS: i64 = 100;
const MAX_NAME: usize = 80;
const MAX_CONTENT: usize = 2000;
const MAX_TAG: usize = 100;
/// Khoá advisory: đếm giới hạn + "một chữ ký mặc định" (giá trị như bản Node).
const SNIPPETS_LOCK: i64 = 7_524_001;

const COLS: &str = "id, kind, name, content, is_default, position, created_by, created_at, updated_at";

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn bad(m: &str) -> AppError {
    HttpError::bad_request(m).into()
}

fn ulen(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Bộ hashtag: tách theo khoảng trắng/dấu phẩy, thêm `#` còn thiếu, bỏ trùng không phân biệt hoa thường, nối bằng một dấu cách.
pub fn normalize_hashtags(raw: &str) -> Result<String, AppError> {
    let text = nfc(raw);
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for part in text
        .split(|c: char| c == ',' || is_js_whitespace(c))
        .filter(|p| !p.is_empty())
    {
        let tag = if part.starts_with('#') {
            part.to_owned()
        } else {
            format!("#{part}")
        };
        if tag == "#" {
            continue;
        }
        if ulen(&tag) > MAX_TAG {
            return Err(bad(&format!("Hashtag quá dài (tối đa {MAX_TAG} ký tự).")));
        }
        if tag[1..].contains('#') {
            return Err(bad(&format!(
                "Hashtag \"{}\" chứa nhiều dấu #; tách bằng dấu cách.",
                utf16_prefix(&tag, 30)
            )));
        }
        if seen.insert(tag.to_lowercase()) {
            out.push(tag);
        }
    }
    Ok(out.join(" "))
}

fn check_name(v: Option<&Value>) -> Result<String, AppError> {
    let Some(s) = v.and_then(Value::as_str) else {
        return Err(bad("Cần tên mẫu."));
    };
    let n = trim_js(s);
    let len = ulen(n);
    if !(1..=MAX_NAME).contains(&len) {
        return Err(bad(&format!("Tên mẫu từ 1 đến {MAX_NAME} ký tự.")));
    }
    Ok(n.to_owned())
}

fn check_content(kind: &str, v: Option<&Value>) -> Result<String, AppError> {
    let Some(s) = v.and_then(Value::as_str) else {
        return Err(bad("Cần nội dung mẫu."));
    };
    let c = if kind == "hashtags" {
        normalize_hashtags(s)?
    } else {
        trim_js(s).to_owned()
    };
    let len = ulen(&c);
    if !(1..=MAX_CONTENT).contains(&len) {
        return Err(bad(&format!("Nội dung mẫu từ 1 đến {MAX_CONTENT} ký tự.")));
    }
    Ok(c)
}

fn check_kind(v: Option<&Value>) -> Result<&'static str, AppError> {
    v.and_then(Value::as_str)
        .and_then(|s| SNIPPET_KINDS.iter().find(|k| **k == s).copied())
        .ok_or_else(|| bad("Loại mẫu phải là hashtags hoặc signature."))
}

/// `is_default`: có gửi thì phải là boolean (kể cả `null` ⇒ lỗi).
fn check_default(v: Option<&Value>) -> Result<Option<bool>, AppError> {
    match v {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(bad("is_default phải là true/false.")),
    }
}

/// Thân `POST/PATCH /social/snippets` sau tầng DTO (`SocialSnippetDto`). `None` = vắng, `Some(Null)` = `null`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnippetInput {
    pub kind: Option<Value>,
    pub name: Option<Value>,
    pub content: Option<Value>,
    pub is_default: Option<Value>,
}

/// `@IsString() @MaxLength(max)` của một trường tuỳ chọn; thứ tự thông điệp: MaxLength rồi IsString.
fn string_errors(v: Option<&Value>, field: &str, max: usize, errs: &mut Vec<String>) {
    match v {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) => {
            if ulen(s) > max {
                errs.push(format!("{field} must be shorter than or equal to {max} characters"));
            }
        }
        Some(_) => {
            errs.push(format!("{field} must be shorter than or equal to {max} characters"));
            errs.push(format!("{field} must be a string"));
        }
    }
}

impl SnippetInput {
    /// Kiểm như class-validator (`forbidNonWhitelisted`): thuộc tính lạ trước, rồi từng trường theo khai báo.
    /// Body không phải object ⇒ coi như object rỗng (Nest chuyển body thành lớp rỗng).
    pub fn from_json(body: &Value) -> Result<Self, HttpError> {
        let mut errs: Vec<String> = Vec::new();
        if let Some(o) = body.as_object() {
            for k in o
                .keys()
                .filter(|k| !matches!(k.as_str(), "kind" | "name" | "content" | "is_default"))
            {
                errs.push(format!("property {k} should not exist"));
            }
        }
        let get = |k: &str| body.get(k).cloned();
        let kind = get("kind");
        if let Some(k) = &kind
            && !k.is_null()
            && !k.as_str().is_some_and(|s| SNIPPET_KINDS.contains(&s))
        {
            errs.push("Loại mẫu phải là hashtags hoặc signature".to_owned());
        }
        string_errors(body.get("name"), "name", 200, &mut errs);
        string_errors(body.get("content"), "content", 10_000, &mut errs);
        if body.get("is_default").is_some_and(|v| !v.is_null() && !v.is_boolean()) {
            errs.push("is_default must be a boolean value".to_owned());
        }
        if !errs.is_empty() {
            return Err(HttpError::validation(errs));
        }
        Ok(Self {
            kind,
            name: get("name"),
            content: get("content"),
            is_default: get("is_default"),
        })
    }
}

/// `GET /social/snippets?kind=`: bộ hashtag và chữ ký, theo loại, vị trí rồi id. `kind` rỗng = không lọc.
pub async fn list(conn: &mut PgConnection, kind: Option<&str>) -> Result<Vec<SocialSnippet>, AppError> {
    let kind = kind.filter(|k| !k.is_empty());
    if let Some(k) = kind {
        check_kind(Some(&Value::String(k.to_owned())))?;
    }
    sqlx::query_as::<_, SocialSnippet>(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM social_snippets WHERE ($1::text IS NULL OR kind = $1) ORDER BY kind ASC, position ASC, id ASC"
    )))
    .bind(kind)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)
}

/// `POST /social/snippets` (201).
pub async fn create(conn: &mut PgConnection, user_id: i32, input: &SnippetInput) -> Result<SocialSnippet, AppError> {
    let kind = check_kind(input.kind.as_ref())?;
    let name = check_name(input.name.as_ref())?;
    let content = check_content(kind, input.content.as_ref())?;
    let is_default = check_default(input.is_default.as_ref())?;
    if is_default == Some(true) && kind != "signature" {
        return Err(bad("Chỉ chữ ký mới đặt được mặc định."));
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SNIPPETS_LOCK)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM social_snippets")
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
    if count >= MAX_SNIPPETS {
        return Err(bad(&format!("Tối đa {MAX_SNIPPETS} mẫu.")));
    }
    if is_default == Some(true) {
        sqlx::query("UPDATE social_snippets SET is_default = false WHERE kind = $1 AND is_default = true")
            .bind(kind)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let row = sqlx::query_as::<_, SocialSnippet>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO social_snippets (kind, name, content, is_default, position, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), -1) + 1 FROM social_snippets WHERE kind = $1), $5, now()) \
         RETURNING {COLS}"
    )))
    .bind(kind)
    .bind(name)
    .bind(content)
    .bind(is_default == Some(true))
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(row)
}

/// `PATCH /social/snippets/:id`: chỉ trường có gửi; không đổi `kind` sau khi tạo.
pub async fn update(conn: &mut PgConnection, id: i32, input: &SnippetInput) -> Result<SocialSnippet, AppError> {
    let cur: Option<SocialSnippet> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM social_snippets WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let Some(cur) = cur else {
        return Err(HttpError::not_found("Không tìm thấy mẫu").into());
    };
    if let Some(k) = &input.kind
        && k.as_str() != Some(cur.kind.as_str())
    {
        return Err(bad("Không đổi loại của mẫu đã tạo."));
    }
    let name = input.name.as_ref().map(|v| check_name(Some(v))).transpose()?;
    let content = input
        .content
        .as_ref()
        .map(|v| check_content(&cur.kind, Some(v)))
        .transpose()?;
    let is_default = check_default(input.is_default.as_ref())?;
    if is_default == Some(true) && cur.kind != "signature" {
        return Err(bad("Chỉ chữ ký mới đặt được mặc định."));
    }
    let mut tx = conn.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SNIPPETS_LOCK)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if is_default == Some(true) {
        sqlx::query("UPDATE social_snippets SET is_default = false WHERE kind = $1 AND is_default = true AND id <> $2")
            .bind(&cur.kind)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    // Mẫu có thể bị xoá giữa lúc đọc và lúc ghi ⇒ 0 dòng ⇒ 404 (Prisma `update` ném P2025).
    let row = sqlx::query_as::<_, SocialSnippet>(sqlx::AssertSqlSafe(format!(
        "UPDATE social_snippets SET name = COALESCE($2, name), content = COALESCE($3, content), \
         is_default = COALESCE($4, is_default), updated_at = now() WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(name)
    .bind(content)
    .bind(is_default)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?;
    let Some(row) = row else {
        return Err(HttpError::not_found("Không tìm thấy mẫu").into());
    };
    tx.commit().await.map_err(db)?;
    Ok(row)
}

/// `DELETE /social/snippets/:id` (204).
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    let r = sqlx::query("DELETE FROM social_snippets WHERE id = $1")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    if r.rows_affected() == 0 {
        return Err(HttpError::not_found("Không tìm thấy mẫu").into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(e: AppError) -> (u16, Value) {
        let (s, b) = e.response(true);
        (s, serde_json::to_value(&b.message).unwrap())
    }

    #[test]
    fn hashtag_chuan_hoa() {
        assert_eq!(normalize_hashtags("a, #B  c\n#A").unwrap(), "#a #B #c");
        assert_eq!(normalize_hashtags("  ,, # ").unwrap(), "");
        assert_eq!(normalize_hashtags("#Đà #đà").unwrap(), "#Đà");
        let (s, m) = msg(normalize_hashtags("a#b").unwrap_err());
        assert_eq!(
            (s, m),
            (400, json!("Hashtag \"#a#b\" chứa nhiều dấu #; tách bằng dấu cách."))
        );
        let long = "x".repeat(100);
        let (s, m) = msg(normalize_hashtags(&long).unwrap_err());
        assert_eq!((s, m), (400, json!("Hashtag quá dài (tối đa 100 ký tự).")));
        assert!(normalize_hashtags(&"x".repeat(99)).is_ok());
    }

    #[test]
    fn kiem_tung_truong() {
        assert_eq!(check_name(Some(&json!("  Tên  "))).unwrap(), "Tên");
        for bad_name in [
            None,
            Some(json!(null)),
            Some(json!(3)),
            Some(json!("   ")),
            Some(json!("a".repeat(81))),
        ] {
            assert_eq!(msg(check_name(bad_name.as_ref()).unwrap_err()).0, 400);
        }
        assert!(check_name(Some(&json!("a".repeat(80)))).is_ok());
        assert_eq!(
            msg(check_content("signature", None).unwrap_err()).1,
            json!("Cần nội dung mẫu.")
        );
        assert_eq!(
            msg(check_content("signature", Some(&json!(" "))).unwrap_err()).1,
            json!("Nội dung mẫu từ 1 đến 2000 ký tự.")
        );
        assert_eq!(check_content("hashtags", Some(&json!("a b"))).unwrap(), "#a #b");
        assert_eq!(
            check_content("signature", Some(&json!("  Cảm ơn!  "))).unwrap(),
            "Cảm ơn!"
        );
        assert_eq!(check_kind(Some(&json!("hashtags"))).unwrap(), "hashtags");
        assert_eq!(
            msg(check_kind(Some(&json!(null))).unwrap_err()).1,
            json!("Loại mẫu phải là hashtags hoặc signature.")
        );
        assert_eq!(check_default(Some(&json!(true))).unwrap(), Some(true));
        assert_eq!(check_default(None).unwrap(), None);
        assert_eq!(
            msg(check_default(Some(&json!(null))).unwrap_err()).1,
            json!("is_default phải là true/false.")
        );
    }

    #[test]
    fn dto_nhu_class_validator() {
        let ok =
            SnippetInput::from_json(&json!({"kind":"hashtags","name":"A","content":"x","is_default":null})).unwrap();
        assert_eq!(ok.is_default, Some(Value::Null));
        assert!(SnippetInput::from_json(&json!({})).unwrap().kind.is_none());
        let m = |v: Value| msg(AppError::from(SnippetInput::from_json(&v).unwrap_err()));
        assert_eq!(
            m(json!({"kind":"x","zz":1,"name":3,"is_default":"no"})).1,
            json!([
                "property zz should not exist",
                "Loại mẫu phải là hashtags hoặc signature",
                "name must be shorter than or equal to 200 characters",
                "name must be a string",
                "is_default must be a boolean value"
            ])
        );
        assert_eq!(
            m(json!({"content":"a".repeat(10_001)})).1,
            json!(["content must be shorter than or equal to 10000 characters"])
        );
        // Chuỗi dài 201 chữ cái có dấu: đếm theo UTF-16, không theo byte.
        assert!(SnippetInput::from_json(&json!({"name":"é".repeat(200)})).is_ok());
    }
}
