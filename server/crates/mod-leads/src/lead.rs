//! Chấm điểm lead theo quy tắc (không gọi AI): đọc/lưu quy tắc, chấm lại danh sách khách, đọc sự kiện outbox để chấm khách
//! vừa đổi, chấm lại khách cũ hơn 12 giờ, và job `lead-scoring.run`.

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::types::{JsonValue, Timestamp};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::OwnerIds;

use crate::rules::{LeadScoringRules, LeadSignals, default_rules, normalize_rules, score_lead};
use crate::{Features, db, http, put_setting, setting};

const RULES_KEY: &str = "lead_scoring_rules";
const CURSOR_KEY: &str = "lead_scoring_outbox_cursor";
const RESCORE_AFTER: Duration = Duration::hours(12);
const CHUNK: usize = 200;
/// Hoạt động hệ thống/nội bộ không tính là "tương tác với khách".
pub const NON_INTERACTION_ACTIONS: [&str; 6] = [
    "contact_transfer",
    "transfer",
    "stage_change",
    "search",
    "auth",
    "password_change",
];

/// `GET /lead-scoring/rules`.
#[derive(Debug, Serialize)]
pub struct RulesResponse {
    pub rules: LeadScoringRules,
    pub defaults: LeadScoringRules,
    pub job_enabled: bool,
}

/// Quy tắc hiệu lực; thiếu hoặc rác ⇒ mặc định.
pub async fn get_rules(conn: &mut PgConnection) -> Result<LeadScoringRules, AppError> {
    Ok(match setting(conn, RULES_KEY).await? {
        Some(text) => serde_json::from_str::<Value>(&text).map_or_else(|_| default_rules(), |v| normalize_rules(&v)),
        None => default_rules(),
    })
}

pub async fn rules_response(conn: &mut PgConnection, job_enabled: bool) -> Result<RulesResponse, AppError> {
    Ok(RulesResponse {
        rules: get_rules(conn).await?,
        defaults: default_rules(),
        job_enabled,
    })
}

/// `PUT /lead-scoring/rules`: lưu quy tắc đã chuẩn hoá rồi trả bản hiệu lực.
pub async fn save_rules(conn: &mut PgConnection, raw: &Value, user: i32) -> Result<LeadScoringRules, AppError> {
    let rules = normalize_rules(raw);
    let text = serde_json::to_string(&rules).map_err(AppError::internal)?;
    put_setting(conn, RULES_KEY, &text, Some(user)).await?;
    Ok(rules)
}

#[derive(sqlx::FromRow)]
struct ContactRow {
    id: i32,
    phone: String,
    product_id: Option<i32>,
    created_at: Timestamp,
    source_value: Option<String>,
    stage_value: Option<String>,
}

/// Gom tín hiệu cho cả lô khách bằng truy vấn gộp (không N+1). Khách đã xoá/không tồn tại bị bỏ.
async fn load_signals(
    conn: &mut PgConnection,
    ids: &[i32],
    rules: &LeadScoringRules,
    now: DateTime<Utc>,
) -> Result<Vec<(i32, LeadSignals)>, AppError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let since = Duration::try_milliseconds((rules.interactions.window_days * 86_400_000.0) as i64)
        .and_then(|d| now.checked_sub_signed(d))
        .ok_or_else(|| AppError::internal(std::io::Error::other("window_days vượt phạm vi thời gian")))?;
    let contacts: Vec<ContactRow> = sqlx::query_as(
        "SELECT c.id, c.phone, c.product_id, c.created_at, so.value AS source_value, st.value AS stage_value
         FROM contacts c LEFT JOIN setting_options so ON so.id = c.source_id LEFT JOIN setting_options st ON st.id = c.stage_id
         WHERE c.id = ANY($1) AND c.deleted_at IS NULL ORDER BY c.id",
    )
    .bind(ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let live: Vec<i32> = contacts.iter().map(|c| c.id).collect();
    let non: Vec<&str> = NON_INTERACTION_ACTIONS.to_vec();
    let last: Vec<(i32, Option<Timestamp>)> = sqlx::query_as(
        "SELECT contact_id, max(created_at) FROM activities WHERE contact_id = ANY($1) AND action <> ALL($2) GROUP BY contact_id",
    )
    .bind(&live)
    .bind(&non)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let recent: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT contact_id, count(*) FROM activities WHERE contact_id = ANY($1) AND action <> ALL($2) AND created_at >= $3 GROUP BY contact_id",
    )
    .bind(&live)
    .bind(&non)
    .bind(since)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let resp: Vec<(i32, Option<Timestamp>)> = sqlx::query_as(
        "SELECT contact_id, max(created_at) FROM activities WHERE contact_id = ANY($1) AND action = ANY($2) GROUP BY contact_id",
    )
    .bind(&live)
    .bind(&rules.response.actions)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let intents: Vec<(i32, f64)> =
        sqlx::query_as("SELECT contact_id, intent FROM lead_ai_intents WHERE contact_id = ANY($1)")
            .bind(&live)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let find_ts = |v: &[(i32, Option<Timestamp>)], id: i32| v.iter().find(|r| r.0 == id).and_then(|r| r.1).map(|t| t.0);
    Ok(contacts
        .into_iter()
        .map(|c| {
            let signals = LeadSignals {
                phone: Some(c.phone),
                has_demand: c.product_id.is_some(),
                stage_value: c.stage_value,
                source_value: c.source_value,
                last_activity_at: find_ts(&last, c.id),
                last_response_at: find_ts(&resp, c.id),
                interactions_in_window: recent.iter().find(|r| r.0 == c.id).map_or(0, |r| r.1),
                ai_intent: intents
                    .iter()
                    .find(|r| r.0 == c.id)
                    .map(|r| r.1)
                    .filter(|v| v.is_finite()),
                created_at: c.created_at.0,
            };
            (c.id, signals)
        })
        .collect())
}

/// Chấm lại một danh sách khách (không AI). Ghi bằng SQL thô có chủ đích: không đổi `updated_at` của khách chỉ vì chấm điểm.
/// Trả số khách được ghi.
pub async fn recompute(conn: &mut PgConnection, ids: &[i32], now: DateTime<Utc>) -> Result<usize, AppError> {
    let rules = get_rules(conn).await?;
    let mut written = 0;
    for chunk in ids.chunks(CHUNK) {
        for (id, signals) in load_signals(conn, chunk, &rules, now).await? {
            let r = score_lead(&signals, &rules, now);
            let reasons = serde_json::to_string(&r.reasons).map_err(AppError::internal)?;
            sqlx::query(
                "UPDATE contacts SET lead_score = $2, lead_label = $3, lead_score_reasons = $4::text::jsonb, lead_scored_at = $5 WHERE id = $1",
            )
            .bind(id)
            .bind(r.score)
            .bind(r.label.as_str())
            .bind(reasons)
            .bind(now)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
            written += 1;
        }
    }
    Ok(written)
}

/// Đọc sự kiện outbox của khách và deal mới (con trỏ riêng, KHÔNG đụng `dispatched_at` của webhook) rồi chấm lại khách liên
/// quan. Lần đầu chưa có con trỏ: đặt con trỏ ở sự kiện mới nhất, không chấm gì.
pub async fn consume_outbox(conn: &mut PgConnection, limit: i64, now: DateTime<Utc>) -> Result<usize, AppError> {
    let Some(cursor) = setting(conn, CURSOR_KEY).await? else {
        let max: Option<i64> = sqlx::query_scalar("SELECT max(id) FROM integration_events")
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
        put_setting(conn, CURSOR_KEY, &max.unwrap_or(0).to_string(), None).await?;
        return Ok(0);
    };
    // Con trỏ hỏng ⇒ về sự kiện mới nhất hiện tại (không về 0, tránh chấm lại cả lịch sử outbox).
    let cursor: i64 = match cursor.trim().parse() {
        Ok(c) => c,
        Err(_) => {
            let max: Option<i64> = sqlx::query_scalar("SELECT max(id) FROM integration_events")
                .fetch_one(&mut *conn)
                .await
                .map_err(db)?;
            let max = max.unwrap_or(0);
            put_setting(conn, CURSOR_KEY, &max.to_string(), None).await?;
            return Ok(0);
        }
    };
    let events: Vec<(i64, String, String, String, JsonValue)> = sqlx::query_as(
        "SELECT id, resource, resource_id, event_type, payload FROM integration_events
         WHERE id > $1 AND resource IN ('contact', 'deal') ORDER BY id LIMIT $2",
    )
    .bind(cursor)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let Some(last) = events.last().map(|e| e.0) else {
        return Ok(0);
    };
    let mut ids: Vec<i32> = Vec::new();
    for (_, resource, resource_id, event_type, payload) in &events {
        if event_type == "contact.deleted" {
            continue;
        }
        let id = if resource == "contact" {
            resource_id.parse::<i64>().ok()
        } else {
            // Sự kiện deal mang khách ở `payload.deal.contact_id`; cũng nhận `payload.contact_id` ở cấp trên cùng.
            payload
                .0
                .get("deal")
                .and_then(|d| d.get("contact_id"))
                .and_then(Value::as_i64)
                .or_else(|| payload.0.get("contact_id").and_then(Value::as_i64))
        };
        if let Some(id) = id.and_then(|i| i32::try_from(i).ok()).filter(|i| *i > 0)
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    recompute(conn, &ids, now).await?;
    put_setting(conn, CURSOR_KEY, &last.to_string(), None).await?;
    Ok(events.len())
}

/// Khách chưa chấm hoặc điểm cũ hơn 12 giờ (độ mới phải giảm theo thời gian), cũ nhất trước.
pub async fn rescore_stale(conn: &mut PgConnection, limit: i64, now: DateTime<Utc>) -> Result<usize, AppError> {
    let ids: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM contacts WHERE deleted_at IS NULL AND (lead_scored_at IS NULL OR lead_scored_at < $1)
         ORDER BY lead_scored_at ASC NULLS FIRST LIMIT $2",
    )
    .bind(now - RESCORE_AFTER)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    recompute(conn, &ids, now).await
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct RunSummary {
    pub outbox_events: usize,
    pub rescored: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Skipped(&'static str),
    Ran(RunSummary),
}

/// Một lượt của job `lead-scoring.run`.
pub async fn run_once<F: Features>(
    conn: &mut PgConnection,
    features: &F,
    now: DateTime<Utc>,
) -> Result<RunOutcome, AppError> {
    if !features.enabled(conn, "lead_scoring").await {
        return Ok(RunOutcome::Skipped("org-flag-off"));
    }
    let outbox_events = consume_outbox(conn, 500, now).await?;
    let rescored = rescore_stale(conn, 500, now).await?;
    if outbox_events + rescored > 0 {
        tracing::info!("Chấm điểm lead: {outbox_events} sự kiện, {rescored} khách chấm lại");
    }
    Ok(RunOutcome::Ran(RunSummary {
        outbox_events,
        rescored,
    }))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Scored {
    pub id: i32,
    pub lead_score: Option<i32>,
    pub lead_label: Option<String>,
    pub lead_score_reasons: Option<JsonValue>,
    pub lead_scored_at: Option<Timestamp>,
}

/// `POST /lead-scoring/contacts/:id/recompute`: phải thấy khách (phạm vi `contacts.view`); trả điểm mới.
pub async fn recompute_one(
    conn: &mut PgConnection,
    view: Option<&OwnerIds>,
    id: i32,
    now: DateTime<Utc>,
) -> Result<Scored, AppError> {
    let owners: Option<(Option<i32>, Option<i32>)> =
        sqlx::query_as("SELECT assigned_to, created_by_id FROM contacts WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((assigned_to, created_by)) = owners else {
        return Err(http(HttpError::not_found("Không tìm thấy")));
    };
    trinity_rbac::assert_in_scope(view, &[assigned_to, created_by]).map_err(|e| AppError::Http(*e))?;
    recompute(conn, &[id], now).await?;
    sqlx::query_as("SELECT id, lead_score, lead_label, lead_score_reasons, lead_scored_at FROM contacts WHERE id = $1")
        .bind(id)
        .fetch_one(conn)
        .await
        .map_err(db)
}
