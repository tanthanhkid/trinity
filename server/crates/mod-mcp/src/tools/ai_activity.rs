//! `list_ai_activity` (`ai-activity-tool.ts`, `AiActionsService.activity`): các thao tác ghi do AI làm (hoặc đề xuất, khi bật chế độ
//! duyệt), cùng bảng `ai_action_drafts` với trang "Hoạt động AI". Mặc định của chính người dùng, hôm nay (giờ VN); `all_users` cần
//! `integrations.ai_admin`. Lý do lỗi chi tiết KHÔNG trả cho AI (như `get_action_status`): thành oracle dò dữ liệu.

use std::collections::HashMap;

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use trinity_db::CompanyRef;
use trinity_db::types::Timestamp;
use trinity_kernel::vn_time::{vn_date, vn_to_utc};
use trinity_rbac::can;

use super::social::vn_iso;
use super::{forbidden, wrapped};
use crate::actions::{effective_status, info};
use crate::args::{clamp_limit, opt_int};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const STATUSES: [&str; 6] = ["executed", "failed", "pending", "approved", "rejected", "expired"];
const MAX_RANGE_DAYS: i64 = 92;
const FAILED_NOTE: &str = "Không thực hiện được — lý do hiển thị cho người dùng trong Trinity (mục Hoạt động AI).";
const NEED_ADMIN: &str = "Xem hoạt động AI của cả công ty cần quyền integrations.ai_admin (quản trị kết nối AI). Bạn vẫn xem được hoạt động AI của chính mình (bỏ all_users). / Company-wide AI activity requires integrations.ai_admin.";

fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// `YYYY-MM-DD` đúng dạng và là ngày có thật.
fn parse_day(d: &str) -> Option<NaiveDate> {
    let b = d.as_bytes();
    let shape = b.len() == 10
        && b.iter()
            .enumerate()
            .all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    shape.then(|| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).flatten()
}

fn non_empty(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Khoảng `[from, to)` theo giờ VN từ hai ngày (gồm cả ngày `to`); mặc định hôm nay; tối đa 92 ngày (`activityRange`).
fn activity_range(
    from_raw: Option<&Value>,
    to_raw: Option<&Value>,
    now: DateTime<Utc>,
) -> Result<(DateTime<Utc>, DateTime<Utc>, String), ToolError> {
    let today = vn_date(now).format("%Y-%m-%d").to_string();
    let (from_s, to_s) = (non_empty(from_raw), non_empty(to_raw));
    let f = from_s.or(to_s).map_or_else(|| today.clone(), str::to_owned);
    let t = to_s.map_or_else(|| if from_s.is_some() { f.clone() } else { today.clone() }, str::to_owned);
    let mut days = Vec::with_capacity(2);
    for d in [&f, &t] {
        let day = parse_day(d).ok_or_else(|| {
            let shown: String = d.chars().take(20).collect();
            ToolError::User(format!("Ngày “{shown}” không hợp lệ — dùng dạng YYYY-MM-DD."))
        })?;
        days.push(day);
    }
    let from = vn_to_utc(days[0], NaiveTime::MIN);
    let to = vn_to_utc(days[1], NaiveTime::MIN) + Duration::days(1);
    if to <= from {
        return Err(ToolError::User("from phải trước hoặc bằng to.".into()));
    }
    if to - from > Duration::days(MAX_RANGE_DAYS) {
        return Err(ToolError::User("Khoảng tối đa 92 ngày.".into()));
    }
    let label = if f == t { f } else { format!("{f} → {t}") };
    Ok((from, to, label))
}

type DraftRow = (
    i32,
    String,
    i32,
    String,
    String,
    String,
    Option<String>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
    DateTime<Utc>,
);

pub fn list_ai_activity<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let all = args.get("all_users").and_then(Value::as_bool) == Some(true);
        if all && !can(&p.grants, "integrations.ai_admin", None) {
            return Err(forbidden(NEED_ADMIN));
        }
        let now = Utc::now();
        let (from, to, label) = activity_range(args.get("from"), args.get("to"), now)?;
        let status = args
            .get("status")
            .and_then(Value::as_str)
            .filter(|s| STATUSES.contains(s))
            .map(str::to_owned);
        let cursor = opt_int(args.get("cursor"));
        let limit = clamp_limit(args.get("limit"));

        // Kết nối công ty của người gọi: nháp + tên người dùng; trả TRƯỚC khi mượn kết nối sổ client (công ty 1).
        let (rows, who, more) = {
            let mut conn = deps.conn(p.company).await?;
            let mut qb = QueryBuilder::<Postgres>::new(
                "SELECT id, client_id, user_id, tool, summary, status, result::text, decided_at, expires_at, created_at
                 FROM ai_action_drafts WHERE created_at >= ",
            );
            qb.push_bind(from).push(" AND created_at < ").push_bind(to);
            if !all {
                qb.push(" AND user_id = ").push_bind(p.user_id);
            }
            if let Some(s) = status {
                qb.push(" AND status = ").push_bind(s);
            }
            if let Some(c) = cursor {
                qb.push(" AND id < ").push_bind(c);
            }
            qb.push(" ORDER BY id DESC LIMIT ").push_bind(limit + 1);
            let mut rows: Vec<DraftRow> = qb
                .build_query_as()
                .fetch_all(&mut *conn)
                .await
                .map_err(internal)?;
            let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
            rows.truncate(usize::try_from(limit).unwrap_or(50));
            let mut uids: Vec<i32> = rows.iter().map(|r| r.2).collect();
            uids.sort_unstable();
            uids.dedup();
            let names: Vec<(i32, Option<String>)> = if uids.is_empty() {
                Vec::new()
            } else {
                sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
                    .bind(&uids)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(internal)?
            };
            (rows, names.into_iter().collect::<HashMap<_, _>>(), more)
        };

        // Tên ứng dụng AI theo `client_id` (sổ client chung ở công ty 1).
        let mut cids: Vec<&str> = rows.iter().map(|r| r.1.as_str()).collect();
        cids.sort_unstable();
        cids.dedup();
        let apps: HashMap<String, String> = if cids.is_empty() {
            HashMap::new()
        } else {
            let mut conn = deps.conn(CompanyRef::DEFAULT).await?;
            let found: Vec<(String, String)> =
                sqlx::query_as("SELECT client_id, name FROM oauth_clients WHERE client_id = ANY($1)")
                    .bind(&cids)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(internal)?;
            found.into_iter().collect()
        };

        let next_cursor = if more { rows.last().map(|r| r.0) } else { None };
        let items: Vec<Value> = rows
            .iter()
            .map(|(id, client_id, user_id, tool, summary, st, result, decided_at, expires_at, created_at)| {
                let status = effective_status(st, result.is_some(), *decided_at, *expires_at, now);
                let what = info(tool).map_or(tool.as_str(), |(label, _)| label);
                let result_json = result
                    .as_deref()
                    .and_then(|t| serde_json::from_str::<Value>(t).ok())
                    .unwrap_or(Value::Null);
                json!({
                    "action_id": id, "at": vn_iso(&Timestamp(*created_at)),
                    "user": who.get(user_id).cloned().flatten(), "app": apps.get(client_id),
                    "tool": tool, "what": what, "summary": summary,
                    "error": if status == "failed" { json!(FAILED_NOTE) } else { Value::Null },
                    "status": status, "result": result_json, "open_at": format!("/ai-actions?id={id}"),
                })
            })
            .collect();
        wrapped(&json!({
            "range": label, "timezone": "Asia/Ho_Chi_Minh", "who": if all { "cả công ty" } else { "chính bạn" },
            "count_on_page": items.len(), "items": items, "next_cursor": next_cursor,
        }))
    })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn khoang_mac_dinh_la_hom_nay_gio_viet_nam() {
        // 20:00Z ngày 26 = 03:00 ngày 27 giờ VN.
        let now = Utc.with_ymd_and_hms(2026, 11, 26, 20, 0, 0).unwrap();
        let (from, to, label) = activity_range(None, None, now).unwrap();
        assert_eq!(label, "2026-11-27");
        assert_eq!(from, at("2026-11-26T17:00:00Z"));
        assert_eq!(to, at("2026-11-27T17:00:00Z"));
    }

    #[test]
    fn khoang_tu_den_gom_ngay_cuoi_va_kiem_loi() {
        let now = Utc::now();
        let (from, to, label) = activity_range(Some(&json!("2026-11-01")), Some(&json!("2026-11-03")), now).unwrap();
        assert_eq!(label, "2026-11-01 → 2026-11-03");
        assert_eq!(to - from, Duration::days(3));
        // chỉ `to` ⇒ from = to
        let (from, to, _) = activity_range(None, Some(&json!("2026-11-05")), now).unwrap();
        assert_eq!(to - from, Duration::days(1));
        assert!(activity_range(Some(&json!("2026-11-05")), Some(&json!("2026-11-01")), now).is_err());
        assert!(activity_range(Some(&json!("2026-01-01")), Some(&json!("2026-06-01")), now).is_err());
        assert!(activity_range(Some(&json!("2026-02-30")), None, now).is_err());
        assert!(activity_range(Some(&json!("27/11/2026")), None, now).is_err());
        assert!(activity_range(Some(&json!("2026-1-1x")), None, now).is_err());
    }
}
