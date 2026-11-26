//! Nhật ký tích hợp (`integration_audit_logs`): ghi có lọc, đọc mới → cũ phân trang cursor.
//! Bản Node: `packages/prisma/src/integrations/{integration-audit.service,audit-sanitize}.ts`.

use std::sync::OnceLock;

use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Row};

pub const MAX_STRING: usize = 300;
pub const MAX_ERROR: usize = 500;
const MAX_DEPTH: usize = 4;
const MAX_KEYS: usize = 30;
const MAX_ITEMS: usize = 20;
const REDACTED: &str = "[redacted]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Mcp,
    WebhookOut,
    WebhookIn,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::WebhookOut => "webhook_out",
            Self::WebhookIn => "webhook_in",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "mcp" => Some(Self::Mcp),
            "webhook_out" => Some(Self::WebhookOut),
            "webhook_in" => Some(Self::WebhookIn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditStatus {
    Ok,
    Denied,
    Error,
}

impl AuditStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Denied => "denied",
            Self::Error => "error",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ok" => Some(Self::Ok),
            "denied" => Some(Self::Denied),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

// ---- Lọc dữ liệu trước khi ghi ----------------------------------------------------------------------------------

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("regex hợp lệ"))
}

fn secret_key(k: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i-u)(secret|token|password|passwd|authorization|api[_-]?key|signature|cookie|credential|verifier|private)",
    )
    .is_match(k)
}

fn phone_key(k: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i-u)(phone|sdt|mobile|msisdn|tel$)").is_match(k)
}

/// `0912345678` thành `***678`.
fn mask_digits(raw: &str) -> String {
    let digits: Vec<char> = raw.chars().filter(char::is_ascii_digit).collect();
    let tail: String = digits[digits.len().saturating_sub(3)..].iter().collect();
    format!("***{tail}")
}

/// Cắt theo đơn vị UTF-16 như `String.prototype.slice` của JS (độ dài cột theo cùng cách đếm).
fn slice_utf16(s: &str, max: usize) -> Option<String> {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return Some(s[..i].to_owned());
        }
    }
    None
}

/// Che SĐT (dãy từ 9 chữ số), `Bearer <token>` và chuỗi token dài; cắt còn `max` đơn vị UTF-16 kèm `…`.
pub fn sanitize_text(input: &str, max: usize) -> String {
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static DIGITS: OnceLock<Regex> = OnceLock::new();
    static LONG: OnceLock<Regex> = OnceLock::new();
    let s = re(&BEARER, r"(?i-u:bearer)\s+[A-Za-z0-9._~+/=-]+").replace_all(input, format!("Bearer {REDACTED}"));
    let s = re(&DIGITS, r"\+?[0-9][0-9\s.\-]{7,}[0-9]").replace_all(&s, |c: &regex::Captures<'_>| {
        let m = &c[0];
        if m.chars().filter(char::is_ascii_digit).count() >= 9 {
            mask_digits(m)
        } else {
            m.to_owned()
        }
    });
    let s = re(&LONG, r"(?-u:\b)[A-Za-z0-9_-]{32,}(?-u:\b)").replace_all(&s, REDACTED);
    match slice_utf16(&s, max) {
        Some(mut cut) => {
            cut.push('…');
            cut
        }
        None => s.into_owned(),
    }
}

fn sanitize_value(key: &str, v: &Value, depth: usize) -> Value {
    if secret_key(key) {
        return Value::String(REDACTED.to_owned());
    }
    match v {
        Value::Null | Value::Bool(_) | Value::Number(_) => v.clone(),
        Value::String(s) => Value::String(if phone_key(key) {
            mask_digits(s)
        } else {
            sanitize_text(s, MAX_STRING)
        }),
        _ if depth >= MAX_DEPTH => Value::String("[truncated]".to_owned()),
        Value::Array(a) => Value::Array(
            a.iter()
                .take(MAX_ITEMS)
                .map(|x| sanitize_value(key, x, depth + 1))
                .collect(),
        ),
        Value::Object(o) => Value::Object(sanitize_object(o, depth + 1)),
    }
}

fn sanitize_object(o: &Map<String, Value>, depth: usize) -> Map<String, Value> {
    o.iter()
        .take(MAX_KEYS)
        .map(|(k, v)| (k.clone(), sanitize_value(k, v, depth)))
        .collect()
}

/// `metadata` an toàn để lưu: luôn là object JSON thuần (không phải object ⇒ `{}`).
pub fn sanitize_metadata(meta: Option<&Value>) -> Value {
    match meta {
        Some(Value::Object(o)) => Value::Object(sanitize_object(o, 0)),
        _ => json!({}),
    }
}

// ---- Ghi ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub channel: Channel,
    /// Tên tool, sự kiện hoặc hành động.
    pub action: String,
    pub status: AuditStatus,
    pub client_id: Option<String>,
    pub user_id: Option<i32>,
    pub resource: Option<String>,
    pub resource_id: Option<String>,
    pub http_status: Option<i64>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
    /// Sẽ bị lọc.
    pub metadata: Option<Value>,
}

impl AuditEntry {
    pub fn new(channel: Channel, action: &str, status: AuditStatus) -> Self {
        Self {
            channel,
            action: action.to_owned(),
            status,
            client_id: None,
            user_id: None,
            resource: None,
            resource_id: None,
            http_status: None,
            duration_ms: None,
            error: None,
            metadata: None,
        }
    }
}

fn cut(v: Option<&str>, max: usize) -> Option<String> {
    v.filter(|s| !s.is_empty())
        .map(|s| slice_utf16(s, max).unwrap_or_else(|| s.to_owned()))
}

fn clamp_int(v: Option<i64>) -> Option<i32> {
    v.map(|n| i32::try_from(n.clamp(0, 2_147_483_647)).unwrap_or(i32::MAX))
}

/// Ghi nhật ký. KHÔNG BAO GIỜ trả lỗi cho người gọi: nhật ký hỏng không được làm hỏng lời gọi MCP/webhook.
/// Lỗi chỉ vào log máy chủ (không kèm payload). Nên gọi trên kết nối riêng, không phải giao dịch nghiệp vụ: một câu
/// lỗi trong giao dịch sẽ làm hỏng cả giao dịch.
pub async fn log(conn: &mut PgConnection, e: &AuditEntry) {
    let res = sqlx::query(
        "INSERT INTO integration_audit_logs \
         (channel, client_id, user_id, action, resource, resource_id, status, http_status, duration_ms, error, metadata) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb)",
    )
    .bind(e.channel.as_str())
    .bind(cut(e.client_id.as_deref(), 255))
    .bind(e.user_id)
    .bind(slice_utf16(&e.action, 128).unwrap_or_else(|| e.action.clone()))
    .bind(cut(e.resource.as_deref(), 64))
    .bind(cut(e.resource_id.as_deref(), 64))
    .bind(e.status.as_str())
    .bind(clamp_int(e.http_status))
    .bind(clamp_int(e.duration_ms))
    .bind(e.error.as_deref().filter(|s| !s.is_empty()).map(|s| sanitize_text(s, MAX_ERROR)))
    .bind(trinity_kernel::json::js_json(&sanitize_metadata(e.metadata.as_ref())))
    .execute(conn)
    .await;
    if let Err(err) = res {
        tracing::warn!(
            "integration audit log failed ({}/{}): {err}",
            e.channel.as_str(),
            e.action
        );
    }
}

// ---- Đọc ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct AuditQuery {
    pub channel: Option<Channel>,
    pub status: Option<AuditStatus>,
    pub user_id: Option<i32>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    /// `next_cursor` của trang trước.
    pub cursor: Option<String>,
    /// 1..=100, mặc định 50 (ngoài khoảng thì kẹp, như bản Node).
    pub limit: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    #[error("cursor không hợp lệ")]
    InvalidCursor,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

/// Cursor `"<epochMs>.<id>"`, cùng định dạng với bản Node (Node phát, Rust nhận và ngược lại).
pub fn encode_cursor(created_at: DateTime<Utc>, id: i64) -> String {
    format!("{}.{id}", created_at.timestamp_millis())
}

pub fn decode_cursor(c: &str) -> Option<(DateTime<Utc>, i64)> {
    let (ms, id) = c.split_once('.')?;
    let digits = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(ms, 15) || !digits(id, 19) {
        return None;
    }
    Some((DateTime::from_timestamp_millis(ms.parse().ok()?)?, id.parse().ok()?))
}

/// Danh sách mới → cũ (khoá `created_at DESC, id DESC`), `{ data, meta: { next_cursor } }`.
pub async fn list(conn: &mut PgConnection, q: &AuditQuery) -> Result<Value, AuditError> {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let cur = match q.cursor.as_deref() {
        Some(c) => Some(decode_cursor(c).ok_or(AuditError::InvalidCursor)?),
        None => None,
    };
    let rows = sqlx::query(
        "SELECT id, created_at, channel, client_id, user_id, action, resource, resource_id, status, http_status, \
                duration_ms, error, metadata \
         FROM integration_audit_logs \
         WHERE ($1::text IS NULL OR channel = $1) \
           AND ($2::text IS NULL OR status = $2) \
           AND ($3::int IS NULL OR user_id = $3) \
           AND ($4::timestamptz IS NULL OR created_at >= $4) \
           AND ($5::timestamptz IS NULL OR created_at <= $5) \
           AND ($6::timestamptz IS NULL OR created_at < $6 OR (created_at = $6 AND id < $7)) \
         ORDER BY created_at DESC, id DESC LIMIT $8",
    )
    .bind(q.channel.map(Channel::as_str))
    .bind(q.status.map(AuditStatus::as_str))
    .bind(q.user_id)
    .bind(q.from)
    .bind(q.to)
    .bind(cur.map(|c| c.0))
    .bind(cur.map_or(0, |c| c.1))
    .bind(limit + 1)
    .fetch_all(conn)
    .await?;
    let take = usize::try_from(limit).unwrap_or(50);
    let mut data = Vec::with_capacity(take);
    let mut last: Option<(DateTime<Utc>, i64)> = None;
    for r in rows.iter().take(take) {
        let id: i64 = r.try_get("id")?;
        let at: DateTime<Utc> = r.try_get("created_at")?;
        last = Some((at, id));
        data.push(json!({
            "id": id.to_string(),
            "created_at": at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "channel": r.try_get::<String, _>("channel")?,
            "client_id": r.try_get::<Option<String>, _>("client_id")?,
            "user_id": r.try_get::<Option<i32>, _>("user_id")?,
            "action": r.try_get::<String, _>("action")?,
            "resource": r.try_get::<Option<String>, _>("resource")?,
            "resource_id": r.try_get::<Option<String>, _>("resource_id")?,
            "status": r.try_get::<String, _>("status")?,
            "http_status": r.try_get::<Option<i32>, _>("http_status")?,
            "duration_ms": r.try_get::<Option<i32>, _>("duration_ms")?,
            "error": r.try_get::<Option<String>, _>("error")?,
            "metadata": r.try_get::<Value, _>("metadata")?,
        }));
    }
    let next = if rows.len() > take {
        last.map(|(a, i)| encode_cursor(a, i))
    } else {
        None
    };
    Ok(json!({ "data": data, "meta": { "next_cursor": next } }))
}
