//! Quản lý endpoint webhook ra (`/integrations/webhooks/endpoints*`, `/deliveries/:id/retry`, `/events`).
//! Port của `webhook-endpoints.service.ts`. Mọi hàm nhận kết nối của công ty hiện tại; lớp route lo quyền
//! (`integrations.webhooks`) và cờ (`webhooks_enabled` tắt ⇒ 404, xem [`crate::status::webhooks_enabled`]).

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection, Row};
use trinity_http::outbound::ssrf::{SsrfBlocked, assert_safe_url};

use super::deliveries::iso;
use super::secret::{encrypt_secret, generate_webhook_secret};
use super::sender::{SendItem, SendTarget, Sender};
use crate::audit::{self, AuditEntry, AuditStatus, Channel};

pub const MAX_ENDPOINTS: i64 = 20;

/// Lỗi nghiệp vụ; mỗi biến ứng với một mã HTTP của bản Node.
#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    /// 404.
    #[error("{0}")]
    NotFound(String),
    /// 400.
    #[error("{0}")]
    BadRequest(String),
    /// 409.
    #[error("{0}")]
    Conflict(String),
    /// 503 (thiếu hoặc sai khoá mã hoá).
    #[error("{0}")]
    Unavailable(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

impl EndpointError {
    pub fn http_status(&self) -> u16 {
        match self {
            Self::NotFound(_) => 404,
            Self::BadRequest(_) => 400,
            Self::Conflict(_) => 409,
            Self::Unavailable(_) => 503,
            Self::Sqlx(_) => 500,
        }
    }
}

const EVENTS_JSON: &str = include_str!("../../../../contracts/events.json");

/// `GET /integrations/webhooks/events`: `[{ type, resource, label }]` theo thứ tự danh mục.
pub fn event_catalog() -> Vec<Value> {
    let v: Value = serde_json::from_str(EVENTS_JSON).expect("events.json hợp lệ");
    v["events"].as_array().cloned().unwrap_or_default()
}

fn is_event_type(t: &str) -> bool {
    event_catalog().iter().any(|e| e["type"] == t)
}

#[derive(Debug, Clone)]
pub struct CreateEndpoint {
    pub name: String,
    pub url: String,
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateEndpoint {
    pub name: Option<String>,
    pub url: Option<String>,
    pub events: Option<Vec<String>>,
    pub is_active: Option<bool>,
}

macro_rules! cols {
    () => {
        "id, name, url, events, is_active, disabled_reason, created_by, created_at, updated_at, last_success_at, last_failure_at, consecutive_failures"
    };
}

/// Phản hồi endpoint: KHÔNG BAO GIỜ có `secret_enc`.
fn view(r: &sqlx::postgres::PgRow) -> Result<Value, sqlx::Error> {
    let ts = |c: &str| -> Result<Value, sqlx::Error> {
        Ok(r.try_get::<Option<DateTime<Utc>>, _>(c)?
            .map_or(Value::Null, |t| json!(iso(t))))
    };
    Ok(json!({
        "id": r.try_get::<i32, _>("id")?,
        "name": r.try_get::<String, _>("name")?,
        "url": r.try_get::<String, _>("url")?,
        "events": r.try_get::<Vec<String>, _>("events")?,
        "is_active": r.try_get::<bool, _>("is_active")?,
        "disabled_reason": r.try_get::<Option<String>, _>("disabled_reason")?,
        "created_by": r.try_get::<i32, _>("created_by")?,
        "created_at": ts("created_at")?,
        "updated_at": ts("updated_at")?,
        "last_success_at": ts("last_success_at")?,
        "last_failure_at": ts("last_failure_at")?,
        "consecutive_failures": r.try_get::<i32, _>("consecutive_failures")?,
        "secret_set": true,
    }))
}

fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|x| b.contains(x))
}

fn check_events(events: &[String]) -> Result<(), EndpointError> {
    if events.is_empty() {
        return Err(EndpointError::BadRequest("Chọn ít nhất 1 sự kiện".into()));
    }
    if events.iter().any(|e| !is_event_type(e)) {
        return Err(EndpointError::BadRequest("Sự kiện không hợp lệ".into()));
    }
    Ok(())
}

async fn log_ok(conn: &mut PgConnection, user: i32, action: &str, id: i32, meta: Value) {
    let mut e = AuditEntry::new(Channel::WebhookOut, action, AuditStatus::Ok);
    e.user_id = Some(user);
    e.resource = Some("webhook_endpoint".into());
    e.resource_id = Some(id.to_string());
    e.metadata = Some(meta);
    audit::log(conn, &e).await;
}

async fn safe_url(sender: &Sender, url: &str) -> Result<String, EndpointError> {
    match assert_safe_url(url, sender.policy(), sender.resolver().as_ref()).await {
        Ok(t) => Ok(t.url.to_string()),
        Err(SsrfBlocked(msg)) => Err(EndpointError::BadRequest(msg.to_owned())),
    }
}

fn key(sender: &Sender) -> Result<super::secret::Key, EndpointError> {
    sender.key().map_err(|e| EndpointError::Unavailable(e.0))
}

async fn find(conn: &mut PgConnection, id: i32) -> Result<sqlx::postgres::PgRow, EndpointError> {
    sqlx::query(concat!(
        "SELECT ",
        cols!(),
        ", secret_enc FROM webhook_endpoints WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(conn)
    .await?
    .ok_or_else(|| EndpointError::NotFound("Không tìm thấy endpoint".into()))
}

pub async fn list(conn: &mut PgConnection) -> Result<Vec<Value>, EndpointError> {
    let rows = sqlx::query(concat!(
        "SELECT ",
        cols!(),
        " FROM webhook_endpoints ORDER BY id DESC LIMIT $1"
    ))
    .bind(MAX_ENDPOINTS + 5)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(view).collect::<Result<_, _>>()?)
}

pub async fn get(conn: &mut PgConnection, id: i32) -> Result<Value, EndpointError> {
    Ok(view(&find(conn, id).await?)?)
}

/// Tạo endpoint; phản hồi có `secret` (hiện đúng một lần).
pub async fn create(
    conn: &mut PgConnection,
    sender: &Sender,
    dto: &CreateEndpoint,
    user: i32,
) -> Result<Value, EndpointError> {
    let k = key(sender)?;
    check_events(&dto.events)?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM webhook_endpoints")
        .fetch_one(&mut *conn)
        .await?;
    if n >= MAX_ENDPOINTS {
        return Err(EndpointError::BadRequest(format!(
            "Tối đa {MAX_ENDPOINTS} endpoint webhook"
        )));
    }
    let url = safe_url(sender, &dto.url).await?;
    let secret = generate_webhook_secret();
    let row = sqlx::query(concat!(
        "INSERT INTO webhook_endpoints (name, url, events, secret_enc, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING ",
        cols!(),
        ""
    ))
    .bind(&dto.name)
    .bind(&url)
    .bind(&dto.events)
    .bind(encrypt_secret(&secret, &k))
    .bind(user)
    .fetch_one(&mut *conn)
    .await?;
    let mut v = view(&row)?;
    let id = row.try_get::<i32, _>("id")?;
    log_ok(conn, user, "endpoint.created", id, json!({"events": dto.events.len()})).await;
    v["secret"] = json!(secret);
    Ok(v)
}

/// Quyền của payload gắn với người CHỌN URL ĐÍCH: đổi URL bởi người KHÁC chủ thể ⇒ chủ thể chuyển sang người sửa và huỷ
/// delivery chờ (đã dựng theo quyền chủ thể cũ). Đổi sự kiện, secret hay tên KHÔNG chuyển chủ thể.
pub async fn update(
    conn: &mut PgConnection,
    sender: &Sender,
    id: i32,
    dto: &UpdateEndpoint,
    user: i32,
) -> Result<Value, EndpointError> {
    let ep = find(conn, id).await?;
    let (cur_url, cur_events, cur_owner): (String, Vec<String>, i32) =
        (ep.try_get("url")?, ep.try_get("events")?, ep.try_get("created_by")?);
    if let Some(e) = &dto.events {
        check_events(e)?;
    }
    let mut fields: Vec<&str> = Vec::new();
    let mut new_url = None;
    if let Some(u) = &dto.url {
        let safe = safe_url(sender, u).await?;
        if safe != cur_url {
            new_url = Some(safe);
        }
    }
    let new_events = dto.events.clone().filter(|e| !same_set(e, &cur_events));
    if dto.name.is_some() {
        fields.push("name");
    }
    if new_url.is_some() {
        fields.push("url");
    }
    if new_events.is_some() {
        fields.push("events");
    }
    if dto.is_active.is_some() {
        fields.push("is_active");
    }
    let url_changed = new_url.is_some();
    let owner_changed = url_changed && cur_owner != user;
    if owner_changed {
        fields.push("created_by");
    }
    let row = sqlx::query(concat!(
        "UPDATE webhook_endpoints SET \
           name = COALESCE($2, name), url = COALESCE($3, url), events = COALESCE($4, events), \
           is_active = COALESCE($5, is_active), \
           disabled_reason = CASE WHEN $5 IS TRUE THEN NULL WHEN $5 IS FALSE THEN 'manual' ELSE disabled_reason END, \
           consecutive_failures = CASE WHEN $5 IS TRUE THEN 0 ELSE consecutive_failures END, \
           created_by = CASE WHEN $6 THEN $7 ELSE created_by END, updated_at = now() \
         WHERE id = $1 RETURNING ",
        cols!(),
        ""
    ))
    .bind(id)
    .bind(dto.name.as_deref())
    .bind(new_url.as_deref())
    .bind(new_events.as_deref())
    .bind(dto.is_active)
    .bind(owner_changed)
    .bind(user)
    .fetch_one(&mut *conn)
    .await?;
    if url_changed {
        cancel_pending(conn, id, "endpoint_changed").await?;
    } else if dto.is_active == Some(false) {
        cancel_pending(conn, id, "endpoint_disabled").await?;
    }
    log_ok(
        conn,
        user,
        "endpoint.updated",
        id,
        json!({"fields": fields, "owner_changed": owner_changed}),
    )
    .await;
    Ok(view(&row)?)
}

pub async fn remove(conn: &mut PgConnection, id: i32, user: i32) -> Result<Value, EndpointError> {
    find(conn, id).await?;
    let mut tx = conn.begin().await?;
    sqlx::query("DELETE FROM webhook_deliveries WHERE endpoint_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM webhook_endpoints WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    log_ok(conn, user, "endpoint.deleted", id, json!({})).await;
    Ok(json!({"deleted": true}))
}

pub async fn rotate_secret(
    conn: &mut PgConnection,
    sender: &Sender,
    id: i32,
    user: i32,
) -> Result<Value, EndpointError> {
    let k = key(sender)?;
    find(conn, id).await?;
    let secret = generate_webhook_secret();
    let row = sqlx::query(concat!(
        "UPDATE webhook_endpoints SET secret_enc = $2, updated_at = now() WHERE id = $1 RETURNING ",
        cols!(),
        ""
    ))
    .bind(id)
    .bind(encrypt_secret(&secret, &k))
    .fetch_one(&mut *conn)
    .await?;
    log_ok(conn, user, "endpoint.secret_rotated", id, json!({})).await;
    let mut v = view(&row)?;
    v["secret"] = json!(secret);
    Ok(v)
}

/// Gửi sự kiện `ping` ĐỒNG BỘ, một lần, không thử lại, không tính vào bộ đếm lỗi liên tiếp.
pub async fn test(conn: &mut PgConnection, sender: &Sender, id: i32, user: i32) -> Result<Value, EndpointError> {
    key(sender)?;
    let ep = find(conn, id).await?;
    let delivery_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let data = json!({"message": "Trinity webhook test"});
    // `next_attempt_at` xa ⇒ worker không bao giờ nhận dòng ping (gửi đồng bộ ngay dưới).
    sqlx::query(
        "INSERT INTO webhook_deliveries (id, endpoint_id, event_type, payload, attempts, created_at, next_attempt_at) \
         VALUES ($1::uuid, $2, 'ping', $3::text::jsonb, 1, $4, $4 + interval '1 day')",
    )
    .bind(&delivery_id)
    .bind(id)
    .bind(data.to_string())
    .bind(now)
    .execute(&mut *conn)
    .await?;
    let target = SendTarget {
        endpoint_id: id,
        url: ep.try_get("url")?,
        secret_enc: ep.try_get("secret_enc")?,
        created_by: user,
    };
    let item = SendItem {
        delivery_id: delivery_id.clone(),
        event_type: "ping".into(),
        data,
        created_at: now,
        attempt: 1,
    };
    let res = sender.send(conn, &target, &item).await;
    sqlx::query(
        "UPDATE webhook_deliveries SET status = $2, delivered_at = CASE WHEN $3 THEN now() END, last_status_code = $4, last_error = $5 \
         WHERE id = $1::uuid",
    )
    .bind(&delivery_id)
    .bind(if res.ok { "success" } else { "dead" })
    .bind(res.ok)
    .bind(res.status_code)
    .bind(res.error.as_deref())
    .execute(&mut *conn)
    .await?;
    sqlx::query(if res.ok {
        "UPDATE webhook_endpoints SET last_success_at = now(), updated_at = now() WHERE id = $1"
    } else {
        "UPDATE webhook_endpoints SET last_failure_at = now(), updated_at = now() WHERE id = $1"
    })
    .bind(id)
    .execute(&mut *conn)
    .await?;
    log_ok(conn, user, "endpoint.tested", id, json!({"ok": res.ok})).await;
    Ok(
        json!({"delivery_id": delivery_id, "ok": res.ok, "status_code": res.status_code, "error": res.error, "duration_ms": res.duration_ms}),
    )
}

async fn cancel_pending(conn: &mut PgConnection, endpoint_id: i32, reason: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE webhook_deliveries SET status = 'dead', last_error = $2 WHERE endpoint_id = $1 AND status IN ('pending', 'failed')")
        .bind(endpoint_id)
        .bind(reason)
        .execute(conn)
        .await?;
    Ok(())
}

/// Gửi lại một lượt đã lỗi hoặc đã dừng: về `pending`, `attempts = 0`.
pub async fn retry_delivery(conn: &mut PgConnection, delivery_id: &str, user: i32) -> Result<Value, EndpointError> {
    let id = uuid::Uuid::parse_str(delivery_id)
        .map_err(|_| EndpointError::BadRequest("Validation failed (uuid is expected)".into()))?;
    let d = sqlx::query("SELECT endpoint_id, event_type, status FROM webhook_deliveries WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| EndpointError::NotFound("Không tìm thấy lượt gửi".into()))?;
    let (endpoint_id, event_type, status): (i32, String, String) = (
        d.try_get("endpoint_id")?,
        d.try_get("event_type")?,
        d.try_get("status")?,
    );
    if event_type == "ping" {
        return Err(EndpointError::BadRequest("Không gửi lại sự kiện thử (ping)".into()));
    }
    if status != "failed" && status != "dead" {
        return Err(EndpointError::Conflict("Chỉ gửi lại được lượt đã lỗi/đã dừng".into()));
    }
    let ep = find(conn, endpoint_id).await?;
    if !ep.try_get::<bool, _>("is_active")? {
        return Err(EndpointError::Conflict(
            "Endpoint đang tắt — bật lại trước khi gửi lại".into(),
        ));
    }
    let n = sqlx::query(
        "UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL \
         WHERE id = $1 AND status IN ('failed', 'dead')",
    )
    .bind(id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(EndpointError::Conflict("Lượt gửi vừa được xử lý".into()));
    }
    log_ok(
        conn,
        user,
        "delivery.retry",
        endpoint_id,
        json!({"delivery_id": delivery_id}),
    )
    .await;
    Ok(json!({"id": delivery_id, "status": "pending"}))
}
