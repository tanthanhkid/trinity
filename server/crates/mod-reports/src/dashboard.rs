//! `GET /reports/dashboard-overview`: KPI + biểu đồ 6 tháng của màn Tổng quan (chuyển từ `dashboard-overview.service.ts`).
//! Cache 5 phút theo người dùng, bộ lọc và phạm vi (RAM).

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::{OwnerIds, Scope, scope_of};

use crate::cache::ReadCache;
use crate::filter::{self, Filter};
use crate::period::{VnRange, month_label, month_range, num};
use crate::{Actor, Ctx, R, db, now, owner_part};

pub const TTL: Duration = Duration::from_secs(300);
const CACHE_VERSION: &str = "v3";
const MONTHS: i32 = 6;

/// `value`, `updated_at`, `won_at` của thương vụ thắng.
type WonRow = (Option<i64>, DateTime<Utc>, Option<DateTime<Utc>>);

fn label(actor: &Actor, filtered: bool) -> &'static str {
    if filtered {
        return "theo bộ lọc";
    }
    match scope_of(&actor.grants, "reports.overview") {
        Some(Scope::Own) => "cá nhân",
        Some(Scope::Team) => "team",
        Some(Scope::Subtree) => "phòng",
        _ => "toàn hệ thống",
    }
}

async fn count_in(conn: &mut PgConnection, sql: &str, ids: &[i32], all: bool, r: VnRange) -> R<i64> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(all)
        .bind(ids)
        .bind(r.start)
        .bind(r.end)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)
}

pub async fn get_overview(ctx: &Ctx, actor: &Actor, f: &Filter) -> R<Value> {
    get_overview_at(ctx, actor, f, now()).await
}

pub async fn get_overview_at(ctx: &Ctx, actor: &Actor, f: &Filter, at: DateTime<Utc>) -> R<Value> {
    let owner = ctx
        .owner_ids(actor, "reports.overview")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let mut c = ctx.conn(actor.company).await?;
    let filter_ids = filter::resolve_ids(&mut c, actor, f).await?;
    let scope = filter::compose(&owner, filter_ids.as_deref());
    let key = ReadCache::tenant_key(
        actor.company,
        &format!(
            "dashboard:overview:{CACHE_VERSION}:{}:{}:{}",
            actor.user_id,
            filter::cache_key(actor, f),
            owner_part(Some(&scope))
        ),
    );
    if let Some(hit) = ctx.cache.get(&key) {
        return Ok(hit);
    }
    let result = compute(&mut c, actor, &scope, filter_ids.is_some(), at).await?;
    ctx.cache.set(key, result.clone(), TTL);
    Ok(result)
}

async fn compute(
    conn: &mut PgConnection,
    actor: &Actor,
    scope: &OwnerIds,
    filtered: bool,
    at: DateTime<Utc>,
) -> R<Value> {
    let offsets: Vec<i32> = (0..MONTHS).map(|i| MONTHS - 1 - i).collect(); // cũ → mới
    let months: Vec<String> = offsets.iter().map(|o| month_label(*o, at)).collect();
    let (ids, all) = match scope {
        OwnerIds::All => (Vec::new(), true),
        OwnerIds::Ids(v) => (v.clone(), false),
    };
    if !all && ids.is_empty() {
        return Ok(json!({
            "scope_label": label(actor, filtered),
            "customers": { "total": 0, "new_this_month": 0, "new_last_month": 0 },
            "opportunities": { "open": 0, "new_this_month": 0, "new_last_month": 0 },
            "revenue": { "this_month": null, "last_month": null },
            "deal_status": { "open": 0, "won": 0, "lost": 0 },
            "months": months,
            "customers_by_month": months.iter().map(|_| 0).collect::<Vec<_>>(),
            "opportunities_by_month": months.iter().map(|_| 0).collect::<Vec<_>>(),
            "revenue_by_month": months.iter().map(|_| Value::Null).collect::<Vec<_>>(),
        }));
    }
    let contact_sql = "SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND ($1 OR assigned_to = ANY($2) OR created_by_id = ANY($2)) AND created_at >= $3 AND created_at < $4";
    let deal_sql = "SELECT count(*) FROM deals WHERE ($1 OR assigned_to = ANY($2) OR created_by = ANY($2)) AND created_at >= $3 AND created_at < $4";
    let mut customers_by_month = Vec::new();
    for o in &offsets {
        customers_by_month.push(count_in(conn, contact_sql, &ids, all, month_range(*o, at)).await?);
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND ($1 OR assigned_to = ANY($2) OR created_by_id = ANY($2))")
        .bind(all)
        .bind(&ids)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    let groups: Vec<(String, i64)> = sqlx::query_as("SELECT status, count(*) FROM deals WHERE ($1 OR assigned_to = ANY($2) OR created_by = ANY($2)) GROUP BY status")
        .bind(all)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let oldest = month_range(MONTHS - 1, at).start;
    // Deal thắng trong khoảng: `won_at`, hoặc `updated_at` nếu thắng từ trước khi có `won_at`.
    let won: Vec<WonRow> = sqlx::query_as(
        "SELECT value, updated_at, won_at FROM deals WHERE ($1 OR assigned_to = ANY($2) OR created_by = ANY($2)) AND status = 'won'
           AND (won_at >= $3 OR (won_at IS NULL AND updated_at >= $3))",
    )
    .bind(all)
    .bind(&ids)
    .bind(oldest)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let mut new_deals = Vec::new();
    for o in &offsets {
        new_deals.push(count_in(conn, deal_sql, &ids, all, month_range(*o, at)).await?);
    }
    let status: BTreeMap<&str, i64> = groups
        .iter()
        .filter(|(s, _)| matches!(s.as_str(), "open" | "won" | "lost"))
        .map(|(s, n)| (s.as_str(), *n))
        .collect();
    let st = |k: &str| status.get(k).copied().unwrap_or(0);
    let revenue_by_month: Vec<Option<f64>> = offsets
        .iter()
        .map(|o| {
            let r = month_range(*o, at);
            let mut sum: Option<f64> = None;
            for (value, updated, won_at) in &won {
                let on = won_at.unwrap_or(*updated);
                let Some(v) = value else { continue };
                if on < r.start || on >= r.end {
                    continue;
                }
                sum = Some(sum.unwrap_or(0.0) + *v as f64);
            }
            sum
        })
        .collect();
    let last = usize::try_from(MONTHS - 1).unwrap_or(5);
    let rev = |i: usize| revenue_by_month[i].map_or(Value::Null, num);
    Ok(json!({
        "scope_label": label(actor, filtered),
        "customers": { "total": total, "new_this_month": customers_by_month[last], "new_last_month": customers_by_month[last - 1] },
        "opportunities": { "open": st("open"), "new_this_month": new_deals[last], "new_last_month": new_deals[last - 1] },
        "revenue": { "this_month": rev(last), "last_month": rev(last - 1) },
        "deal_status": { "open": st("open"), "won": st("won"), "lost": st("lost") },
        "months": months,
        "customers_by_month": customers_by_month,
        "opportunities_by_month": new_deals,
        "revenue_by_month": (0..revenue_by_month.len()).map(rev).collect::<Vec<_>>(),
    }))
}
