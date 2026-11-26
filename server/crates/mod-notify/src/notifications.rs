//! Thông báo (4 endpoint `/api/v1/notifications`): danh sách của chính mình, số chưa đọc, đánh dấu đã đọc, gửi tay; cùng
//! hàng đợi hẹn giờ (`processScheduled`) và reaper dòng kẹt. Bản TS: `notifications.service.ts`.
//!
//! Quyền: ba route đầu `AuthOnly` (chỉ thấy thông báo của chính mình, lọc theo `user_id` của JWT); `POST /send` đòi
//! `settings.integrations`. Phân trang: con trỏ kiểu Prisma `cursor: {id}` + `skip: 1` trên thứ tự `created_at DESC`
//! (cột không duy nhất): giữ ĐÚNG câu SQL Prisma sinh (`created_at <= (SELECT created_at … WHERE id = cursor)`, bỏ dòng đầu),
//! nên trang 2 cho cùng kết quả với cùng dữ liệu, kể cả chỗ trùng `created_at` (PLAN 4.4, dạng 3).
//!
//! Khác bản TS: không có cache số chưa đọc 5 phút trong bộ nhớ (đếm thẳng từ DB, luôn mới).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::TenantDb;
use trinity_db::pg_error::app_error;
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, HttpError};

use crate::delivery::Deliverer;
use crate::helpers::{MESSAGE_EVENT_TYPES, is_business_hours, next_business_start, parse_iso8601};

/// Dòng `processing` quá ngần này thì coi là kẹt.
pub const STUCK_PROCESSING: Duration = Duration::minutes(15);
/// Tổng số lần được thử của một dòng hẹn giờ (kể cả lần bị kẹt).
pub const MAX_SCHEDULED_ATTEMPTS: i32 = 3;
const DEDUP_WINDOW_MINUTES: i32 = 5;

/// Kênh gửi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Push,
    InApp,
    Webhook,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Push => "push",
            Self::InApp => "in_app",
            Self::Webhook => "webhook",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "push" => Some(Self::Push),
            "in_app" => Some(Self::InApp),
            "webhook" => Some(Self::Webhook),
            _ => None,
        }
    }
}

/// Body `POST /notifications/send` (K15 lenient: `user_id` số nguyên, `channel`, `title`/`body` chuỗi không rỗng,
/// `action_url` bắt đầu bằng `/` không phải `//` hay `/\`, `scheduled_at` ISO 8601).
#[derive(Debug, Clone, Deserialize)]
pub struct SendNotification {
    pub user_id: i32,
    pub channel: Channel,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub template_id: Option<i32>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub entity_id: Option<i32>,
    #[serde(default)]
    pub action_url: Option<String>,
    #[serde(default)]
    pub scheduled_at: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

impl SendNotification {
    /// `metadata[key]` nếu là chuỗi.
    pub fn metadata_str(&self, key: &str) -> Option<String> {
        self.metadata.as_ref()?.get(key)?.as_str().map(str::to_owned)
    }
}

/// Kết quả `POST /notifications/send`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SendResult {
    pub id: i32,
    pub status: String,
}

/// Một thông báo trong danh sách (đúng thứ tự khoá của `select`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct NotificationItem {
    pub id: i32,
    pub title: Option<String>,
    pub body: Option<String>,
    pub channel: String,
    pub event_type: Option<String>,
    pub action_url: Option<String>,
    pub is_read: bool,
    pub created_at: Timestamp,
}

/// Một trang.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page {
    pub data: Vec<NotificationItem>,
    pub next_cursor: Option<i32>,
}

/// Số chưa đọc.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Unread {
    pub count: i64,
}

/// Nhóm đếm của `GET /unread-count?category=`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Profile,
    Message,
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

async fn conn(t: &TenantDb) -> Result<trinity_db::TenantConn, AppError> {
    t.acquire().await.map_err(AppError::internal)
}

fn message_types() -> Vec<String> {
    MESSAGE_EVENT_TYPES.map(String::from).to_vec()
}

/// `GET /notifications`: mới nhất trước; `cursor` là id dòng cuối của trang trước.
pub async fn find_by_user(
    conn: &mut PgConnection,
    user_id: i32,
    cursor: Option<i32>,
    limit: i64,
    read: Option<bool>,
) -> Result<Page, AppError> {
    // `cursor = 0` (falsy) = không có con trỏ, như `cursor ? {...} : {}` của bản TS.
    let cursor = cursor.filter(|c| *c != 0);
    let mut rows: Vec<NotificationItem> = sqlx::query_as(
        "SELECT id, title, body, channel, event_type, action_url, is_read, created_at FROM notification_logs \
         WHERE recipient_id = $1 AND ($2::bool IS NULL OR is_read = $2) \
           AND ($3::int4 IS NULL OR created_at <= (SELECT created_at FROM notification_logs WHERE id = $3)) \
         ORDER BY created_at DESC LIMIT $4 OFFSET $5",
    )
    .bind(user_id)
    .bind(read)
    .bind(cursor)
    .bind(limit + 1)
    .bind(i64::from(cursor.is_some()))
    .fetch_all(conn)
    .await
    .map_err(db)?;
    let has_next = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    if has_next {
        rows.pop();
    }
    let next_cursor = if has_next { rows.last().map(|r| r.id) } else { None };
    Ok(Page {
        data: rows,
        next_cursor,
    })
}

/// `GET /notifications/unread-count`: `message` = tin nhắn/đề cập, `profile` = còn lại (kể cả `event_type` NULL).
pub async fn unread_count(
    conn: &mut PgConnection,
    user_id: i32,
    category: Option<Category>,
) -> Result<Unread, AppError> {
    let cat = category.map(|c| matches!(c, Category::Message));
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_logs WHERE recipient_id = $1 AND is_read = false \
         AND ($2::bool IS NULL OR ($2 AND event_type = ANY($3)) OR (NOT $2 AND (event_type IS NULL OR event_type <> ALL($3))))",
    )
    .bind(user_id)
    .bind(cat)
    .bind(message_types())
    .fetch_one(conn)
    .await
    .map_err(db)?;
    Ok(Unread { count })
}

/// Phát tin `bell` cho các tiến trình khác (ghi DB trước, phát sau). Dòng đã ghi thành công nên lỗi phát chỉ ghi log,
/// không làm request trả 500 (client thấy thông báo ở lần tải sau).
async fn publish_bell(t: &TenantDb, users: &[i32], ids: &[i32]) {
    let res = async {
        let mut tx = t.begin().await.map_err(|e| e.to_string())?;
        trinity_db::sync::publish_bell_best_effort(&mut tx, i64::from(t.company().id()), users, ids).await;
        tx.commit().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = res {
        tracing::warn!("không phát được tin bell: {e}");
    }
}

/// `PATCH /notifications/:id/read`: thông báo của người khác hoặc không có ⇒ 404 (không 403).
pub async fn mark_as_read(t: &TenantDb, d: &Deliverer, id: i32, user_id: i32) -> Result<Success, AppError> {
    let mut c = conn(t).await?;
    let owner: Option<i32> = sqlx::query_scalar("SELECT recipient_id FROM notification_logs WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?;
    if owner != Some(user_id) {
        return Err(HttpError::not_found("Thong bao khong ton tai").into());
    }
    sqlx::query("UPDATE notification_logs SET is_read = true, status = 'read', read_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    drop(c);
    // Phát trước, để lỗi/độ trễ của đếm cục bộ không làm mất tin cho tiến trình khác.
    publish_bell(t, &[user_id], &[]).await;
    d.sink
        .refresh_unread(i64::from(t.company().id()), i64::from(user_id))
        .await;
    Ok(Success { success: true })
}

/// Kết quả `{ success: true }` của `PATCH /:id/read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Success {
    pub success: bool,
}

async fn set_scheduled(t: &TenantDb, id: i32, at: DateTime<Utc>) -> Result<(), AppError> {
    let mut c = conn(t).await?;
    sqlx::query("UPDATE notification_logs SET status = 'scheduled', scheduled_at = $2 WHERE id = $1")
        .bind(id)
        .bind(at)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    Ok(())
}

/// Thông báo cùng sự kiện + người nhận + tiêu đề + nội dung trong 5 phút gần nhất là trùng (log chưa lưu `entity_id`,
/// nên hai thực thể có nội dung khác nhau không bị nuốt).
async fn is_duplicate(t: &TenantDb, dto: &SendNotification) -> Result<bool, AppError> {
    let (Some(event), Some(_)) = (
        dto.event_type.as_ref().filter(|e| !e.is_empty()),
        dto.entity_id.filter(|e| *e != 0),
    ) else {
        return Ok(false);
    };
    let mut c = conn(t).await?;
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM notification_logs WHERE event_type = $1 AND recipient_id = $2 AND title = $3 AND body = $4 \
         AND created_at >= now() - make_interval(mins => $5) LIMIT 1",
    )
    .bind(event)
    .bind(dto.user_id)
    .bind(&dto.title)
    .bind(&dto.body)
    .bind(DEDUP_WINDOW_MINUTES)
    .fetch_optional(&mut *c)
    .await
    .map_err(db)?;
    Ok(found.is_some())
}

async fn create_log(t: &TenantDb, dto: &SendNotification) -> Result<i32, AppError> {
    let mut c = conn(t).await?;
    sqlx::query_scalar(
        "INSERT INTO notification_logs (template_id, event_type, channel, recipient_id, title, body, action_url, webhook_url, \
         status, retry_count, is_read) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, false) RETURNING id",
    )
    .bind(dto.template_id)
    .bind(dto.event_type.as_deref().unwrap_or("manual"))
    .bind(dto.channel.as_str())
    .bind(dto.user_id)
    .bind(&dto.title)
    .bind(&dto.body)
    .bind(&dto.action_url)
    .bind(dto.metadata_str("webhook_url"))
    .fetch_one(&mut *c)
    .await
    .map_err(db)
}

/// Sau khi giao in-app: báo các tiến trình khác rồi đẩy lại số đếm cục bộ.
async fn after_in_app(t: &TenantDb, d: &Deliverer, user: i32, log_id: i32) {
    publish_bell(t, &[user], &[log_id]).await;
    d.sink
        .refresh_unread(i64::from(t.company().id()), i64::from(user))
        .await;
}

/// `POST /notifications/send`. `now` là giờ hiện tại (đưa vào để test): lịch tương lai do người gọi chọn được giữ nguyên;
/// ngoài giờ hành chính (08:00..18:00 UTC+7) thì dời sang 08:00 kế tiếp.
pub async fn send(
    t: &TenantDb,
    d: &Deliverer,
    dto: &SendNotification,
    now: DateTime<Utc>,
) -> Result<SendResult, AppError> {
    if is_duplicate(t, dto).await? {
        tracing::debug!("Dedup: skip {:?}:{:?}:{}", dto.event_type, dto.entity_id, dto.user_id);
        return Ok(SendResult {
            id: 0,
            status: "deduplicated".to_owned(),
        });
    }
    // Kiểm trước khi ghi: `scheduled_at` sai dạng là 400, không lặng lẽ gửi ngay.
    let scheduled = match dto.scheduled_at.as_deref() {
        Some(s) => Some(
            parse_iso8601(s)
                .ok_or_else(|| HttpError::bad_request("scheduled_at must be a valid ISO 8601 date string"))?,
        ),
        None => None,
    };
    let id = create_log(t, dto).await?;
    if let Some(at) = scheduled
        && at > now
    {
        set_scheduled(t, id, at).await?;
        return Ok(SendResult {
            id,
            status: "scheduled".to_owned(),
        });
    }
    if !is_business_hours(now) {
        set_scheduled(t, id, next_business_start(now)).await?;
        return Ok(SendResult {
            id,
            status: "scheduled".to_owned(),
        });
    }
    let status = d.deliver_with_retry(t, id, dto).await?;
    if dto.channel == Channel::InApp {
        after_in_app(t, d, dto.user_id, id).await;
    }
    Ok(SendResult {
        id,
        status: status.to_owned(),
    })
}

/// Reaper: dòng kẹt ở `processing` quá 15 phút (tiến trình chết giữa chừng) ⇒ về `scheduled` để gửi lại, hoặc `failed` khi
/// đã thử đủ [`MAX_SCHEDULED_ATTEMPTS`]. Dòng cũ chưa có `claimed_at` thì tính theo `scheduled_at`. Trả `(requeued, failed)`.
pub async fn reap_stuck_processing(t: &TenantDb, now: DateTime<Utc>) -> Result<(u64, u64), AppError> {
    let cutoff = now - STUCK_PROCESSING;
    let mut c = conn(t).await?;
    let stuck: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT id, retry_count FROM notification_logs WHERE status = 'processing' \
         AND (claimed_at < $1 OR (claimed_at IS NULL AND scheduled_at < $1)) LIMIT 200",
    )
    .bind(cutoff)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let (mut requeued, mut failed) = (0, 0);
    for (id, retry) in stuck {
        // Điều kiện status = 'processing': không đụng dòng vừa được xử lý xong bởi tiến trình khác.
        if retry + 1 >= MAX_SCHEDULED_ATTEMPTS {
            failed += sqlx::query(
                "UPDATE notification_logs SET status = 'failed', retry_count = $2, \
                 error = 'Kẹt ở trạng thái processing quá lâu, đã quá số lần thử' WHERE id = $1 AND status = 'processing'",
            )
            .bind(id)
            .bind(retry + 1)
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected();
        } else {
            requeued += sqlx::query(
                "UPDATE notification_logs SET status = 'scheduled', retry_count = $2, claimed_at = NULL \
                 WHERE id = $1 AND status = 'processing'",
            )
            .bind(id)
            .bind(retry + 1)
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected();
        }
    }
    if requeued + failed > 0 {
        tracing::warn!("Reaper: trả {requeued} dòng về scheduled, đánh failed {failed} dòng kẹt processing");
    }
    Ok((requeued, failed))
}

#[derive(sqlx::FromRow)]
struct DueRow {
    recipient_id: i32,
    channel: String,
    title: Option<String>,
    body: Option<String>,
    event_type: Option<String>,
    template_id: Option<i32>,
    action_url: Option<String>,
    webhook_url: Option<String>,
    id: i32,
}

/// Job `notification.scheduled` cho một công ty: reaper rồi giao tối đa 100 dòng đến hạn. Mỗi dòng được claim RIÊNG, ngay
/// trước khi giao (`scheduled` → `processing` có điều kiện; chỉ dòng mà câu lệnh này thật sự đổi mới được giao), nên hai
/// tiến trình không gửi đôi và lượt bị cắt giữa chừng (hết budget) chỉ để lại tối đa MỘT dòng `processing` cho reaper, không
/// phải cả lô 100. KHÔNG chặn theo giờ hành chính ở đây (việc dời giờ đã nằm trong `scheduled_at`). Trả số dòng đã xử lý.
pub async fn process_scheduled(t: &TenantDb, d: &Deliverer, now: DateTime<Utc>) -> Result<usize, AppError> {
    reap_stuck_processing(t, now).await?;
    let due: Vec<i32> = {
        let mut c = conn(t).await?;
        sqlx::query_scalar(
            "SELECT id FROM notification_logs WHERE status = 'scheduled' AND scheduled_at <= $1 \
             ORDER BY scheduled_at ASC LIMIT 100",
        )
        .bind(now)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?
    };
    let mut processed = 0;
    for id in due {
        // Giữ kết nối chỉ cho hai câu lệnh ngắn; trả lại trước khi giao (webhook có thể chờ mạng).
        let row: Option<DueRow> = {
            let mut c = conn(t).await?;
            let won = sqlx::query(
                "UPDATE notification_logs SET status = 'processing', claimed_at = now() \
                 WHERE id = $1 AND status = 'scheduled'",
            )
            .bind(id)
            .execute(&mut *c)
            .await
            .map_err(db)?
            .rows_affected();
            if won == 1 {
                sqlx::query_as(
                    "SELECT id, recipient_id, channel, title, body, event_type, template_id, action_url, webhook_url \
                     FROM notification_logs WHERE id = $1",
                )
                .bind(id)
                .fetch_optional(&mut *c)
                .await
                .map_err(db)?
            } else {
                None
            }
        };
        let Some(r) = row else { continue };
        let Some(channel) = Channel::parse(&r.channel) else {
            // Kênh lạ: không thử lại được, đánh failed ngay.
            let msg = format!("Kenh {} khong ho tro", r.channel);
            let mut c = conn(t).await?;
            sqlx::query("UPDATE notification_logs SET status = 'failed', error = $2 WHERE id = $1")
                .bind(r.id)
                .bind(&msg)
                .execute(&mut *c)
                .await
                .map_err(db)?;
            tracing::error!("Notification {} failed: {msg}", r.id);
            processed += 1;
            continue;
        };
        // Thông báo hẹn giờ không lưu `fcm_token`: push hẹn giờ ⇒ `skipped`, không thử lại vô ích.
        let mut meta = r.webhook_url.map(|u| serde_json::json!({ "webhook_url": u }));
        if channel == Channel::Push {
            meta = Some(serde_json::json!({ "scheduled_row": true }));
        }
        let dto = SendNotification {
            user_id: r.recipient_id,
            channel,
            title: r.title.unwrap_or_default(),
            body: r.body.unwrap_or_default(),
            template_id: r.template_id,
            event_type: r.event_type,
            entity_id: None,
            action_url: r.action_url,
            scheduled_at: None,
            metadata: meta,
        };
        d.deliver_with_retry(t, r.id, &dto).await?;
        if channel == Channel::InApp {
            after_in_app(t, d, r.recipient_id, r.id).await;
        }
        processed += 1;
    }
    Ok(processed)
}
