//! Dữ liệu và lưu bản tin cho AGENT của khách qua MCP (`get_briefing_data`, `save_briefing`; `agentData`/`saveFromAgent` của
//! `briefings.service.ts` và `briefing-details.ts`). Máy chủ không gọi AI: agent đọc số liệu + danh sách chi tiết rồi tự viết bản
//! tin, lưu vào hộp bản tin của CHÍNH người dùng đã kết nối.
//!
//! Phạm vi quyền (`Owners`) do bên gọi đưa vào (đã tính từ `reports.overview`); danh sách `Owners::Users` rỗng = không ai ⇒ không
//! có dòng nào. Không trả SĐT.

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgConnection, Row};
use trinity_db::TenantDb;
use trinity_db::outbox::{NewNotification, create_notification};
use trinity_db::types::Timestamp;

use crate::aggregate::collect;
use crate::config;
use crate::service::{CHANNEL_IN_APP, Error, Result};
use crate::text::{build_content, short_body};
use crate::time::{slot_windows, vn_day_key};
use crate::types::{BriefingData, Content, Owners, Slot};

/// Số dòng tối đa mỗi danh sách (`DETAIL_LIMIT`).
pub const DETAIL_LIMIT: i64 = 15;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewContactRow {
    pub id: i32,
    pub name: Option<String>,
    pub source: Option<String>,
    pub owner: Option<String>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OverdueTaskRow {
    pub id: i32,
    pub title: String,
    pub due_at: Option<Timestamp>,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CallbackRow {
    pub id: i32,
    pub name: Option<String>,
    pub reminder_at: Option<Timestamp>,
    pub note: Option<String>,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HotLeadRow {
    pub id: i32,
    pub name: Option<String>,
    pub score: Option<i32>,
    pub label: Option<String>,
    pub owner: Option<String>,
}

/// `BriefingDetails`: bốn danh sách đi kèm số liệu.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Details {
    pub new_contacts: Vec<NewContactRow>,
    pub overdue_tasks: Vec<OverdueTaskRow>,
    pub callbacks: Vec<CallbackRow>,
    pub hot_leads: Vec<HotLeadRow>,
}

/// `AgentBriefingData`: số liệu, danh sách chi tiết và bản mẫu dựng sẵn.
#[derive(Debug, Clone, Serialize)]
pub struct AgentData {
    pub data: BriefingData,
    pub details: Details,
    pub template: Content,
}

/// Kết quả [`save_from_agent`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Saved {
    pub id: i32,
    pub created: bool,
    pub notified: bool,
}

/// `(tất cả, danh sách owner)` cho tham số `$1`/`$2` của SQL.
fn split(owners: &Owners) -> (bool, Vec<i32>) {
    match owners {
        Owners::All => (true, Vec::new()),
        Owners::Users(v) => (false, v.clone()),
    }
}

/// `collectBriefingDetails`: các danh sách chi tiết theo phạm vi, tuần tự trên MỘT kết nối.
pub async fn collect_details(
    conn: &mut PgConnection,
    owners: &Owners,
    slot: Slot,
    now: DateTime<Utc>,
) -> std::result::Result<Details, sqlx::Error> {
    if matches!(owners, Owners::Users(v) if v.is_empty()) {
        return Ok(Details::default());
    }
    let (all, ids) = split(owners);
    let w = slot_windows(slot, now);
    let new_contacts = sqlx::query(
        "SELECT c.id, c.full_name, c.created_at, so.label AS source, u.full_name AS owner
         FROM contacts c
         LEFT JOIN setting_options so ON so.id = c.source_id
         LEFT JOIN users u ON u.id = c.assigned_to
         WHERE c.deleted_at IS NULL AND ($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2))
           AND c.created_at >= $3 AND c.created_at < $4
         ORDER BY c.created_at DESC, c.id DESC LIMIT $5",
    )
    .bind(all)
    .bind(&ids)
    .bind(w.cur.start)
    .bind(w.cur.end)
    .bind(DETAIL_LIMIT)
    .fetch_all(&mut *conn)
    .await?
    .iter()
    .map(|r| NewContactRow {
        id: r.get("id"),
        name: r.get("full_name"),
        source: r.get("source"),
        owner: r.get("owner"),
        created_at: r.get("created_at"),
    })
    .collect();
    let overdue_tasks = sqlx::query(
        "SELECT k.id, k.title, k.due_at, u.full_name AS owner
         FROM kanban_cards k LEFT JOIN users u ON u.id = k.assignee_id
         WHERE ($1 OR k.assignee_id = ANY($2))
           AND k.deleted_at IS NULL AND k.completed_at IS NULL AND k.due_completed_at IS NULL AND k.due_at < $3
         ORDER BY k.due_at ASC, k.id ASC LIMIT $4",
    )
    .bind(all)
    .bind(&ids)
    .bind(now)
    .bind(DETAIL_LIMIT)
    .fetch_all(&mut *conn)
    .await?
    .iter()
    .map(|r| OverdueTaskRow {
        id: r.get("id"),
        title: r.get("title"),
        due_at: r.get("due_at"),
        owner: r.get("owner"),
    })
    .collect();
    let callbacks = sqlx::query(
        "SELECT c.id, c.full_name, c.reminder_at, c.reminder_notes, u.full_name AS owner
         FROM contacts c LEFT JOIN users u ON u.id = c.assigned_to
         WHERE c.deleted_at IS NULL AND ($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2))
           AND c.reminder_at >= $3 AND c.reminder_at < $4
         ORDER BY c.reminder_at ASC, c.id ASC LIMIT $5",
    )
    .bind(all)
    .bind(&ids)
    .bind(w.callbacks.start)
    .bind(w.callbacks.end)
    .bind(DETAIL_LIMIT)
    .fetch_all(&mut *conn)
    .await?
    .iter()
    .map(|r| CallbackRow {
        id: r.get("id"),
        name: r.get("full_name"),
        reminder_at: r.get("reminder_at"),
        note: r.get("reminder_notes"),
        owner: r.get("owner"),
    })
    .collect();
    let hot_leads = sqlx::query(
        "SELECT c.id, c.full_name, c.lead_score, c.lead_label, u.full_name AS owner
         FROM contacts c LEFT JOIN users u ON u.id = c.assigned_to
         WHERE c.deleted_at IS NULL AND ($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2))
           AND c.lead_label IN ('hot', 'warm')
         ORDER BY c.lead_score DESC NULLS LAST, c.id DESC LIMIT $3",
    )
    .bind(all)
    .bind(&ids)
    .bind(DETAIL_LIMIT)
    .fetch_all(&mut *conn)
    .await?
    .iter()
    .map(|r| HotLeadRow {
        id: r.get("id"),
        name: r.get("full_name"),
        score: r.get("lead_score"),
        label: r.get("lead_label"),
        owner: r.get("owner"),
    })
    .collect();
    Ok(Details {
        new_contacts,
        overdue_tasks,
        callbacks,
        hot_leads,
    })
}

/// `agentData`: số liệu + chi tiết + bản mẫu cho người có phạm vi `owners`.
pub async fn agent_data(conn: &mut PgConnection, owners: &Owners, slot: Slot, now: DateTime<Utc>) -> Result<AgentData> {
    let data = collect(conn, owners, slot, now).await?;
    let details = collect_details(conn, owners, slot, now).await?;
    let template = build_content(&data);
    Ok(AgentData {
        data,
        details,
        template,
    })
}

/// `saveFromAgent`: ghi bản tin do agent viết cho CHÍNH `user_id`. Cùng (slot, ngày VN) đã có thì thay tiêu đề và nội dung (giữ
/// số liệu cũ); chưa báo trong app thì báo. Một giao dịch, một kết nối. Không đụng dữ liệu nghiệp vụ. `title`/`text` đã cắt và
/// kiểm bởi bên gọi.
pub async fn save_from_agent(
    db: &TenantDb,
    user_id: i32,
    owners: &Owners,
    slot: Slot,
    title: &str,
    text: &str,
    now: DateTime<Utc>,
) -> Result<Saved> {
    let day = vn_day_key(now);
    let mut tx = db.begin().await?;
    let data = collect(&mut tx, owners, slot, now).await?;
    let data_json = serde_json::to_string(&data).map_err(|e| Error::Internal(e.to_string()))?;
    // `xmax = 0` chỉ đúng với dòng vừa chèn (không phải dòng bị cập nhật do xung đột khoá).
    let row = sqlx::query(
        "INSERT INTO briefings (user_id, slot, day, title, text, data) VALUES ($1, $2, $3, $4, $5, $6::text::jsonb)
         ON CONFLICT (user_id, slot, day) DO UPDATE SET title = EXCLUDED.title, text = EXCLUDED.text
         RETURNING id, (xmax = 0) AS created, channels::text AS channels",
    )
    .bind(user_id)
    .bind(slot.as_str())
    .bind(&day)
    .bind(title)
    .bind(text)
    .bind(data_json)
    .fetch_one(&mut *tx)
    .await?;
    let id: i32 = row.get("id");
    let created: bool = row.get("created");
    let channels: Option<String> = row.get("channels");
    let mut sent: Vec<String> = channels
        .and_then(|c| serde_json::from_str::<Vec<String>>(&c).ok())
        .unwrap_or_default();
    let cfg = config::get(&mut tx).await;
    let mut notified = false;
    if cfg.in_app && !sent.iter().any(|c| c == CHANNEL_IN_APP) {
        let content = Content {
            title: title.to_owned(),
            text: text.to_owned(),
        };
        let item = NewNotification {
            recipient_id: user_id,
            event_type: format!("briefing.{}", slot.as_str()),
            title: content.title.clone(),
            body: short_body(&content),
            action_url: Some(format!("/briefings?id={id}")),
        };
        // Lỗi tạo thông báo không làm hỏng bản tin (như `notifyMissing` nuốt lỗi kênh).
        match create_notification(&mut tx, &[item]).await {
            Ok(created) if !created.is_empty() => {
                sent.push(CHANNEL_IN_APP.to_owned());
                notified = true;
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("Gửi bản tin {id} qua {CHANNEL_IN_APP} lỗi: {e}"),
        }
    }
    if notified {
        sqlx::query("UPDATE briefings SET channels = $2::text::jsonb WHERE id = $1")
            .bind(id)
            .bind(serde_json::to_string(&sent).map_err(|e| Error::Internal(e.to_string()))?)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Saved { id, created, notified })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pham_vi_tach_tham_so() {
        assert_eq!(split(&Owners::All), (true, Vec::new()));
        assert_eq!(split(&Owners::Users(vec![3, 4])), (false, vec![3, 4]));
    }

    #[test]
    fn chi_tiet_mac_dinh_rong() {
        let d = Details::default();
        assert!(d.new_contacts.is_empty() && d.overdue_tasks.is_empty());
        assert!(d.callbacks.is_empty() && d.hot_leads.is_empty());
    }
}
