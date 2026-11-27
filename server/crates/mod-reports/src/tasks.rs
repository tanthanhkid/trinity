//! `GET /reports/dashboard-tasks`: việc cần làm hôm nay (thẻ Kanban + lịch hẹn nhắc), mặc định CHỈ của chính người gọi
//! (chuyển từ `dashboard-tasks.service.ts`). Không cache: danh sách nhỏ và người dùng tick xong phải thấy ngay.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::{OwnerIds, can};

use crate::filter::{self, Filter};
use crate::period::today_range;
use crate::{Actor, Ctx, R, db, iso, now};

const MAX_ITEMS: i64 = 8;
const LOOKBACK_DAYS: i64 = 7;

type CardRow = (i32, String, Option<i32>, DateTime<Utc>, Option<String>);
type ReminderRow = (i32, Option<String>, Option<String>, DateTime<Utc>);

pub async fn get(ctx: &Ctx, actor: &Actor, f: &Filter) -> R<Value> {
    get_at(ctx, actor, f, now()).await
}

pub async fn get_at(ctx: &Ctx, actor: &Actor, f: &Filter, at: DateTime<Utc>) -> R<Value> {
    let r = today_range(at);
    let mut c = ctx.conn(actor.company).await?;
    let assignees = resolve_assignees(ctx, &mut c, actor, f).await?;
    let role_ids: Vec<i32> = sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id = $1")
        .bind(actor.user_id)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    let manage_boards = can(&actor.grants, "kanban.boards", None);
    let card_from = "FROM kanban_cards c
        JOIN kanban_boards b ON b.id = c.board_id
        JOIN kanban_columns col ON col.id = c.column_id
        WHERE c.deleted_at IS NULL AND c.due_at IS NOT NULL AND c.due_at < $1 AND c.due_completed_at IS NULL AND c.completed_at IS NULL
          AND b.is_active AND b.deleted_at IS NULL
          AND ($2 OR cardinality(b.visibility_role_ids) = 0 OR b.visibility_role_ids && $3)
          AND NOT col.is_archived AND NOT col.is_done
          AND (c.assignee_id = ANY($4) OR EXISTS (SELECT 1 FROM kanban_card_assignees a WHERE a.card_id = c.id AND a.user_id = ANY($4)))";
    let cards: Vec<CardRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT c.id, c.title, c.contact_id, c.due_at, c.priority {card_from} ORDER BY c.due_at ASC LIMIT {MAX_ITEMS}"
    )))
    .bind(r.end)
    .bind(manage_boards)
    .bind(&role_ids)
    .bind(&assignees)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let card_total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) {card_from}")))
        .bind(r.end)
        .bind(manage_boards)
        .bind(&role_ids)
        .bind(&assignees)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
    let card_today: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT count(*) {card_from} AND c.due_at >= $5"
    )))
    .bind(r.end)
    .bind(manage_boards)
    .bind(&role_ids)
    .bind(&assignees)
    .bind(r.start)
    .fetch_one(&mut *c)
    .await
    .map_err(db)?;
    let lookback = r.start - chrono::Duration::days(LOOKBACK_DAYS);
    let rem_where =
        "FROM contacts WHERE assigned_to = ANY($1) AND deleted_at IS NULL AND reminder_at >= $2 AND reminder_at < $3";
    let reminders: Vec<ReminderRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, full_name, reminder_notes, reminder_at {rem_where} ORDER BY reminder_at ASC LIMIT {MAX_ITEMS}"
    )))
    .bind(&assignees)
    .bind(lookback)
    .bind(r.end)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let rem_total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) {rem_where}")))
        .bind(&assignees)
        .bind(lookback)
        .bind(r.end)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
    let rem_today: i64 = sqlx::query_scalar("SELECT count(*) FROM contacts WHERE assigned_to = ANY($1) AND deleted_at IS NULL AND reminder_at >= $2 AND reminder_at < $3")
        .bind(&assignees)
        .bind(r.start)
        .bind(r.end)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
    let wanted: Vec<i32> = cards
        .iter()
        .filter_map(|x| x.2)
        .chain(reminders.iter().map(|x| x.0))
        .collect();
    let names = contact_names(ctx, &mut c, actor, &wanted).await?;
    let mut items: Vec<(String, Value)> = Vec::new();
    for (id, title, contact_id, due, priority) in &cards {
        let key = iso(*due);
        items.push((
            key.clone(),
            json!({
                "key": format!("k{id}"), "kind": "kanban", "id": id, "title": title, "contact_id": contact_id,
                "contact_name": contact_id.and_then(|i| names.get(&i).cloned().flatten()),
                "due_at": key, "priority": priority, "overdue": *due < r.start,
            }),
        ));
    }
    for (i, (id, _name, notes, at_)) in reminders.iter().enumerate() {
        // Khách ngoài phạm vi contacts.view: không lộ ghi chú nhắc hẹn lẫn id khách.
        let visible = names.contains_key(id);
        let title = notes
            .as_deref()
            .map(str::trim)
            .filter(|s| visible && !s.is_empty())
            .unwrap_or("Nhắc liên hệ lại");
        let key = iso(*at_);
        items.push((
            key.clone(),
            json!({
                "key": if visible { format!("c{id}") } else { format!("c-hidden-{i}") },
                "kind": "reminder", "id": if visible { *id } else { 0 }, "title": title,
                "contact_id": if visible { json!(id) } else { Value::Null },
                "contact_name": names.get(id).cloned().flatten(),
                "due_at": key, "priority": Value::Null, "overdue": *at_ < r.start,
            }),
        ));
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));
    let items: Vec<Value> = items.into_iter().take(MAX_ITEMS as usize).map(|x| x.1).collect();
    let total = card_total + rem_total;
    let due_today = card_today + rem_today;
    Ok(json!({ "total": total, "due_today": due_today, "overdue": total - due_today, "items": items }))
}

async fn resolve_assignees(ctx: &Ctx, c: &mut PgConnection, actor: &Actor, f: &Filter) -> R<Vec<i32>> {
    let Some(filter_ids) = filter::resolve_ids(c, actor, f).await? else {
        return Ok(vec![actor.user_id]);
    };
    let owner = ctx
        .owner_ids(actor, "reports.overview")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    Ok(match filter::compose(&owner, Some(&filter_ids)) {
        OwnerIds::All => filter_ids,
        OwnerIds::Ids(v) => v,
    })
}

/// Chỉ hiện tên khách nằm trong phạm vi `contacts.view` của người gọi (không lộ khách ngoài phạm vi).
async fn contact_names(
    ctx: &Ctx,
    c: &mut PgConnection,
    actor: &Actor,
    ids: &[i32],
) -> R<BTreeMap<i32, Option<String>>> {
    let mut wanted: Vec<i32> = ids.to_vec();
    wanted.sort_unstable();
    wanted.dedup();
    let mut map = BTreeMap::new();
    if wanted.is_empty() {
        return Ok(map);
    }
    let owner = ctx
        .owner_ids(actor, "contacts.view")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let (all, owners) = match owner {
        OwnerIds::All => (true, Vec::new()),
        OwnerIds::Ids(v) => (false, v),
    };
    let rows: Vec<(i32, Option<String>)> = sqlx::query_as(
        "SELECT id, full_name FROM contacts WHERE deleted_at IS NULL AND id = ANY($1) AND ($2 OR assigned_to = ANY($3) OR created_by_id = ANY($3))",
    )
    .bind(&wanted)
    .bind(all)
    .bind(&owners)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    for (id, name) in rows {
        map.insert(id, name);
    }
    Ok(map)
}
