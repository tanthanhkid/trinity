//! Thao tác ghi về bản ghi: `create_record`, `update_record`, `archive_record` (`actions/action-record-tools.ts`,
//! `action-archive-record.ts`, `action-core-records.ts`). Bảng tuỳ biến đi qua `mod_custom::records` (cùng kiểm quyền, phạm vi và
//! kiểm dữ liệu như giao diện web); bảng lõi `contacts`/`tasks` đi qua đúng thao tác `create_contact`/`create_task` và
//! `mod-contacts`/`mod-kanban`. Chưa có: ghi thương vụ (`deals`) và liên kết theo khoá nghiệp vụ `{"trường": "giá trị"}`.

use std::collections::HashMap;

use mod_contacts::write::UpdateContact;
use mod_custom::access::{ObjectDef, load_visible_object};
use mod_custom::records::{Validated, assert_unique, title_of, validate};
use mod_custom::refs::{Owners, RefAccess, RefType, RefView, parse_code, parse_ref, resolve_codes};
use mod_custom::types::FieldDef;
use mod_kanban::cards::UpdateCard;
use serde_json::{Map, Value, json};
use trinity_kernel::error::AppError;
use trinity_kernel::json::js_json;
use trinity_kernel::vi::trim_js;
use trinity_rbac::mask_phone;

use super::act_contacts::CREATE_CONTACT;
use super::act_tasks::CREATE_TASK;
use super::records::{id_from_code, valid_table_key};
use super::schema::is_core_key;
use super::visible_contacts;
use crate::actions::{
    ActionCx, ActionDef, Prepared, bad, clean_text, clean_value, covers, http_err, internal, line, lines, load_contact,
    message_of, owner, renamed, require_perm, shown,
};
use crate::ai_output::slice16;
use crate::args::opt_int;
use crate::deps::{app_err, to_json};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

const MAX_VALUES_KEYS: usize = 60;
const GONE: &str = "Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn.";
const DEALS_UNSUPPORTED: &str = "Ghi thương vụ (deals) qua MCP chưa chuyển sang Rust — hãy làm trên giao diện web.";
const CONTACT_EDITABLE: [&str; 9] = [
    "full_name",
    "job_title",
    "company_name",
    "email",
    "stage_id",
    "contact_status_id",
    "source_id",
    "reminder_at",
    "reminder_notes",
];
const TASK_EDITABLE: [&str; 5] = ["title", "description", "due_at", "priority", "contact_id"];

// ---------------------------------------------------------------------------------------------------------------
// Đối số và hiển thị

/// Khoá bảng + values từ tham số AI; values phải là object thường, không chứa NUL, không quá nhiều khoá.
fn parse_args(args: &Value) -> Result<(String, Map<String, Value>, Option<i32>), ToolError> {
    let key = clean_value(args.get("object"), 48);
    if !valid_table_key(&key) {
        return Err(ToolError::User(
            "object phải là khoá bảng (a-z, 0-9, _) — hãy gọi describe_schema để lấy đúng khoá.".to_owned(),
        ));
    }
    let Some(values) = args.get("values").and_then(Value::as_object) else {
        return Err(ToolError::User(
            "values phải là object {khoá_trường: giá trị}.".to_owned(),
        ));
    };
    if values.is_empty() || values.len() > MAX_VALUES_KEYS {
        return Err(ToolError::User(format!("values cần 1-{MAX_VALUES_KEYS} trường.")));
    }
    if js_json(&Value::Object(values.clone())).contains("\\u0000") {
        return Err(ToolError::User("values chứa ký tự không hợp lệ.".to_owned()));
    }
    Ok((key, values.clone(), opt_int(args.get("owner_id"))))
}

fn plain(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn choice_label(f: &FieldDef, x: &Value) -> String {
    let choices = f.options.get("choices").and_then(Value::as_array);
    let hit = choices.and_then(|cs| {
        cs.iter()
            .find(|c| c.get("value") == Some(x))
            .and_then(|c| c.get("label"))
            .and_then(Value::as_str)
    });
    hit.map_or_else(|| plain(x), str::to_owned)
}

/// Giá trị trường để người duyệt đọc (SĐT che).
fn show_value(f: &FieldDef, v: Option<&Value>) -> String {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return "(trống)".to_owned();
    };
    if f.kind == "phone" {
        return mask_phone(Some(plain(v).as_str())).unwrap_or_else(|| "***".to_owned());
    }
    match (f.kind.as_str(), v) {
        ("select", _) => choice_label(f, v),
        (_, Value::Array(a)) => a
            .iter()
            .map(|x| {
                if f.kind == "multi_select" {
                    choice_label(f, x)
                } else {
                    format!("#{}", plain(x))
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
        ("relation" | "user", _) => format!("#{}", plain(v)),
        (_, Value::Bool(b)) => (if *b { "Có" } else { "Không" }).to_owned(),
        _ => plain(v),
    }
}

fn field_lines(
    def: &ObjectDef,
    data: &Map<String, Value>,
    only: &[String],
    before: Option<&Map<String, Value>>,
) -> Vec<Option<Value>> {
    only.iter()
        .map(|k| {
            let f = def.fields.iter().find(|f| f.key == *k)?;
            let now = show_value(f, data.get(k));
            let text = match before {
                Some(b) => format!("{} → {now}", show_value(f, b.get(k))),
                None => now,
            };
            line(&f.label, Some(text.as_str()), 600)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Bảng, phạm vi, kiểm dữ liệu

/// Bảng AI nhắm tới: ngoài tầm nhìn/không tồn tại ⇒ cùng một thông báo (không lộ bảng bị ẩn).
async fn load_def(cx: &ActionCx<'_>, key: &str) -> Result<ObjectDef, ToolError> {
    let p = cx.principal;
    let actor = cx.deps.custom_actor(p);
    let mut conn = cx.deps.conn(p.company).await?;
    load_visible_object(&mut conn, &actor, key, None).await.map_err(|e| {
        let (status, message) = message_of(e);
        if status == 404 {
            ToolError::User(format!(
                "Không có bảng “{key}” (hoặc bạn không được thấy). Hãy gọi describe_schema để lấy danh sách bảng."
            ))
        } else {
            ToolError::Http { status, message }
        }
    })
}

/// Lỗi kiểm dữ liệu (400 kèm `errors` theo trường) → câu AI đọc được để sửa lại.
fn explain(e: AppError) -> ToolError {
    let (status, body) = e.response(true);
    let message = match body.message {
        trinity_kernel::error::Message::One(s) => s,
        trinity_kernel::error::Message::Many(m) => m.join("; "),
    };
    if status == 400 {
        let detail = match &body.errors {
            Some(Value::Object(m)) => m
                .iter()
                .map(|(k, v)| format!("{}: {}", slice16(k, 40), v.as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("; "),
            _ => message,
        };
        return ToolError::User(slice16(&format!("Dữ liệu không hợp lệ — {detail}"), 1500));
    }
    if status == 404 {
        return ToolError::NotFound;
    }
    ToolError::Http { status, message }
}

/// Giao cho người khác: phải nằm trong phạm vi SỬA của người dùng (báo lỗi sớm; service kiểm lại lúc ghi).
async fn assert_owner_ok(cx: &ActionCx<'_>, owner_id: Option<i32>) -> Result<(), ToolError> {
    let Some(o) = owner_id.filter(|o| *o != cx.principal.user_id) else {
        return Ok(());
    };
    let allowed = owner(cx, "custom_records.manage").await?;
    if covers(allowed.as_ref(), o) {
        Ok(())
    } else {
        Err(ToolError::User(
            "Không giao được cho người này (ngoài phạm vi của bạn). Xem list_crm_options.".to_owned(),
        ))
    }
}

/// Nhãn của trường `key` (không có thì chính khoá).
fn label_of<'a>(def: &'a ObjectDef, key: &'a str) -> &'a str {
    def.fields
        .iter()
        .find(|f| f.key == key)
        .map_or(key, |f| f.label.as_str())
}

async fn validate_for(
    cx: &ActionCx<'_>,
    def: &ObjectDef,
    data: &Map<String, Value>,
    existing: Option<&Map<String, Value>>,
    exclude: Option<i32>,
) -> Result<Validated, ToolError> {
    let p = cx.principal;
    let actor = cx.deps.custom_actor(p);
    let owners = Owners::load(&cx.deps.custom_ctx(), &actor).await.map_err(app_err)?;
    let mut conn = cx.deps.conn(p.company).await?;
    let acc = RefAccess::build(&mut conn, &actor, owners).await.map_err(app_err)?;
    let v = validate(&mut conn, &actor, &acc, def, data, existing)
        .await
        .map_err(explain)?;
    assert_unique(&mut conn, def, &v.data, &v.changed, exclude)
        .await
        .map_err(explain)?;
    Ok(v)
}

// ---------------------------------------------------------------------------------------------------------------
// Liên kết theo mã

fn as_list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Null => Vec::new(),
        Value::Array(a) => a.iter().collect(),
        other => vec![other],
    }
}

fn target_object_id(f: &FieldDef) -> Option<i32> {
    f.options
        .get("target_object_id")
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
}

/// Một giá trị liên kết: id số / `loại:id` giữ nguyên; mã `"HS001"` ⇒ id (relation, kiểm đúng bảng đích) hoặc mã (link).
fn resolve_item(
    f: &FieldDef,
    item: &Value,
    found: &HashMap<String, RefView>,
    keys: &HashMap<i32, String>,
) -> Result<Value, String> {
    if item.is_number() {
        return Ok(item.clone());
    }
    let Some(s) = item.as_str() else {
        return Err(
            "giá trị liên kết phải là id hoặc mã (HS001); liên kết theo khoá nghiệp vụ {\"trường\": \"giá trị\"} chưa hỗ trợ"
                .to_owned(),
        );
    };
    if parse_ref(s).is_some() {
        return Ok(item.clone());
    }
    let Some(c) = parse_code(s.strip_prefix('@').unwrap_or(s)) else {
        return Err(format!(
            "“{}” không phải id, mã (HS001) hay khoá nghiệp vụ {{\"trường\": \"giá trị\"}}",
            slice16(s, 30)
        ));
    };
    if f.kind == "link" {
        return Ok(json!(c.code));
    }
    let to_contact = f.options.get("target").and_then(Value::as_str) == Some("contact");
    let target_key = target_object_id(f).and_then(|id| keys.get(&id));
    let hit = found.get(&c.code).filter(|v| {
        if to_contact {
            v.ty == RefType::Contact
        } else {
            v.ty == RefType::Record && v.table_key.as_ref() == target_key
        }
    });
    hit.map(|v| json!(v.id)).ok_or_else(|| {
        format!(
            "không tìm thấy {} trong bảng đích (hoặc bạn không có quyền xem)",
            c.code
        )
    })
}

/// Liên kết theo mã → id (cùng cơ chế tra mã với `find_by_code`, theo phạm vi XEM của người ghi).
async fn resolve_links(
    cx: &ActionCx<'_>,
    def: &ObjectDef,
    values: &Map<String, Value>,
) -> Result<Map<String, Value>, ToolError> {
    let p = cx.principal;
    let fields: Vec<&FieldDef> = def
        .fields
        .iter()
        .filter(|f| f.kind == "relation" || f.kind == "link")
        .filter(|f| values.get(&f.key).is_some_and(|v| !v.is_null()))
        .collect();
    if fields.is_empty() {
        return Ok(values.clone());
    }
    let mut codes: Vec<String> = Vec::new();
    for f in &fields {
        for item in as_list(&values[&f.key]) {
            let Some(s) = item.as_str() else { continue };
            if parse_ref(s).is_some() {
                continue;
            }
            if let Some(c) = parse_code(s.strip_prefix('@').unwrap_or(s))
                && !codes.contains(&c.code)
            {
                codes.push(c.code);
            }
        }
    }
    let target_ids: Vec<i32> = fields.iter().filter_map(|f| target_object_id(f)).collect();
    let actor = cx.deps.custom_actor(p);
    let owners = if codes.is_empty() {
        None
    } else {
        Some(Owners::load(&cx.deps.custom_ctx(), &actor).await.map_err(app_err)?)
    };
    let (keys, found): (HashMap<i32, String>, HashMap<String, RefView>) = {
        let mut conn = cx.deps.conn(p.company).await?;
        let keys = if target_ids.is_empty() {
            HashMap::new()
        } else {
            sqlx::query_as::<_, (i32, String)>("SELECT id, key FROM custom_objects WHERE id = ANY($1)")
                .bind(&target_ids)
                .fetch_all(&mut *conn)
                .await
                .map_err(internal)?
                .into_iter()
                .collect()
        };
        let found = match owners {
            Some(o) => {
                let acc = RefAccess::build(&mut conn, &actor, o).await.map_err(app_err)?;
                resolve_codes(&mut conn, &acc, &codes).await.map_err(app_err)?
            }
            None => HashMap::new(),
        };
        (keys, found)
    };
    let mut out = values.clone();
    for f in &fields {
        let raw = &values[&f.key];
        let mut items: Vec<Value> = Vec::new();
        for item in as_list(raw) {
            let r = resolve_item(f, item, &found, &keys)
                .map_err(|m| ToolError::User(format!("Liên kết không hợp lệ — {}: {m}", f.key)))?;
            items.push(r);
        }
        let multiple = f.options.get("multiple").and_then(Value::as_bool).unwrap_or(false);
        let value = if raw.is_array() || (f.kind == "relation" && multiple) || f.kind == "link" {
            Value::Array(items)
        } else {
            items.into_iter().next().unwrap_or(Value::Null)
        };
        out.insert(f.key.clone(), value);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Bảng lõi (contacts, tasks)

fn core_create_perm(key: &str) -> &'static str {
    match key {
        "contacts" => "contacts.create",
        "deals" => "deals.manage",
        _ => "kanban.manage",
    }
}

fn core_update_perm(key: &str) -> &'static str {
    match key {
        "contacts" => "contacts.update",
        "deals" => "deals.manage",
        _ => "kanban.manage",
    }
}

fn core_def(key: &str) -> Result<&'static ActionDef, ToolError> {
    match key {
        "contacts" => Ok(&CREATE_CONTACT),
        "tasks" => Ok(&CREATE_TASK),
        _ => Err(ToolError::User(DEALS_UNSUPPORTED.to_owned())),
    }
}

async fn core_create_prepare(cx: &ActionCx<'_>, key: &str, vals: &Map<String, Value>) -> Result<Prepared, ToolError> {
    require_perm(cx.principal, core_create_perm(key))?;
    let def = core_def(key)?;
    let input = Value::Object(vals.clone());
    let p = (def.prepare)(&input, cx).await?;
    Ok(Prepared {
        params: json!({ "object": key, "values": p.params }),
        summary: p.summary,
        details: p.details,
        impact: None,
    })
}

/// Khi SỬA, `null` nghĩa là xoá giá trị: chỉ bỏ chuỗi rỗng; chuỗi được làm sạch.
fn clean_update(values: &Map<String, Value>) -> Map<String, Value> {
    values
        .iter()
        .map(|(k, v)| match v {
            Value::String(s) => (k.clone(), json!(clean_text(s, 2000))),
            other => (k.clone(), other.clone()),
        })
        .filter(|(_, v)| v.as_str() != Some(""))
        .collect()
}

fn only(values: &Map<String, Value>, allowed: &[&str], table: &str) -> Result<(), ToolError> {
    let not_ok: Vec<&str> = values
        .keys()
        .map(String::as_str)
        .filter(|k| !allowed.contains(k))
        .take(5)
        .collect();
    if not_ok.is_empty() {
        Ok(())
    } else {
        Err(ToolError::User(format!(
            "Bảng {table} chỉ sửa được: {} (không sửa được: {}).",
            allowed.join(", "),
            not_ok.join(", ")
        )))
    }
}

fn show_params(params: &Map<String, Value>) -> Vec<Option<Value>> {
    params
        .iter()
        .map(|(k, v)| {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            line(k, Some(text.as_str()), 600)
        })
        .collect()
}

fn keys_of(params: &Map<String, Value>) -> String {
    params.keys().map(String::as_str).collect::<Vec<_>>().join(", ")
}

async fn core_update_prepare(
    cx: &ActionCx<'_>,
    key: &str,
    id: i32,
    values: &Map<String, Value>,
) -> Result<Prepared, ToolError> {
    let p = cx.principal;
    require_perm(p, core_update_perm(key))?;
    if key == "contacts" {
        only(values, &CONTACT_EDITABLE, "khách hàng")?;
        let params = clean_update(values);
        if params.is_empty() {
            return Err(ToolError::User("Không có giá trị nào để sửa.".to_owned()));
        }
        serde_json::from_value::<UpdateContact>(Value::Object(params.clone())).map_err(|e| bad(e.to_string()))?;
        let c = load_contact(cx, id, "contacts.update", true).await?;
        // Đổi tên chỉ khi khách chưa có tên (Quản trị ghi đè thì tên mới hiện ở kết quả, không ở bản nháp).
        let blank = c.full_name.as_deref().is_none_or(|n| trim_js(n).is_empty());
        let after = if blank {
            params.get("full_name").and_then(Value::as_str)
        } else {
            None
        };
        let shown_name = renamed(c.full_name.as_deref(), after);
        let name = if shown_name.is_empty() {
            format!("#{}", c.id)
        } else {
            shown_name
        };
        let who = format!("{} (#{})", c.full_name.as_deref().unwrap_or("(chưa có tên)"), c.id);
        let mut details = vec![line("Khách hàng", Some(who.as_str()), 600)];
        details.extend(show_params(&params));
        return Ok(Prepared {
            summary: shown(&format!("Sửa khách \"{name}\": {}", keys_of(&params)), 300),
            details: lines(details),
            params: json!({ "object": key, "id": id, "values": params }),
            impact: None,
        });
    }
    if key != "tasks" {
        return Err(ToolError::User(DEALS_UNSUPPORTED.to_owned()));
    }
    only(values, &TASK_EDITABLE, "việc")?;
    let params = clean_update(values);
    if params.is_empty() {
        return Err(ToolError::User("Không có giá trị nào để sửa.".to_owned()));
    }
    let dto: UpdateCard = serde_json::from_value(Value::Object(params.clone())).map_err(|e| bad(e.to_string()))?;
    dto.validate().map_err(http_err)?;
    let actor = cx.deps.kanban_actor(p).await?;
    let scopes = cx.deps.contact_scopes(p).await?;
    let mut conn = cx.deps.conn(p.company).await?;
    // Gắn khách vào việc phải kiểm phạm vi NGAY lúc nhận (null = gỡ liên kết thì không cần).
    if let Some(Some(cid)) = dto.contact_id {
        let seen = visible_contacts(&scopes, p, &mut conn, &[Some(cid)]).await?;
        if !seen.contains(&cid) {
            return Err(ToolError::User(format!(
                "contact_id {cid}: không tìm thấy khách hàng hoặc nằm ngoài phạm vi quyền của bạn."
            )));
        }
    }
    let card = mod_kanban::cards::find_one(&mut conn, &actor, id)
        .await
        .map_err(app_err)?;
    let c = to_json(&card)?;
    let title = c.get("title").and_then(Value::as_str);
    let after = params.get("title").and_then(Value::as_str);
    let who = format!("{} (#{id})", title.unwrap_or(""));
    let mut details = vec![line("Việc", Some(who.as_str()), 600)];
    details.extend(show_params(&params));
    Ok(Prepared {
        summary: shown(
            &format!("Sửa việc \"{}\": {}", renamed(title, after), keys_of(&params)),
            300,
        ),
        details: lines(details),
        params: json!({ "object": key, "id": id, "values": params }),
        impact: None,
    })
}

async fn core_update_execute(cx: &ActionCx<'_>, key: &str, id: i32, values: &Value) -> Result<Value, ToolError> {
    let p = cx.principal;
    require_perm(p, core_update_perm(key))?;
    if key == "contacts" {
        let dto: UpdateContact = serde_json::from_value(values.clone()).map_err(|e| bad(e.to_string()))?;
        let scopes = cx.deps.contact_scopes(p).await?;
        let tenant = cx.deps.db.tenant(p.company).await.map_err(internal)?;
        let actor = mod_contacts::Actor {
            user_id: p.user_id,
            is_admin: false,
            email: Some(p.email.clone()),
        };
        mod_contacts::write::update(&tenant, &scopes, &actor, id, &dto)
            .await
            .map_err(app_err)?;
    } else if key == "tasks" {
        let dto: UpdateCard = serde_json::from_value(values.clone()).map_err(|e| bad(e.to_string()))?;
        let actor = cx.deps.kanban_actor(p).await?;
        let mut conn = cx.deps.conn(p.company).await?;
        mod_kanban::cards::update(&mut conn, &actor, id, &dto)
            .await
            .map_err(app_err)?;
    } else {
        return Err(ToolError::User(DEALS_UNSUPPORTED.to_owned()));
    }
    Ok(json!({ "object": key, "record_id": id }))
}

// ---------------------------------------------------------------------------------------------------------------
// create_record

pub(crate) static CREATE_RECORD: ActionDef = ActionDef {
    name: "create_record",
    label: "Tạo bản ghi",
    permissions: &[],
    prepare: create_prepare,
    execute: create_execute,
    structure: false,
};

fn create_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        let (key, values, owner_id) = parse_args(args)?;
        if is_core_key(&key) {
            return core_create_prepare(cx, &key, &values).await;
        }
        require_perm(p, "custom_records.view")?;
        require_perm(p, "custom_records.manage")?;
        assert_owner_ok(cx, owner_id).await?;
        let def = load_def(cx, &key).await?;
        let resolved = resolve_links(cx, &def, &values).await?;
        let v = validate_for(cx, &def, &resolved, None, None).await?;
        let title = title_of(&def, &v.data).map(|t| format!(" \"{t}\"")).unwrap_or_default();
        let keys: Vec<String> = v.data.keys().cloned().collect();
        let owner_text = owner_id.map_or_else(|| "Bạn".to_owned(), |o| format!("#{o}"));
        let mut details = vec![
            line("Bảng", Some(def.obj.label_plural.as_str()), 600),
            line("Người phụ trách", Some(owner_text.as_str()), 600),
        ];
        details.extend(field_lines(&def, &v.data, &keys, None));
        let mut params = Map::new();
        params.insert("object".into(), json!(key));
        params.insert("values".into(), Value::Object(resolved));
        if let Some(o) = owner_id {
            params.insert("owner_id".into(), json!(o));
        }
        Ok(Prepared {
            params: Value::Object(params),
            summary: shown(
                &format!("Tạo {}{title} (bảng {})", def.obj.label, def.obj.label_plural),
                300,
            ),
            details: lines(details),
            impact: None,
        })
    })
}

fn create_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        let key = params.get("object").and_then(Value::as_str).unwrap_or("");
        if is_core_key(key) {
            let def = core_def(key)?;
            require_perm(p, core_create_perm(key))?;
            let inner = params.get("values").cloned().unwrap_or(Value::Null);
            let res = (def.execute)(&inner, cx, draft_id).await?;
            let mut out = Map::new();
            out.insert("object".into(), json!(key));
            if let Value::Object(m) = res {
                out.extend(m);
            }
            return Ok(Value::Object(out));
        }
        require_perm(p, "custom_records.manage")?;
        let mut body = Map::new();
        body.insert(
            "data".into(),
            params.get("values").cloned().unwrap_or_else(|| json!({})),
        );
        if let Some(o) = opt_int(params.get("owner_id")) {
            body.insert("owner_id".into(), json!(o));
        }
        let (ctx, actor) = (cx.deps.custom_ctx(), cx.deps.custom_actor(p));
        let body = Value::Object(body);
        let res = mod_custom::records::create(&ctx, &actor, key, &body)
            .await
            .map_err(app_err)?;
        Ok(json!({ "record_id": res["id"], "object": key }))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// update_record

pub(crate) static UPDATE_RECORD: ActionDef = ActionDef {
    name: "update_record",
    label: "Sửa bản ghi",
    permissions: &[],
    prepare: update_prepare,
    execute: update_execute,
    structure: false,
};

/// Dòng bản ghi tuỳ biến của bảng `object_id`: (chủ, người tạo, tiêu đề, dữ liệu dạng chuỗi JSON).
type RecordRow = (Option<i32>, Option<i32>, Option<String>, String);

async fn load_record_row(cx: &ActionCx<'_>, object_id: i32, id: i32) -> Result<Option<RecordRow>, ToolError> {
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    sqlx::query_as(
        "SELECT owner_id, created_by, title, data::text FROM custom_records
         WHERE id = $1 AND object_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(object_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)
}

fn update_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        let (key, raw, owner_id) = parse_args(args)?;
        let code = args.get("code").filter(|c| !c.is_null() && c.as_str() != Some(""));
        let by_code = match code {
            Some(c) => Some(id_from_code(cx.deps, p, c, Some(key.as_str())).await?),
            None => None,
        };
        let raw_id = opt_int(args.get("id"));
        if let (Some((_, cid)), Some(rid)) = (&by_code, raw_id)
            && rid != *cid
        {
            let shown_code = code
                .and_then(Value::as_str)
                .map_or_else(String::new, |c| trim_js(c).to_uppercase());
            return Err(ToolError::User(format!(
                "id {rid} và code {shown_code} (bản ghi #{cid}) không cùng một bản ghi — chỉ gửi một trong hai."
            )));
        }
        let Some(id) = by_code.as_ref().map(|(_, i)| *i).or(raw_id) else {
            return Err(ToolError::User(
                "Cần id (số nguyên dương) hoặc code (mã bản ghi, vd SP001).".to_owned(),
            ));
        };
        if is_core_key(&key) {
            return core_update_prepare(cx, &key, id, &raw).await;
        }
        require_perm(p, "custom_records.view")?;
        require_perm(p, "custom_records.manage")?;
        assert_owner_ok(cx, owner_id).await?;
        let def = load_def(cx, &key).await?;
        let values = resolve_links(cx, &def, &raw).await?;
        let view = owner(cx, "custom_records.view").await?;
        let manage = owner(cx, "custom_records.manage").await?;
        let Some((row_owner, row_creator, row_title, data_text)) = load_record_row(cx, def.obj.id, id).await? else {
            return Err(ToolError::User(GONE.to_owned()));
        };
        // Phạm vi SỬA + phạm vi XEM (tiêu đề/giá trị cũ đi vào bản nháp trả cho AI).
        let owners = [row_owner, row_creator];
        if trinity_rbac::assert_in_scope(manage.as_ref(), &owners).is_err()
            || trinity_rbac::assert_in_scope(view.as_ref(), &owners).is_err()
        {
            return Err(ToolError::User(GONE.to_owned()));
        }
        let before: Map<String, Value> = serde_json::from_str::<Value>(&data_text)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let v = validate_for(cx, &def, &values, Some(&before), Some(id)).await?;
        let owner_changed = owner_id.is_some_and(|o| Some(o) != row_owner);
        if v.changed.is_empty() && !owner_changed {
            return Err(ToolError::User(
                "Không có thay đổi nào so với bản ghi hiện tại.".to_owned(),
            ));
        }
        let labels: Vec<&str> = v.changed.iter().map(|k| label_of(&def, k)).collect();
        let title = renamed(row_title.as_deref(), title_of(&def, &v.data).as_deref());
        let title_part = if title.is_empty() {
            String::new()
        } else {
            format!(" \"{title}\"")
        };
        let record = format!(
            "#{id}{}",
            row_title.as_deref().map_or_else(String::new, |t| format!(" {t}"))
        );
        let mut details = vec![
            line("Bảng", Some(def.obj.label_plural.as_str()), 600),
            line("Bản ghi", Some(record.as_str()), 600),
        ];
        details.extend(field_lines(&def, &v.data, &v.changed, Some(&before)));
        let mut params = Map::new();
        params.insert("object".into(), json!(key));
        params.insert("id".into(), json!(id));
        params.insert("values".into(), Value::Object(values));
        if let Some(o) = owner_id {
            params.insert("owner_id".into(), json!(o));
        }
        Ok(Prepared {
            params: Value::Object(params),
            summary: shown(
                &format!("Sửa {} #{id}{title_part}: {}", def.obj.label, labels.join(", ")),
                300,
            ),
            details: lines(details),
            impact: None,
        })
    })
}

fn update_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        let key = params.get("object").and_then(Value::as_str).unwrap_or("");
        let Some(id) = opt_int(params.get("id")) else {
            return Err(bad("Dữ liệu đề xuất không hợp lệ"));
        };
        if is_core_key(key) {
            let values = params.get("values").cloned().unwrap_or(Value::Null);
            return core_update_execute(cx, key, id, &values).await;
        }
        require_perm(p, "custom_records.manage")?;
        let mut body = Map::new();
        body.insert(
            "data".into(),
            params.get("values").cloned().unwrap_or_else(|| json!({})),
        );
        if let Some(o) = opt_int(params.get("owner_id")) {
            body.insert("owner_id".into(), json!(o));
        }
        let (ctx, actor) = (cx.deps.custom_ctx(), cx.deps.custom_actor(p));
        let body = Value::Object(body);
        let res = mod_custom::records::update(&ctx, &actor, key, i64::from(id), &body)
            .await
            .map_err(app_err)?;
        Ok(json!({ "record_id": res["id"], "object": key }))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// archive_record

pub(crate) static ARCHIVE_RECORD: ActionDef = ActionDef {
    name: "archive_record",
    label: "Lưu trữ (xoá mềm) bản ghi",
    permissions: &["custom_records.view", "custom_records.delete"],
    prepare: archive_prepare,
    execute: archive_execute,
    structure: false,
};

fn archive_prepare<'a>(args: &'a Value, cx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = clean_value(args.get("object"), 48);
        let id = opt_int(args.get("id"));
        let Some(id) = id.filter(|_| valid_table_key(&key)) else {
            return Err(ToolError::User(
                "object phải là khoá bảng và id là số nguyên dương.".to_owned(),
            ));
        };
        if is_core_key(&key) {
            return Err(ToolError::User(
                "Không lưu trữ được bản ghi của bảng lõi (khách hàng, thương vụ, việc) qua MCP.".to_owned(),
            ));
        }
        let def = load_def(cx, &key).await?;
        let delete = owner(cx, "custom_records.delete").await?;
        let view = owner(cx, "custom_records.view").await?;
        let Some((row_owner, row_creator, row_title, _)) = load_record_row(cx, def.obj.id, id).await? else {
            return Err(ToolError::User(GONE.to_owned()));
        };
        let owners = [row_owner, row_creator];
        if trinity_rbac::assert_in_scope(delete.as_ref(), &owners).is_err()
            || trinity_rbac::assert_in_scope(view.as_ref(), &owners).is_err()
        {
            return Err(ToolError::User(GONE.to_owned()));
        }
        let name = format!(
            "#{id}{}",
            row_title.as_deref().map_or_else(String::new, |t| format!(" \"{t}\""))
        );
        Ok(Prepared {
            params: json!({ "object": key, "id": id }),
            summary: shown(&format!("Lưu trữ (xoá mềm) {} {name}", def.obj.label), 300),
            details: lines(vec![
                line("Bảng", Some(def.obj.label_plural.as_str()), 600),
                line("Bản ghi", Some(name.as_str()), 600),
                line(
                    "Hậu quả",
                    Some("Bản ghi biến khỏi danh sách; dữ liệu vẫn còn trong hệ thống"),
                    600,
                ),
            ]),
            impact: None,
        })
    })
}

fn archive_execute<'a>(
    params: &'a Value,
    cx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let p = cx.principal;
        let key = params.get("object").and_then(Value::as_str).unwrap_or("");
        let Some(id) = opt_int(params.get("id")) else {
            return Err(bad("Dữ liệu đề xuất không hợp lệ"));
        };
        let (ctx, actor) = (cx.deps.custom_ctx(), cx.deps.custom_actor(p));
        mod_custom::records::remove(&ctx, &actor, key, i64::from(id))
            .await
            .map_err(app_err)?;
        Ok(json!({ "object": key, "record_id": id, "archived": true }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(kind: &str, options: Value) -> FieldDef {
        FieldDef {
            id: 1,
            key: "f".into(),
            label: "F".into(),
            kind: kind.into(),
            required: false,
            is_unique: false,
            is_title: false,
            show_in_list: true,
            sort_order: 0,
            options,
            help_text: None,
        }
    }

    fn obj(v: Value) -> Map<String, Value> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn doc_doi_so_bang_va_values() {
        let ok = json!({ "object": " don_hang ", "values": { "a": 1 }, "owner_id": 4 });
        let (k, v, o) = parse_args(&ok).unwrap();
        assert_eq!((k.as_str(), v.len(), o), ("don_hang", 1, Some(4)));
        for (args, msg) in [
            (
                json!({ "object": "Sai Khoa", "values": { "a": 1 } }),
                "object phải là khoá bảng",
            ),
            (json!({ "object": "x", "values": [1] }), "values phải là object"),
            (json!({ "object": "x", "values": {} }), "values cần 1-60 trường."),
            (
                json!({ "object": "x", "values": { "a": "\u{0}" } }),
                "values chứa ký tự không hợp lệ.",
            ),
        ] {
            let Err(ToolError::User(m)) = parse_args(&args) else {
                panic!("phải là lỗi người dùng: {args}");
            };
            assert!(m.starts_with(msg), "{m}");
        }
        let many: Map<String, Value> = (0..61).map(|i| (format!("k{i}"), json!(i))).collect();
        assert!(parse_args(&json!({ "object": "x", "values": many })).is_err());
    }

    #[test]
    fn hien_thi_gia_tri_truong() {
        let sel = field("select", json!({ "choices": [{ "value": "a", "label": "Loại A" }] }));
        assert_eq!(show_value(&sel, Some(&json!("a"))), "Loại A");
        assert_eq!(show_value(&sel, Some(&json!("z"))), "z");
        assert_eq!(show_value(&sel, None), "(trống)");
        assert_eq!(show_value(&sel, Some(&Value::Null)), "(trống)");
        let multi = field("multi_select", json!({ "choices": [{ "value": "a", "label": "A" }] }));
        assert_eq!(show_value(&multi, Some(&json!(["a", "b"]))), "A, b");
        assert_eq!(show_value(&field("relation", json!({})), Some(&json!(5))), "#5");
        assert_eq!(
            show_value(&field("relation", json!({})), Some(&json!([5, 6]))),
            "#5, #6"
        );
        assert_eq!(show_value(&field("boolean", json!({})), Some(&json!(true))), "Có");
        assert_eq!(
            show_value(&field("phone", json!({})), Some(&json!("0901234567"))),
            "***567"
        );
        assert_eq!(show_value(&field("number", json!({})), Some(&json!(1.5))), "1.5");
    }

    fn view(ty: RefType, id: i32, table_key: Option<&str>) -> RefView {
        RefView {
            ty,
            id,
            code: None,
            title: String::new(),
            table: String::new(),
            table_key: table_key.map(str::to_owned),
            href: None,
        }
    }

    #[test]
    fn lien_ket_theo_ma() {
        let rel = field("relation", json!({ "target_object_id": 3 }));
        let keys = HashMap::from([(3, "san_pham".to_owned())]);
        let found = HashMap::from([
            ("SP001".to_owned(), view(RefType::Record, 11, Some("san_pham"))),
            ("HS002".to_owned(), view(RefType::Record, 12, Some("khac"))),
            ("KH001".to_owned(), view(RefType::Contact, 13, None)),
        ]);
        assert_eq!(resolve_item(&rel, &json!(7), &found, &keys), Ok(json!(7)));
        assert_eq!(
            resolve_item(&rel, &json!("record:9"), &found, &keys),
            Ok(json!("record:9"))
        );
        assert_eq!(resolve_item(&rel, &json!("@sp1"), &found, &keys), Ok(json!(11)));
        assert!(resolve_item(&rel, &json!("HS002"), &found, &keys).is_err());
        assert!(resolve_item(&rel, &json!("KH001"), &found, &keys).is_err());
        assert!(resolve_item(&rel, &json!("###"), &found, &keys).is_err());
        assert!(resolve_item(&rel, &json!({ "ma": "C1" }), &found, &keys).is_err());
        let to_contact = field("relation", json!({ "target": "contact" }));
        assert_eq!(resolve_item(&to_contact, &json!("KH001"), &found, &keys), Ok(json!(13)));
        let link = field("link", json!({}));
        assert_eq!(resolve_item(&link, &json!("sp1"), &found, &keys), Ok(json!("SP001")));
    }

    #[test]
    fn sua_bang_loi_chi_truong_cho_phep() {
        let m = obj(json!({ "phone": "0900000001", "full_name": " A " }));
        let Err(ToolError::User(msg)) = only(&m, &CONTACT_EDITABLE, "khách hàng") else {
            panic!("phải bị từ chối");
        };
        assert!(msg.contains("không sửa được: phone"), "{msg}");
        let c = clean_update(&obj(json!({ "title": "  x ", "description": "", "contact_id": null })));
        assert_eq!(c.get("title"), Some(&json!("x")));
        assert!(c.get("description").is_none());
        assert_eq!(c.get("contact_id"), Some(&Value::Null));
    }
}
