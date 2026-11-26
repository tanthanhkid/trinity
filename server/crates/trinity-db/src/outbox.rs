//! Cổng sự kiện tích hợp (outbox) và thông báo dùng chung (K36). Mọi module Rust ghi sự kiện/thông báo qua đây, không tự
//! viết lại (PLAN mục 4.1): hai bản lệch nhau là rủi ro 23.
//!
//! - [`publish_integration_event`]: tương đương `publishIntegrationEvent` của bản Node — một dòng `integration_events` trên
//!   CHÍNH giao dịch nghiệp vụ (rollback ⇒ không có sự kiện ảo; commit ⇒ chắc chắn có). Loại sự kiện kiểm theo
//!   `server/contracts/events.json` (nguồn là `event-catalog.ts`). Bộ phát webhook của Node đọc bảng này ở lượt tick kế
//!   (10 giây, như hiện tại); không có "đá" (PLAN, N-7).
//! - [`create_notification`]: tương đương `createPendingLogs` — dòng `notification_logs` kênh `in_app`, `status = 'sent'`,
//!   rồi tin `NOTIFY bell` (cùng giao dịch ⇒ chỉ phát khi commit; xem [`crate::sync`]).

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::OnceLock;

use serde_json::Value;
use sqlx::{PgConnection, Row};

use crate::TenantTx;

use crate::sync::{self, SyncError};

const EVENTS_JSON: &str = include_str!("../../../contracts/events.json");

/// Danh mục sự kiện: loại → resource.
fn catalog() -> &'static HashMap<String, String> {
    static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let v: Value = serde_json::from_str(EVENTS_JSON).expect("events.json hợp lệ");
        v["events"]
            .as_array()
            .expect("events.json có mảng events")
            .iter()
            .map(|e| {
                (
                    e["type"].as_str().unwrap_or_default().to_owned(),
                    e["resource"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect()
    })
}

/// Resource của một loại sự kiện (`None` nếu loại không có trong danh mục).
pub fn event_resource(event_type: &str) -> Option<&'static str> {
    catalog().get(event_type).map(String::as_str)
}

#[derive(Debug, thiserror::Error)]
pub enum OutboxError {
    #[error("loại sự kiện tích hợp không có trong danh mục: {0}")]
    UnknownEvent(String),
    #[error("action_url phải là đường dẫn tương đối bắt đầu bằng /: {0}")]
    InvalidActionUrl(String),
    #[error("resource_id dài quá 64 ký tự")]
    ResourceIdTooLong,
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Sync(#[from] SyncError),
}

/// Ghi một dòng outbox. Gọi với giao dịch của chính việc ghi dữ liệu nghiệp vụ. Không nuốt lỗi (như Node).
/// `payload` đã ở dạng JSON thuần: số lớn (BigInt) là chuỗi, ngày là chuỗi ISO — người gọi dựng đúng như `toJsonValue`.
/// Ghi bằng serializer của kernel ([`trinity_kernel::json::js_json`]): số in như `JSON.stringify` (`1.0` → `1`), nên dòng
/// giống bản Node. Khác biệt đã biết: engine của Prisma làm tròn số thực có trên 15 chữ số có nghĩa (vd `106.66009616851807`
/// thành `106.6600961685181`); Rust giữ nguyên giá trị. Payload sự kiện hiện chỉ mang số nguyên, chuỗi, ngày ISO.
pub async fn publish_integration_event(
    conn: &mut PgConnection,
    event_type: &str,
    payload: &Value,
    resource_id: impl Display,
    actor_user_id: Option<i32>,
) -> Result<(), OutboxError> {
    let resource = event_resource(event_type).ok_or_else(|| OutboxError::UnknownEvent(event_type.to_owned()))?;
    let resource_id = resource_id.to_string();
    if resource_id.chars().count() > 64 {
        return Err(OutboxError::ResourceIdTooLong);
    }
    sqlx::query(
        "INSERT INTO integration_events (event_type, resource, resource_id, payload, actor_user_id) VALUES ($1, $2, $3, $4::text::jsonb, $5)",
    )
    .bind(event_type)
    .bind(resource)
    .bind(resource_id)
    .bind(trinity_kernel::json::js_json(payload))
    .bind(actor_user_id)
    .execute(conn)
    .await?;
    Ok(())
}

/// Một thông báo trong chuông (kênh `in_app`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewNotification {
    pub recipient_id: i32,
    pub event_type: String,
    pub title: String,
    pub body: String,
    /// Đường dẫn tương đối bắt đầu bằng `/` (như luật của DTO bản Node), hoặc `None`.
    pub action_url: Option<String>,
}

/// Dòng đã tạo, đủ dữ liệu để bên gọi đẩy socket NỘI BỘ sau khi commit (cùng thông tin `WsEmitItem` của bản Node + `log_id`).
/// Tin `NOTIFY bell` bị lọc khỏi chính tiến trình phát, nên socket trong tiến trình này do bên gọi tự đẩy từ dữ liệu này;
/// các tiến trình khác nhận qua `NOTIFY` và đọc nội dung từ DB theo id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedNotification {
    pub id: i32,
    pub recipient_id: i32,
    pub event_type: String,
    pub title: String,
    pub body: String,
    pub action_url: Option<String>,
}

/// Tạo thông báo cho nhiều người (một câu INSERT, kết quả theo đúng thứ tự `items`) rồi phát `NOTIFY bell` kèm id dòng. Công
/// ty lấy từ giao dịch (`tx.company()`). Tin chỉ phát khi giao dịch commit. Việc gửi tin KHÔNG làm hỏng giao dịch nghiệp
/// vụ: chạy trong savepoint, lỗi chỉ ghi log (người dùng vẫn thấy thông báo ở lần tải sau; cache có TTL). Danh sách rỗng ⇒ không làm gì.
pub async fn create_notification(
    tx: &mut TenantTx,
    items: &[NewNotification],
) -> Result<Vec<CreatedNotification>, OutboxError> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    for it in items {
        if let Some(u) = it
            .action_url
            .as_deref()
            .filter(|u| !u.starts_with('/') || u.starts_with("//") || u.starts_with("/\\"))
        {
            return Err(OutboxError::InvalidActionUrl(u.to_owned()));
        }
    }
    let company = i64::from(tx.company().id());
    let recipients: Vec<i32> = items.iter().map(|i| i.recipient_id).collect();
    let events: Vec<&str> = items.iter().map(|i| i.event_type.as_str()).collect();
    let titles: Vec<&str> = items.iter().map(|i| i.title.as_str()).collect();
    let bodies: Vec<&str> = items.iter().map(|i| i.body.as_str()).collect();
    let urls: Vec<Option<&str>> = items.iter().map(|i| i.action_url.as_deref()).collect();
    // RETURNING không thấy cột nguồn (`ord`); câu INSERT … ORDER BY ord cấp id tăng dần theo thứ tự đó, nên sắp theo id là thứ tự đầu vào.
    let mut rows = sqlx::query(
        "INSERT INTO notification_logs (recipient_id, event_type, channel, title, body, status, sent_at, action_url)
         SELECT r, e, 'in_app', t, b, 'sent', now(), u
         FROM unnest($1::int4[], $2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS x(r, e, t, b, u, ord)
         ORDER BY ord
         RETURNING id",
    )
    .bind(&recipients)
    .bind(&events)
    .bind(&titles)
    .bind(&bodies)
    .bind(&urls)
    .fetch_all(&mut **tx)
    .await?
    .iter()
    .map(|r| r.get::<i32, _>("id"))
    .collect::<Vec<_>>();
    rows.sort_unstable();
    let created: Vec<CreatedNotification> = rows
        .iter()
        .zip(items)
        .map(|(id, it)| CreatedNotification {
            id: *id,
            recipient_id: it.recipient_id,
            event_type: it.event_type.clone(),
            title: it.title.clone(),
            body: it.body.clone(),
            action_url: it.action_url.clone(),
        })
        .collect();
    let ids: Vec<i32> = created.iter().map(|c| c.id).collect();
    sync::publish_bell_best_effort(tx, company, &recipients, &ids).await;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn danh_muc_du_25_loai() {
        assert_eq!(catalog().len(), 25);
        // G07b gỡ cổng thanh toán: `payment.received` không còn trong danh mục.
        assert_eq!(event_resource("payment.received"), None);
        assert_eq!(event_resource("contact.created"), Some("contact"));
        assert_eq!(event_resource("pos.order.completed"), Some("pos_order"));
        assert_eq!(event_resource("store_order.status_changed"), Some("store_order"));
        assert_eq!(event_resource("khong.co"), None);
    }
}
