//! `GET /reports/overview`: khách mới và hoạt động của kỳ so với kỳ liền trước (chuyển từ `report-overview.service.ts`).

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::{OwnerIds, Scope, scope_of};

use crate::period::{Period, delta_metric, parse_period, previous_period};
use crate::{Actor, Ctx, R, db, now};

pub fn scope_label(s: Option<Scope>) -> &'static str {
    match s {
        Some(Scope::Own) => "Của mình",
        Some(Scope::Team) => "Nhóm",
        Some(Scope::Subtree) => "Toàn bộ cấp dưới",
        Some(Scope::All) | None => "Toàn công ty",
    }
}

async fn bundle(conn: &mut PgConnection, owner: &OwnerIds, p: Period) -> R<(i64, i64)> {
    let ids: Vec<i32> = match owner {
        OwnerIds::All => Vec::new(),
        OwnerIds::Ids(v) => v.clone(),
    };
    let all = matches!(owner, OwnerIds::All);
    let customers: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND created_at >= $1 AND created_at <= $2
           AND ($3 OR assigned_to = ANY($4) OR created_by_id = ANY($4))",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(all)
    .bind(&ids)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    let activities: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activities WHERE created_at >= $1 AND created_at <= $2 AND ($3 OR created_by = ANY($4))",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(all)
    .bind(&ids)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    Ok((customers, activities))
}

pub async fn get(ctx: &Ctx, actor: &Actor, date_from: Option<&str>, date_to: Option<&str>) -> R<Value> {
    get_at(ctx, actor, date_from, date_to, now()).await
}

pub async fn get_at(
    ctx: &Ctx,
    actor: &Actor,
    date_from: Option<&str>,
    date_to: Option<&str>,
    at: DateTime<Utc>,
) -> R<Value> {
    let period = parse_period(date_from, date_to, at)?;
    let owner = ctx
        .owner_ids(actor, "reports.overview")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let label = scope_label(scope_of(&actor.grants, "reports.overview"));
    if matches!(&owner, OwnerIds::Ids(v) if v.is_empty()) {
        let zero = delta_metric(0, 0);
        return Ok(json!({ "new_customers": zero, "activities": zero, "scope_label": label }));
    }
    let mut c = ctx.conn(actor.company).await?;
    let (cur, prev) = (
        bundle(&mut c, &owner, period).await?,
        bundle(&mut c, &owner, previous_period(period)).await?,
    );
    Ok(
        json!({ "new_customers": delta_metric(cur.0, prev.0), "activities": delta_metric(cur.1, prev.1), "scope_label": label }),
    )
}
