//! Khoá API cấp cho bên thứ ba (`api-keys.service.ts`). Khoá nguyên bản chỉ hiện MỘT lần lúc tạo hoặc xoay; DB chỉ lưu
//! SHA-256. Khoá mang tiền tố công ty (`c<id>.`, không có = công ty 1) để biết phải tra ở schema nào.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};
use trinity_db::pg_error::app_error;
use trinity_db::platform::Platform;
use trinity_db::types::Timestamp;
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{PermissionService, can};

use crate::company_token::{company_id_of_token, company_token_prefix, with_company_prefix};

/// Tiền tố khoá. `extract_prefix` cắt theo ĐỘ DÀI nên không được đổi: khoá đã phát hành sẽ bị cắt sai.
const KEY_PREFIX: &str = "trinity_live_";
/// 24 byte ngẫu nhiên ⇒ 32 ký tự base64url (~192 bit).
const RANDOM_BYTES: usize = 24;

pub const API_KEY_SCOPES: [&str; 4] = ["auth:login", "contacts:create", "deals:create", "tasks:create"];

/// Quyền nghiệp vụ owner phải có cho từng phạm vi.
fn owner_permission(scope: &str) -> Option<&'static str> {
    match scope {
        "auth:login" | "contacts:create" => Some("contacts.create"),
        "deals:create" => Some("deals.manage"),
        "tasks:create" => Some("kanban.manage"),
        _ => None,
    }
}

fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn bad_request(msg: impl Into<String>) -> AppError {
    HttpError::bad_request(msg.into()).into()
}

fn unauthorized(msg: &str) -> AppError {
    HttpError::unauthorized(msg).into()
}

fn not_found() -> AppError {
    HttpError::not_found("Không tìm thấy khoá API").into()
}

/// Thân `POST /api-keys` đã kiểm.
#[derive(Debug, Clone)]
pub struct CreateApiKey {
    pub name: String,
    pub scopes: Vec<String>,
    pub owner_user_id: i32,
    pub expires_at: Option<DateTime<Utc>>,
}

/// ISO 8601 như `@IsDateString`: RFC 3339, ngày `YYYY-MM-DD`, hoặc ngày giờ không múi giờ (coi là UTC).
fn parse_iso(s: &str) -> Option<DateTime<Utc>> {
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|n| n.and_utc());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, f) {
            return Some(n.and_utc());
        }
    }
    None
}

/// Kiểm thân request đúng câu của class-validator. Thông báo xếp theo thứ tự đăng ký ngược của decorator.
pub fn validate_create(body: &Value) -> Result<CreateApiKey, HttpError> {
    let mut errors = Vec::new();
    let name = body.get("name").and_then(Value::as_str);
    match name {
        Some(n) => {
            let len: usize = n.chars().map(char::len_utf16).sum();
            if !(1..=120).contains(&len) {
                errors.push("Tên khoá 1-120 ký tự".to_owned());
            }
        }
        None => {
            errors.push("Tên khoá 1-120 ký tự".to_owned());
            errors.push("name must be a string".to_owned());
        }
    }
    let scopes: Option<Vec<String>> = body.get("scopes").and_then(Value::as_array).and_then(|a| {
        a.iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
    });
    match body.get("scopes") {
        Some(Value::Array(a)) => {
            if scopes
                .as_ref()
                .is_none_or(|s| s.iter().any(|x| !API_KEY_SCOPES.contains(&x.as_str())))
            {
                errors.push("Phạm vi không hợp lệ".to_owned());
            }
            if a.is_empty() {
                errors.push("Phải chọn ít nhất 1 phạm vi".to_owned());
            }
        }
        _ => {
            errors.push("Phạm vi không hợp lệ".to_owned());
            errors.push("Phải chọn ít nhất 1 phạm vi".to_owned());
            errors.push("scopes must be an array".to_owned());
        }
    }
    // `@Type(() => Number)`: chuỗi số cũng nhận.
    let owner = body.get("owner_user_id").and_then(|v| match v {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && f.fract() == 0.0)
            .map(|f| f as i64),
        _ => None,
    });
    let owner = owner.and_then(|n| i32::try_from(n).ok());
    if owner.is_none() {
        errors.push("owner_user_id phải là số nguyên".to_owned());
    }
    let expires_at = match body.get("expires_at") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => match parse_iso(s) {
            Some(d) => Some(d),
            None => {
                errors.push("expires_at không hợp lệ".to_owned());
                None
            }
        },
        Some(_) => {
            errors.push("expires_at không hợp lệ".to_owned());
            None
        }
    };
    if !errors.is_empty() {
        return Err(HttpError::validation(errors));
    }
    Ok(CreateApiKey {
        name: name.unwrap_or_default().to_owned(),
        scopes: scopes.unwrap_or_default(),
        owner_user_id: owner.unwrap_or_default(),
        expires_at,
    })
}

/// Một khoá, không lộ khoá gốc hay hash.
#[derive(Debug, Serialize)]
pub struct ApiKeyView {
    pub id: i32,
    pub name: String,
    pub prefix: String,
    pub scopes: Vec<String>,
    pub owner_user_id: i32,
    pub created_by: i32,
    pub last_used_at: Option<Timestamp>,
    pub last_used_ip: Option<String>,
    pub expires_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Serialize)]
pub struct Created {
    #[serde(flatten)]
    pub key: ApiKeyView,
    /// CHỈ hiện một lần.
    pub plain_key: String,
    pub message: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Rotated {
    #[serde(flatten)]
    pub key: ApiKeyView,
    pub plain_key: String,
}

#[derive(Debug, Serialize)]
pub struct Message {
    pub message: &'static str,
}

/// Kết quả xác thực `X-API-Key`.
#[derive(Debug, Clone)]
pub struct ValidatedApiKey {
    pub id: i32,
    pub name: String,
    pub scopes: Vec<String>,
    pub owner_user_id: i32,
    /// Công ty giữ khoá (theo tiền tố), để bước sau chạy đúng schema.
    pub company: CompanyRef,
}

macro_rules! key_cols {
    () => {
        "id, name, prefix, scopes, owner_user_id, created_by, last_used_at, last_used_ip, expires_at, revoked_at, created_at, updated_at"
    };
}

fn view(r: &sqlx::postgres::PgRow) -> ApiKeyView {
    ApiKeyView {
        id: r.get("id"),
        name: r.get("name"),
        prefix: r.get("prefix"),
        scopes: r.get::<Option<Vec<String>>, _>("scopes").unwrap_or_default(),
        owner_user_id: r.get("owner_user_id"),
        created_by: r.get("created_by"),
        last_used_at: r.get("last_used_at"),
        last_used_ip: r.get("last_used_ip"),
        expires_at: r.get("expires_at"),
        revoked_at: r.get("revoked_at"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

/// SHA-256 dạng hex thường (như `createHash('sha256').digest('hex')`).
pub fn hash_key(plain: &str) -> String {
    Sha256::digest(plain.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn generate_plain_key(company_id: i32) -> String {
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let mut bytes = [0u8; RANDOM_BYTES];
    bytes[..16].copy_from_slice(a.as_bytes());
    bytes[16..].copy_from_slice(&b.as_bytes()[..RANDOM_BYTES - 16]);
    with_company_prefix(&format!("{KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)), company_id)
}

/// `[c5.]trinity_live_XXXXXX`: tiền tố công ty + `KEY_PREFIX` + 6 ký tự đầu của phần ngẫu nhiên.
fn extract_prefix(plain: &str) -> String {
    let tag = company_token_prefix(company_id_of_token(plain));
    let end = (tag.len() + KEY_PREFIX.len() + 6).min(plain.len());
    format!("{tag}{}", &plain[tag.len()..end])
}

/// Dịch vụ quyền để kiểm owner của khoá.
pub struct Ctx<'a> {
    pub company: CompanyRef,
    pub permissions: &'a PermissionService,
}

/// Owner phải còn hoạt động, KHÔNG là Quản trị (khoá mang đúng quyền của owner, nên Quản trị làm owner là phát hành khoá
/// toàn quyền trá hình) và có ĐÚNG quyền nghiệp vụ mà từng phạm vi dùng tới.
async fn assert_owner(conn: &mut PgConnection, ctx: &Ctx<'_>, user_id: i32, scopes: &[String]) -> Result<(), AppError> {
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    let Some(status) = status else {
        return Err(bad_request(format!("Không tìm thấy user ID {user_id} để gán owner")));
    };
    if status != "active" {
        return Err(bad_request(format!(
            "User ID {user_id} đang bị khoá — không thể gán làm owner"
        )));
    }
    let g = ctx
        .permissions
        .grants_for(ctx.company, user_id)
        .await
        .map_err(AppError::internal)?;
    if g.is_admin {
        return Err(bad_request(format!(
            "User ID {user_id} là Quản trị — không được phép làm owner của API key. Chọn một tài khoản nhân viên có đúng quyền cần dùng."
        )));
    }
    let mut missing: Vec<&str> = Vec::new();
    for p in scopes.iter().filter_map(|s| owner_permission(s)) {
        if !missing.contains(&p) && !can(&g.grants, p, None) {
            missing.push(p);
        }
    }
    if !missing.is_empty() {
        let list = missing
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(bad_request(format!(
            "User ID {user_id} không có quyền {list} — không được phép làm owner của API key với các phạm vi đã chọn."
        )));
    }
    Ok(())
}

/// `POST /api-keys` (`settings.integrations`, 201).
pub async fn create(
    conn: &mut PgConnection,
    ctx: &Ctx<'_>,
    input: &CreateApiKey,
    created_by: i32,
) -> Result<Created, AppError> {
    assert_owner(conn, ctx, input.owner_user_id, &input.scopes).await?;
    let plain = generate_plain_key(ctx.company.id());
    let row = sqlx::query(concat!(
        "INSERT INTO api_keys (name, prefix, key_hash, scopes, owner_user_id, created_by, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING ",
        key_cols!()
    ))
    .bind(input.name.trim())
    .bind(extract_prefix(&plain))
    .bind(hash_key(&plain))
    .bind(&input.scopes)
    .bind(input.owner_user_id)
    .bind(created_by)
    .bind(input.expires_at)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    let key = view(&row);
    tracing::info!(
        "ApiKey created id={} name=\"{}\" scopes=[{}] by user {created_by}",
        key.id,
        key.name,
        input.scopes.join(",")
    );
    Ok(Created {
        key,
        plain_key: plain,
        message: "Lưu lại khoá ngay — hệ thống chỉ hiển thị 1 lần duy nhất. Nếu mất, hãy xoay khoá mới.",
    })
}

/// `GET /api-keys` (`settings.integrations`): mới nhất trước.
pub async fn find_all(conn: &mut PgConnection) -> Result<Vec<ApiKeyView>, AppError> {
    let rows = sqlx::query(concat!(
        "SELECT ",
        key_cols!(),
        " FROM api_keys ORDER BY created_at DESC, id DESC"
    ))
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows.iter().map(view).collect())
}

/// `GET /api-keys/:id`.
pub async fn find_by_id(conn: &mut PgConnection, id: i32) -> Result<ApiKeyView, AppError> {
    let row = sqlx::query(concat!("SELECT ", key_cols!(), " FROM api_keys WHERE id = $1"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?
        .ok_or_else(not_found)?;
    Ok(view(&row))
}

/// `POST /api-keys/:id/rotate`: giữ nguyên dòng, thay hash và prefix; khoá cũ vô hiệu ngay. Khoá đã thu hồi ⇒ 400.
pub async fn rotate(conn: &mut PgConnection, ctx: &Ctx<'_>, id: i32, rotated_by: i32) -> Result<Rotated, AppError> {
    let revoked: Option<Option<DateTime<Utc>>> = sqlx::query_scalar("SELECT revoked_at FROM api_keys WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    match revoked {
        None => return Err(not_found()),
        Some(Some(_)) => return Err(bad_request("Khoá đã bị thu hồi, không xoay được")),
        Some(None) => {}
    }
    // Khoá mới mang tiền tố công ty của người xoay (cùng công ty với khoá, vì dòng nằm trong schema công ty này).
    let plain = generate_plain_key(ctx.company.id());
    let row = sqlx::query(concat!(
        "UPDATE api_keys SET prefix = $2, key_hash = $3, updated_at = now() WHERE id = $1 RETURNING ",
        key_cols!()
    ))
    .bind(id)
    .bind(extract_prefix(&plain))
    .bind(hash_key(&plain))
    .fetch_one(conn)
    .await
    .map_err(db)?;
    tracing::info!("ApiKey rotated id={id} by user {rotated_by}");
    Ok(Rotated {
        key: view(&row),
        plain_key: plain,
    })
}

/// `DELETE /api-keys/:id`: thu hồi mềm, lặp lại không lỗi.
pub async fn revoke(conn: &mut PgConnection, id: i32, revoked_by: i32) -> Result<Message, AppError> {
    let revoked: Option<Option<DateTime<Utc>>> = sqlx::query_scalar("SELECT revoked_at FROM api_keys WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    match revoked {
        None => Err(not_found()),
        Some(Some(_)) => Ok(Message {
            message: "Khoá đã bị thu hồi trước đó",
        }),
        Some(None) => {
            sqlx::query("UPDATE api_keys SET revoked_at = now(), updated_at = now() WHERE id = $1")
                .bind(id)
                .execute(conn)
                .await
                .map_err(db)?;
            tracing::info!("ApiKey revoked id={id} by user {revoked_by}");
            Ok(Message {
                message: "Đã thu hồi khoá",
            })
        }
    }
}

/// Xác thực header `X-API-Key` + phạm vi (`ApiKeyGuard`): công ty theo tiền tố khoá (không có hoặc đang treo ⇒ 401), tra
/// băm SHA-256 ở schema công ty đó, kiểm thu hồi, hết hạn, phạm vi. Ghi `last_used_*` ở nền, lỗi chỉ cảnh báo.
pub async fn validate(
    db_: &Db,
    platform: &Platform,
    raw_key: &str,
    required_scope: &str,
    ip: Option<&str>,
) -> Result<ValidatedApiKey, AppError> {
    if raw_key.is_empty() {
        return Err(unauthorized("Thiếu X-API-Key header"));
    }
    let key = raw_key.trim();
    let invalid = || unauthorized("X-API-Key không hợp lệ");
    let company = platform
        .active_company(i64::from(company_id_of_token(key)))
        .await
        .map_err(AppError::internal)?
        .ok_or_else(invalid)?;
    let tenant = db_.tenant(company).await.map_err(AppError::internal)?;
    let mut conn = tenant.acquire().await.map_err(AppError::internal)?;
    let row =
        sqlx::query("SELECT id, name, scopes, owner_user_id, revoked_at, expires_at FROM api_keys WHERE key_hash = $1")
            .bind(hash_key(key))
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?
            .ok_or_else(invalid)?;
    if row.get::<Option<DateTime<Utc>>, _>("revoked_at").is_some() {
        return Err(unauthorized("Khoá API đã bị thu hồi"));
    }
    if row
        .get::<Option<DateTime<Utc>>, _>("expires_at")
        .is_some_and(|e| e < Utc::now())
    {
        return Err(unauthorized("Khoá API đã hết hạn"));
    }
    let scopes = row.get::<Option<Vec<String>>, _>("scopes").unwrap_or_default();
    if !scopes.iter().any(|s| s == required_scope) {
        return Err(unauthorized(&format!("Khoá API không có phạm vi \"{required_scope}\"")));
    }
    let id: i32 = row.get("id");
    drop(conn);
    let ip = ip.map(str::to_owned);
    tokio::spawn(async move {
        let res = async {
            let mut c = tenant.acquire().await.map_err(|e| e.to_string())?;
            sqlx::query("UPDATE api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1")
                .bind(id)
                .bind(ip)
                .execute(&mut *c)
                .await
                .map(drop)
                .map_err(|e| e.to_string())
        }
        .await;
        if let Err(e) = res {
            tracing::warn!("ApiKey last_used update failed: {e}");
        }
    });
    Ok(ValidatedApiKey {
        id,
        name: row.get("name"),
        scopes,
        owner_user_id: row.get("owner_user_id"),
        company,
    })
}
