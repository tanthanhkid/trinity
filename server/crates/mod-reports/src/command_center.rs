//! `GET /reports/dashboard-command-center`: bốn khối của bố cục "Trung tâm điều hành" (issue #606): phễu bán hàng, nhiệt hoạt
//! động theo `thứ × giờ`, xếp hạng nhân viên và tỉ lệ thắng (kèm kỳ trước). Kỳ chọn qua `date_from`/`date_to` (như
//! `/reports/overview`); riêng nhiệt luôn là 7 ngày gần nhất. Mọi số đều nằm TRONG phạm vi `reports.overview` của người gọi:
//! vai chỉ xem của mình chỉ thấy số của mình (xếp hạng chỉ có đúng một dòng). Giờ theo múi `Asia/Ho_Chi_Minh` (múi của tổ chức).
//! Cache 120 giây theo người dùng, phạm vi và kỳ.

use std::collections::BTreeMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::OwnerIds;

use crate::cache::ReadCache;
use crate::overview::scope_label;
use crate::period::{Period, day_range, num, parse_period, previous_period, to_fixed_1};
use crate::{Actor, Ctx, R, db, now, owner_part};

pub const TTL: Duration = Duration::from_secs(120);
const CACHE_VERSION: &str = "v1";
/// Số dòng tối đa của bảng xếp hạng.
pub const TOP_N: usize = 10;

fn split(owner: &OwnerIds) -> (bool, Vec<i32>) {
    match owner {
        OwnerIds::All => (true, Vec::new()),
        OwnerIds::Ids(v) => (false, v.clone()),
    }
}

/// Tỉ lệ thắng theo phần trăm một chữ số thập phân; `null` khi chưa có thương vụ nào đóng.
pub fn win_rate(won: i64, lost: i64) -> Value {
    let total = won + lost;
    if total == 0 {
        Value::Null
    } else {
        num(to_fixed_1(won as f64 / total as f64 * 100.0))
    }
}

/// Ma trận 7 × 24 (hàng 0 = thứ Hai … 6 = Chủ nhật) từ các ô `(isodow 1..7, giờ 0..23, số)`; ô ngoài miền bị bỏ qua.
pub fn heat_matrix(cells: &[(i32, i32, i64)]) -> Vec<Vec<i64>> {
    let mut m = vec![vec![0_i64; 24]; 7];
    for &(dow, hour, n) in cells {
        if (1..=7).contains(&dow) && (0..24).contains(&hour) {
            m[(dow - 1) as usize][hour as usize] += n;
        }
    }
    m
}

/// Các giờ đông nhất trong ngày (cộng theo mọi thứ), tối đa `k` giờ, theo thứ tự giờ tăng dần; rỗng khi không có hoạt động.
pub fn peak_hours(m: &[Vec<i64>], k: usize) -> Vec<usize> {
    let mut by_hour: Vec<(usize, i64)> = (0..24).map(|h| (h, m.iter().map(|r| r[h]).sum())).collect();
    by_hour.retain(|x| x.1 > 0);
    by_hour.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut top: Vec<usize> = by_hour.into_iter().take(k).map(|x| x.0).collect();
    top.sort_unstable();
    top
}

async fn funnel(conn: &mut PgConnection, owner: &OwnerIds, p: Period) -> R<Value> {
    let (all, ids) = split(owner);
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
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT status, count(*), COALESCE(sum(value), 0)::bigint FROM deals
          WHERE created_at >= $1 AND created_at <= $2 AND ($3 OR assigned_to = ANY($4) OR created_by = ANY($4))
          GROUP BY status",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(all)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let by = |s: &str| rows.iter().find(|r| r.0 == s).map_or((0, 0), |r| (r.1, r.2));
    let (open, won, lost) = (by("open"), by("won"), by("lost"));
    let total = (
        rows.iter().map(|r| r.1).sum::<i64>(),
        rows.iter().map(|r| r.2).sum::<i64>(),
    );
    let st = |(count, value): (i64, i64)| json!({ "count": count, "value": value });
    Ok(json!({
        "stages": [
            { "key": "customers", "count": customers, "value": null },
            { "key": "opportunities", "count": total.0, "value": total.1 },
            { "key": "won", "count": won.0, "value": won.1 },
        ],
        "by_status": { "open": st(open), "won": st(won), "lost": st(lost) },
    }))
}

/// Thắng/thua đóng trong kỳ: thắng tính theo `won_at` (hoặc `updated_at` với thương vụ cũ chưa có `won_at`), thua theo `updated_at`.
async fn closed(conn: &mut PgConnection, owner: &OwnerIds, p: Period) -> R<(i64, i64)> {
    let (all, ids) = split(owner);
    sqlx::query_as(
        "SELECT count(*) FILTER (WHERE status = 'won' AND COALESCE(won_at, updated_at) >= $1 AND COALESCE(won_at, updated_at) <= $2),
                count(*) FILTER (WHERE status = 'lost' AND updated_at >= $1 AND updated_at <= $2)
           FROM deals WHERE ($3 OR assigned_to = ANY($4) OR created_by = ANY($4))",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(all)
    .bind(&ids)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)
}

async fn win(conn: &mut PgConnection, owner: &OwnerIds, p: Period) -> R<Value> {
    let (won, lost) = closed(conn, owner, p).await?;
    let (pw, pl) = closed(conn, owner, previous_period(p)).await?;
    Ok(json!({
        "won": won, "lost": lost, "rate": win_rate(won, lost),
        "previous": { "won": pw, "lost": pl, "rate": win_rate(pw, pl) },
    }))
}

/// Xếp hạng: chỉ người nằm trong phạm vi. Sắp theo doanh thu thắng, rồi số cơ hội thắng, rồi việc hoàn thành.
async fn leaderboard(conn: &mut PgConnection, owner: &OwnerIds, p: Period) -> R<Value> {
    let (all, ids) = split(owner);
    let won: Vec<(i32, i64, i64)> = sqlx::query_as(
        "SELECT assigned_to, count(*), COALESCE(sum(value), 0)::bigint FROM deals
          WHERE status = 'won' AND COALESCE(won_at, updated_at) >= $1 AND COALESCE(won_at, updated_at) <= $2
            AND ($3 OR assigned_to = ANY($4)) GROUP BY assigned_to",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(all)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let tasks: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT assignee_id, count(*) FROM kanban_cards
          WHERE deleted_at IS NULL AND assignee_id IS NOT NULL AND completed_at >= $1 AND completed_at <= $2
            AND ($3 OR assignee_id = ANY($4)) GROUP BY assignee_id",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(all)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    // (số thắng, doanh thu thắng, việc xong)
    let mut agg: BTreeMap<i32, (i64, i64, i64)> = BTreeMap::new();
    for (u, n, v) in won {
        let e = agg.entry(u).or_default();
        e.0 = n;
        e.1 = v;
    }
    for (u, n) in tasks {
        agg.entry(u).or_default().2 = n;
    }
    let mut order: Vec<(i32, (i64, i64, i64))> = agg.into_iter().collect();
    order.sort_by(|a, b| {
        b.1.1
            .cmp(&a.1.1)
            .then(b.1.0.cmp(&a.1.0))
            .then(b.1.2.cmp(&a.1.2))
            .then(a.0.cmp(&b.0))
    });
    order.truncate(TOP_N);
    let uids: Vec<i32> = order.iter().map(|o| o.0).collect();
    let names: Vec<(i32, String)> = if uids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
            .bind(&uids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    Ok(Value::Array(
        order
            .into_iter()
            .map(|(id, (won_count, won_value, tasks_done))| {
                let name = names
                    .iter()
                    .find(|n| n.0 == id)
                    .map_or_else(|| format!("NV #{id}"), |n| n.1.clone());
                json!({ "user_id": id, "full_name": name, "won_count": won_count, "won_value": won_value, "tasks_done": tasks_done })
            })
            .collect(),
    ))
}

/// Hoạt động 7 ngày gần nhất: tương tác (`activities`), việc hoàn thành (thẻ Kanban) và tin nhắn Zalo OA / Fanpage.
/// Phạm vi theo người tạo / người được giao / người gửi; phạm vi `All` đếm cả tin khách gửi tới (không có người gửi).
async fn heat(conn: &mut PgConnection, owner: &OwnerIds, at: DateTime<Utc>) -> R<Value> {
    let (all, ids) = split(owner);
    let from = day_range(6, at).start;
    let to = day_range(0, at).end;
    let cells: Vec<(i32, i32, i64)> = sqlx::query_as(
        "SELECT extract(isodow FROM ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::int, extract(hour FROM ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::int, count(*)
           FROM (
             SELECT created_at AS ts FROM activities WHERE created_at >= $1 AND created_at < $2 AND ($3 OR created_by = ANY($4))
             UNION ALL
             SELECT completed_at FROM kanban_cards WHERE deleted_at IS NULL AND completed_at >= $1 AND completed_at < $2 AND ($3 OR assignee_id = ANY($4))
             UNION ALL
             SELECT created_at FROM zalo_oa_messages WHERE created_at >= $1 AND created_at < $2 AND ($3 OR sent_by = ANY($4))
             UNION ALL
             SELECT sent_at FROM facebook_messages WHERE sent_at >= $1 AND sent_at < $2 AND ($3 OR sent_by_user_id = ANY($4))
           ) e GROUP BY 1, 2",
    )
    .bind(from)
    .bind(to)
    .bind(all)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let m = heat_matrix(&cells);
    let total: i64 = m.iter().flatten().sum();
    let max = m.iter().flatten().copied().max().unwrap_or(0);
    Ok(
        json!({ "cells": m, "max": max, "total": total, "peak_hours": peak_hours(&m, 2), "timezone": "Asia/Ho_Chi_Minh" }),
    )
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
    let owner = ctx.owner_ids(actor, "reports.overview").await?;
    let label = scope_label(trinity_rbac::scope_of(&actor.grants, "reports.overview"));
    let owner = owner.unwrap_or(OwnerIds::Ids(Vec::new()));
    let key = ReadCache::tenant_key(
        actor.company,
        &format!(
            "dashboard:command:{CACHE_VERSION}:{}:{}:{}:{}",
            actor.user_id,
            owner_part(Some(&owner)),
            period.from.timestamp_millis(),
            period.to.timestamp_millis()
        ),
    );
    if let Some(hit) = ctx.cache.get(&key) {
        return Ok(hit);
    }
    let result = if matches!(&owner, OwnerIds::Ids(v) if v.is_empty()) {
        json!({
            "scope_label": label,
            "funnel": {
                "stages": [
                    { "key": "customers", "count": 0, "value": null },
                    { "key": "opportunities", "count": 0, "value": 0 },
                    { "key": "won", "count": 0, "value": 0 },
                ],
                "by_status": { "open": { "count": 0, "value": 0 }, "won": { "count": 0, "value": 0 }, "lost": { "count": 0, "value": 0 } },
            },
            "heatmap": { "cells": heat_matrix(&[]), "max": 0, "total": 0, "peak_hours": [], "timezone": "Asia/Ho_Chi_Minh" },
            "leaderboard": [],
            "win_rate": { "won": 0, "lost": 0, "rate": null, "previous": { "won": 0, "lost": 0, "rate": null } },
        })
    } else {
        let mut c = ctx.conn(actor.company).await?;
        json!({
            "scope_label": label,
            "funnel": funnel(&mut c, &owner, period).await?,
            "heatmap": heat(&mut c, &owner, at).await?,
            "leaderboard": leaderboard(&mut c, &owner, period).await?,
            "win_rate": win(&mut c, &owner, period).await?,
        })
    };
    ctx.cache.set(key, result.clone(), TTL);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ti_le_thang() {
        assert_eq!(win_rate(0, 0), Value::Null);
        assert_eq!(win_rate(58, 58), json!(50));
        assert_eq!(win_rate(1, 2), json!(33.3));
        assert_eq!(win_rate(0, 4), json!(0));
    }

    #[test]
    fn ma_tran_nhiet_va_gio_cao_diem() {
        let m = heat_matrix(&[(1, 9, 5), (1, 9, 2), (7, 23, 1), (8, 0, 9), (0, 0, 9), (3, 24, 9)]);
        assert_eq!((m.len(), m[0].len()), (7, 24));
        assert_eq!((m[0][9], m[6][23]), (7, 1));
        assert_eq!(m.iter().flatten().sum::<i64>(), 8, "ô ngoài miền bị bỏ");
        assert_eq!(peak_hours(&m, 2), [9, 23]);
        assert!(peak_hours(&heat_matrix(&[]), 2).is_empty());
    }
}
