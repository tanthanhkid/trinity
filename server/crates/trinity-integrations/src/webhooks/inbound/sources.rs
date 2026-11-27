//! Quản trị nguồn webhook vào (`webhook-inbound-sources.service.ts`): 6 route dưới `/integrations/webhooks/inbound-sources`.
//! Token và signing secret CHỈ có ở phản hồi tạo / tạo lại; DB lưu SHA-256 của token và secret đã mã hoá AES-256-GCM.

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection, Row};
use trinity_http::validate::{Mode, validate_value};
use trinity_kernel::error::AppError;
use trinity_rbac::OwnerIds;

use super::token::{INBOUND_PATH_PREFIX, generate_token, hash_token, token_prefix, with_company_hint};
use crate::audit::{self, AuditEntry, AuditStatus, Channel};
use crate::webhooks::deliveries::iso;
use crate::webhooks::secret::{KeySource, encrypt_secret, generate_webhook_secret};

pub const MAX_INBOUND_SOURCES: i64 = 50;

/// Lỗi nghiệp vụ; mỗi biến ứng với một mã HTTP của bản Node.
#[derive(Debug, thiserror::Error)]
pub enum SourceError {
    /// 404.
    #[error("{0}")]
    NotFound(String),
    /// 400.
    #[error("{0}")]
    BadRequest(String),
    /// 403.
    #[error("{0}")]
    Forbidden(String),
    /// 503 (thiếu hoặc sai khoá mã hoá).
    #[error("{0}")]
    Unavailable(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

impl SourceError {
    pub fn http_status(&self) -> u16 {
        match self {
            Self::NotFound(_) => 404,
            Self::BadRequest(_) => 400,
            Self::Forbidden(_) => 403,
            Self::Unavailable(_) => 503,
            Self::Sqlx(_) => 500,
        }
    }
}

/// Người cấu hình. `transfer` = phạm vi `contacts.transfer` của họ (`None` = không có quyền đó).
#[derive(Debug, Clone)]
pub struct Actor {
    pub user_id: i32,
    pub transfer: Option<OwnerIds>,
}

/// Công ty của lời gọi, để `path` có gợi ý `?cid=` ở bản nhiều công ty.
#[derive(Debug, Clone, Copy)]
pub struct Tenant {
    pub company_id: i32,
    pub multi_tenant: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateInboundSource {
    pub name: String,
    pub default_assignee_id: i32,
    pub contact_source_id: i32,
    pub project_id: Option<i32>,
    pub signed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateInboundSource {
    pub name: Option<String>,
    pub default_assignee_id: Option<i32>,
    pub contact_source_id: Option<i32>,
    /// `Some(None)` = bỏ dự án.
    pub project_id: Option<Option<i32>>,
    pub is_active: Option<bool>,
    pub signed: Option<bool>,
}

fn dto_error(e: AppError) -> SourceError {
    let (status, body) = e.response(true);
    let msg = match body.message {
        trinity_kernel::error::Message::One(s) => s,
        trinity_kernel::error::Message::Many(m) => m.join("; "),
    };
    if status >= 500 {
        SourceError::Unavailable(msg)
    } else {
        SourceError::BadRequest(msg)
    }
}

/// Số nguyên i32 của khoá `k`: vắng hoặc `null` ⇒ `None`; có mặt mà ngoài khoảng i32 ⇒ 400 (KHÔNG rơi về `None`, kẻo PATCH
/// xoá `project_id` hay tạo nguồn bỏ dự án một cách lặng lẽ).
fn int(v: &Map<String, Value>, k: &str) -> Result<Option<i32>, SourceError> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(x) => x
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| SourceError::BadRequest(format!("{k} must not be greater than {}", i32::MAX))),
    }
}

impl CreateInboundSource {
    /// Kiểm body như `CreateInboundSourceDto` (strict, trim tên, ép số). Lỗi ⇒ 400 gom câu.
    pub fn from_body(body: &Value) -> Result<Self, SourceError> {
        let v = validate_value("CreateInboundSourceDto", body, Mode::Strict).map_err(dto_error)?;
        let m = v.as_object().cloned().unwrap_or_default();
        Ok(Self {
            name: m.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            default_assignee_id: int(&m, "default_assignee_id")?.unwrap_or_default(),
            contact_source_id: int(&m, "contact_source_id")?.unwrap_or_default(),
            project_id: int(&m, "project_id")?,
            signed: m.get("signed").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

impl UpdateInboundSource {
    /// Kiểm body như `UpdateInboundSourceDto`; `project_id: null` = bỏ dự án.
    pub fn from_body(body: &Value) -> Result<Self, SourceError> {
        let v = validate_value("UpdateInboundSourceDto", body, Mode::Strict).map_err(dto_error)?;
        let m = v.as_object().cloned().unwrap_or_default();
        Ok(Self {
            name: m.get("name").and_then(Value::as_str).map(str::to_owned),
            default_assignee_id: int(&m, "default_assignee_id")?,
            contact_source_id: int(&m, "contact_source_id")?,
            project_id: match m.get("project_id") {
                None => None,
                Some(Value::Null) => Some(None),
                Some(_) => Some(int(&m, "project_id")?),
            },
            is_active: m.get("is_active").and_then(Value::as_bool),
            signed: m.get("signed").and_then(Value::as_bool),
        })
    }
}

/// Cột của bảng, KHÔNG có `token_hash` và `signing_secret_enc` (chỉ cờ `signed`).
const COLS: &str = "id, name, token_prefix, signing_secret_enc IS NOT NULL AS signed, default_assignee_id, contact_source_id, \
     project_id, is_active, created_by, created_at, updated_at, last_received_at";

/// Phản hồi nguồn: thứ tự khoá như `toSourceView` (các cột của model, rồi `signed`).
fn view(r: &sqlx::postgres::PgRow) -> Result<Map<String, Value>, sqlx::Error> {
    let ts = |c: &str| -> Result<Value, sqlx::Error> {
        Ok(r.try_get::<Option<DateTime<Utc>>, _>(c)?
            .map_or(Value::Null, |t| json!(iso(t))))
    };
    let mut m = Map::new();
    m.insert("id".into(), json!(r.try_get::<i32, _>("id")?));
    m.insert("name".into(), json!(r.try_get::<String, _>("name")?));
    m.insert("token_prefix".into(), json!(r.try_get::<String, _>("token_prefix")?));
    m.insert(
        "default_assignee_id".into(),
        json!(r.try_get::<i32, _>("default_assignee_id")?),
    );
    m.insert(
        "contact_source_id".into(),
        json!(r.try_get::<i32, _>("contact_source_id")?),
    );
    m.insert("project_id".into(), json!(r.try_get::<Option<i32>, _>("project_id")?));
    m.insert("is_active".into(), json!(r.try_get::<bool, _>("is_active")?));
    m.insert("created_by".into(), json!(r.try_get::<i32, _>("created_by")?));
    m.insert("created_at".into(), ts("created_at")?);
    m.insert("updated_at".into(), ts("updated_at")?);
    m.insert("last_received_at".into(), ts("last_received_at")?);
    m.insert("signed".into(), json!(r.try_get::<bool, _>("signed")?));
    Ok(m)
}

async fn find(conn: &mut PgConnection, id: i32) -> Result<sqlx::postgres::PgRow, SourceError> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM webhook_inbound_sources WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(|| SourceError::NotFound("Không tìm thấy nguồn".into()))
}

async fn log_ok(conn: &mut PgConnection, user: i32, action: &str, id: i32, meta: Value) {
    let mut e = AuditEntry::new(Channel::WebhookIn, action, AuditStatus::Ok);
    e.user_id = Some(user);
    e.resource = Some("webhook_source".into());
    e.resource_id = Some(id.to_string());
    e.metadata = Some(meta);
    audit::log(conn, &e).await;
}

fn key(src: &KeySource) -> Result<crate::webhooks::secret::Key, SourceError> {
    src().map_err(|e| SourceError::Unavailable(e.0))
}

fn covers(owners: Option<&OwnerIds>, id: i32) -> bool {
    match owners {
        Some(OwnerIds::All) => true,
        Some(OwnerIds::Ids(v)) => v.contains(&id),
        None => false,
    }
}

/// Người nhận phải đang hoạt động VÀ nằm trong phạm vi `contacts.transfer` của người cấu hình (không gán khách cho người ngoài tầm).
async fn assert_assignable(conn: &mut PgConnection, actor: &Actor, assignee: i32) -> Result<(), SourceError> {
    let u: Option<(String, Option<chrono::NaiveDateTime>)> =
        sqlx::query_as("SELECT status, deleted_at FROM users WHERE id = $1")
            .bind(assignee)
            .fetch_optional(&mut *conn)
            .await?;
    match u {
        Some((status, None)) if status == "active" => {}
        _ => {
            return Err(SourceError::BadRequest(
                "Người nhận không tồn tại hoặc không hoạt động".into(),
            ));
        }
    }
    if assignee == actor.user_id || covers(actor.transfer.as_ref(), assignee) {
        return Ok(());
    }
    Err(SourceError::Forbidden(
        "Không có quyền gán khách cho người này (cần contacts.transfer phủ người nhận)".into(),
    ))
}

async fn assert_contact_source(conn: &mut PgConnection, id: i32) -> Result<(), SourceError> {
    let o: Option<(String, bool)> = sqlx::query_as("SELECT group_key, is_active FROM setting_options WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    match o {
        Some((g, active)) if g == "contact_source" => {
            if active {
                Ok(())
            } else {
                Err(SourceError::BadRequest("Nguồn khách đang bị tắt".into()))
            }
        }
        _ => Err(SourceError::BadRequest(
            "contact_source_id không thuộc nhóm nguồn khách".into(),
        )),
    }
}

async fn assert_project(conn: &mut PgConnection, id: i32) -> Result<(), SourceError> {
    let n: Option<i32> = sqlx::query_scalar("SELECT id FROM projects WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    n.map(|_| ())
        .ok_or_else(|| SourceError::BadRequest("project_id không tồn tại".into()))
}

/// `GET /inbound-sources`: `{ data }`, mới nhất trước.
pub async fn list(conn: &mut PgConnection) -> Result<Value, SourceError> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLS} FROM webhook_inbound_sources ORDER BY id DESC LIMIT $1"
    )))
    .bind(MAX_INBOUND_SOURCES + 5)
    .fetch_all(conn)
    .await?;
    let data = rows
        .iter()
        .map(|r| view(r).map(Value::Object))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "data": data }))
}

/// `GET /inbound-sources/:id`.
pub async fn get(conn: &mut PgConnection, id: i32) -> Result<Value, SourceError> {
    Ok(Value::Object(view(&find(conn, id).await?)?))
}

/// `POST /inbound-sources`: phản hồi có `token` + `path` (+ `signing_secret`), hiện đúng một lần.
pub async fn create(
    conn: &mut PgConnection,
    keys: &KeySource,
    tenant: Tenant,
    dto: &CreateInboundSource,
    actor: &Actor,
) -> Result<Value, SourceError> {
    let k = key(keys)?;
    // Đếm và chèn trong MỘT giao dịch có khoá tư vấn: hai request song song không cùng lọt qua trần 50.
    let mut tx = conn.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('webhook_inbound_sources:create'))")
        .execute(&mut *tx)
        .await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM webhook_inbound_sources")
        .fetch_one(&mut *tx)
        .await?;
    if n >= MAX_INBOUND_SOURCES {
        return Err(SourceError::BadRequest(format!(
            "Tối đa {MAX_INBOUND_SOURCES} nguồn webhook vào"
        )));
    }
    assert_assignable(&mut tx, actor, dto.default_assignee_id).await?;
    assert_contact_source(&mut tx, dto.contact_source_id).await?;
    if let Some(p) = dto.project_id {
        assert_project(&mut tx, p).await?;
    }
    let token = generate_token();
    let signing = dto.signed.then(generate_webhook_secret);
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO webhook_inbound_sources (name, token_hash, token_prefix, signing_secret_enc, default_assignee_id, \
         contact_source_id, project_id, created_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING {COLS}"
    )))
    .bind(&dto.name)
    .bind(hash_token(&token))
    .bind(token_prefix(&token))
    .bind(signing.as_deref().map(|s| encrypt_secret(s, &k)))
    .bind(dto.default_assignee_id)
    .bind(dto.contact_source_id)
    .bind(dto.project_id)
    .bind(actor.user_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let id = row.try_get::<i32, _>("id")?;
    log_ok(
        conn,
        actor.user_id,
        "source.created",
        id,
        json!({ "signed": signing.is_some() }),
    )
    .await;
    let mut v = view(&row)?;
    v.insert("token".into(), json!(token));
    v.insert(
        "path".into(),
        json!(with_company_hint(
            &format!("{INBOUND_PATH_PREFIX}{token}"),
            tenant.multi_tenant,
            tenant.company_id
        )),
    );
    if let Some(s) = signing {
        v.insert("signing_secret".into(), json!(s));
    }
    Ok(Value::Object(v))
}

/// `PATCH /inbound-sources/:id`. Mọi thay đổi trừ "chỉ TẮT nguồn" đều dùng quyền của nguồn (tạo khách thay mặt người nhận) ⇒
/// người sửa phải với tới người nhận cuối cùng.
pub async fn update(
    conn: &mut PgConnection,
    keys: &KeySource,
    id: i32,
    dto: &UpdateInboundSource,
    actor: &Actor,
) -> Result<Value, SourceError> {
    let cur = find(conn, id).await?;
    let cur_assignee: i32 = cur.try_get("default_assignee_id")?;
    let cur_source: i32 = cur.try_get("contact_source_id")?;
    let only_disabling = dto.is_active == Some(false)
        && dto.name.is_none()
        && dto.default_assignee_id.is_none()
        && dto.contact_source_id.is_none()
        && dto.project_id.is_none()
        && dto.signed.is_none();
    if !only_disabling {
        assert_assignable(conn, actor, dto.default_assignee_id.unwrap_or(cur_assignee)).await?;
    }
    let mut fields: Vec<&str> = Vec::new();
    let mut name = None;
    let mut assignee = None;
    let mut source = None;
    let mut project: Option<Option<i32>> = None;
    let mut secret: Option<Option<String>> = None;
    let mut signing = None;
    if let Some(n) = &dto.name {
        name = Some(n.clone());
        fields.push("name");
    }
    if dto.is_active.is_some() {
        fields.push("is_active");
    }
    if let Some(a) = dto.default_assignee_id.filter(|a| *a != cur_assignee) {
        assignee = Some(a);
        fields.push("default_assignee_id");
    }
    if let Some(s) = dto.contact_source_id.filter(|s| *s != cur_source) {
        assert_contact_source(conn, s).await?;
        source = Some(s);
        fields.push("contact_source_id");
    }
    if let Some(p) = dto.project_id {
        if let Some(p) = p {
            assert_project(conn, p).await?;
        }
        project = Some(p);
        fields.push("project_id");
    }
    match dto.signed {
        Some(true) => {
            let s = generate_webhook_secret();
            secret = Some(Some(encrypt_secret(&s, &key(keys)?)));
            signing = Some(s);
            fields.push("signing_secret_enc");
        }
        Some(false) => {
            secret = Some(None);
            fields.push("signing_secret_enc");
        }
        None => {}
    }
    let saved = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE webhook_inbound_sources SET
           name = COALESCE($2, name), is_active = COALESCE($3, is_active),
           default_assignee_id = COALESCE($4, default_assignee_id), contact_source_id = COALESCE($5, contact_source_id),
           project_id = CASE WHEN $6 THEN $7 ELSE project_id END,
           signing_secret_enc = CASE WHEN $8 THEN $9 ELSE signing_secret_enc END, updated_at = now()
         WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(name)
    .bind(dto.is_active)
    .bind(assignee)
    .bind(source)
    .bind(project.is_some())
    .bind(project.flatten())
    .bind(secret.is_some())
    .bind(secret.flatten())
    .fetch_one(&mut *conn)
    .await?;
    log_ok(conn, actor.user_id, "source.updated", id, json!({ "fields": fields })).await;
    let mut v = view(&saved)?;
    if let Some(s) = signing {
        v.insert("signing_secret".into(), json!(s));
    }
    Ok(Value::Object(v))
}

/// `POST /inbound-sources/:id/rotate-token`: URL cũ vô hiệu ngay; trả token mới MỘT lần.
pub async fn rotate_token(
    conn: &mut PgConnection,
    tenant: Tenant,
    id: i32,
    actor: &Actor,
) -> Result<Value, SourceError> {
    let cur = find(conn, id).await?;
    // Cấp lại credential = dùng quyền của nguồn.
    assert_assignable(conn, actor, cur.try_get("default_assignee_id")?).await?;
    let token = generate_token();
    let saved = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE webhook_inbound_sources SET token_hash = $2, token_prefix = $3, updated_at = now() WHERE id = $1 RETURNING {COLS}"
    )))
    .bind(id)
    .bind(hash_token(&token))
    .bind(token_prefix(&token))
    .fetch_one(&mut *conn)
    .await?;
    log_ok(conn, actor.user_id, "source.token_rotated", id, json!({})).await;
    let mut v = view(&saved)?;
    v.insert("token".into(), json!(token));
    v.insert(
        "path".into(),
        json!(with_company_hint(
            &format!("{INBOUND_PATH_PREFIX}{token}"),
            tenant.multi_tenant,
            tenant.company_id
        )),
    );
    Ok(Value::Object(v))
}

/// `DELETE /inbound-sources/:id`: xoá biên nhận idempotency rồi nguồn, một giao dịch.
pub async fn remove(conn: &mut PgConnection, id: i32, actor: &Actor) -> Result<Value, SourceError> {
    find(conn, id).await?;
    let mut tx = conn.begin().await?;
    sqlx::query("DELETE FROM webhook_inbound_receipts WHERE source_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM webhook_inbound_sources WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    log_ok(conn, actor.user_id, "source.deleted", id, json!({})).await;
    Ok(json!({ "deleted": true }))
}
