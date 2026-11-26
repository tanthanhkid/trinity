//! Nhật ký gửi (`GET /integrations/webhooks/deliveries`). KHÔNG trả `payload`: nó chứa dữ liệu khách theo quyền của CHỦ THỂ,
//! người xem có thể thấp quyền hơn.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{PgConnection, Row};

pub fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn encode(at: DateTime<Utc>, id: &str) -> String {
    format!("{}.{id}", at.timestamp_millis())
}

/// Cursor `<epochMs>.<uuid>`; uuid viết thường 36 ký tự hex và `-` như Node.
fn decode(c: &str) -> Option<(DateTime<Utc>, uuid::Uuid)> {
    let (ms, id) = c.split_once('.')?;
    if ms.is_empty() || ms.len() > 15 || !ms.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if id.len() != 36
        || !id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-')
    {
        return None;
    }
    Some((
        DateTime::from_timestamp_millis(ms.parse().ok()?)?,
        uuid::Uuid::parse_str(id).ok()?,
    ))
}

#[derive(Debug, Clone, Default)]
pub struct DeliveryQuery {
    pub endpoint_id: Option<i32>,
    /// `pending`, `success`, `failed` hoặc `dead`.
    pub status: Option<String>,
    pub event_type: Option<String>,
    pub cursor: Option<String>,
    /// 1..=100, mặc định 30.
    pub limit: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum DeliveryError {
    #[error("cursor không hợp lệ")]
    InvalidCursor,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

/// `{ data, next_cursor }` (route bọc thành `{ data, meta: { next_cursor } }`).
pub async fn list(conn: &mut PgConnection, q: &DeliveryQuery) -> Result<(Vec<Value>, Option<String>), DeliveryError> {
    let limit = q.limit.unwrap_or(30).clamp(1, 100);
    let cur = match q.cursor.as_deref() {
        Some(c) => Some(decode(c).ok_or(DeliveryError::InvalidCursor)?),
        None => None,
    };
    let rows = sqlx::query(
        "SELECT id::text AS id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at, last_status_code, \
                last_error, created_at, delivered_at \
         FROM webhook_deliveries \
         WHERE ($1::int IS NULL OR endpoint_id = $1) AND ($2::text IS NULL OR status = $2) \
           AND ($3::text IS NULL OR event_type = $3) \
           AND ($4::timestamptz IS NULL OR created_at < $4 OR (created_at = $4 AND id < $5)) \
         ORDER BY created_at DESC, id DESC LIMIT $6",
    )
    .bind(q.endpoint_id)
    .bind(q.status.as_deref())
    .bind(q.event_type.as_deref())
    .bind(cur.map(|c| c.0))
    .bind(cur.map(|c| c.1))
    .bind(limit + 1)
    .fetch_all(conn)
    .await?;
    let take = usize::try_from(limit).unwrap_or(30);
    let mut data = Vec::with_capacity(take);
    let mut last = None;
    for r in rows.iter().take(take) {
        let id: String = r.try_get("id")?;
        let created: DateTime<Utc> = r.try_get("created_at")?;
        last = Some((created, id.clone()));
        data.push(json!({
            "id": id,
            "endpoint_id": r.try_get::<i32, _>("endpoint_id")?,
            "event_id": r.try_get::<Option<i64>, _>("event_id")?.map(|n| n.to_string()),
            "event_type": r.try_get::<String, _>("event_type")?,
            "status": r.try_get::<String, _>("status")?,
            "attempts": r.try_get::<i32, _>("attempts")?,
            "next_attempt_at": iso(r.try_get("next_attempt_at")?),
            "last_status_code": r.try_get::<Option<i32>, _>("last_status_code")?,
            "last_error": r.try_get::<Option<String>, _>("last_error")?,
            "created_at": iso(created),
            "delivered_at": r.try_get::<Option<DateTime<Utc>>, _>("delivered_at")?.map(iso),
        }));
    }
    let next = if rows.len() > take {
        last.map(|(a, i)| encode(a, &i))
    } else {
        None
    };
    Ok((data, next))
}
