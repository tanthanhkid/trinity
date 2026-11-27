//! `GET /reports/marketing/recruitment-overview` (`marketing-recruitment-report.service.ts`): báo cáo Marketing theo tài khoản, nhóm
//! "Tuyển dụng". Hai chỉ số không có nguồn dữ liệu (tin nhắn tuyển dụng, CV nhận) trả `null` + `available: false`, không bịa số.

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::{Value, json};
use trinity_kernel::error::HttpError;
use trinity_kernel::vn_time::{parse_vn_date_range, vn_date};
use trinity_rbac::OwnerIds;

use crate::{Actor, Ctx, R, db, now};

/// `resolveMarketingReportScopeIds`: `None` = không giới hạn. `override` ngoài phạm vi ⇒ 403.
pub fn resolve_scope_ids(owner: &OwnerIds, over: Option<i32>) -> R<Option<Vec<i32>>> {
    Ok(match (owner, over) {
        (OwnerIds::All, Some(o)) => Some(vec![o]),
        (OwnerIds::All, None) => None,
        (OwnerIds::Ids(v), Some(o)) => {
            if !v.contains(&o) {
                return Err(HttpError::forbidden("marketing_user_id ngoài phạm vi quyền của bạn").into());
            }
            Some(vec![o])
        }
        (OwnerIds::Ids(v), None) => Some(v.clone()),
    })
}

/// `buildFilterDates`: mặc định 7 ngày gần nhất (giờ VN) khi thiếu biên.
pub fn filter_dates(from: Option<&str>, to: Option<&str>, at: DateTime<Utc>) -> R<(DateTime<Utc>, DateTime<Utc>)> {
    let today = vn_date(at);
    let default_from = today - Duration::days(7);
    let (f, t) = (
        from.map_or_else(|| default_from.format("%Y-%m-%d").to_string(), str::to_owned),
        to.map_or_else(|| today.format("%Y-%m-%d").to_string(), str::to_owned),
    );
    parse_vn_date_range(Some(&f), Some(&t), 7, false, at).map_err(|e| HttpError::bad_request(e.to_string()).into())
}

/// Đầu vào đã qua K15.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub marketing_user_id: Option<i64>,
}

impl Query {
    pub fn from_validated(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        Self {
            date_from: s("date_from"),
            date_to: s("date_to"),
            marketing_user_id: v.get("marketing_user_id").and_then(Value::as_i64),
        }
    }
}

pub async fn overview(ctx: &Ctx, actor: &Actor, q: &Query) -> R<Value> {
    overview_at(ctx, actor, q, now()).await
}

pub async fn overview_at(ctx: &Ctx, actor: &Actor, q: &Query, at: DateTime<Utc>) -> R<Value> {
    let (from, to) = filter_dates(q.date_from.as_deref(), q.date_to.as_deref(), at)?;
    let owner = ctx
        .owner_ids(actor, "reports.channels")
        .await?
        .unwrap_or(OwnerIds::Ids(Vec::new()));
    // `users.id` là int4: mã ngoài miền không thể là người dùng nào ⇒ ngoài phạm vi (403) hoặc khớp rỗng.
    let over = q.marketing_user_id.map(|n| i32::try_from(n).unwrap_or(0));
    let scope = resolve_scope_ids(&owner, over)?;
    let (all, ids) = match &scope {
        None => (true, Vec::new()),
        Some(v) => (false, v.clone()),
    };
    // Cột `date`: so với mốc `timestamp` (giờ UTC) như tham số Date của Prisma, không phụ thuộc múi giờ phiên.
    let (nf, nt): (NaiveDateTime, NaiveDateTime) = (from.naive_utc(), to.naive_utc());
    let mut c = ctx.conn(actor.company).await?;
    let cond = "($1 OR recruiter_id = ANY($2) OR created_by = ANY($2))";
    let count = |table: &str, date: &str, extra: &str| {
        format!("SELECT count(*) FROM {table} WHERE {cond} AND {date} >= $3 AND {date} < $4 {extra}")
    };
    let mut n = Vec::new();
    for sql in [
        count("recruitment_positions", "opened_date", ""),
        count("recruitment_candidates", "applied_date", ""),
        count(
            "recruitment_candidates",
            "applied_date",
            "AND interview_date IS NOT NULL",
        ),
        count("recruitment_candidates", "applied_date", "AND decision = 'hired'"),
    ] {
        let v: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .bind(all)
            .bind(&ids)
            .bind(nf)
            .bind(nt)
            .fetch_one(&mut *c)
            .await
            .map_err(db)?;
        n.push(v);
    }
    Ok(json!({
        "positions_posted": n[0], "candidates_interested": n[1], "candidates_interviewed": n[2], "candidates_hired": n[3],
        "recruitment_messages": null, "recruitment_messages_available": false, "cv_received": null, "cv_received_available": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pham_vi_marketing() {
        let ids = OwnerIds::Ids(vec![3, 4]);
        assert_eq!(resolve_scope_ids(&OwnerIds::All, None).unwrap(), None);
        assert_eq!(resolve_scope_ids(&OwnerIds::All, Some(9)).unwrap(), Some(vec![9]));
        assert_eq!(resolve_scope_ids(&ids, None).unwrap(), Some(vec![3, 4]));
        assert_eq!(resolve_scope_ids(&ids, Some(4)).unwrap(), Some(vec![4]));
        assert!(resolve_scope_ids(&ids, Some(9)).is_err());
    }

    #[test]
    fn khoang_ngay_mac_dinh_bay_ngay() {
        let at = DateTime::parse_from_rfc3339("2026-11-27T05:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let (f, t) = filter_dates(None, None, at).unwrap();
        assert_eq!(vn_date(f).to_string(), "2026-11-20");
        assert_eq!(vn_date(t).to_string(), "2026-11-27");
        let (f, _) = filter_dates(Some("2026-01-05"), Some("2026-01-06"), at).unwrap();
        assert_eq!(vn_date(f).to_string(), "2026-01-05");
    }
}
