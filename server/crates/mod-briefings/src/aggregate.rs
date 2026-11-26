//! Số liệu bản tin THEO PHẠM VI QUYỀN (`briefing-aggregator.service.ts`). `Owners::All` = cả công ty; danh sách = nhóm hoặc
//! chính mình; danh sách rỗng = không ai (không tự nới) ⇒ toàn số 0.

use chrono::{DateTime, Utc};
use sqlx::PgConnection;

use crate::time::{Range, SlotWindows, slot_windows, vn_day_key};
use crate::types::{BriefingData, Delta, Metrics, Owners, ScopeKind, Slot, TopSeller};

/// Phạm vi trong SQL: `$1` = cả công ty, `$2` = danh sách owner. Khách: `assigned_to` hoặc `created_by_id`, chưa xoá. Thương vụ:
/// `assigned_to` hoặc `created_by`. Deal thắng trong kỳ: theo `won_at`; deal cũ chưa có `won_at` rơi về `updated_at`.
fn split(owners: &Owners) -> (bool, Vec<i32>) {
    match owners {
        Owners::All => (true, Vec::new()),
        Owners::Users(v) => (false, v.clone()),
    }
}

fn scope_kind(owners: &Owners) -> ScopeKind {
    match owners {
        Owners::All => ScopeKind::Company,
        Owners::Users(v) if v.len() > 1 => ScopeKind::Team,
        Owners::Users(_) => ScopeKind::Own,
    }
}

/// `collect(owner, slot, now)`.
pub async fn collect(
    conn: &mut PgConnection,
    owners: &Owners,
    slot: Slot,
    now: DateTime<Utc>,
) -> Result<BriefingData, sqlx::Error> {
    let w = slot_windows(slot, now);
    let empty = matches!(owners, Owners::Users(v) if v.is_empty());
    let metrics = if empty {
        Metrics::default()
    } else {
        metrics(conn, owners, &w, now).await?
    };
    let people_count = match owners {
        Owners::All => {
            sqlx::query_scalar("SELECT count(*) FROM users WHERE status = 'active' AND deleted_at IS NULL")
                .fetch_one(&mut *conn)
                .await?
        }
        Owners::Users(v) => v.len() as i64,
    };
    Ok(BriefingData {
        slot,
        day: vn_day_key(now),
        period_label: w.period_label.to_owned(),
        reminder_label: w.reminder_label.to_owned(),
        scope: scope_kind(owners),
        people_count,
        metrics,
    })
}

async fn metrics(
    conn: &mut PgConnection,
    owners: &Owners,
    w: &SlotWindows,
    now: DateTime<Utc>,
) -> Result<Metrics, sqlx::Error> {
    let (all, ids) = split(owners);
    let new_contacts = Delta {
        value: new_contacts(conn, all, &ids, w.cur).await?,
        prev: new_contacts(conn, all, &ids, w.prev).await?,
    };
    let stage_changes = Delta {
        value: stage_changes(conn, all, &ids, w.cur).await?,
        prev: stage_changes(conn, all, &ids, w.prev).await?,
    };
    let deals_created = Delta {
        value: deals_created(conn, all, &ids, w.cur).await?,
        prev: deals_created(conn, all, &ids, w.prev).await?,
    };
    let won_now = deals_won(conn, all, &ids, w.cur).await?;
    let won_prev = deals_won(conn, all, &ids, w.prev).await?;
    let lost_now = deals_lost(conn, all, &ids, w.cur).await?;
    let lost_prev = deals_lost(conn, all, &ids, w.prev).await?;
    Ok(Metrics {
        new_contacts,
        stage_changes,
        deals_created,
        deals_won: Delta {
            value: won_now.0,
            prev: won_prev.0,
        },
        won_value: Delta {
            value: won_now.1,
            prev: won_prev.1,
        },
        deals_lost: Delta {
            value: lost_now,
            prev: lost_prev,
        },
        overdue_tasks: overdue_tasks(conn, all, &ids, now).await?,
        callbacks: callbacks(conn, all, &ids, w.callbacks).await?,
        top_sellers: top_sellers(conn, owners, w.cur).await?,
    })
}

async fn new_contacts(conn: &mut PgConnection, all: bool, ids: &[i32], r: Range) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM contacts c WHERE c.deleted_at IS NULL AND ($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2)) AND c.created_at >= $3 AND c.created_at < $4")
        .bind(all)
        .bind(ids)
        .bind(r.start)
        .bind(r.end)
        .fetch_one(conn)
        .await
}

async fn stage_changes(conn: &mut PgConnection, all: bool, ids: &[i32], r: Range) -> Result<i64, sqlx::Error> {
    // Chọn tất cả: không cần khách (kể cả hoạt động không gắn khách). Có phạm vi: khách phải trong phạm vi.
    sqlx::query_scalar(
        "SELECT count(*) FROM activities a WHERE a.action = 'stage_change' AND a.created_at >= $3 AND a.created_at < $4
           AND ($1 OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = a.contact_id AND c.deleted_at IS NULL AND (c.assigned_to = ANY($2) OR c.created_by_id = ANY($2))))",
    )
    .bind(all)
    .bind(ids)
    .bind(r.start)
    .bind(r.end)
    .fetch_one(conn)
    .await
}

async fn deals_created(conn: &mut PgConnection, all: bool, ids: &[i32], r: Range) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM deals d WHERE ($1 OR d.assigned_to = ANY($2) OR d.created_by = ANY($2)) AND d.created_at >= $3 AND d.created_at < $4")
        .bind(all)
        .bind(ids)
        .bind(r.start)
        .bind(r.end)
        .fetch_one(conn)
        .await
}

/// (số deal thắng, tổng giá trị VND) trong kỳ.
async fn deals_won(conn: &mut PgConnection, all: bool, ids: &[i32], r: Range) -> Result<(i64, i64), sqlx::Error> {
    sqlx::query_as(
        "SELECT count(*), COALESCE(sum(d.value), 0)::int8 FROM deals d
         WHERE ($1 OR d.assigned_to = ANY($2) OR d.created_by = ANY($2))
           AND d.status = 'won' AND ((d.won_at >= $3 AND d.won_at < $4) OR (d.won_at IS NULL AND d.updated_at >= $3 AND d.updated_at < $4))",
    )
    .bind(all)
    .bind(ids)
    .bind(r.start)
    .bind(r.end)
    .fetch_one(conn)
    .await
}

/// Deal thua: chưa có cột riêng nên dùng `updated_at`.
async fn deals_lost(conn: &mut PgConnection, all: bool, ids: &[i32], r: Range) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM deals d WHERE ($1 OR d.assigned_to = ANY($2) OR d.created_by = ANY($2)) AND d.status = 'lost' AND d.updated_at >= $3 AND d.updated_at < $4")
        .bind(all)
        .bind(ids)
        .bind(r.start)
        .bind(r.end)
        .fetch_one(conn)
        .await
}

async fn overdue_tasks(
    conn: &mut PgConnection,
    all: bool,
    ids: &[i32],
    now: DateTime<Utc>,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT count(*) FROM kanban_cards k WHERE ($1 OR k.assignee_id = ANY($2))
           AND k.deleted_at IS NULL AND k.completed_at IS NULL AND k.due_completed_at IS NULL AND k.due_at < $3",
    )
    .bind(all)
    .bind(ids)
    .bind(now)
    .fetch_one(conn)
    .await
}

async fn callbacks(conn: &mut PgConnection, all: bool, ids: &[i32], r: Range) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM contacts c WHERE c.deleted_at IS NULL AND ($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2)) AND c.reminder_at >= $3 AND c.reminder_at < $4")
        .bind(all)
        .bind(ids)
        .bind(r.start)
        .bind(r.end)
        .fetch_one(conn)
        .await
}

/// Chỉ có nghĩa khi phạm vi > 1 người; top 3 theo giá trị deal thắng trong kỳ. Bảng chỉ gồm người trong phạm vi (deal do người
/// trong nhóm tạo nhưng giao cho người ngoài nhóm vẫn tính vào số liệu chung, không hiện người ngoài nhóm ở bảng nổi bật).
/// Giá trị rỗng xếp như 0 (không lên đầu bảng như `DESC` mặc định của Postgres).
async fn top_sellers(conn: &mut PgConnection, owners: &Owners, r: Range) -> Result<Vec<TopSeller>, sqlx::Error> {
    if matches!(owners, Owners::Users(v) if v.len() <= 1) {
        return Ok(Vec::new());
    }
    let (all, ids) = split(owners);
    let rows: Vec<(i32, i64, Option<i64>)> = sqlx::query_as(
        "SELECT d.assigned_to, count(*), sum(d.value)::int8 FROM deals d
         WHERE ($1 OR d.assigned_to = ANY($2) OR d.created_by = ANY($2))
           AND ($1 OR d.assigned_to = ANY($2))
           AND d.status = 'won' AND ((d.won_at >= $3 AND d.won_at < $4) OR (d.won_at IS NULL AND d.updated_at >= $3 AND d.updated_at < $4))
         GROUP BY d.assigned_to ORDER BY COALESCE(sum(d.value), 0) DESC, d.assigned_to LIMIT 3",
    )
    .bind(all)
    .bind(&ids)
    .bind(r.start)
    .bind(r.end)
    .fetch_all(&mut *conn)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let user_ids: Vec<i32> = rows.iter().map(|r| r.0).collect();
    let names: Vec<(i32, String)> = sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
        .bind(&user_ids)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(uid, count, sum)| TopSeller {
            user_id: uid,
            name: names
                .iter()
                .find(|n| n.0 == uid)
                .map_or_else(|| format!("#{uid}"), |n| n.1.clone()),
            won_count: count,
            won_value: sum.unwrap_or(0),
        })
        .collect())
}
