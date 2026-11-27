//! `list_records`, `get_record`, `find_by_code` (`record-tools.ts`, `code-tools.ts`, `core-records.ts`). Bảng tuỳ biến đi qua
//! `mod_custom::records` (cùng phạm vi, che SĐT, công thức như giao diện web); bảng lõi `contacts | deals | tasks` đi qua đúng
//! các tool nhóm 1 / module nghiệp vụ. Phạm vi xem và người gọi luôn lấy TRƯỚC khi giữ kết nối.

use mod_custom::refs::{Owners, RefAccess, RefType, RefView, parse_code, resolve_codes};
use serde_json::{Map, Value, json};
use trinity_kernel::error::{AppError, Message};
use trinity_kernel::json::js_json;
use trinity_kernel::vi::trim_js;

use super::{contacts, deals, wrapped};
use crate::args::{clamp_limit, opt_int, opt_str, reject_digit_probe};
use crate::auth::Principal;
use crate::deps::{ToolDeps, app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

const TABLE_NOT_FOUND: &str = "Không tìm thấy tính năng này";

/// `^[a-z][a-z0-9_]{0,47}$`.
fn valid_table_key(k: &str) -> bool {
    let mut it = k.chars();
    it.next().is_some_and(|c| c.is_ascii_lowercase())
        && k.len() <= 48
        && it.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn table_key(v: Option<&Value>) -> Result<String, ToolError> {
    let key = v.and_then(Value::as_str).map_or("", trim_js);
    if !valid_table_key(key) {
        return Err(ToolError::User(
            "object phải là khoá bảng (a-z, 0-9, _) — hãy gọi describe_schema để lấy đúng khoá.".into(),
        ));
    }
    Ok(key.to_owned())
}

/// Bảng không có/không được thấy ⇒ chỉ đường tới describe_schema (không phân biệt hai trường hợp: không lộ bảng bị ẩn).
fn map_not_found(e: AppError, key: &str) -> ToolError {
    let (status, body) = e.response(true);
    let message = match body.message {
        Message::One(s) => s,
        Message::Many(m) => m.join("; "),
    };
    match status {
        404 if message == TABLE_NOT_FOUND => ToolError::User(format!(
            "Không có bảng “{key}” (hoặc bạn không được thấy). Hãy gọi describe_schema để lấy danh sách bảng."
        )),
        404 => ToolError::NotFound,
        s => ToolError::Http { status: s, message },
    }
}

/// `requirePerm`: thiếu quyền ⇒ 403 `HttpException` (thành câu từ chối chung).
fn require_perm(p: &Principal, perm: &str) -> Result<(), ToolError> {
    if trinity_rbac::can(&p.grants, perm, None) {
        Ok(())
    } else {
        Err(ToolError::Http {
            status: 403,
            message: format!("Bạn không có quyền thực hiện thao tác này (cần quyền {perm})."),
        })
    }
}

fn core_view_perm(key: &str) -> &'static str {
    match key {
        "contacts" => "contacts.view",
        "deals" => "deals.view",
        _ => "kanban.view",
    }
}

/// `totalCounts`: total đếm gì, để AI không đọc nhầm số bản ghi khớp tìm kiếm thành số bản ghi của cả bảng.
fn total_counts(search: Option<&str>, filter: Option<&str>, total: &Value) -> String {
    if total.is_null() {
        return "total chỉ có ở trang đầu / total is only on the first page".to_owned();
    }
    if search.is_some() || filter.is_some() {
        let mut parts: Vec<String> = Vec::new();
        if let Some(s) = search {
            parts.push(format!("search “{s}”"));
        }
        if filter.is_some() {
            parts.push("filter".to_owned());
        }
        return format!(
            "số bản ghi khớp {} trong phạm vi quyền — không phải cả bảng / records matching the search/filter, not the whole table",
            parts.join(" + ")
        );
    }
    "toàn bộ bản ghi bạn xem được trong bảng / all records of the table within your scope".to_owned()
}

// ---------------------------------------------------------------------------------------------------------------
// mã chung

/// Chuẩn hoá danh sách mã AI gửi: bỏ "@", in hoa, đệm số; sai dạng ⇒ lỗi AI sửa được (`readCodes`).
fn read_codes(raw: Option<&Value>, max: usize) -> Result<Vec<String>, ToolError> {
    let items: Vec<Value> = match raw {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s
            .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
            .map(|x| Value::String(x.to_owned()))
            .collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for x in &items {
        let Some(s) = x.as_str().filter(|s| !trim_js(s).is_empty()) else {
            continue;
        };
        let Some(c) = parse_code(s.strip_prefix('@').unwrap_or(s)) else {
            return Err(ToolError::User(format!(
                "“{}” không phải mã bản ghi (dạng tiền tố 2–4 chữ + số, vd SP001, KH012).",
                crate::ai_output::slice16(s, 30)
            )));
        };
        if !out.contains(&c.code) {
            out.push(c.code);
        }
    }
    if out.is_empty() {
        return Err(ToolError::User("Cần ít nhất một mã, vd [\"SP001\"].".into()));
    }
    if out.len() > max {
        return Err(ToolError::User(format!("Tối đa {max} mã mỗi lần.")));
    }
    Ok(out)
}

/// Khoá bảng theo cách AI gọi (describe_schema): bảng tuỳ biến = khoá bảng; bảng lõi = contacts | deals | tasks.
fn table_key_of(v: &RefView) -> String {
    match v.ty {
        RefType::Record => v.table_key.clone().unwrap_or_default(),
        RefType::Contact => "contacts".to_owned(),
        RefType::Deal => "deals".to_owned(),
        RefType::Task => "tasks".to_owned(),
    }
}

fn ref_out(v: &RefView, base_url: &str) -> Value {
    json!({
        "code": v.code, "object": table_key_of(v), "id": v.id, "title": v.title, "table": v.table, "ref": v.reference(),
        "open_at": v.href.as_ref().map(|h| format!("{base_url}{h}")),
    })
}

/// Mã → bản ghi người gọi XEM ĐƯỢC. Phạm vi lấy trước, rồi mới giữ MỘT kết nối.
async fn resolve(
    deps: &ToolDeps,
    p: &Principal,
    codes: &[String],
) -> Result<std::collections::HashMap<String, RefView>, ToolError> {
    let (cctx, actor) = (deps.custom_ctx(), deps.custom_actor(p));
    let owners = Owners::load(&cctx, &actor).await.map_err(app_err)?;
    let mut conn = deps.conn(p.company).await?;
    let acc = RefAccess::build(&mut conn, &actor, owners).await.map_err(app_err)?;
    resolve_codes(&mut conn, &acc, codes).await.map_err(app_err)
}

pub fn find_by_code<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let codes = read_codes(args.get("codes"), 50)?;
        let map = resolve(ctx.deps, ctx.principal, &codes).await?;
        let found: Vec<Value> = codes
            .iter()
            .filter_map(|c| {
                map.get(c).map(|v| {
                    let mut o = ref_out(v, ctx.base_url);
                    if let Some(m) = o.as_object_mut() {
                        m.insert("requested".into(), json!(c));
                    }
                    o
                })
            })
            .collect();
        let not_found: Vec<&String> = codes.iter().filter(|c| !map.contains_key(*c)).collect();
        wrapped(&json!({ "found": found, "not_found": not_found }))
    })
}

/// `idFromCode`: mã → id (kiểm đúng bảng nếu AI có ghi `object`).
async fn id_from_code(
    deps: &ToolDeps,
    p: &Principal,
    raw: &Value,
    object: Option<&str>,
) -> Result<(String, i32), ToolError> {
    let codes = read_codes(Some(&Value::Array(vec![raw.clone()])), 1)?;
    let code = codes.first().cloned().unwrap_or_default();
    let map = resolve(deps, p, &codes).await?;
    let Some(v) = map.get(&code) else {
        return Err(ToolError::User(format!(
            "Không tìm thấy bản ghi mã {code} (hoặc bạn không có quyền xem). Dùng find_by_code / list_records để kiểm."
        )));
    };
    let key = table_key_of(v);
    if let Some(o) = object
        && o != key
    {
        return Err(ToolError::User(format!("Mã {code} thuộc bảng “{key}”, không phải “{o}”.")));
    }
    Ok((key, v.id))
}

// ---------------------------------------------------------------------------------------------------------------
// bảng lõi

const CONTACT_FILTERS: [&str; 5] = ["stage_id", "contact_status_id", "source_id", "assigned_to", "uncontacted_days"];
const DEAL_FILTERS: [&str; 2] = ["status", "assigned_to"];
const TASK_FILTERS: [&str; 5] = ["board_id", "column_id", "contact_id", "assignee_id", "overdue"];

fn read_filter(key: &str, raw: Option<&Value>) -> Result<Map<String, Value>, ToolError> {
    let allowed: &[&str] = match key {
        "contacts" => &CONTACT_FILTERS,
        "deals" => &DEAL_FILTERS,
        _ => &TASK_FILTERS,
    };
    let m = match raw {
        None | Some(Value::Null) => return Ok(Map::new()),
        Some(Value::Object(m)) => m,
        Some(_) => return Err(ToolError::User("filter phải là object {khoá_trường: giá trị}.".into())),
    };
    let bad: Vec<&str> = m.keys().map(String::as_str).filter(|k| !allowed.contains(k)).collect();
    if !bad.is_empty() {
        return Err(ToolError::User(format!(
            "Bảng {key} chỉ lọc được theo: {} (không có: {}).",
            allowed.join(", "),
            bad.iter().take(5).copied().collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(m.clone())
}

/// `cursorOf`: chuỗi 1-10 chữ số ⇒ số nguyên dương trong int4.
fn cursor_of(v: Option<&str>) -> Option<i32> {
    let s = v?;
    if s.is_empty() || s.len() > 10 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    opt_int(Some(&json!(s.parse::<i64>().ok()?)))
}

fn next_of(v: &Value) -> Value {
    v.as_i64().map_or(Value::Null, |n| json!(n.to_string()))
}

fn task_record(c: &Value) -> Value {
    let contact = c.get("contact").filter(|x| !x.is_null());
    json!({
        "id": c["id"], "code": c["code"], "title": c["title"], "description": c["description"], "due_at": c["due_at"],
        "priority": c["priority"], "contact_id": contact.map_or(Value::Null, |x| x["id"].clone()), "column_id": c["column_id"],
        "board_id": c["board_id"], "assignee_ids": c["assignee_ids"],
        "contact": contact.map_or(Value::Null, |x| x["full_name"].clone()),
        "completed": !c["completed_at"].is_null(), "is_overdue": c["is_overdue"], "labels": c["labels"],
    })
}

/// Khách → khoá THEO describe_schema (`assigned_to` = id người phụ trách; tên ở `assigned_to_name`).
fn contact_record(d: &Value) -> Value {
    let mut m = d.as_object().cloned().unwrap_or_default();
    let owner = m.remove("assigned_to").unwrap_or(Value::Null);
    let (id, name) = if owner.is_object() {
        (owner["id"].clone(), owner["full_name"].clone())
    } else {
        (owner, Value::Null)
    };
    m.insert("assigned_to".into(), id);
    m.insert("assigned_to_name".into(), name);
    Value::Object(m)
}

fn unwrap_data(out: &ToolOutput) -> Value {
    out.structured.get("data").cloned().unwrap_or(Value::Null)
}

struct CoreList {
    records: Vec<Value>,
    next_cursor: Value,
}

async fn list_core(
    key: &str,
    filter: Option<&Value>,
    search: Option<&str>,
    limit: i64,
    cursor: Option<&str>,
    ctx: &ToolCtx<'_>,
) -> Result<CoreList, ToolError> {
    let p = ctx.principal;
    require_perm(p, core_view_perm(key))?;
    let mut f = read_filter(key, filter)?;
    let cursor = cursor_of(cursor);
    match key {
        "tasks" => {
            let (deps, actor) = (ctx.deps, ctx.deps.kanban_actor(p).await?);
            let q = mod_kanban::cards::ListCards {
                search: search.map(str::to_owned),
                limit: Some(limit),
                cursor,
                board_id: opt_int(f.get("board_id")),
                column_id: opt_int(f.get("column_id")),
                contact_id: opt_int(f.get("contact_id")),
                assignee_id: opt_int(f.get("assignee_id")),
                overdue: (f.get("overdue") == Some(&Value::Bool(true))).then_some(true),
                ..mod_kanban::cards::ListCards::default()
            };
            let mut conn = deps.conn(p.company).await?;
            let res = mod_kanban::cards::list(&mut conn, &actor, &q).await.map_err(app_err)?;
            let r = to_json(&res)?;
            let records = r["cards"].as_array().map(|a| a.iter().map(task_record).collect()).unwrap_or_default();
            Ok(CoreList {
                records,
                next_cursor: next_of(&r["next_cursor"]),
            })
        }
        "contacts" => {
            f.insert("limit".into(), json!(limit));
            if let Some(c) = cursor {
                f.insert("cursor".into(), json!(c));
            }
            if let Some(s) = search {
                f.insert("name".into(), json!(s));
            }
            let out = contacts::list_contacts(&Value::Object(f), ctx).await?;
            let d = unwrap_data(&out);
            let records = d["contacts"].as_array().map(|a| a.iter().map(contact_record).collect()).unwrap_or_default();
            Ok(CoreList {
                records,
                next_cursor: next_of(&d["next_cursor"]),
            })
        }
        _ => {
            f.insert("limit".into(), json!(limit));
            if let Some(c) = cursor {
                f.insert("cursor".into(), json!(c));
            }
            if let Some(s) = search {
                f.insert("search".into(), json!(s));
            }
            let out = deals::list_deals(&Value::Object(f), ctx).await?;
            let d = unwrap_data(&out);
            let records = d["deals"].as_array().cloned().unwrap_or_default();
            Ok(CoreList {
                records,
                next_cursor: next_of(&d["next_cursor"]),
            })
        }
    }
}

async fn get_core(key: &str, id: i32, ctx: &ToolCtx<'_>) -> Result<Value, ToolError> {
    let (p, deps) = (ctx.principal, ctx.deps);
    require_perm(p, core_view_perm(key))?;
    match key {
        "contacts" => {
            let out = contacts::get_contact(&json!({ "id": id }), ctx).await?;
            Ok(contact_record(&unwrap_data(&out)))
        }
        "deals" => {
            let (dscopes, cscopes) = (deps.deal_scopes(p).await?, deps.contact_scopes(p).await?);
            let mut conn = deps.conn(p.company).await?;
            let d = mod_deals::deals::find_one(&mut conn, &dscopes, id).await.map_err(app_err)?;
            let d = to_json(&d)?;
            let cid = d["contact_id"].as_i64().and_then(|n| i32::try_from(n).ok());
            let seen = super::visible_contacts(&cscopes, p, &mut conn, &[cid]).await?;
            let visible = cid.is_some_and(|c| seen.contains(&c));
            Ok(json!({
                "id": d["id"], "code": d["code"], "title": d["title"], "description": d["description"], "value": d["value"],
                "status": d["status"], "note": d["note"],
                "contact_id": if visible { d["contact_id"].clone() } else { Value::Null },
                "assigned_to": d["assigned_to"],
                "assignee": d.get("assignee").and_then(|a| a.get("full_name")).cloned().unwrap_or(Value::Null),
                "created_at": d["created_at"], "updated_at": d["updated_at"],
            }))
        }
        _ => {
            let actor = deps.kanban_actor(p).await?;
            let mut conn = deps.conn(p.company).await?;
            let c = mod_kanban::cards::find_one(&mut conn, &actor, id).await.map_err(app_err)?;
            let c = to_json(&c)?;
            let (total, done) = (c["checklist_total"].as_i64().unwrap_or(0), c["checklist_done"].as_i64().unwrap_or(0));
            let mut rec = task_record(&c);
            if let Some(m) = rec.as_object_mut() {
                m.insert(
                    "checklist".into(),
                    if total > 0 { json!(format!("{done}/{total}")) } else { Value::Null },
                );
                m.insert("created_at".into(), c["created_at"].clone());
                m.insert("updated_at".into(), c["updated_at"].clone());
            }
            Ok(rec)
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// list_records, get_record

pub fn list_records<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let key = table_key(args.get("object"))?;
        let search = opt_str(args.get("search"), 100);
        if let Some(q) = &search {
            reject_digit_probe(q)?;
        }
        let limit = clamp_limit(args.get("limit"));
        let cursor = opt_str(args.get("cursor"), 400);
        if is_core_key(&key) {
            let r = list_core(&key, args.get("filter"), search.as_deref(), limit, cursor.as_deref(), ctx).await?;
            return wrapped(&json!({ "object": key, "total": null, "records": r.records, "next_cursor": r.next_cursor }));
        }
        require_perm(p, "custom_records.view")?;
        let filter = args
            .get("filter")
            .filter(|f| f.is_object() || f.is_array())
            .map(js_json);
        let mut q = Map::new();
        if let Some(s) = &search {
            q.insert("q".into(), json!(s));
        }
        q.insert("limit".into(), json!(limit));
        if let Some(c) = &cursor {
            q.insert("cursor".into(), json!(c));
        }
        if let Some(s) = opt_str(args.get("sort"), 60) {
            q.insert("sort".into(), json!(s));
        }
        q.insert(
            "dir".into(),
            json!(if args.get("dir").and_then(Value::as_str) == Some("asc") { "asc" } else { "desc" }),
        );
        if let Some(f) = &filter {
            q.insert("filter".into(), json!(f));
        }
        let res = mod_custom::records::list(&deps.custom_ctx(), &deps.custom_actor(p), &key, &Value::Object(q))
            .await
            .map_err(|e| map_not_found(e, &key))?;
        wrapped(&json!({
            "object": key, "total": res["total"],
            "total_counts": total_counts(search.as_deref(), filter.as_deref(), &res["total"]),
            "records": res["items"], "next_cursor": res["next_cursor"],
        }))
    })
}

pub fn get_record<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let code = args.get("code").filter(|c| !c.is_null() && c.as_str() != Some(""));
        let by_code = match code {
            Some(c) => {
                let object = match args.get("object").filter(|o| !o.is_null()) {
                    Some(o) => Some(table_key(Some(o))?),
                    None => None,
                };
                Some(id_from_code(deps, p, c, object.as_deref()).await?)
            }
            None => None,
        };
        let key = match &by_code {
            Some((k, _)) => k.clone(),
            None => table_key(args.get("object"))?,
        };
        let raw_id = opt_int(args.get("id"));
        // Cả id lẫn code mà trỏ hai bản ghi khác nhau ⇒ không đoán, báo AI chọn một.
        if let (Some((_, cid)), Some(rid)) = (&by_code, raw_id)
            && rid != *cid
        {
            let shown = code.and_then(Value::as_str).map_or(String::new(), |c| trim_js(c).to_uppercase());
            return Err(ToolError::User(format!(
                "id {rid} và code {shown} (bản ghi #{cid}) không cùng một bản ghi — chỉ gửi một trong hai."
            )));
        }
        let Some(id) = by_code.as_ref().map(|(_, i)| *i).or(raw_id) else {
            return Err(ToolError::User(
                "Cần id (số nguyên dương, kèm object) hoặc code (mã bản ghi, vd SP001).".into(),
            ));
        };
        if is_core_key(&key) {
            let mut rec = get_core(&key, id, ctx).await?;
            if let Some(m) = rec.as_object_mut() {
                m.insert("object".into(), json!(key));
            }
            return wrapped(&rec);
        }
        require_perm(p, "custom_records.view")?;
        let mut rec = mod_custom::records::get_one(&deps.custom_ctx(), &deps.custom_actor(p), &key, i64::from(id))
            .await
            .map_err(|e| map_not_found(e, &key))?;
        if let Some(m) = rec.as_object_mut() {
            m.insert("object".into(), json!(key));
        }
        wrapped(&rec)
    })
}

fn is_core_key(k: &str) -> bool {
    super::schema::is_core_key(k)
}
