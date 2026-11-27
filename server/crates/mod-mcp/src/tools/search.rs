//! `search` và `fetch` (`search-fetch.ts`, định dạng OpenAI: `{ id, title, url }` rồi `{ id, title, text, url, metadata }`).
//! Tìm khách theo TÊN (không theo SĐT), deal và thẻ công việc, mỗi loại tối đa 10, chỉ trong phạm vi quyền.

use std::sync::LazyLock;

use mod_contacts::filter::{ContactFilters, resolve};
use mod_deals::deals::DealQuery;
use mod_kanban::cards::ListCards;
use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::{Postgres, QueryBuilder};
use trinity_rbac::can;

use super::contacts::escape_like;
use super::{done, forbidden, visible_contacts};
use crate::ai_output::{DATA_NOTICE, mask_phones_in_text, sanitize_for_ai, slice16};
use crate::args::{opt_str, reject_digit_probe, s};
use crate::auth::Principal;
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const PER_TYPE: i64 = 10;

static ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(contact|deal|card):([0-9]{1,9})$").expect("regex hợp lệ"));

fn internal(e: sqlx::Error) -> ToolError {
    ToolError::Internal(e.to_string())
}

fn has(p: &Principal, perm: &str) -> bool {
    can(&p.grants, perm, None)
}

pub fn search<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let q = opt_str(args.get("query"), 200).filter(|q| q.encode_utf16().count() >= 2);
        let Some(q) = q else {
            return Err(ToolError::Plain("query phải có ít nhất 2 ký tự".into()));
        };
        reject_digit_probe(&q)?;
        let (can_contacts, can_deals, can_cards) =
            (has(p, "contacts.view"), has(p, "deals.view"), has(p, "kanban.view"));
        if !can_contacts && !can_deals && !can_cards {
            return Err(forbidden("Bạn không có quyền xem khách hàng, deal hay công việc."));
        }
        let base = ctx.base_url;
        // Phạm vi và người gọi lấy TRƯỚC khi giữ kết nối (không xin kết nối thứ hai khi đang giữ một).
        let scopes = deps.contact_scopes(p).await?;
        let dscopes = deps.deal_scopes(p).await?;
        let actor = if can_cards {
            Some(deps.kanban_actor(p).await?)
        } else {
            None
        };
        let mut conn = deps.conn(p.company).await?;
        let mut results: Vec<Value> = Vec::new();
        if can_contacts {
            let wh = resolve(&mut conn, &scopes, &ContactFilters::default())
                .await
                .map_err(app_err)?;
            let mut qb = QueryBuilder::<Postgres>::new("SELECT c.id, c.full_name FROM contacts c WHERE ");
            wh.push_aliased(&mut qb);
            qb.push(" AND c.full_name ILIKE ")
                .push_bind(format!("%{}%", escape_like(&q)))
                .push(" ESCAPE '\\'");
            qb.push(" ORDER BY c.id DESC LIMIT ").push_bind(PER_TYPE);
            let rows: Vec<(i32, Option<String>)> = qb.build_query_as().fetch_all(&mut *conn).await.map_err(internal)?;
            for (id, name) in rows {
                results.push(json!({
                    "id": format!("contact:{id}"), "title": name.unwrap_or_else(|| format!("Khách hàng #{id}")),
                    "url": format!("{base}/contacts/{id}"),
                }));
            }
        }
        if can_deals {
            let res = mod_deals::deals::find_all(
                &mut conn,
                &dscopes,
                &DealQuery {
                    search: Some(q.clone()),
                    limit: Some(PER_TYPE),
                    ..DealQuery::default()
                },
            )
            .await
            .map_err(app_err)?;
            let r = to_json(&res)?;
            let rows: Vec<Value> = r["data"].as_array().cloned().unwrap_or_default();
            let ids: Vec<Option<i32>> = rows
                .iter()
                .map(|d| d["contact_id"].as_i64().and_then(|n| i32::try_from(n).ok()))
                .collect();
            let seen = visible_contacts(&scopes, p, &mut conn, &ids).await?;
            for (d, cid) in rows.iter().zip(&ids) {
                let url = match cid {
                    Some(c) if seen.contains(c) => format!("{base}/contacts/{c}"),
                    _ => format!("{base}/dashboard"),
                };
                results.push(json!({
                    "id": format!("deal:{}", d["id"]), "title": format!("{} ({})", s(d, "title").unwrap_or(""), s(d, "status").unwrap_or("")),
                    "url": url,
                }));
            }
        }
        if let Some(actor) = actor {
            let res = mod_kanban::cards::list(
                &mut conn,
                &actor,
                &ListCards {
                    search: Some(q.clone()),
                    limit: Some(PER_TYPE),
                    ..ListCards::default()
                },
            )
            .await
            .map_err(app_err)?;
            let r = to_json(&res)?;
            for c in r["cards"].as_array().cloned().unwrap_or_default() {
                results.push(
                    json!({ "id": format!("card:{}", c["id"]), "title": c["title"], "url": format!("{base}/kanban") }),
                );
            }
        }
        results.truncate(50);
        let safe = sanitize_for_ai(&Value::Array(results), "", 0);
        done(json!({ "results": safe }))
    })
}

/// Giá trị người dùng nhập luôn 1 dòng: xuống dòng trong dữ liệu không được dựng thành "dòng hệ thống" giả.
fn one_line(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut in_break = false;
    for c in v.chars() {
        if matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            out.push(c);
        }
    }
    out
}

/// `label: value\n`, rỗng khi `null` hoặc chuỗi rỗng.
fn line(label: &str, v: Option<&Value>) -> String {
    let text = match v {
        None | Some(Value::Null) => return String::new(),
        Some(Value::String(s)) if s.is_empty() => return String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    format!("{label}: {}\n", one_line(&text))
}

struct Fetched {
    id: String,
    title: String,
    text: String,
    url: String,
    metadata: Value,
}

async fn fetch_contact(id: i32, ctx: &ToolCtx<'_>) -> Result<Fetched, ToolError> {
    let (p, deps) = (ctx.principal, ctx.deps);
    if !has(p, "contacts.view") {
        return Err(forbidden("Bạn không có quyền xem khách hàng (contacts.view)."));
    }
    let scopes = deps.contact_scopes(p).await?;
    let mut conn = deps.conn(p.company).await?;
    let c = to_json(
        &mod_contacts::read::find_by_id(&mut conn, &scopes, id)
            .await
            .map_err(app_err)?,
    )?;
    let cid = c["id"].as_i64().unwrap_or(0);
    let title = s(&c, "full_name").map_or_else(|| format!("Khách hàng #{cid}"), str::to_owned);
    let label = |k: &str| c.get(k).and_then(|o| o.get("label")).cloned();
    let name_of = |k: &str, f: &str| c.get(k).and_then(|o| o.get(f)).cloned();
    let deals: String = c["deals"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(10)
                .map(|d| {
                    format!(
                        "  - deal:{} {} ({})",
                        d["id"],
                        s(d, "title").unwrap_or(""),
                        s(d, "status").unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let acts: String = c["activities"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(10)
                .map(|x| {
                    let when: String = s(x, "created_at").unwrap_or("").chars().take(16).collect();
                    let details = match x.get("details") {
                        Some(d) if !d.is_null() => format!(" — {}", slice16(&trinity_kernel::json::js_json(d), 300)),
                        _ => String::new(),
                    };
                    format!("  - [{when}] {}{details}", s(x, "action").unwrap_or(""))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let mut text = format!("Khách hàng #{cid}: {title}\n");
    for (l, v) in [
        ("SĐT", c.get("phone").cloned()),
        ("Nguồn", label("source")),
        ("Giai đoạn", label("stage_option")),
        ("Trạng thái", label("contact_status")),
        ("Người phụ trách", name_of("assigned_user", "full_name")),
        ("Team", name_of("team", "name")),
        ("Công việc", c.get("job_title").cloned()),
        ("Công ty", c.get("company_name").cloned()),
        ("Tạo lúc", c.get("created_at").cloned()),
        ("Hẹn nhắc", c.get("reminder_at").cloned()),
        ("Ghi chú nhắc", c.get("reminder_notes").cloned()),
    ] {
        text.push_str(&line(l, v.as_ref()));
    }
    if !deals.is_empty() {
        text.push_str(&format!("Deal:\n{deals}\n"));
    }
    if !acts.is_empty() {
        text.push_str(&format!("Hoạt động gần đây:\n{acts}\n"));
    }
    Ok(Fetched {
        id: format!("contact:{cid}"),
        title,
        text,
        url: format!("{}/contacts/{cid}", ctx.base_url),
        metadata: json!({ "type": "contact", "stage": label("stage_option").unwrap_or(Value::Null) }),
    })
}

async fn fetch_deal(id: i32, ctx: &ToolCtx<'_>) -> Result<Fetched, ToolError> {
    let (p, deps) = (ctx.principal, ctx.deps);
    if !has(p, "deals.view") {
        return Err(forbidden("Bạn không có quyền xem deal (deals.view)."));
    }
    let dscopes = deps.deal_scopes(p).await?;
    let cscopes = deps.contact_scopes(p).await?;
    let mut conn = deps.conn(p.company).await?;
    let d = to_json(
        &mod_deals::deals::find_one(&mut conn, &dscopes, id)
            .await
            .map_err(app_err)?,
    )?;
    let cid = d["contact_id"].as_i64().and_then(|n| i32::try_from(n).ok());
    let see = visible_contacts(&cscopes, p, &mut conn, &[cid]).await?;
    let see_contact = cid.is_some_and(|c| see.contains(&c));
    let did = d["id"].as_i64().unwrap_or(0);
    let title = s(&d, "title").unwrap_or("").to_owned();
    let contact = d.get("contact").filter(|c| !c.is_null());
    let mut text = format!("Deal #{did}: {title}\n");
    for (l, v) in [
        ("Trạng thái", d.get("status").cloned()),
        ("Giá trị (VND)", d.get("value").cloned()),
        ("Mô tả", d.get("description").cloned()),
        ("Ghi chú", d.get("note").cloned()),
        (
            "Người phụ trách",
            d.get("assignee").and_then(|a| a.get("full_name")).cloned(),
        ),
        (
            "Khách hàng",
            contact
                .filter(|_| see_contact)
                .and_then(|c| c.get("full_name"))
                .cloned(),
        ),
        (
            "SĐT khách",
            contact.filter(|_| see_contact).and_then(|c| c.get("phone")).cloned(),
        ),
        ("Tạo lúc", d.get("created_at").cloned()),
    ] {
        text.push_str(&line(l, v.as_ref()));
    }
    let url = match cid {
        Some(c) if see_contact => format!("{}/contacts/{c}", ctx.base_url),
        _ => format!("{}/dashboard", ctx.base_url),
    };
    Ok(Fetched {
        id: format!("deal:{did}"),
        title,
        text,
        url,
        metadata: json!({ "type": "deal", "status": d["status"] }),
    })
}

async fn fetch_card(id: i32, ctx: &ToolCtx<'_>) -> Result<Fetched, ToolError> {
    let (p, deps) = (ctx.principal, ctx.deps);
    if !has(p, "kanban.view") {
        return Err(forbidden("Bạn không có quyền xem công việc (kanban.view)."));
    }
    let actor = deps.kanban_actor(p).await?;
    let mut conn = deps.conn(p.company).await?;
    let c = to_json(
        &mod_kanban::cards::find_one(&mut conn, &actor, id)
            .await
            .map_err(app_err)?,
    )?;
    let cid = c["id"].as_i64().unwrap_or(0);
    let title = s(&c, "title").unwrap_or("").to_owned();
    let labels = c["labels"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let (total, done_n) = (
        c["checklist_total"].as_i64().unwrap_or(0),
        c["checklist_done"].as_i64().unwrap_or(0),
    );
    let mut text = format!("Thẻ công việc #{cid}: {title}\n");
    for (l, v) in [
        ("Mô tả", c.get("description").cloned()),
        ("Ưu tiên", c.get("priority").cloned()),
        ("Hạn", c.get("due_at").cloned()),
        ("Quá hạn", c["is_overdue"].as_bool().filter(|b| *b).map(|_| json!("có"))),
        ("Nhãn", Some(json!(labels))),
        ("Checklist", (total > 0).then(|| json!(format!("{done_n}/{total}")))),
        ("Khách hàng", c.get("contact").and_then(|x| x.get("full_name")).cloned()),
        ("Tạo lúc", c.get("created_at").cloned()),
    ] {
        text.push_str(&line(l, v.as_ref()));
    }
    Ok(Fetched {
        id: format!("card:{cid}"),
        title,
        text,
        url: format!("{}/kanban", ctx.base_url),
        metadata: json!({ "type": "card", "overdue": c["is_overdue"] }),
    })
}

pub fn fetch<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let raw = args.get("id").and_then(Value::as_str).unwrap_or("");
        let Some(m) = ID_RE.captures(raw) else {
            return Err(ToolError::Plain(
                "id phải có dạng contact:12, deal:5 hoặc card:9".into(),
            ));
        };
        let n: i32 = m[2].parse().map_err(|_| ToolError::Plain("id không hợp lệ".into()))?;
        let out = match &m[1] {
            "contact" => fetch_contact(n, ctx).await?,
            "deal" => fetch_deal(n, ctx).await?,
            _ => fetch_card(n, ctx).await?,
        };
        let mut meta = match sanitize_for_ai(&out.metadata, "", 0) {
            Value::Object(o) => o,
            _ => Map::new(),
        };
        meta.insert("notice".into(), json!(DATA_NOTICE));
        let body = format!("[{DATA_NOTICE}]\n\n{}", mask_phones_in_text(&out.text));
        let text = format!("{}\n\n[{DATA_NOTICE}]", slice16(&body, 5500));
        done(json!({
            "id": out.id, "title": mask_phones_in_text(&out.title), "text": text, "url": out.url, "metadata": Value::Object(meta),
        }))
    })
}
