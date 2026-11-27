//! `describe_schema`, `list_screen_types`, `list_structure_versions`, `list_object_templates` (`schema-core.ts`, `schema-tools.ts`,
//! `screen-types-tool.ts`, `setup-tools.ts`, `template-tools.ts`). Bảng tuỳ biến chỉ hiện cho người dùng được thấy (vai trò, bật/tắt)
//! và người có `custom_records.view`; trường/lựa chọn/bảng đích ngoài quyền xem không lộ khoá hay tên.

use mod_custom::access::{FIELD_COLS, OBJ_COLS, VIEW_COLS, is_object_visible, load_access};
use mod_custom::types::{CHOICE_COLORS, CUSTOM_ICONS, FIELD_TYPES, FieldDef, Limits};
use mod_custom::views::VIEW_TYPES;
use serde_json::{Map, Value, json};
use trinity_db::models::{CustomField, CustomObject, CustomView};
use trinity_kernel::json::js_json;
use trinity_rbac::{Grant, Grants, can};

use super::wrapped;
use crate::ai_output::{DATA_NOTICE, sanitize_at, slice16};
use crate::auth::Principal;
use crate::deps::{ToolDeps, app_err};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

fn internal(e: sqlx::Error) -> ToolError {
    ToolError::Internal(e.to_string())
}

/// own | team | subtree | all (`true` ⇒ all); không có quyền ⇒ null (`scopeName`).
pub(super) fn scope_name(g: &Grants, perm: &str) -> Value {
    match g.get(perm) {
        None => Value::Null,
        Some(Grant::Full) => json!("all"),
        Some(Grant::Scope(s)) => json!(s.as_str()),
    }
}

const MAX_TABLES: i64 = 60;

fn core_field(key: &str, label: &str, ty: &str, settable_on: &[&str], required: bool, help: Option<&str>) -> Value {
    json!({
        "key": key, "label": label, "type": ty, "required": required, "unique": false,
        "is_title": key == "full_name" || key == "title", "read_only": settable_on.is_empty(),
        "help_text": help, "settable_on": settable_on,
    })
}

const CU: [&str; 2] = ["create", "update"];
const OPT_HELP: &str = "id từ list_crm_options";

struct Core {
    key: &'static str,
    label: &'static str,
    prefix: &'static str,
    view: &'static str,
    create: &'static str,
    update: &'static str,
    note: &'static str,
    filters: &'static [&'static str],
    extras: &'static [(&'static str, &'static str)],
}

const CORE: [Core; 3] = [
    Core {
        key: "contacts",
        label: "Khách hàng",
        prefix: "KH",
        view: "contacts.view",
        create: "contacts.create",
        update: "contacts.update",
        note: "Khách hàng: Sale thấy khách mình phụ trách, Trưởng nhóm thấy thêm khách của cấp dưới. Khách tạo mới do chính người dùng phụ trách. Không có tuỳ biến cấu trúc cho bảng lõi — muốn thêm dữ liệu theo ngành hãy tạo bảng tuỳ biến có trường liên kết tới khách hàng.",
        filters: &["stage_id", "contact_status_id", "source_id", "assigned_to", "uncontacted_days"],
        extras: &[
            ("id", "ID bản ghi"),
            ("code", "Mã chung (KH001…) — dùng để gắn liên kết"),
            ("assigned_to_name", "Tên người phụ trách"),
            ("stage", "Nhãn giai đoạn"),
            ("status", "Nhãn trạng thái"),
            ("source", "Nhãn nguồn"),
            ("created_at", "Tạo lúc"),
            ("updated_at", "Sửa lúc"),
            ("phone_2", "SĐT 2 (che)"),
            ("team", "Tên team"),
            ("deals", "Deal của khách"),
            ("recent_activities", "Hoạt động gần đây"),
        ],
    },
    Core {
        key: "deals",
        label: "Deal",
        prefix: "DL",
        view: "deals.view",
        create: "deals.manage",
        update: "deals.manage",
        note: "Thương vụ: Sale thấy deal của mình, Trưởng nhóm thấy thêm của cấp dưới.",
        filters: &["status", "assigned_to"],
        extras: &[
            ("id", "ID bản ghi"),
            ("code", "Mã chung (DL001…)"),
            ("assignee", "Tên người phụ trách"),
            ("created_at", "Tạo lúc"),
            ("updated_at", "Sửa lúc"),
        ],
    },
    Core {
        key: "tasks",
        label: "Việc (Kanban)",
        prefix: "CV",
        view: "kanban.view",
        create: "kanban.manage",
        update: "kanban.manage",
        note: "Việc Kanban: tạo mới luôn giao cho chính người dùng. Chỉ thấy thẻ trong board và phạm vi của bạn.",
        filters: &["board_id", "column_id", "contact_id", "assignee_id", "overdue"],
        extras: &[
            ("id", "ID bản ghi"),
            ("code", "Mã chung (CV001…)"),
            ("board_id", "ID bảng Kanban"),
            ("assignee_ids", "ID người được giao"),
            ("contact", "Tên khách gắn kèm"),
            ("completed", "Đã hoàn thành"),
            ("is_overdue", "Quá hạn"),
            ("labels", "Nhãn"),
            ("checklist", "Tiến độ checklist"),
            ("created_at", "Tạo lúc"),
            ("updated_at", "Sửa lúc"),
        ],
    },
];

fn core_fields(key: &str) -> Vec<Value> {
    match key {
        "contacts" => vec![
            core_field("full_name", "Họ tên", "text", &CU, true, None),
            core_field("phone", "SĐT (luôn bị che với AI; chỉ nhập khi tạo)", "phone", &["create"], true, None),
            core_field("source_id", "Nguồn", "option", &CU, true, Some(OPT_HELP)),
            core_field("stage_id", "Giai đoạn", "option", &CU, false, Some(OPT_HELP)),
            core_field("contact_status_id", "Trạng thái", "option", &["update"], false, Some(OPT_HELP)),
            core_field("assigned_to", "Người phụ trách (đổi bằng assign_contact)", "user", &[], false, None),
            core_field("job_title", "Nghề nghiệp", "text", &CU, false, None),
            core_field("company_name", "Công ty", "text", &CU, false, None),
            core_field("email", "Email", "email", &CU, false, None),
            core_field("reminder_at", "Hẹn nhắc", "datetime", &["update"], false, None),
            core_field("reminder_notes", "Ghi chú hẹn nhắc", "long_text", &["update"], false, None),
        ],
        "deals" => vec![
            core_field("title", "Tiêu đề", "text", &CU, true, None),
            core_field("description", "Mô tả", "long_text", &CU, false, None),
            core_field("value", "Giá trị (VND, số nguyên)", "currency", &CU, false, None),
            core_field("status", "Trạng thái", "select", &CU, false, Some("open | won | lost")),
            core_field("note", "Ghi chú", "long_text", &CU, false, None),
            core_field(
                "assigned_to",
                "Người phụ trách (id; mặc định bạn; trong phạm vi quản lý deal của bạn)",
                "user",
                &["create"],
                false,
                None,
            ),
            core_field("contact_id", "Khách hàng", "relation", &["create"], false, None),
        ],
        _ => vec![
            core_field("title", "Tiêu đề", "text", &CU, true, None),
            core_field("description", "Mô tả", "long_text", &CU, false, None),
            core_field("due_at", "Hạn (ISO 8601)", "datetime", &CU, false, None),
            core_field("priority", "Ưu tiên", "select", &CU, false, None),
            core_field("contact_id", "Khách hàng gắn kèm", "relation", &CU, false, None),
            core_field("column_id", "Cột (chỉ khi tạo)", "option", &["create"], false, Some(OPT_HELP)),
        ],
    }
}

/// `CORE_TABLES[..].describe(user)`: `None` khi không có quyền xem.
fn describe_core(c: &Core, g: &Grants) -> Option<Value> {
    if !can(g, c.view, None) {
        return None;
    }
    let (can_create, can_update) = (can(g, c.create, None), can(g, c.update, None));
    let mut write: Vec<&str> = Vec::new();
    if can_create {
        write.push("create_record");
    }
    if can_update {
        write.push("update_record");
    }
    Some(json!({
        "key": c.key, "label": c.label, "label_plural": c.label, "kind": "core", "description": c.note, "is_active": true,
        "code_prefix": c.prefix, "code_example": format!("{}001", c.prefix),
        "permissions": { "view": true, "create": can_create, "update": can_update },
        "data_scope": scope_name(g, c.view),
        "fields": core_fields(c.key), "filters": c.filters,
        "read_only_fields": c.extras.iter().map(|(k, help)| json!({ "key": k, "help": help })).collect::<Vec<_>>(),
        "tools": { "read": ["list_records", "get_record"], "write": write },
    }))
}

pub(super) fn is_core_key(k: &str) -> bool {
    CORE.iter().any(|c| c.key == k)
}

fn describe_field(f: &FieldDef, key_by_id: &std::collections::HashMap<i32, String>) -> Value {
    let mut d = Map::new();
    d.insert("key".into(), json!(f.key));
    d.insert("label".into(), json!(f.label));
    d.insert("type".into(), json!(f.kind));
    d.insert("required".into(), json!(f.required));
    d.insert("unique".into(), json!(f.is_unique));
    d.insert("is_title".into(), json!(f.is_title));
    d.insert("read_only".into(), json!(f.kind == "formula"));
    d.insert("help_text".into(), json!(f.help_text));
    if let Some(choices) = f.options.get("choices").and_then(Value::as_array).filter(|c| !c.is_empty()) {
        let out: Vec<Value> = choices
            .iter()
            .map(|c| json!({ "value": c.get("value").cloned().unwrap_or(Value::Null), "label": c.get("label").cloned().unwrap_or(Value::Null) }))
            .collect();
        d.insert("choices".into(), Value::Array(out));
    }
    match f.kind.as_str() {
        "user" => {
            d.insert(
                "relation".into(),
                json!({ "table": "users (id từ list_crm_options)", "multiple": false }),
            );
        }
        "link" if f.help_text.is_none() => {
            d.insert(
                "help_text".into(),
                    json!("Liên kết tới bản ghi ở BẤT KỲ bảng nào: danh sách MÃ, vd [\"HS001\",\"KH002\"] (không ràng buộc bảng)."),
            );
        }
        "long_text" if f.help_text.as_deref().is_none_or(str::is_empty) => {
            d.insert(
                "help_text".into(),
                    json!("Văn bản; gắn thẻ bản ghi khác bằng @MÃ (vd \"Khám cho @BN001\") — Trinity tự tạo liên kết."),
            );
        }
        "relation" => {
            let target = if f.options.get("target").and_then(Value::as_str) == Some("contact") {
                Some("contacts".to_owned())
            } else {
                f.options
                    .get("target_object_id")
                    .and_then(Value::as_i64)
                    .and_then(|id| i32::try_from(id).ok())
                    .and_then(|id| key_by_id.get(&id).cloned())
            };
            // Bảng đích người dùng không được thấy ⇒ không lộ khoá/tên của nó.
            d.insert(
                "relation".into(),
                json!({
                    "table": target.unwrap_or_else(|| "(bảng bạn không có quyền xem)".to_owned()),
                    "multiple": f.options.get("multiple").is_some_and(truthy),
                }),
            );
        }
        _ => {}
    }
    Value::Object(d)
}

/// `!!v` của JS cho giá trị JSON.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Bảng tuỳ biến người dùng được thấy (theo `visible_role_ids`/bật-tắt) + quyền xem/tạo/sửa thật của họ (`describeCustomTables`).
pub(super) async fn describe_custom_tables(
    deps: &ToolDeps,
    p: &Principal,
    only: Option<&str>,
) -> Result<Vec<Value>, ToolError> {
    if !can(&p.grants, "custom_records.view", None) {
        return Ok(Vec::new());
    }
    let actor = deps.custom_actor(p);
    let mut conn = deps.conn(p.company).await?;
    let access = load_access(&mut conn, &actor).await.map_err(app_err)?;
    let all: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE deleted_at IS NULL ORDER BY nav_order ASC, id ASC LIMIT {MAX_TABLES}"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)?;
    let visible: Vec<CustomObject> = all.into_iter().filter(|o| is_object_visible(o, &access)).collect();
    let key_by_id: std::collections::HashMap<i32, String> = visible.iter().map(|o| (o.id, o.key.clone())).collect();
    let picked: Vec<&CustomObject> = visible.iter().filter(|o| only.is_none_or(|k| o.key == k)).collect();
    let ids: Vec<i32> = picked.iter().map(|o| o.id).collect();
    let fields: Vec<CustomField> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FIELD_COLS} FROM custom_fields WHERE object_id = ANY($1) AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC"
    )))
    .bind(ids.clone())
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)?;
    let views: Vec<CustomView> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VIEW_COLS} FROM custom_views WHERE object_id = ANY($1) AND deleted_at IS NULL ORDER BY nav_order ASC, id ASC"
    )))
    .bind(ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(internal)?;
    let can_write = can(&p.grants, "custom_records.manage", None);
    let can_archive = can(&p.grants, "custom_records.delete", None);
    let data_scope = scope_name(&p.grants, "custom_records.view");
    let mut out = Vec::new();
    for o in picked {
        let fs: Vec<Value> = fields
            .iter()
            .filter(|r| r.object_id == o.id)
            .map(|r| describe_field(&FieldDef::from_row(r), &key_by_id))
            .collect();
        let vs: Vec<Value> = views
            .iter()
            .filter(|v| v.object_id == o.id)
            .map(|v| {
                json!({
                    "key": v.key, "label": v.label, "type": v.r#type,
                    "group_by": v.config.0.get("group_by").and_then(Value::as_str),
                    "show_in_nav": v.show_in_nav,
                })
            })
            .collect();
        let mut write: Vec<&str> = Vec::new();
        if can_write {
            write.extend(["create_record", "update_record"]);
            if can_archive {
                write.push("archive_record");
            }
        }
        out.push(json!({
            "key": o.key, "label": o.label, "label_plural": o.label_plural, "kind": "custom", "description": o.description,
            "is_active": o.is_active, "code_prefix": o.code_prefix,
            "code_example": o.code_prefix.as_ref().map(|c| format!("{c}001")),
            "permissions": { "view": true, "create": can_write, "update": can_write, "archive": can_write && can_archive },
            "data_scope": data_scope, "fields": fs, "show_in_nav": o.show_in_nav, "views": vs,
            "tools": { "read": ["list_records", "get_record"], "write": write },
        }));
    }
    Ok(out)
}

/// Phần AI cần để dựng cấu trúc (chỉ người có quyền quản trị tính năng tuỳ biến mới thấy chi tiết).
fn describe_structure(g: &Grants) -> Value {
    if !can(g, "custom_objects.manage", None) {
        return json!({ "can_edit": false, "note": "Bạn không có quyền sửa cấu trúc bảng (chỉ quản trị viên). Hãy nhờ quản trị viên." });
    }
    json!({
        "can_edit": true,
        "tools": ["get_setup_guide", "propose_workspace", "import_records", "link_records", "find_by_code", "complete_setup", "list_screen_types", "create_view", "update_view", "set_menu", "create_objects", "create_object", "update_object", "add_field", "update_field", "archive_field", "list_object_templates", "install_object_template", "list_structure_versions", "restore_structure_version"],
        "field_types": FIELD_TYPES, "screen_types": VIEW_TYPES, "icons": CUSTOM_ICONS, "choice_colors": CHOICE_COLORS,
        "limits": { "max_objects": Limits::MAX_OBJECTS, "max_fields_per_object": Limits::MAX_FIELDS_PER_OBJECT, "max_choices": Limits::MAX_CHOICES },
    })
}

fn key_label(t: &Value) -> Value {
    json!({ "key": t["key"], "label": t["label"] })
}

pub fn describe_schema<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let only = args
            .get("object")
            .and_then(Value::as_str)
            .map(trinity_kernel::vi::trim_js)
            .filter(|s| !s.is_empty());
        let core: Vec<Value> = CORE
            .iter()
            .filter(|c| only.is_none_or(|k| c.key == k))
            .filter_map(|c| describe_core(c, &p.grants))
            .collect();
        let custom = describe_custom_tables(deps, p, only).await?;
        if let Some(k) = only
            && core.len() + custom.len() == 0
        {
            return Err(ToolError::User(format!(
                "Không có bảng “{}” (hoặc bạn không được thấy). Gọi describe_schema không tham số để xem danh sách.",
                slice16(k, 48)
            )));
        }
        // Mô tả một bảng ⇒ kèm tên các bảng khác: dữ liệu liên quan (vd quận trên đơn hàng) có thể nằm ở bảng khác.
        let other_tables: Option<Vec<Value>> = match only {
            Some(k) => {
                let every_custom = describe_custom_tables(deps, p, None).await?;
                let every_core = CORE.iter().filter_map(|c| describe_core(c, &p.grants));
                Some(
                    every_core
                        .chain(every_custom)
                        .filter(|t| t["key"].as_str() != Some(k))
                        .map(|t| key_label(&t))
                        .collect(),
                )
            }
            None => None,
        };
        let tables: Vec<Value> = core.into_iter().chain(custom).collect();
        let mut data = json!({ "tables": tables, "structure": describe_structure(&p.grants) });
        if let (Some(o), Some(map)) = (other_tables, data.as_object_mut()) {
            map.insert("other_tables".into(), Value::Array(o));
        }
        // Cây tables → trường → lựa chọn sâu hơn trần MAX_DEPTH ⇒ bắt đầu từ độ sâu -1 (vẫn che SĐT, bỏ khoá nhạy cảm, cắt độ dài).
        let out = json!({ "notice": DATA_NOTICE, "data": sanitize_at(&data, "", -1) });
        Ok(ToolOutput {
            text: Some(js_json(&out)),
            structured: out,
        })
    })
}

// ---------------------------------------------------------------------------------------------------------------
// list_screen_types

const NOT_SUPPORTED_SCREENS: &str =
    "biểu đồ / chart, dashboard tuỳ biến, gantt / timeline, bản đồ / map, 3D, form tuỳ biến, trang HTML tuỳ ý";

fn screen_types() -> Value {
    json!([
        {
            "type": "list", "name": "Danh sách",
            "summary": "Danh sách bản ghi có cột, tìm kiếm, lọc, sắp xếp; bấm một dòng để mở chi tiết / Record list with columns, search, filters and sorting",
            "requires": {}, "optional": ["columns (≤12 khoá trường)", "sort_field", "sort_dir"],
            "good_for": "Tra cứu, xem tất cả bản ghi / Browsing all records",
        },
        {
            "type": "kanban", "name": "Kanban",
            "summary": "Mỗi cột là một giá trị của một trường lựa chọn (select, vd Trạng thái, Giai đoạn); kéo thẻ sang cột khác để đổi giá trị. Chỉ chia cột theo trường select — trường người dùng, chữ, số, ngày không chia cột được / One column per choice of a select field (only select fields); drag cards to change it",
            "requires": { "group_by": "khoá một trường kiểu select (lựa chọn) của bảng / key of a select field" },
            "optional": ["card_fields (≤6)", "sort_field", "sort_dir"],
            "good_for": "Quy trình theo bước: pipeline bán hàng, xử lý đơn, tuyển dụng / Step-by-step pipelines",
        },
        {
            "type": "calendar", "name": "Lịch",
            "summary": "Lịch tháng hoặc tuần; mỗi bản ghi nằm ở ngày của một trường ngày / ngày giờ / Month or week calendar placing records on a date field",
            "requires": { "date_field": "khoá một trường kiểu date hoặc datetime của bảng / key of a date or datetime field" },
            "optional": ["mode (month | week)", "card_fields (≤6)"],
            "good_for": "Lịch hẹn, lịch giao hàng, hạn chót / Appointments, deliveries, deadlines",
        },
        {
            "type": "table", "name": "Bảng sửa nhanh",
            "summary": "Bảng tính: sửa giá trị ngay tại ô, không mở form / Spreadsheet-style grid with in-cell editing",
            "requires": {}, "optional": ["columns (≤12 khoá trường)", "sort_field", "sort_dir"],
            "good_for": "Nhập / sửa hàng loạt nhanh / Fast bulk editing",
        },
    ])
}

pub fn list_screen_types<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let mut data = Map::new();
        data.insert("screen_types".into(), screen_types());
        data.insert("not_supported".into(), json!(NOT_SUPPORTED_SCREENS));
        data.insert(
            "applies_to".into(),
            json!("Bảng tuỳ biến (kind=custom trong describe_schema). Bảng lõi contacts / deals / tasks dùng màn có sẵn của Trinity, không thêm màn mới được; cần màn riêng cho loại dữ liệu đó thì dựng bảng tuỳ biến. / Custom tables only."),
        );
        data.insert(
            "create_with".into(),
            json!("create_view (một màn) hoặc propose_workspace.views (khi dựng cả gói); sửa: update_view; đưa lên menu: show_in_nav hoặc set_menu."),
        );
        data.insert("can_create".into(), json!(can(&p.grants, "custom_objects.manage", None)));
        let key = args
            .get("object")
            .and_then(Value::as_str)
            .map_or("", trinity_kernel::vi::trim_js);
        if !key.is_empty() {
            if is_core_key(key) {
                data.insert(
                    "object".into(),
                    json!({ "key": key, "kind": "core", "note": "Bảng lõi: không tạo thêm màn được. / Core table: no custom screens." }),
                );
            } else {
                let tables = describe_custom_tables(deps, p, Some(key)).await?;
                let Some(t) = tables.first() else {
                    return Err(ToolError::User(format!(
                        "Không có bảng “{}” (hoặc bạn không được thấy). Gọi describe_schema để lấy khoá bảng.",
                        slice16(key, 48)
                    )));
                };
                let fields: Vec<Value> = t["fields"].as_array().cloned().unwrap_or_default();
                let pick = |ok: &dyn Fn(&str) -> bool| -> Vec<Value> {
                    fields
                        .iter()
                        .filter(|f| f["type"].as_str().is_some_and(ok))
                        .map(|f| json!({ "key": f["key"], "label": f["label"], "type": f["type"] }))
                        .collect()
                };
                let selects = pick(&|x| x == "select");
                let dates = pick(&|x| x == "date" || x == "datetime");
                let mut obj = Map::new();
                obj.insert("key".into(), t["key"].clone());
                obj.insert("label".into(), t["label"].clone());
                obj.insert("existing_screens".into(), t["views"].clone());
                obj.insert("list_table_columns".into(), json!("mọi trường của bảng (columns tuỳ chọn)"));
                if selects.is_empty() {
                    obj.insert(
                        "kanban_missing".into(),
                        json!("Bảng chưa có trường lựa chọn (select) — cần thêm một trường select (add_field) trước khi tạo kanban."),
                    );
                }
                if dates.is_empty() {
                    obj.insert(
                        "calendar_missing".into(),
                        json!("Bảng chưa có trường ngày (date/datetime) — cần thêm một trường ngày (add_field) trước khi tạo lịch."),
                    );
                }
                obj.insert("kanban_group_by_fields".into(), Value::Array(selects));
                obj.insert("calendar_date_fields".into(), Value::Array(dates));
                data.insert("object".into(), Value::Object(obj));
            }
        }
        wrapped(&Value::Object(data))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// list_structure_versions, list_object_templates

pub fn list_structure_versions<'a>(
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let limit = args.get("limit").and_then(Value::as_f64).map_or(20, |f| f.trunc() as i64);
        let mut conn = deps.conn(p.company).await?;
        let rows = mod_custom::versions::list(&mut conn, limit).await.map_err(app_err)?;
        let versions: Vec<Value> = rows
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|r| json!({ "id": r["id"], "tool": r["tool"], "summary": r["summary"], "created_at": r["created_at"] }))
                    .collect()
            })
            .unwrap_or_default();
        wrapped(&json!({ "versions": versions }))
    })
}

pub fn list_object_templates<'a>(
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let (p, deps) = (ctx.principal, ctx.deps);
        let templates = mod_setup::templates::list(&deps.setup_ctx(), &deps.setup_actor(p))
            .await
            .map_err(app_err)?;
        wrapped(&json!({ "templates": templates }))
    })
}

