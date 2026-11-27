//! `POST /hooks/in/:token` (`webhook-inbound.service.ts`): nhận khách từ nguồn ngoài. Thứ tự kiểm CỐ Ý: cờ → định dạng token →
//! tra token (sai/tắt ⇒ 404, không phân biệt) → thân JSON → chữ ký (nếu nguồn có secret) → hạn mức theo nguồn → kiểm payload →
//! người nhận còn hoạt động → ghi. Mọi request đã nhận diện được nguồn đều ghi `integration_audit_logs` (kênh `webhook_in`),
//! KHÔNG ghi body/SĐT.

use std::sync::Arc;

use mod_contacts::third_party::{Owner, ThirdPartyContact, create_in_tx};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::TenantDb;
use trinity_http::rate_limit::{FixedWindowLimiter, now_ms};
use trinity_kernel::phone::phone_variants;

use super::payload::{MAX_BODY_BYTES, ParsedInbound, parse_inbound_payload};
use super::token::{hash_token, is_valid_token};
use crate::audit::{self, AuditEntry, AuditStatus, Channel};
use crate::webhooks::secret::{KeySource, decrypt_secret};
use crate::webhooks::signature::verify_signature_header;

/// Dung sai đồng hồ của chữ ký (giây).
const SIGNATURE_TOLERANCE_SEC: i64 = 300;

/// Một request vào. `raw_body` là đúng các byte nhận được (chữ ký ký trên đó); `body` là JSON đã phân tích.
#[derive(Debug, Clone, Copy)]
pub struct InboundRequest<'a> {
    pub raw_body: Option<&'a [u8]>,
    pub body: &'a Value,
    /// Giá trị header `X-Trinity-Signature`.
    pub signature: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Created,
    Duplicate,
    Replayed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Duplicate => "duplicate",
            Self::Replayed => "replayed",
        }
    }
}

/// Phản hồi CÔNG KHAI luôn là `200 {"status":"accepted","contact_id":null}`; `outcome`/`contact_id` chỉ để ghi nhật ký nội bộ.
#[derive(Debug, Clone, PartialEq)]
pub struct InboundResult {
    pub http_status: u16,
    pub body: Value,
    pub outcome: Outcome,
    pub contact_id: Option<i32>,
}

#[derive(Debug, thiserror::Error)]
pub enum InboundError {
    /// 404: cờ tắt, token sai định dạng/không có/nguồn tắt (không phân biệt).
    #[error("Not Found")]
    NotFound,
    /// 400.
    #[error("{0}")]
    BadRequest(String),
    /// 413.
    #[error("{0}")]
    PayloadTooLarge(String),
    /// 401.
    #[error("{0}")]
    Unauthorized(String),
    /// 503.
    #[error("{0}")]
    Unavailable(String),
    /// 422.
    #[error("{0}")]
    Unprocessable(String),
    /// 429; `first_in_window` = lần đầu vượt hạn mức trong cửa sổ (chỉ ghi nhật ký một lần).
    #[error("Quá nhiều request, thử lại sau.")]
    RateLimited {
        retry_after_sec: u64,
        first_in_window: bool,
    },
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("{0}")]
    Contacts(Box<trinity_kernel::error::AppError>),
}

impl From<trinity_kernel::error::AppError> for InboundError {
    fn from(e: trinity_kernel::error::AppError) -> Self {
        Self::Contacts(Box::new(e))
    }
}

impl InboundError {
    pub fn http_status(&self) -> u16 {
        match self {
            Self::NotFound => 404,
            Self::BadRequest(_) => 400,
            Self::PayloadTooLarge(_) => 413,
            Self::Unauthorized(_) => 401,
            Self::Unavailable(_) => 503,
            Self::Unprocessable(_) => 422,
            Self::RateLimited { .. } => 429,
            Self::Sqlx(_) | Self::Contacts(_) => 500,
        }
    }

    fn reason(&self) -> String {
        let s = match self {
            Self::Sqlx(_) | Self::Contacts(_) => "internal_error".to_owned(),
            e => e.to_string(),
        };
        s.chars().take(200).collect()
    }
}

/// (id, name, token_hash, signing_secret_enc, default_assignee_id, contact_source_id, project_id, is_active).
type SourceRow = (i32, String, String, Option<String>, i32, i32, Option<i32>, bool);

struct Source {
    id: i32,
    name: String,
    token_hash: String,
    signing_secret_enc: Option<String>,
    default_assignee_id: i32,
    contact_source_id: i32,
    project_id: Option<i32>,
}

/// Cấu hình + bộ giới hạn của webhook vào (dựng một lần ở `serve`, dùng chung mọi công ty: khoá theo `token_hash`).
#[derive(Clone)]
pub struct InboundService {
    /// 100 request hợp lệ/phút/nguồn.
    limiter: Arc<FixedWindowLimiter>,
    /// Lần chữ ký SAI theo token (30/phút): chặn dò/gây ồn, độc lập với hạn mức request hợp lệ.
    fail_limiter: Arc<FixedWindowLimiter>,
    keys: KeySource,
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl InboundService {
    /// `enabled` = `status::webhooks_enabled` đọc lúc gọi.
    pub fn new(keys: KeySource, enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self {
            limiter: FixedWindowLimiter::new(100, 60_000),
            fail_limiter: FixedWindowLimiter::new(30, 60_000),
            keys,
            enabled,
        }
    }

    pub async fn receive(
        &self,
        db: &TenantDb,
        token: &str,
        req: &InboundRequest<'_>,
    ) -> Result<InboundResult, InboundError> {
        if !(self.enabled)() || !is_valid_token(token) {
            return Err(InboundError::NotFound);
        }
        let hash = hash_token(token);
        let src: Option<Source> = {
            let mut c = db.acquire().await.map_err(trinity_kernel::error::AppError::internal)?;
            let row: Option<SourceRow> = sqlx::query_as(
                "SELECT id, name, token_hash, signing_secret_enc, default_assignee_id, contact_source_id, project_id, is_active \
                 FROM webhook_inbound_sources WHERE token_hash = $1",
            )
            .bind(&hash)
            .fetch_optional(&mut *c)
            .await?;
            row.filter(|r| r.7).map(|r| Source {
                id: r.0,
                name: r.1,
                token_hash: r.2,
                signing_secret_enc: r.3,
                default_assignee_id: r.4,
                contact_source_id: r.5,
                project_id: r.6,
            })
        };
        let src = src.ok_or(InboundError::NotFound)?;
        let started = std::time::Instant::now();
        match self.process(db, &src, req).await {
            Ok(out) => {
                record(
                    db,
                    &src,
                    started,
                    AuditStatus::Ok,
                    200,
                    &json!({ "result": out.outcome.as_str() }),
                    out.contact_id,
                )
                .await;
                Ok(out)
            }
            Err(err) => {
                let status = err.http_status();
                let denied = status == 401 || status == 429;
                // Bị chặn hạn mức: chỉ ghi nhật ký lần ĐẦU mỗi cửa sổ (không để kẻ gửi dồn khuếch đại ghi DB).
                if !matches!(
                    err,
                    InboundError::RateLimited {
                        first_in_window: false,
                        ..
                    }
                ) {
                    let st = if denied {
                        AuditStatus::Denied
                    } else {
                        AuditStatus::Error
                    };
                    record(
                        db,
                        &src,
                        started,
                        st,
                        i64::from(status),
                        &json!({ "reason": err.reason() }),
                        None,
                    )
                    .await;
                }
                if matches!(err, InboundError::Sqlx(_) | InboundError::Contacts(_)) {
                    tracing::error!("Webhook vào source={}: lỗi {err}", src.id);
                }
                Err(err)
            }
        }
    }

    async fn process(
        &self,
        db: &TenantDb,
        src: &Source,
        req: &InboundRequest<'_>,
    ) -> Result<InboundResult, InboundError> {
        let raw = req
            .raw_body
            .filter(|b| !b.is_empty())
            .ok_or_else(|| InboundError::BadRequest("Body phải là JSON (Content-Type: application/json)".into()))?;
        if raw.len() > MAX_BODY_BYTES {
            return Err(InboundError::PayloadTooLarge(format!(
                "Body tối đa {MAX_BODY_BYTES} byte"
            )));
        }
        // Chữ ký TRƯỚC hạn mức: người chỉ biết token (không có secret) không tiêu được hạn mức của bên gửi hợp lệ;
        // lần sai chữ ký bị đếm riêng.
        if let Some(enc) = &src.signing_secret_enc {
            self.verify_signature(src, enc, raw, req.signature)?;
        }
        let rl = self.limiter.hit(&format!("tok:{}", src.token_hash), now_ms());
        if !rl.allowed {
            return Err(InboundError::RateLimited {
                retry_after_sec: rl.retry_after_sec,
                first_in_window: rl.count == self.limiter.max() + 1,
            });
        }
        {
            let mut c = db.acquire().await.map_err(trinity_kernel::error::AppError::internal)?;
            sqlx::query(
                "UPDATE webhook_inbound_sources SET last_received_at = now(), updated_at = now() WHERE id = $1",
            )
            .bind(src.id)
            .execute(&mut *c)
            .await?;
        }
        let parsed = parse_inbound_payload(req.body).map_err(|e| InboundError::BadRequest(e.join("; ")))?;
        let owner = load_owner(db, src).await?;
        assert_source_usable(db, src).await?;
        let (outcome, contact_id) = persist(db, src, &parsed, owner).await?;
        Ok(InboundResult {
            http_status: 200,
            body: json!({ "status": "accepted", "contact_id": null }),
            outcome,
            contact_id,
        })
    }

    /// Thiếu khoá giải mã ⇒ 503 (không thể kiểm chữ ký, KHÔNG được bỏ qua kiểm). Sai chữ ký ⇒ 401 chung chung.
    fn verify_signature(&self, src: &Source, enc: &str, raw: &[u8], header: Option<&str>) -> Result<(), InboundError> {
        let unavailable =
            || InboundError::Unavailable("Không kiểm được chữ ký (cấu hình khoá mã hoá của máy chủ)".into());
        let key = (self.keys)().map_err(|_| unavailable())?;
        let secret = decrypt_secret(enc, &key).map_err(|_| unavailable())?;
        let now = i64::try_from(now_ms()).unwrap_or(i64::MAX);
        if verify_signature_header(&secret, raw, header, SIGNATURE_TOLERANCE_SEC, now) {
            return Ok(());
        }
        let f = self.fail_limiter.hit(&format!("fail:{}", src.token_hash), now_ms());
        if !f.allowed {
            return Err(InboundError::RateLimited {
                retry_after_sec: f.retry_after_sec,
                first_in_window: f.count == self.fail_limiter.max() + 1,
            });
        }
        Err(InboundError::Unauthorized("Chữ ký không hợp lệ".into()))
    }
}

async fn load_owner(db: &TenantDb, src: &Source) -> Result<Owner, InboundError> {
    let mut c = db.acquire().await.map_err(trinity_kernel::error::AppError::internal)?;
    let u: Option<(i32, String, Option<i32>, Option<chrono::NaiveDateTime>)> =
        sqlx::query_as("SELECT id, status, team_id, deleted_at FROM users WHERE id = $1")
            .bind(src.default_assignee_id)
            .fetch_optional(&mut *c)
            .await?;
    match u {
        Some((id, status, team_id, None)) if status == "active" => Ok(Owner { id: Some(id), team_id }),
        _ => {
            tracing::warn!(
                "Webhook vào source={}: người nhận mặc định {} không còn hoạt động",
                src.id,
                src.default_assignee_id
            );
            Err(InboundError::Unprocessable(
                "Người nhận mặc định của nguồn không còn hoạt động".into(),
            ))
        }
    }
}

async fn assert_source_usable(db: &TenantDb, src: &Source) -> Result<(), InboundError> {
    let mut c = db.acquire().await.map_err(trinity_kernel::error::AppError::internal)?;
    let o: Option<(String, bool)> = sqlx::query_as("SELECT group_key, is_active FROM setting_options WHERE id = $1")
        .bind(src.contact_source_id)
        .fetch_optional(&mut *c)
        .await?;
    if matches!(&o, Some((g, true)) if g == "contact_source") {
        return Ok(());
    }
    tracing::warn!(
        "Webhook vào source={}: nguồn khách {} không còn dùng được",
        src.id,
        src.contact_source_id
    );
    Err(InboundError::Unprocessable(
        "Nguồn khách của nguồn webhook không còn dùng được".into(),
    ))
}

/// 1 giao dịch: idempotency (UNIQUE) → khoá theo SĐT → dedupe → (tạo khách + outbox | ghi activity).
async fn persist(
    db: &TenantDb,
    src: &Source,
    p: &ParsedInbound,
    owner: Owner,
) -> Result<(Outcome, Option<i32>), InboundError> {
    let mut tx = db.begin().await.map_err(trinity_kernel::error::AppError::internal)?;
    let conn: &mut PgConnection = &mut tx;
    if let Some(ext) = &p.external_id {
        let claimed: Option<i64> = sqlx::query_scalar(
            "INSERT INTO webhook_inbound_receipts (source_id, external_id) VALUES ($1, $2) \
             ON CONFLICT (source_id, external_id) DO NOTHING RETURNING id",
        )
        .bind(src.id)
        .bind(ext)
        .fetch_optional(&mut *conn)
        .await?;
        if claimed.is_none() {
            let prev: Option<Option<i32>> = sqlx::query_scalar(
                "SELECT contact_id FROM webhook_inbound_receipts WHERE source_id = $1 AND external_id = $2",
            )
            .bind(src.id)
            .bind(ext)
            .fetch_optional(&mut *conn)
            .await?;
            tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
            return Ok((Outcome::Replayed, prev.flatten()));
        }
    }
    // Cùng khoá với `ContactsService.create` (hashtext(phone) trên SĐT chuẩn hoá) ⇒ tạo tay và webhook vào cùng SĐT cũng tuần tự.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&p.phone)
        .execute(&mut *conn)
        .await?;
    let dup: Option<(i32, Option<i32>)> = sqlx::query_as(
        "SELECT id, assigned_to FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
    )
    .bind(phone_variants(&p.phone))
    .fetch_optional(&mut *conn)
    .await?;
    let contact_id = match dup {
        Some((id, _)) => id,
        None => {
            create_in_tx(
                conn,
                &ThirdPartyContact {
                    phone: &p.phone,
                    full_name: &p.name,
                    source_id: Some(src.contact_source_id),
                    email: p.email.as_deref(),
                    project_id: src.project_id,
                },
                owner,
                "webhook_in",
            )
            .await?
        }
    };
    // Khách cũ của người KHÁC: chỉ ghi dấu vết ngắn (không `extra`, ghi chú cắt 500) — nguồn ngoài không gieo nội dung dài
    // vào hồ sơ người khác.
    let foreign = matches!(dup, Some((_, a)) if a != owner.id);
    let (details, metadata) = activity(src, p, dup.is_some(), foreign);
    sqlx::query(
        "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
         VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, NULL)",
    )
    .bind(contact_id)
    .bind(trinity_kernel::json::js_json(&details))
    .bind(trinity_kernel::json::js_json(&metadata))
    .execute(&mut *conn)
    .await?;
    if let Some(ext) = &p.external_id {
        sqlx::query("UPDATE webhook_inbound_receipts SET contact_id = $3 WHERE source_id = $1 AND external_id = $2")
            .bind(src.id)
            .bind(ext)
            .bind(contact_id)
            .execute(&mut *conn)
            .await?;
    }
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    Ok((
        if dup.is_some() {
            Outcome::Duplicate
        } else {
            Outcome::Created
        },
        Some(contact_id),
    ))
}

fn activity(src: &Source, p: &ParsedInbound, duplicate: bool, foreign: bool) -> (Value, Value) {
    let head = if duplicate {
        format!("Khách gửi lại từ webhook \"{}\"", src.name)
    } else {
        format!("Tạo từ webhook \"{}\"", src.name)
    };
    let label = p
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!(" ({s})"))
        .unwrap_or_default();
    let note = p
        .note
        .as_deref()
        .filter(|n| !n.is_empty())
        .map_or_else(String::new, |n| {
            let n = if foreign {
                n.encode_utf16().take(500).collect::<Vec<_>>()
            } else {
                n.encode_utf16().collect()
            };
            format!(" — {}", String::from_utf16_lossy(&n))
        });
    let mut meta = serde_json::Map::new();
    meta.insert("webhook_source_id".into(), json!(src.id));
    if let Some(e) = &p.external_id {
        meta.insert("external_id".into(), json!(e));
    }
    if !foreign && let Some(x) = &p.extra {
        meta.insert("extra".into(), Value::Object(x.clone()));
    }
    (
        json!({ "description": format!("{head}{label}{note}"), "source": "webhook_in" }),
        Value::Object(meta),
    )
}

async fn record(
    db: &TenantDb,
    src: &Source,
    started: std::time::Instant,
    status: AuditStatus,
    http_status: i64,
    meta: &Value,
    contact_id: Option<i32>,
) {
    let Ok(mut c) = db.acquire().await else { return };
    let mut e = AuditEntry::new(Channel::WebhookIn, "receive", status);
    e.client_id = Some(format!("source:{}", src.id));
    // Tác nhân là hệ thống ngoài, KHÔNG phải sale nhận (tránh đọc nhầm khi điều tra).
    e.user_id = None;
    e.resource = Some(
        if contact_id.is_some() {
            "contact"
        } else {
            "webhook_source"
        }
        .into(),
    );
    e.resource_id = Some(contact_id.unwrap_or(src.id).to_string());
    e.http_status = Some(http_status);
    e.duration_ms = Some(i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX));
    if status != AuditStatus::Ok {
        e.error = meta.get("reason").and_then(Value::as_str).map(str::to_owned);
    }
    let mut m = json!({ "source_id": src.id, "assignee_id": src.default_assignee_id });
    if status == AuditStatus::Ok
        && let (Some(mm), Some(extra)) = (m.as_object_mut(), meta.as_object())
    {
        mm.extend(extra.clone());
    }
    e.metadata = Some(m);
    audit::log(&mut c, &e).await;
}
