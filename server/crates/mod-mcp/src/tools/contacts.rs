//! `list_contacts`, `get_contact`, `list_contact_activities` (`contacts-tools.ts`).

use mod_contacts::filter::{ContactFilters, resolve};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};
use trinity_db::types::Timestamp;
use trinity_kernel::vn_time::js_iso_string;
use trinity_rbac::{can, mask_phone};

use super::{forbidden, wrapped};
use crate::args::{clamp_limit, opt_int, opt_str, reject_digit_probe, s};
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const DAY_MS: i64 = 86_400_000;

fn internal(e: sqlx::Error) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// Thoát `\`, `%`, `_` để chuỗi gõ khớp theo nghĩa đen trong `ILIKE … ESCAPE '\'`.
pub(crate) fn escape_like(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if matches!(c, '\\' | '%' | '_') {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

fn ts(r: &sqlx::postgres::PgRow, c: &str) -> Result<Value, ToolError> {
    Ok(r.try_get::<Option<Timestamp>, _>(c)
        .map_err(internal)?
        .map_or(Value::Null, |t| json!(js_iso_string(t.0))))
}

pub fn list_contacts<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let limit = clamp_limit(args.get("limit"));
        let days = opt_int(args.get("uncontacted_days"));
        let name = opt_str(args.get("name"), 100);
        if let Some(n) = &name {
            reject_digit_probe(n)?;
        }
        let cursor = opt_int(args.get("cursor"));
        let scopes = deps.contact_scopes(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let filters = ContactFilters {
            stage_id: opt_int(args.get("stage_id")),
            contact_status_id: opt_int(args.get("contact_status_id")),
            source_id: opt_int(args.get("source_id")),
            assigned_to: opt_int(args.get("assigned_to")),
            ..ContactFilters::default()
        };
        let wh = resolve(&mut conn, &scopes, &filters).await.map_err(app_err)?;
        let mut qb = QueryBuilder::<Postgres>::new(
            "SELECT c.id, c.code, c.full_name, c.phone, c.created_at, c.assigned_to, c.reminder_at, c.source_id, c.stage_id,
                    c.contact_status_id, so.label AS source_label, st.label AS stage_label, cs.label AS status_label, u.full_name AS owner_name
             FROM contacts c
             LEFT JOIN setting_options so ON so.id = c.source_id
             LEFT JOIN setting_options st ON st.id = c.stage_id
             LEFT JOIN setting_options cs ON cs.id = c.contact_status_id
             LEFT JOIN users u ON u.id = c.assigned_to
             WHERE ",
        );
        wh.push_aliased(&mut qb);
        if let Some(n) = &name {
            qb.push(" AND c.full_name ILIKE ")
                .push_bind(format!("%{}%", escape_like(n)))
                .push(" ESCAPE '\\'");
        }
        if let Some(d) = days {
            let since = chrono_since(i64::from(d) * DAY_MS);
            qb.push(" AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id AND a.created_at >= ")
                .push_bind(since)
                .push(")");
        }
        if let Some(cur) = cursor {
            qb.push(" AND c.id < ")
                .push_bind(cur)
                .push(" AND EXISTS (SELECT 1 FROM contacts WHERE id = ")
                .push_bind(cur)
                .push(")");
        }
        qb.push(" ORDER BY c.id DESC LIMIT ").push_bind(limit + 1);
        let rows = qb.build().fetch_all(&mut *conn).await.map_err(internal)?;
        let more = i64::try_from(rows.len()).unwrap_or(0) > limit;
        let page = &rows[..rows.len().min(usize::try_from(limit).unwrap_or(20))];
        let mut contacts = Vec::new();
        for r in page {
            let phone: Option<String> = r.try_get("phone").map_err(internal)?;
            let owner: Option<i32> = r.try_get("assigned_to").map_err(internal)?;
            let owner_name: Option<String> = r.try_get("owner_name").map_err(internal)?;
            contacts.push(json!({
                "id": r.try_get::<i32, _>("id").map_err(internal)?,
                "code": r.try_get::<Option<String>, _>("code").map_err(internal)?,
                "full_name": r.try_get::<Option<String>, _>("full_name").map_err(internal)?,
                "phone": mask_phone(phone.as_deref()),
                "stage": r.try_get::<Option<String>, _>("stage_label").map_err(internal)?,
                "status": r.try_get::<Option<String>, _>("status_label").map_err(internal)?,
                "source": r.try_get::<Option<String>, _>("source_label").map_err(internal)?,
                "assigned_to": owner.map(|id| json!({ "id": id, "full_name": owner_name })),
                "source_id": r.try_get::<Option<i32>, _>("source_id").map_err(internal)?,
                "stage_id": r.try_get::<Option<i32>, _>("stage_id").map_err(internal)?,
                "contact_status_id": r.try_get::<Option<i32>, _>("contact_status_id").map_err(internal)?,
                "created_at": ts(r, "created_at")?,
                "reminder_at": ts(r, "reminder_at")?,
            }));
        }
        let next = if more {
            page.last().map(|r| r.get::<i32, _>("id"))
        } else {
            None
        };
        wrapped(&json!({ "contacts": contacts, "next_cursor": next }))
    })
}

/// Mốc `now - ms` (cho `a.created_at >= …`).
fn chrono_since(ms: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() - chrono::Duration::milliseconds(ms)
}

pub fn get_contact<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let Some(id) = opt_int(args.get("id")) else {
            return Err(ToolError::Plain("id phải là số nguyên dương".into()));
        };
        let scopes = deps.contact_scopes(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let full = mod_contacts::read::find_by_id(&mut conn, &scopes, id)
            .await
            .map_err(app_err)?;
        let c = to_json(&full)?;
        let label = |k: &str| c.get(k).and_then(|o| s(o, "label")).map(str::to_owned);
        let list = |k: &str, n: usize| {
            c.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().take(n).cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        };
        let pick = |v: &Value, keys: &[&str]| -> Value {
            Value::Object(
                keys.iter()
                    .map(|k| ((*k).to_owned(), v.get(*k).cloned().unwrap_or(Value::Null)))
                    .collect(),
            )
        };
        let au = c.get("assigned_user").filter(|u| !u.is_null());
        let data = json!({
            "id": c["id"], "code": c["code"], "full_name": c["full_name"], "phone": c["phone"], "phone_2": c["phone_2"],
            "job_title": c["job_title"], "company_name": c["company_name"], "email": c["email"],
            "source_id": c["source_id"], "stage_id": c["stage_id"], "contact_status_id": c["contact_status_id"],
            "stage": label("stage_option"), "status": label("contact_status"), "source": label("source"),
            "assigned_to": au.map(|u| pick(u, &["id", "full_name"])),
            "team": c.get("team").and_then(|t| s(t, "name")),
            "created_at": c["created_at"], "updated_at": c["updated_at"],
            "reminder_at": c["reminder_at"], "reminder_notes": c["reminder_notes"],
            "deals": list("deals", 20).iter().map(|d| pick(d, &["id", "title", "status", "created_at"])).collect::<Vec<_>>(),
            "recent_activities": list("activities", 20).iter().map(|a| pick(a, &["id", "action", "details", "created_at"])).collect::<Vec<_>>(),
        });
        wrapped(&data)
    })
}

pub fn list_contact_activities<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let Some(contact_id) = opt_int(args.get("contact_id")) else {
            return Err(ToolError::Plain("contact_id phải là số nguyên dương".into()));
        };
        if !can(&p.grants, "contacts.view", None) {
            return Err(forbidden("Bạn không có quyền xem khách hàng (contacts.view)."));
        }
        let scopes = deps.deal_scopes(p).await?;
        let mut conn = deps.conn(p.company).await?;
        let cursor = opt_int(args.get("cursor")).map(|c| c.to_string());
        let limit = clamp_limit(args.get("limit")).to_string();
        let res =
            mod_deals::activities::find_by_contact(&mut conn, &scopes, contact_id, cursor.as_deref(), Some(&limit))
                .await
                .map_err(app_err)?;
        let t = to_json(&res)?;
        let activities: Vec<Value> = t["data"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|x| {
                        json!({
                            "id": x["id"], "action": x["action"], "details": x["details"],
                            "created_by": x.get("user").and_then(|u| s(u, "full_name")), "created_at": x["created_at"],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        wrapped(&json!({ "activities": activities, "next_cursor": t["next_cursor"] }))
    })
}
