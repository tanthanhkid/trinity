//! `GET /reports/dashboard-trend-14d`: chuỗi 14 ngày cho thẻ chỉ số (chuyển từ `dashboard-trend.service.ts`). Ngày theo giờ
//! Việt Nam, cũ → mới, điểm cuối là hôm nay; ngày không phát sinh trả 0. Chuỗi thiếu quyền nguồn vắng khỏi `series`.
//! Cache 120 giây.

use std::time::Duration;

use chrono::{DateTime, Duration as Dur, Utc};
use serde_json::{Map, Value, json};
use trinity_rbac::OwnerIds;

use crate::cache::ReadCache;
use crate::period::day_range;
use crate::{Actor, Ctx, R, db, now, owner_part};

pub const TTL: Duration = Duration::from_secs(120);
const CACHE_VERSION: &str = "v5";
pub const DAYS: usize = 14;

fn day_key(start: DateTime<Utc>) -> String {
    (start + Dur::hours(7)).format("%Y-%m-%d").to_string()
}

pub async fn get(ctx: &Ctx, actor: &Actor) -> R<Value> {
    get_at(ctx, actor, now()).await
}

pub async fn get_at(ctx: &Ctx, actor: &Actor, at: DateTime<Utc>) -> R<Value> {
    let contacts = ctx.owner_ids(actor, "contacts.view").await?;
    // Chuỗi không phụ thuộc danh tính (`all`/`none`) thì mọi người cùng phạm vi dùng chung một lần quét.
    let who = if matches!(contacts, None | Some(OwnerIds::All)) {
        "shared".to_owned()
    } else {
        actor.user_id.to_string()
    };
    let key = ReadCache::tenant_key(
        actor.company,
        &format!(
            "dashboard:trend14:{CACHE_VERSION}:{who}:k{}",
            owner_part(contacts.as_ref())
        ),
    );
    if let Some(hit) = ctx.cache.get(&key) {
        return Ok(hit);
    }
    let days: Vec<String> = (0..DAYS)
        .rev()
        .map(|i| day_key(day_range(i as i64, at).start))
        .collect();
    let mut series = Map::new();
    if let Some(owner) = &contacts {
        let mut counts = vec![0_i64; DAYS];
        if !matches!(owner, OwnerIds::Ids(v) if v.is_empty()) {
            let (all, ids) = match owner {
                OwnerIds::All => (true, Vec::new()),
                OwnerIds::Ids(v) => (false, v.clone()),
            };
            let mut c = ctx.conn(actor.company).await?;
            let rows: Vec<(String, i64)> = sqlx::query_as(
                "SELECT to_char((created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD'), count(*) FROM contacts
                 WHERE created_at >= $1 AND created_at < $2 AND deleted_at IS NULL AND ($3 OR assigned_to = ANY($4) OR created_by_id = ANY($4))
                 GROUP BY 1",
            )
            .bind(day_range((DAYS - 1) as i64, at).start)
            .bind(day_range(0, at).end)
            .bind(all)
            .bind(&ids)
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
            for (d, n) in rows {
                if let Some(i) = days.iter().position(|x| *x == d) {
                    counts[i] = n;
                }
            }
        }
        series.insert("interest".to_owned(), json!(counts));
    }
    let result = json!({ "days": days, "series": series });
    ctx.cache.set(key, result.clone(), TTL);
    Ok(result)
}
