//! Sự kiện nội bộ (2 endpoint `/api/v1/events`, `Internal` = header `X-Service-Secret`): `payslip-approved` và
//! `notify-ws-emit`. Bản TS: `subscribers/subscribers.service.ts`.
//!
//! Chiều tạo thông báo từ module khác dùng `trinity_db::outbox::create_notification` (K36); `notify-ws-emit` còn giữ cho
//! client ngoài tiến trình (bản Node nhận lời gọi HTTP từ CRM tách rời).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use trinity_db::TenantDb;
use trinity_kernel::number::format_vn_number;
use trinity_realtime::NotificationPayload;

use crate::delivery::Deliverer;
use crate::notifications::{Channel, SendNotification, send};
use crate::templates::render_by_event_type;

/// `payload` của `POST /events/payslip-approved` (camelCase như bản TS).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipApproved {
    pub payslip_id: i32,
    pub user_id: i32,
    pub month: String,
    #[serde(default)]
    pub total_amount: f64,
}

/// Body `POST /events/payslip-approved`.
#[derive(Debug, Clone, Deserialize)]
pub struct PayslipApprovedDto {
    pub payload: PayslipApproved,
}

/// Một dòng `notify-ws-emit` (đã nằm trong `notification_logs`, status `sent`).
#[derive(Debug, Clone, Deserialize)]
pub struct WsEmitItem {
    pub recipient_id: i32,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub action_url: Option<String>,
    #[serde(default)]
    pub log_id: Option<i32>,
}

/// Body `POST /events/notify-ws-emit`.
#[derive(Debug, Clone, Deserialize)]
pub struct WsEmitDto {
    pub items: Vec<WsEmitItem>,
}

fn default_title(event_type: &str) -> &'static str {
    match event_type {
        "payslip.approved" => "Phiếu lương đã duyệt",
        _ => "Thông báo mới",
    }
}

fn default_body(event_type: &str, data: &Value) -> String {
    match event_type {
        "payslip.approved" => format!(
            "Phiếu lương tháng {}: {} VNĐ",
            data["month"].as_str().unwrap_or(""),
            format_vn_number(data["totalAmount"].as_f64().unwrap_or(0.0))
        ),
        _ => trinity_kernel::json::js_json(data),
    }
}

/// Một sự kiện cần thông báo tới nhiều người qua nhiều kênh.
#[derive(Debug, Clone, Copy)]
pub struct Event<'a> {
    pub recipients: &'a [i32],
    pub event_type: &'a str,
    pub entity_id: i32,
    pub channels: &'a [Channel],
    pub data: &'a Value,
}

/// Gửi tới từng người nhận qua các kênh: render mẫu đang bật của `(event_type, kênh)`; mẫu hỏng (cú pháp lưu từ trước)
/// không làm chết handler, rơi về nội dung mặc định. Lỗi của từng người nhận chỉ ghi log.
pub async fn send_to_recipients(t: &TenantDb, d: &Deliverer, event: &Event<'_>, now: DateTime<Utc>) {
    let Event {
        recipients,
        event_type,
        entity_id,
        channels,
        data,
    } = *event;
    for &channel in channels {
        let rendered = render_by_event_type(t, event_type, channel, data)
            .await
            .unwrap_or_else(|e| {
                tracing::error!("Render template {event_type}/{} lỗi: {e:?}", channel.as_str());
                None
            });
        let title = rendered
            .as_ref()
            .and_then(|r| r.subject.clone())
            .unwrap_or_else(|| default_title(event_type).to_owned());
        let body = rendered.map_or_else(|| default_body(event_type, data), |r| r.body);
        for &user_id in recipients {
            let dto = SendNotification {
                user_id,
                channel,
                title: title.clone(),
                body: body.clone(),
                template_id: None,
                event_type: Some(event_type.to_owned()),
                entity_id: Some(entity_id),
                action_url: None,
                scheduled_at: None,
                metadata: None,
            };
            if let Err(e) = send(t, d, &dto, now).await {
                tracing::error!("Failed to notify user {user_id}: {e:?}");
            }
        }
    }
}

/// `POST /events/payslip-approved` (200, không body): thông báo in-app cho người có phiếu. `send` có dedup theo sự kiện +
/// người nhận + nội dung nên tin lặp không tạo thông báo thứ hai.
pub async fn on_payslip_approved(t: &TenantDb, d: &Deliverer, p: &PayslipApproved, now: DateTime<Utc>) {
    let data = json!({ "payslipId": p.payslip_id, "month": p.month, "totalAmount": p.total_amount });
    let event = Event {
        recipients: &[p.user_id],
        event_type: "payslip.approved",
        entity_id: p.payslip_id,
        channels: &[Channel::InApp],
        data: &data,
    };
    send_to_recipients(t, d, &event, now).await;
}

/// Kết quả `notify-ws-emit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Emitted {
    pub emitted: usize,
}

/// `POST /events/notify-ws-emit`: đẩy `notification:new` cho các dòng đã ghi sẵn trong `notification_logs`, báo tiến trình khác
/// TRƯỚC (lỗi đếm cục bộ không làm mất chuông bên kia; nội dung bên kia đọc từ DB theo id), rồi số chưa đọc của từng người.
pub async fn emit_ws_notifications(t: &TenantDb, d: &Deliverer, items: &[WsEmitItem]) -> Emitted {
    if items.is_empty() {
        return Emitted { emitted: 0 };
    }
    let company = i64::from(t.company().id());
    let mut users: Vec<i32> = items.iter().map(|i| i.recipient_id).collect();
    users.dedup();
    let mut seen = std::collections::HashSet::new();
    users.retain(|u| seen.insert(*u));
    let ids: Vec<i32> = items.iter().filter_map(|i| i.log_id).collect();
    // Các dòng đã nằm trong DB; lỗi phát tin cho tiến trình khác chỉ ghi log, không làm request 500.
    let bell = async {
        let mut tx = t.begin().await.map_err(|e| e.to_string())?;
        trinity_db::sync::publish_bell_best_effort(&mut tx, company, &users, &ids).await;
        tx.commit().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = bell {
        tracing::warn!("notify-ws-emit: không phát được tin bell: {e}");
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    for it in items {
        let payload = NotificationPayload {
            id: it.log_id,
            title: it.title.clone(),
            body: it.body.clone(),
            channel: "in_app".to_owned(),
            event_type: it.event_type.clone(),
            action_url: it.action_url.clone(),
            is_read: false,
            created_at: now.clone(),
        };
        d.sink.send(company, i64::from(it.recipient_id), &payload).await;
    }
    for u in &users {
        d.sink.refresh_unread(company, i64::from(*u)).await;
    }
    tracing::info!(
        "emitWsNotifications: emitted {} WS events for {} recipients",
        items.len(),
        users.len()
    );
    Emitted { emitted: items.len() }
}
