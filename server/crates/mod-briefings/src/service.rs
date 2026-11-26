//! Logic của 6 endpoint và của job `briefings.run-due` (`briefings.service.ts`, `briefings.controller.ts`).
//!
//! Máy chủ KHÔNG gọi AI: theo lịch dựng bản tin MẪU từ số liệu rồi gửi trong app; agent của khách (MCP) viết bản khác và lưu
//! đè (M41, không thuộc issue này).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgConnection, Row};
use trinity_db::outbox::{NewNotification, create_notification};
use trinity_db::types::{JsonValue, Timestamp};
use trinity_db::{DbError, TenantDb};
use trinity_kernel::error::HttpError;
use trinity_kernel::vn_time::vn_clock_minutes;

use crate::aggregate::collect;
use crate::config::{self, Patch};
use crate::text::{build_content, short_body};
use crate::time::{is_slot_due, vn_day_key};
use crate::types::{BriefingData, Config, Content, Owners, Slot};

/// Quyền để xem bản tin; người giữ quyền này là người nhận.
pub const PERMISSION: &str = "reports.overview";
pub const MAX_RECIPIENTS: usize = 500;
/// Tên kênh trong cột `channels`.
pub const CHANNEL_IN_APP: &str = "in_app";

/// Các việc cần tầng RBAC (`PermissionService`, `ScopeService`, `OrgFeaturesService`). Chưa có router ⇒ bên gọi cài; test dùng
/// bản giả. [`roster_with_permission`] là phần SQL dùng chung của `recipients`.
pub trait Ports: Send + Sync + 'static {
    /// Cờ `ai_briefing` (công tắc tổ chức + gói) đang bật.
    fn feature_on(&self, conn: &mut PgConnection) -> impl Future<Output = bool> + Send;
    /// Người dùng đang hoạt động giữ [`PERMISSION`] (vai trò hệ thống luôn tính).
    fn recipients(&self, conn: &mut PgConnection) -> impl Future<Output = Vec<i32>> + Send;
    /// Phạm vi `reports.overview` của người dùng; `None` = không có quyền.
    fn owners_for(
        &self,
        conn: &mut PgConnection,
        user_id: i32,
        email: &str,
    ) -> impl Future<Output = Option<Owners>> + Send;
}

/// `findUserIdsWithPermission`: vai trò hệ thống (`is_system`) có mọi quyền, cộng vai trò được cấp quyền đó.
pub async fn roster_with_permission(
    conn: &mut PgConnection,
    permission: &str,
) -> std::result::Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT DISTINCT ur.user_id FROM user_roles ur
         JOIN users u ON u.id = ur.user_id AND u.status = 'active' AND u.deleted_at IS NULL
         WHERE ur.role_id IN (SELECT r.id FROM roles r WHERE r.is_system OR EXISTS (SELECT 1 FROM role_permissions g WHERE g.role_id = r.id AND g.permission = $1))
         ORDER BY ur.user_id",
    )
    .bind(permission)
    .fetch_all(conn)
    .await
}

#[derive(Debug)]
pub enum Error {
    Http(Box<HttpError>),
    Internal(String),
}

impl From<HttpError> for Error {
    fn from(e: HttpError) -> Self {
        Error::Http(Box::new(e))
    }
}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Error::Internal(e.to_string())
    }
}

impl From<DbError> for Error {
    fn from(e: DbError) -> Self {
        Error::Internal(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// `GET /briefings/config`.
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub config: Config,
    pub available: Available,
}

#[derive(Debug, Serialize)]
pub struct Available {
    pub feature: bool,
}

/// Kết quả một lượt gửi (`POST /briefings/run-now`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunResult {
    pub slot: Slot,
    pub recipients: i64,
    pub created: i64,
    pub skipped: i64,
    pub channels: BTreeMap<String, i64>,
}

/// Kết quả của `run_due`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunDue {
    /// `config-off` hoặc `feature-off`.
    Skipped(&'static str),
    Ran(Vec<RunResult>),
}

#[derive(Debug, Serialize)]
pub struct Preview {
    pub data: BriefingData,
    pub content: Content,
}

#[derive(Debug, Serialize)]
pub struct BriefingSummary {
    pub id: i32,
    pub slot: String,
    pub day: String,
    pub title: String,
    pub text: String,
    pub channels: JsonValue,
    pub created_at: Timestamp,
}

#[derive(Debug, Serialize)]
pub struct Briefing {
    pub id: i32,
    pub user_id: i32,
    pub slot: String,
    pub day: String,
    pub title: String,
    pub text: String,
    pub data: JsonValue,
    pub channels: JsonValue,
    pub created_at: Timestamp,
}

/// Slot theo giờ VN hiện tại (`nowSlot`): trước 12h là sáng.
pub fn now_slot(now: DateTime<Utc>) -> Slot {
    if vn_clock_minutes(now) < 12 * 60 {
        Slot::Morning
    } else {
        Slot::Evening
    }
}

/// `GET /briefings/config` (`settings.integrations`).
pub async fn get_config<P: Ports>(db: &TenantDb, ports: &P) -> Result<ConfigResponse> {
    let mut conn = db.acquire().await?;
    let config = config::get(&mut conn).await;
    let feature = ports.feature_on(&mut conn).await;
    Ok(ConfigResponse {
        config,
        available: Available { feature },
    })
}

/// `PATCH /briefings/config` (`settings.integrations`): thân request thô, kiểm như DTO.
pub async fn update_config(db: &TenantDb, body: &serde_json::Value, user_id: i32) -> Result<Config> {
    let patch = Patch::parse(body).map_err(Error::Http)?;
    let mut conn = db.acquire().await?;
    Ok(config::update(&mut conn, &patch, user_id).await?)
}

/// Cổng `RequireOrgFeature('ai_briefing')`.
async fn require_feature<P: Ports>(conn: &mut PgConnection, ports: &P) -> Result<()> {
    if ports.feature_on(conn).await {
        Ok(())
    } else {
        Err(HttpError::forbidden("Tính năng \"Bản tin sáng/chiều\" chưa bật hoặc không có trong gói hiện tại.").into())
    }
}

/// `POST /briefings/run-now?slot=` (`settings.integrations` + cờ `ai_briefing`): gửi ngay một slot, mặc định theo giờ VN.
pub async fn run_now<P: Ports>(db: &TenantDb, ports: &P, slot: Option<&str>, now: DateTime<Utc>) -> Result<RunResult> {
    let slot = parse_slot(slot)?;
    {
        let mut conn = db.acquire().await?;
        require_feature(&mut conn, ports).await?;
    }
    run_slot(db, ports, slot.unwrap_or_else(|| now_slot(now)), None, now).await
}

fn parse_slot(slot: Option<&str>) -> Result<Option<Slot>> {
    match slot {
        None => Ok(None),
        Some(s) => Slot::parse(s).map(Some).ok_or_else(|| {
            HttpError::validation(vec![
                "slot must be one of the following values: morning, evening".to_owned(),
            ])
            .into()
        }),
    }
}

/// `GET /briefings/preview?slot=` (`reports.overview` + cờ): số liệu và bản mẫu cho CHÍNH người gọi, không lưu, không gửi.
/// `None` ⇒ không có phạm vi (JSON `null`).
pub async fn preview<P: Ports>(
    db: &TenantDb,
    ports: &P,
    user_id: i32,
    email: &str,
    slot: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Option<Preview>> {
    let slot = parse_slot(slot)?;
    let mut conn = db.acquire().await?;
    require_feature(&mut conn, ports).await?;
    let Some(owners) = ports.owners_for(&mut conn, user_id, email).await else {
        return Ok(None);
    };
    let data = collect(&mut conn, &owners, slot.unwrap_or_else(|| now_slot(now)), now).await?;
    let content = build_content(&data);
    Ok(Some(Preview { data, content }))
}

/// `GET /briefings` (`reports.overview`): 30 bản tin mới nhất của chính người gọi.
pub async fn list(db: &TenantDb, user_id: i32) -> Result<Vec<BriefingSummary>> {
    let mut conn = db.acquire().await?;
    let rows = sqlx::query(
        "SELECT id, slot, day, title, text, channels, created_at FROM briefings WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|r| BriefingSummary {
            id: r.get("id"),
            slot: r.get("slot"),
            day: r.get("day"),
            title: r.get("title"),
            text: r.get("text"),
            channels: r.get("channels"),
            created_at: r.get("created_at"),
        })
        .collect())
}

/// `GET /briefings/:id` (`reports.overview`): bản tin của ai chỉ người đó đọc; id ngoài chủ là 404.
pub async fn one(db: &TenantDb, user_id: i32, id: i32) -> Result<Briefing> {
    let mut conn = db.acquire().await?;
    let r = sqlx::query("SELECT id, user_id, slot, day, title, text, data, channels, created_at FROM briefings WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| Error::from(HttpError::not_found("Không tìm thấy")))?;
    Ok(Briefing {
        id: r.get("id"),
        user_id: r.get("user_id"),
        slot: r.get("slot"),
        day: r.get("day"),
        title: r.get("title"),
        text: r.get("text"),
        data: r.get("data"),
        channels: r.get("channels"),
        created_at: r.get("created_at"),
    })
}

/// Job mỗi phút: gửi slot nào đã đến giờ mà chưa gửi hôm nay. Tắt bằng `enabled`/cờ ⇒ không làm gì.
pub async fn run_due<P: Ports>(db: &TenantDb, ports: &P, now: DateTime<Utc>) -> Result<RunDue> {
    let cfg = {
        let mut conn = db.acquire().await?;
        let cfg = config::get(&mut conn).await;
        if !cfg.enabled {
            return Ok(RunDue::Skipped("config-off"));
        }
        if !ports.feature_on(&mut conn).await {
            return Ok(RunDue::Skipped("feature-off"));
        }
        cfg
    };
    let mut out = Vec::new();
    for (slot, on, time) in [
        (Slot::Morning, cfg.morning_enabled, &cfg.morning_time),
        (Slot::Evening, cfg.evening_enabled, &cfg.evening_time),
    ] {
        if on && is_slot_due(time, now) {
            out.push(run_slot(db, ports, slot, Some(&cfg), now).await?);
        }
    }
    Ok(RunDue::Ran(out))
}

/// Dựng và gửi một slot cho mọi người giữ `reports.overview`. Idempotent: khoá duy nhất (user, slot, ngày) chặn gửi trùng.
pub async fn run_slot<P: Ports>(
    db: &TenantDb,
    ports: &P,
    slot: Slot,
    cfg: Option<&Config>,
    now: DateTime<Utc>,
) -> Result<RunResult> {
    let mut conn = db.acquire().await?;
    let config = match cfg {
        Some(c) => c.clone(),
        None => config::get(&mut conn).await,
    };
    let day = vn_day_key(now);
    let mut ids = ports.recipients(&mut conn).await;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_RECIPIENTS);
    let done: BTreeSet<i32> =
        sqlx::query_scalar("SELECT user_id FROM briefings WHERE slot = $1 AND day = $2 AND user_id = ANY($3)")
            .bind(slot.as_str())
            .bind(&day)
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    let todo: Vec<i32> = ids.into_iter().filter(|id| !done.contains(id)).collect();
    let mut result = RunResult {
        slot,
        recipients: todo.len() as i64,
        created: 0,
        skipped: done.len() as i64,
        channels: BTreeMap::new(),
    };
    if todo.is_empty() {
        return Ok(result);
    }
    let users: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, email FROM users WHERE id = ANY($1) AND status = 'active' AND deleted_at IS NULL ORDER BY id",
    )
    .bind(&todo)
    .fetch_all(&mut *conn)
    .await?;
    let mut groups: HashMap<String, (BriefingData, Content)> = HashMap::new();
    for (user_id, email) in users {
        let Some(owners) = ports.owners_for(&mut conn, user_id, &email).await else {
            continue;
        };
        let key = match &owners {
            Owners::All => "all".to_owned(),
            Owners::Users(v) => {
                let mut v = v.clone();
                v.sort_unstable();
                v.iter().map(i32::to_string).collect::<Vec<_>>().join(",")
            }
        };
        if !groups.contains_key(&key) {
            let data = collect(&mut conn, &owners, slot, now).await?;
            let content = build_content(&data);
            groups.insert(key.clone(), (data, content));
        }
        let (data, content) = &groups[&key];
        deliver(db, &mut conn, data, content, slot, &day, user_id, &config, &mut result).await?;
    }
    tracing::info!(
        "Bản tin {}: {}/{} người, kênh {:?}",
        slot.as_str(),
        result.created,
        result.recipients,
        result.channels
    );
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn deliver(
    db: &TenantDb,
    conn: &mut PgConnection,
    data: &BriefingData,
    content: &Content,
    slot: Slot,
    day: &str,
    user_id: i32,
    cfg: &Config,
    result: &mut RunResult,
) -> Result<()> {
    let data_json = serde_json::to_string(data).map_err(|e| Error::Internal(e.to_string()))?;
    let id: Option<i32> = sqlx::query_scalar(
        "INSERT INTO briefings (user_id, slot, day, title, text, data) VALUES ($1, $2, $3, $4, $5, $6::text::jsonb)
         ON CONFLICT (user_id, slot, day) DO NOTHING RETURNING id",
    )
    .bind(user_id)
    .bind(slot.as_str())
    .bind(day)
    .bind(&content.title)
    .bind(&content.text)
    .bind(data_json)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(id) = id else {
        result.skipped += 1;
        return Ok(());
    };
    result.created += 1;
    let mut sent: Vec<&str> = Vec::new();
    if cfg.in_app {
        // Lỗi một kênh không chặn việc gửi (bản tin đã lưu); kênh lỗi không ghi vào `channels`.
        match notify_in_app(db, user_id, slot, id, content).await {
            Ok(true) => {
                sent.push(CHANNEL_IN_APP);
                *result.channels.entry(CHANNEL_IN_APP.to_owned()).or_insert(0) += 1;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!("Gửi bản tin {id} qua {CHANNEL_IN_APP} lỗi: {e:?}"),
        }
    }
    sqlx::query("UPDATE briefings SET channels = $2::text::jsonb WHERE id = $1")
        .bind(id)
        .bind(serde_json::to_string(&sent).map_err(|e| Error::Internal(e.to_string()))?)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn notify_in_app(db: &TenantDb, user_id: i32, slot: Slot, briefing_id: i32, content: &Content) -> Result<bool> {
    let mut tx = db.begin().await?;
    let created = create_notification(
        &mut tx,
        &[NewNotification {
            recipient_id: user_id,
            event_type: format!("briefing.{}", slot.as_str()),
            title: content.title.clone(),
            body: short_body(content),
            action_url: Some(format!("/briefings?id={briefing_id}")),
        }],
    )
    .await
    .map_err(|e| Error::Internal(e.to_string()))?;
    tx.commit().await?;
    Ok(!created.is_empty())
}
