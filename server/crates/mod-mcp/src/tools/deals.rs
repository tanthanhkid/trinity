//! `list_deals`, `get_dashboard_overview`, `list_my_tasks` (`deals-dashboard-tools.ts`).

use mod_deals::deals::{DealQuery, find_all};
use mod_kanban::cards::{ListCards, list};
use serde_json::{Value, json};

use super::{visible_contacts, wrapped};
use crate::args::{clamp_limit, opt_int, opt_str, reject_digit_probe, s};
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

pub fn list_deals<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let search = opt_str(args.get("search"), 100);
        if let Some(q) = &search {
            reject_digit_probe(q)?;
        }
        let status = args
            .get("status")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "open" | "won" | "lost"))
            .map(str::to_owned);
        let query = DealQuery {
            status,
            assigned_to: opt_int(args.get("assigned_to")),
            cursor: opt_int(args.get("cursor")),
            limit: Some(clamp_limit(args.get("limit"))),
            search,
        };
        let dscopes = deps.deal_scopes(p).await?;
        let cscopes = deps.contact_scopes(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let res = find_all(&mut conn, &dscopes, &query).await.map_err(app_err)?;
        let r = to_json(&res)?;
        let rows: Vec<Value> = r["data"].as_array().cloned().unwrap_or_default();
        let ids: Vec<Option<i32>> = rows
            .iter()
            .map(|d| d["contact_id"].as_i64().and_then(|n| i32::try_from(n).ok()))
            .collect();
        let seen = visible_contacts(&cscopes, p, &mut conn, &ids).await?;
        let deals: Vec<Value> = rows
            .iter()
            .zip(&ids)
            .map(|(d, cid)| {
                let visible = cid.is_some_and(|c| seen.contains(&c));
                json!({
                    "id": d["id"], "code": d["code"], "title": d["title"], "status": d["status"], "value": d["value"],
                    "contact_id": if visible { d["contact_id"].clone() } else { Value::Null },
                    "assignee": d.get("assignee").and_then(|a| s(a, "full_name")), "assigned_to": d["assigned_to"],
                    "created_at": d["created_at"],
                })
            })
            .collect();
        wrapped(&json!({ "deals": deals, "next_cursor": r["meta"]["next_cursor"] }))
    })
}

pub fn dashboard_overview<'a>(_args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let actor = deps.report_actor(p);
        let v = mod_reports::dashboard::get_overview(&deps.reports, &actor, &mod_reports::filter::Filter::default())
            .await
            .map_err(app_err)?;
        wrapped(&v)
    })
}

pub fn my_tasks<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let actor = deps.kanban_actor(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let q = ListCards {
            cursor: opt_int(args.get("cursor")),
            limit: Some(clamp_limit(args.get("limit"))),
            involving: Some(p.user_id),
            open_only: true,
            ..ListCards::default()
        };
        let res = list(&mut conn, &actor, &q).await.map_err(app_err)?;
        let r = to_json(&res)?;
        let mut cards: Vec<Value> = r["cards"].as_array().cloned().unwrap_or_default();
        // Hạn gần nhất trước (không hạn xuống cuối), sắp trong trang đã lấy (≤ 50) để con trỏ theo id vẫn ổn định.
        cards.sort_by(|a, b| {
            let due = |c: &Value| s(c, "due_at").map(str::to_owned);
            match (due(a), due(b)) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });
        let tasks: Vec<Value> = cards
            .iter()
            .map(|c| {
                let (total, done) = (c["checklist_total"].as_i64().unwrap_or(0), c["checklist_done"].as_i64().unwrap_or(0));
                json!({
                    "id": c["id"], "code": c["code"], "title": c["title"], "due_at": c["due_at"], "is_overdue": c["is_overdue"],
                    "priority": c["priority"], "labels": c["labels"],
                    "checklist": if total > 0 { json!(format!("{done}/{total}")) } else { Value::Null },
                    "contact": c.get("contact").and_then(|x| s(x, "full_name")),
                })
            })
            .collect();
        wrapped(&json!({ "tasks": tasks, "next_cursor": r["next_cursor"] }))
    })
}
