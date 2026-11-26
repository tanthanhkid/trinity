//! Phân phối theo kênh (`delivery.service.ts` và `channels/*`): in-app (socket), push (chưa tích hợp ⇒ `skipped`), webhook
//! (qua lớp chống SSRF K35). Thử lại tối đa 3 lần với lùi 1 s, 4 s (`4^attempt × 250 ms`); lỗi vĩnh viễn (URL bị chặn, kênh chưa
//! tích hợp) không thử lại. Không giữ kết nối pool khi chờ mạng: mỗi câu lệnh tự lấy rồi trả kết nối.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde_json::Value;
use trinity_db::TenantDb;
use trinity_db::pg_error::app_error;
use trinity_http::outbound::ssrf::{SsrfPolicy, SystemResolver, parse_target_url, safe_client};
use trinity_kernel::error::AppError;
use trinity_realtime::{NotifSocket, NotificationPayload};

use crate::notifications::{Channel, SendNotification};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Lý do kênh push không gửi (chưa có lời gọi FCM nào).
pub const PUSH_NOT_CONFIGURED: &str = "Push (FCM) chua duoc tich hop - thong bao khong duoc gui qua push";
/// Thời gian chờ cứng của một lần POST webhook.
pub const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(5);
/// Số lần thử tối đa của một thông báo.
pub const MAX_ATTEMPTS: u32 = 3;

/// Kết quả một lần gửi qua kênh.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeliveryResult {
    pub success: bool,
    pub error: Option<String>,
    /// Kênh chưa cấu hình: không gửi, không thử lại, ghi `skipped`.
    pub skipped: bool,
    /// `false` = lỗi vĩnh viễn, thử lại vô ích.
    pub non_retryable: bool,
}

impl DeliveryResult {
    fn ok() -> Self {
        Self {
            success: true,
            ..Self::default()
        }
    }

    fn fail(error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::default()
        }
    }

    fn permanent(error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            non_retryable: true,
            ..Self::default()
        }
    }
}

/// Đẩy tới socket của tiến trình này (cổng `trinity-realtime`, hoặc bản ghi lại trong test).
pub trait InAppSink: Send + Sync {
    /// `notification:new` tới user.
    fn send<'a>(&'a self, company: i64, user: i64, payload: &'a NotificationPayload) -> BoxFuture<'a, ()>;
    /// Tính lại 3 số chưa đọc từ DB rồi `notification:count`.
    fn refresh_unread<'a>(&'a self, company: i64, user: i64) -> BoxFuture<'a, ()>;
}

/// POST JSON tới URL webhook (đã qua kiểm cú pháp). Trả mã HTTP.
pub trait WebhookPoster: Send + Sync {
    fn post<'a>(&'a self, url: &'a str, payload: String) -> BoxFuture<'a, Result<u16, String>>;
}

/// [`InAppSink`] thật: socket `/notif-ws`.
pub struct RealtimeSink {
    pub socket: NotifSocket,
    pub db: trinity_db::Db,
}

impl InAppSink for RealtimeSink {
    fn send<'a>(&'a self, company: i64, user: i64, payload: &'a NotificationPayload) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.socket.send_to_user(company, user, payload).await })
    }

    fn refresh_unread<'a>(&'a self, company: i64, user: i64) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.socket.refresh_unread(&self.db, company, user).await })
    }
}

/// [`WebhookPoster`] thật: client `reqwest` có bộ phân giải DNS chống SSRF, không theo chuyển hướng, không dùng proxy.
pub struct SafeWebhookPoster {
    client: reqwest::Client,
}

impl SafeWebhookPoster {
    pub fn new(policy: SsrfPolicy) -> reqwest::Result<Self> {
        Ok(Self {
            client: safe_client(policy, Arc::new(SystemResolver), WEBHOOK_TIMEOUT)?,
        })
    }
}

impl WebhookPoster for SafeWebhookPoster {
    fn post<'a>(&'a self, url: &'a str, payload: String) -> BoxFuture<'a, Result<u16, String>> {
        Box::pin(async move {
            let res = self
                .client
                .post(url)
                .header("Content-Type", "application/json")
                .timeout(WEBHOOK_TIMEOUT)
                .body(payload)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            Ok(res.status().as_u16())
        })
    }
}

/// Điểm phân phối dùng chung của module.
pub struct Deliverer {
    pub sink: Arc<dyn InAppSink>,
    pub poster: Arc<dyn WebhookPoster>,
    pub policy: SsrfPolicy,
    /// Đơn vị lùi (bản TS: 250 ms); test đặt 0.
    pub retry_unit: Duration,
}

impl Deliverer {
    pub fn new(sink: Arc<dyn InAppSink>, poster: Arc<dyn WebhookPoster>, policy: SsrfPolicy) -> Self {
        Self {
            sink,
            poster,
            policy,
            retry_unit: Duration::from_millis(250),
        }
    }

    async fn in_app(&self, db: &TenantDb, user: i32, title: &str, body: &str, meta: &Meta) -> DeliveryResult {
        let payload = NotificationPayload {
            id: meta.log_id,
            title: title.to_owned(),
            body: body.to_owned(),
            channel: "in_app".to_owned(),
            event_type: meta.event_type.clone(),
            action_url: meta.action_url.clone(),
            is_read: false,
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        self.sink
            .send(i64::from(db.company().id()), i64::from(user), &payload)
            .await;
        DeliveryResult::ok()
    }

    #[allow(clippy::unused_self)]
    fn push(&self, meta: &Meta) -> DeliveryResult {
        if meta.fcm_token.is_none() {
            return DeliveryResult::fail("Khong co FCM token");
        }
        DeliveryResult {
            error: Some(PUSH_NOT_CONFIGURED.to_owned()),
            skipped: true,
            non_retryable: true,
            ..DeliveryResult::default()
        }
    }

    async fn webhook(&self, user: i32, title: &str, body: &str, meta: &Meta) -> DeliveryResult {
        let Some(raw) = meta.webhook_url.as_deref().filter(|u| !u.is_empty()) else {
            return DeliveryResult::fail("Khong co webhook URL");
        };
        if let Err(e) = parse_target_url(raw, self.policy) {
            tracing::warn!("Webhook bi chan: {e}");
            return DeliveryResult::permanent(e.to_string());
        }
        let mut payload = serde_json::Map::new();
        payload.insert("recipient_id".into(), Value::from(user));
        payload.insert("title".into(), Value::from(title));
        payload.insert("body".into(), Value::from(body));
        payload.insert(
            "timestamp".into(),
            Value::from(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        );
        let text = trinity_kernel::json::js_json(&Value::Object(payload));
        match self.poster.post(raw, text).await {
            // Chuyển hướng (3xx) cũng là lỗi: không bao giờ đi theo.
            Ok(s) if (200..300).contains(&s) => DeliveryResult::ok(),
            Ok(s) => DeliveryResult::fail(format!("HTTP {s}")),
            Err(e) => {
                tracing::error!("Webhook failed: {e}");
                DeliveryResult::fail(e)
            }
        }
    }

    /// Gửi một lần qua kênh của `dto`.
    pub async fn send_once(&self, db: &TenantDb, log_id: i32, dto: &SendNotification) -> DeliveryResult {
        let meta = Meta {
            log_id: Some(log_id),
            event_type: dto.event_type.clone(),
            action_url: dto.action_url.clone(),
            fcm_token: dto.metadata_str("fcm_token"),
            webhook_url: dto.metadata_str("webhook_url"),
        };
        match dto.channel {
            Channel::InApp => self.in_app(db, dto.user_id, &dto.title, &dto.body, &meta).await,
            Channel::Push => self.push(&meta),
            Channel::Webhook => self.webhook(dto.user_id, &dto.title, &dto.body, &meta).await,
        }
    }

    /// `deliverWithRetry`: trả `sent`, `skipped` hoặc `failed` và ghi trạng thái vào `notification_logs`.
    pub async fn deliver_with_retry(
        &self,
        db: &TenantDb,
        log_id: i32,
        dto: &SendNotification,
    ) -> Result<&'static str, AppError> {
        let mut attempt: u32 = 1;
        loop {
            let r = self.send_once(db, log_id, dto).await;
            if r.success {
                exec(
                    db,
                    "UPDATE notification_logs SET status = 'sent', sent_at = now() WHERE id = $1",
                    log_id,
                    None,
                    None,
                )
                .await?;
                return Ok("sent");
            }
            if r.skipped {
                exec(
                    db,
                    "UPDATE notification_logs SET status = 'skipped', error = $2 WHERE id = $1",
                    log_id,
                    r.error.as_deref(),
                    None,
                )
                .await?;
                tracing::warn!("Notification {log_id} skipped: {}", r.error.as_deref().unwrap_or(""));
                return Ok("skipped");
            }
            exec(
                db,
                "UPDATE notification_logs SET retry_count = $3, error = $2 WHERE id = $1",
                log_id,
                r.error.as_deref(),
                Some(i32::try_from(attempt).unwrap_or(i32::MAX)),
            )
            .await?;
            if attempt < MAX_ATTEMPTS && !r.non_retryable {
                tokio::time::sleep(self.retry_unit * 4u32.pow(attempt)).await;
                attempt += 1;
                continue;
            }
            let error = r.error.unwrap_or_else(|| "Max retries exceeded".to_owned());
            exec(
                db,
                "UPDATE notification_logs SET status = 'failed', error = $2 WHERE id = $1",
                log_id,
                Some(&error),
                None,
            )
            .await?;
            tracing::error!("Notification {log_id} failed: {error}");
            return Ok("failed");
        }
    }
}

struct Meta {
    log_id: Option<i32>,
    event_type: Option<String>,
    action_url: Option<String>,
    fcm_token: Option<String>,
    webhook_url: Option<String>,
}

/// Một câu UPDATE ngắn trên `notification_logs`: $1 = id, $2 = chuỗi, $3 = số (tuỳ câu).
async fn exec(db: &TenantDb, sql: &'static str, id: i32, text: Option<&str>, num: Option<i32>) -> Result<(), AppError> {
    let mut conn = db.acquire().await.map_err(AppError::internal)?;
    let mut q = sqlx::query(sql).bind(id);
    if sql.contains("$2") {
        q = q.bind(text);
    }
    if sql.contains("$3") {
        q = q.bind(num);
    }
    q.execute(&mut *conn).await.map_err(|e| app_error(&e))?;
    Ok(())
}
