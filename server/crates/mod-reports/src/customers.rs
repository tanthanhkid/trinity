//! Nhóm "Khách hàng" (`report-customers.service.ts`, `report-customers-uncontacted.service.ts`): khách mới theo thời gian + phân bổ
//! theo Nguồn / Trạng thái / Người phụ trách, và khách chưa được chăm sóc quá N ngày. Phạm vi theo quyền `reports.customers`
//! (chủ sở hữu = `assigned_to` HOẶC `created_by_id`); SĐT che theo `contacts.phone_full`.

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_kernel::error::HttpError;
use trinity_rbac::{OwnerIds, PhoneMasker};

use crate::buckets::{build_buckets, pick_granularity};
use crate::period::{Period, parse_period};
use crate::{Actor, Ctx, R, db, iso, now};

const DEFAULT_DAYS: i64 = 7;
const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 100;

/// `(tất cả, danh sách id)` để bind: `All` ⇒ điều kiện `$all` đúng, không cần danh sách.
pub(crate) fn split_owner(o: &OwnerIds) -> (bool, Vec<i32>) {
    match o {
        OwnerIds::All => (true, Vec::new()),
        OwnerIds::Ids(v) => (false, v.clone()),
    }
}

/// Điều kiện phạm vi của khách: `($all OR c.assigned_to = ANY($ids) OR c.created_by_id = ANY($ids))`.
const SCOPE: &str = "($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2))";

/// Dòng phân bổ `{ id, label, count }`.
fn item(id: Option<i32>, label: String, count: i64) -> (i64, Value) {
    (count, json!({ "id": id, "label": label, "count": count }))
}

/// Sắp theo số đếm giảm dần, ổn định (cùng số đếm giữ thứ tự theo khoá nhóm).
fn sorted(mut v: Vec<(i64, Value)>) -> Vec<Value> {
    v.sort_by_key(|x| std::cmp::Reverse(x.0));
    v.into_iter().map(|x| x.1).collect()
}

async fn option_labels(c: &mut PgConnection, ids: &[i32]) -> R<std::collections::BTreeMap<i32, String>> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(i32, String)> = sqlx::query_as("SELECT id, label FROM setting_options WHERE id = ANY($1)")
        .bind(ids)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    Ok(rows.into_iter().collect())
}

async fn employee_names(c: &mut PgConnection, ids: &[i32]) -> R<std::collections::BTreeMap<i32, String>> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(i32, String)> = sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
        .bind(ids)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    Ok(rows.into_iter().collect())
}

pub async fn overview(ctx: &Ctx, actor: &Actor, date_from: Option<&str>, date_to: Option<&str>) -> R<Value> {
    overview_at(ctx, actor, date_from, date_to, now()).await
}

pub async fn overview_at(
    ctx: &Ctx,
    actor: &Actor,
    date_from: Option<&str>,
    date_to: Option<&str>,
    at: DateTime<Utc>,
) -> R<Value> {
    let period = parse_period(date_from, date_to, at)?;
    let owner = ctx
        .owner_ids(actor, "reports.customers")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let (all, ids) = split_owner(&owner);
    let mut c = ctx.conn(actor.company).await?;
    let trend = trend(&mut c, all, &ids, period).await?;
    let base =
        format!("FROM contacts c WHERE c.deleted_at IS NULL AND {SCOPE} AND c.created_at >= $3 AND c.created_at <= $4");
    let group = |col: &str| format!("SELECT c.{col}, count(*) {base} GROUP BY c.{col} ORDER BY c.{col} ASC NULLS LAST");
    let by_source: Vec<(Option<i32>, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(group("source_id")))
        .bind(all)
        .bind(&ids)
        .bind(period.from)
        .bind(period.to)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    let by_status: Vec<(Option<i32>, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(group("contact_status_id")))
        .bind(all)
        .bind(&ids)
        .bind(period.from)
        .bind(period.to)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    let by_assignee: Vec<(Option<i32>, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(group("assigned_to")))
        .bind(all)
        .bind(&ids)
        .bind(period.from)
        .bind(period.to)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    let src_labels = option_labels(&mut c, &by_source.iter().filter_map(|r| r.0).collect::<Vec<_>>()).await?;
    let st_labels = option_labels(&mut c, &by_status.iter().filter_map(|r| r.0).collect::<Vec<_>>()).await?;
    let names = employee_names(&mut c, &by_assignee.iter().filter_map(|r| r.0).collect::<Vec<_>>()).await?;
    let opt = |labels: &std::collections::BTreeMap<i32, String>, rows: &[(Option<i32>, i64)]| {
        sorted(
            rows.iter()
                .map(|(id, n)| {
                    item(
                        *id,
                        id.map_or_else(
                            || "Chưa xác định".to_owned(),
                            |i| labels.get(&i).cloned().unwrap_or_else(|| format!("#{i}")),
                        ),
                        *n,
                    )
                })
                .collect(),
        )
    };
    let assignee = sorted(
        by_assignee
            .iter()
            .map(|(id, n)| {
                item(
                    *id,
                    id.map_or_else(
                        || "Chưa gán".to_owned(),
                        |i| names.get(&i).cloned().unwrap_or_else(|| format!("NV #{i}")),
                    ),
                    *n,
                )
            })
            .collect(),
    );
    Ok(json!({
        "trend": trend,
        "by_source": opt(&src_labels, &by_source),
        "by_status": opt(&st_labels, &by_status),
        "by_assignee": assignee,
    }))
}

/// Đếm khách mới theo bucket bằng MỘT truy vấn (mỗi bucket một nhóm), không kéo dòng.
async fn trend(c: &mut PgConnection, all: bool, ids: &[i32], p: Period) -> R<Vec<Value>> {
    let buckets = build_buckets(p.from, p.to, pick_granularity(p.from, p.to));
    let starts: Vec<DateTime<Utc>> = buckets.iter().map(|b| b.start).collect();
    let ends: Vec<DateTime<Utc>> = buckets.iter().map(|b| b.end).collect();
    let rows: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT b.i, count(c.id) FROM unnest($5::timestamptz[], $6::timestamptz[]) WITH ORDINALITY AS b(s, e, i)
         LEFT JOIN contacts c ON c.deleted_at IS NULL AND c.created_at >= $3 AND c.created_at <= $4
           AND (c.created_at >= b.s AND c.created_at < b.e) AND ($1 OR c.assigned_to = ANY($2) OR c.created_by_id = ANY($2))
         GROUP BY b.i",
    )
    .bind(all)
    .bind(ids)
    .bind(p.from)
    .bind(p.to)
    .bind(&starts)
    .bind(&ends)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let count = |i: usize| {
        rows.iter()
            .find(|r| usize::try_from(r.0).ok() == Some(i + 1))
            .map_or(0, |r| r.1)
    };
    Ok(buckets
        .iter()
        .enumerate()
        .map(|(i, b)| json!({ "label": b.label, "count": count(i) }))
        .collect())
}

/// Đầu vào của "chưa chăm sóc" đã qua K15 (`days` ∈ 7/14/30, `cursor` ≥ 1, `limit` ≥ 1).
#[derive(Debug, Clone, Copy, Default)]
pub struct Uncontacted {
    pub days: Option<i64>,
    pub cursor: Option<i64>,
    pub limit: Option<i64>,
}

impl Uncontacted {
    pub fn from_validated(v: &Value) -> Self {
        let n = |k: &str| v.get(k).and_then(Value::as_i64);
        Self {
            days: n("days"),
            cursor: n("cursor"),
            limit: n("limit"),
        }
    }
}

pub async fn uncontacted(ctx: &Ctx, actor: &Actor, q: &Uncontacted) -> R<Value> {
    uncontacted_at(ctx, actor, q, now()).await
}

pub async fn uncontacted_at(ctx: &Ctx, actor: &Actor, q: &Uncontacted, at: DateTime<Utc>) -> R<Value> {
    let days = q.days.unwrap_or(DEFAULT_DAYS);
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
    // `contacts.id` là int4: con trỏ ngoài miền ⇒ 400 (không phải 500 như lỗi tràn của ORM).
    let cursor = match q.cursor {
        Some(c) => {
            Some(i32::try_from(c).map_err(|_| HttpError::bad_request("cursor must not be greater than 2147483647"))?)
        }
        None => None,
    };
    let cutoff = at - Duration::days(days);
    let owner = ctx
        .owner_ids(actor, "reports.customers")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    let phone_owner = ctx.owner_ids(actor, "contacts.phone_full").await?;
    let (all, ids) = split_owner(&owner);
    let mut c = ctx.conn(actor.company).await?;
    // Như `cursor` + `skip: 1` của Prisma: con trỏ phải là dòng có thật (không thì rỗng); lấy `id <= con trỏ` rồi bỏ dòng đầu.
    let paging = if cursor.is_some() {
        "AND c.id <= $4 AND EXISTS (SELECT 1 FROM contacts x WHERE x.id = $4) ORDER BY c.id DESC LIMIT $5 OFFSET 1"
    } else {
        "ORDER BY c.id DESC LIMIT $5"
    };
    let sql = format!(
        "SELECT c.id, c.full_name, c.phone, c.assigned_to, c.created_by_id, c.created_at, u.full_name
         FROM contacts c LEFT JOIN users u ON u.id = c.assigned_to
         WHERE c.deleted_at IS NULL AND {SCOPE}
           AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id AND a.created_at >= $3)
           {paging}"
    );
    type Row = (
        i32,
        Option<String>,
        String,
        Option<i32>,
        Option<i32>,
        DateTime<Utc>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(all)
        .bind(&ids)
        .bind(cutoff)
        .bind(cursor.unwrap_or(0))
        .bind(limit)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    let masker = PhoneMasker::new(phone_owner);
    let next = (i64::try_from(rows.len()).ok() == Some(limit))
        .then(|| rows.last().map(|r| r.0))
        .flatten();
    let out: Vec<Value> = rows
        .iter()
        .map(|(id, name, phone, assigned, created_by, created, assignee)| {
            json!({
                "id": id, "full_name": name,
                "phone": masker.mask(&[*assigned, *created_by], Some(phone)).unwrap_or_default(),
                "assigned_to": assigned, "assignee_name": assignee, "created_at": iso(*created),
            })
        })
        .collect();
    Ok(json!({ "rows": out, "next_cursor": next, "days": days }))
}
