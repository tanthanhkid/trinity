//! `GET /reports/dashboard-stats-today`: thẻ "quan tâm" hôm nay so với hôm qua (chuyển từ
//! `dashboard-stats-today.service.ts`). Khối thiếu quyền nguồn (`contacts.view`) trả `null`, không phải 0. Cache 15 giây.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::{OwnerIds, Scope, scope_of};

use crate::cache::ReadCache;
use crate::overview::scope_label;
use crate::period::{VnRange, day_range};
use crate::{Actor, Ctx, R, db, now, owner_part};

pub const TTL: Duration = Duration::from_secs(15);
const CACHE_VERSION: &str = "v22";

pub(crate) async fn count_contacts(conn: &mut PgConnection, owner: &OwnerIds, r: VnRange) -> R<i64> {
    let (all, ids) = match owner {
        OwnerIds::All => (true, Vec::new()),
        OwnerIds::Ids(v) => (false, v.clone()),
    };
    sqlx::query_scalar(
        "SELECT count(*) FROM contacts WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2 AND ($3 OR assigned_to = ANY($4) OR created_by_id = ANY($4))",
    )
    .bind(r.start)
    .bind(r.end)
    .bind(all)
    .bind(&ids)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)
}

pub async fn get(ctx: &Ctx, actor: &Actor) -> R<Value> {
    get_at(ctx, actor, now()).await
}

pub async fn get_at(ctx: &Ctx, actor: &Actor, at: DateTime<Utc>) -> R<Value> {
    let contacts = ctx.owner_ids(actor, "contacts.view").await?;
    let overview = ctx.owner_ids(actor, "reports.overview").await?;
    let key = ReadCache::tenant_key(
        actor.company,
        &format!(
            "dashboard:{CACHE_VERSION}:today:{}:k{}",
            actor.user_id,
            owner_part(contacts.as_ref())
        ),
    );
    if let Some(hit) = ctx.cache.get(&key) {
        return Ok(hit);
    }
    let (today, yesterday) = match &contacts {
        Some(o) => {
            let mut c = ctx.conn(actor.company).await?;
            (
                Some(count_contacts(&mut c, o, day_range(0, at)).await?),
                Some(count_contacts(&mut c, o, day_range(1, at)).await?),
            )
        }
        None => (None, None),
    };
    let scope = scope_of(&actor.grants, "reports.overview");
    // Số nhân viên trong phạm vi: chỉ có nghĩa ở phạm vi nhóm / cấp dưới.
    let team_size = match (scope, &overview) {
        (Some(Scope::Team | Scope::Subtree), Some(OwnerIds::Ids(v))) => Some(v.len()),
        _ => None,
    };
    let result = json!({ "interest_total": today, "interest_yesterday": yesterday, "team_size": team_size, "scope_label": scope_label(scope) });
    ctx.cache.set(key, result.clone(), TTL);
    Ok(result)
}
