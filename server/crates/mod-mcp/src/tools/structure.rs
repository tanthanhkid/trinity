//! Tool GHI cấu trúc bảng tuỳ biến (M43): `create_objects`, `create_object`, `update_object`, `add_field`, `update_field`,
//! `archive_field`, `restore_structure_version` (`action-structure-tools.ts`, `action-field-tools.ts`, `action-version-tools.ts`,
//! `structure-spec.ts`). Chạy NGAY theo quyền người dùng qua `mod-custom` (cùng kiểm dữ liệu với giao diện web); bảng mới cần
//! lời đồng ý `confirmed_by_user`. Không có tool xoá: `archive_field` chỉ ẨN, `update_object` không có xoá bảng.

use std::collections::HashSet;

use mod_custom::access::{ObjectDef, load_visible_object};
use mod_custom::fields::{self, CreateField, UpdateField, assert_flags_allowed, build_options, formulas_referencing};
use mod_custom::objects::{self, CreateObject, UpdateObject};
use mod_custom::types::{
    CUSTOM_ICONS, FIELD_TYPES, FieldDef, Limits, RESERVED_OBJECT_KEYS, TITLE_TYPES, is_field_type, valid_key,
};
use mod_custom::values::slugify_key;
use serde_json::{Map, Value, json};
use trinity_kernel::error::AppError;

use super::write::{
    Detail, as_int, assert_confirmed, clean_text, impact_json, internal, line, opt_clean, prepared, user, user_err,
};
use crate::actions::{ActionCx, ActionDef, Prepared};
use crate::exec::ToolError;
use crate::protocol::BoxFuture;

const MAX_OBJECTS_PER_CALL: usize = 8;

/// Câu lỗi của dịch vụ nghiệp vụ (để ghép vào câu của tool).
pub(super) fn app_msg(e: AppError) -> String {
    match user_err(e) {
        ToolError::User(m) | ToolError::Http { message: m, .. } => m,
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Đặc tả bảng/trường theo cách AI mô tả
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(super) struct FieldSpec {
    pub label: String,
    pub kind: String,
    pub key: String,
    pub required: Option<bool>,
    pub is_unique: Option<bool>,
    pub is_title: Option<bool>,
    pub show_in_list: Option<bool>,
    pub help_text: Option<String>,
    pub choices: Option<Vec<Value>>,
    pub target_object: Option<String>,
    pub multiple: Option<bool>,
    pub expression: Option<String>,
    pub format: Option<String>,
    pub decimals: Option<i64>,
}

#[derive(Debug, Clone)]
pub(super) struct ObjectSpec {
    pub key: String,
    pub label: String,
    pub label_plural: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub code_prefix: Option<String>,
    pub fields: Vec<FieldSpec>,
}

fn assert_key(key: &str, what: &str, reserved: bool) -> Result<(), ToolError> {
    if !valid_key(key) {
        return Err(user(format!(
            "Khoá {what} “{}” không hợp lệ: chỉ a-z, 0-9, _ ; bắt đầu bằng chữ; tối đa 48 ký tự.",
            key.chars().take(50).collect::<String>()
        )));
    }
    if reserved && RESERVED_OBJECT_KEYS.contains(&key) {
        return Err(user(format!(
            "Khoá bảng “{key}” là từ khoá hệ thống, hãy chọn khoá khác."
        )));
    }
    if !reserved && key == "constructor" {
        return Err(user(format!(
            "Khoá trường “{key}” là từ khoá hệ thống, hãy chọn khoá khác."
        )));
    }
    Ok(())
}

fn flag(v: &Value, k: &str) -> Option<bool> {
    v.get(k).and_then(Value::as_bool)
}

pub(super) fn parse_field(raw: &Value) -> Result<FieldSpec, ToolError> {
    let label = clean_text(raw.get("label"), 100);
    if label.is_empty() {
        return Err(user("Mỗi trường cần có tên (label)."));
    }
    let kind = match raw.get("type").and_then(Value::as_str) {
        Some(t) if is_field_type(t) => t.to_owned(),
        _ => {
            return Err(user(format!(
                "Kiểu trường không hợp lệ. Dùng một trong: {}.",
                FIELD_TYPES.join(", ")
            )));
        }
    };
    let key = opt_clean(raw.get("key"), 48).unwrap_or_else(|| slugify_key(&label));
    assert_key(&key, "trường", false)?;
    let target_object = match opt_clean(raw.get("target_object"), 48) {
        Some(t) => {
            assert_key(&t, "bảng liên kết", true)?;
            Some(t)
        }
        None => None,
    };
    Ok(FieldSpec {
        label,
        kind,
        key,
        required: flag(raw, "required"),
        is_unique: flag(raw, "is_unique"),
        is_title: flag(raw, "is_title"),
        show_in_list: flag(raw, "show_in_list"),
        help_text: opt_clean(raw.get("help_text"), 300),
        choices: raw
            .get("choices")
            .and_then(Value::as_array)
            .map(|a| a.iter().take(Limits::MAX_CHOICES).cloned().collect()),
        target_object,
        multiple: flag(raw, "multiple"),
        expression: opt_clean(raw.get("expression"), 300),
        format: raw.get("format").and_then(Value::as_str).map(str::to_owned),
        decimals: as_int(raw.get("decimals")),
    })
}

/// Tiền tố mã AI ghi (nếu có) → chuẩn hoá; sai ⇒ lỗi AI sửa được.
pub(super) fn read_prefix(raw: Option<&Value>, label: &str) -> Result<Option<String>, ToolError> {
    let s: String = match raw {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => return Ok(None),
        Some(other) => other.to_string(),
    };
    if s.is_empty() {
        return Ok(None);
    }
    mod_custom::codes::normalize_prefix(&s)
        .map(Some)
        .map_err(|e| user(format!("Bảng “{label}”: {}", app_msg(e))))
}

pub(super) fn parse_object(raw: &Value) -> Result<ObjectSpec, ToolError> {
    let label = clean_text(raw.get("label"), 100);
    if label.is_empty() {
        return Err(user("Mỗi bảng cần có tên (label)."));
    }
    let key = opt_clean(raw.get("key"), 48).unwrap_or_else(|| slugify_key(&label));
    assert_key(&key, "bảng", true)?;
    let icon = opt_clean(raw.get("icon"), 48);
    if let Some(i) = &icon
        && !CUSTOM_ICONS.contains(&i.as_str())
    {
        return Err(user(format!(
            "Biểu tượng “{i}” không hợp lệ. Dùng một trong: {}.",
            CUSTOM_ICONS.join(", ")
        )));
    }
    let fields = match raw.get("fields").and_then(Value::as_array) {
        Some(a) => a.iter().map(parse_field).collect::<Result<Vec<_>, _>>()?,
        None => Vec::new(),
    };
    let keys: HashSet<&str> = fields.iter().map(|f| f.key.as_str()).collect();
    if keys.len() != fields.len() {
        return Err(user(format!("Bảng “{label}” có hai trường trùng khoá.")));
    }
    if fields.len() > Limits::MAX_FIELDS_PER_OBJECT {
        return Err(user(format!(
            "Mỗi bảng tối đa {} trường.",
            Limits::MAX_FIELDS_PER_OBJECT
        )));
    }
    let label_plural = opt_clean(raw.get("label_plural"), 100).unwrap_or_else(|| label.clone());
    let code_prefix = read_prefix(raw.get("code_prefix"), &label)?;
    Ok(ObjectSpec {
        key,
        label,
        label_plural,
        icon,
        description: opt_clean(raw.get("description"), 500),
        code_prefix,
        fields,
    })
}

/// `options` của trường theo `toFieldDto`. `target_id` = id bảng đích (relation tới bảng tuỳ biến).
pub(super) fn field_options(f: &FieldSpec, target_id: Option<i64>) -> Value {
    let mut o = Map::new();
    if let Some(ch) = &f.choices {
        let items = ch
            .iter()
            .map(|c| match c {
                Value::String(s) => json!({ "label": s }),
                other => other.clone(),
            })
            .collect();
        o.insert("choices".into(), Value::Array(items));
    }
    if f.kind == "relation" {
        if f.target_object.as_deref() == Some("contacts") {
            o.insert("target".into(), json!("contact"));
        } else if let Some(id) = target_id {
            o.insert("target_object_id".into(), json!(id));
        }
        o.insert("multiple".into(), json!(f.multiple == Some(true)));
    }
    if f.kind == "formula" {
        if let Some(e) = &f.expression {
            o.insert("expression".into(), json!(e));
        }
        if let Some(x) = &f.format {
            o.insert("format".into(), json!(x));
        }
        if let Some(d) = f.decimals {
            o.insert("decimals".into(), json!(d));
        }
    }
    Value::Object(o)
}

pub(super) fn to_create_field(f: &FieldSpec, target_id: Option<i64>) -> CreateField {
    CreateField {
        key: Some(f.key.clone()),
        label: f.label.clone(),
        kind: f.kind.clone(),
        required: f.required,
        is_unique: f.is_unique,
        is_title: f.is_title,
        show_in_list: f.show_in_list,
        options: Some(field_options(f, target_id)),
        help_text: f.help_text.clone(),
    }
}

/// Chạy thử kiểm hợp lệ KHÔNG ghi: cùng luật với dịch vụ (kiểu, cờ, lựa chọn, công thức, đích liên kết) để báo lỗi sớm.
pub(super) fn check_fields(
    fields: &[FieldSpec],
    existing: &[FieldDef],
    known_targets: &HashSet<String>,
) -> Result<(), ToolError> {
    let mut sib: Vec<FieldDef> = existing.to_vec();
    if sib.len() + fields.len() > Limits::MAX_FIELDS_PER_OBJECT {
        return Err(user(format!(
            "Mỗi bảng tối đa {} trường.",
            Limits::MAX_FIELDS_PER_OBJECT
        )));
    }
    let mut has_title = sib.iter().any(|x| x.is_title);
    for f in fields {
        if sib.iter().any(|x| x.key == f.key) {
            return Err(user(format!("Khoá trường “{}” đã tồn tại.", f.key)));
        }
        if f.kind == "relation" {
            let ok = f
                .target_object
                .as_deref()
                .is_some_and(|t| t == "contacts" || known_targets.contains(t));
            if !ok {
                let mut names: Vec<&str> = known_targets.iter().map(String::as_str).collect();
                names.sort_unstable();
                names.truncate(8);
                return Err(user(format!(
                    "Trường liên kết “{}” cần target_object là khoá một bảng có sẵn ({}) hoặc \"contacts\".",
                    f.label,
                    if names.is_empty() {
                        "chưa có bảng nào".to_owned()
                    } else {
                        names.join(", ")
                    }
                )));
            }
        }
        let wrap = |e: AppError| user(format!("Trường “{}”: {}", f.label, app_msg(e)));
        let options = build_options(&f.kind, &field_options(f, Some(1)), &sib, Some(&f.key)).map_err(wrap)?;
        let is_title = f
            .is_title
            .unwrap_or(!has_title && TITLE_TYPES.contains(&f.kind.as_str()));
        assert_flags_allowed(&f.kind, f.required == Some(true), f.is_unique == Some(true), is_title).map_err(wrap)?;
        has_title = has_title || is_title;
        sib.push(FieldDef {
            id: i32::try_from(sib.len()).unwrap_or(i32::MAX).saturating_add(1),
            key: f.key.clone(),
            label: f.label.clone(),
            kind: f.kind.clone(),
            required: f.required == Some(true),
            is_unique: f.is_unique == Some(true),
            is_title,
            show_in_list: true,
            sort_order: i32::try_from(sib.len()).unwrap_or(i32::MAX),
            options,
            help_text: None,
        });
    }
    Ok(())
}

async fn live_object_keys(ctx: &ActionCx<'_>) -> Result<Vec<String>, ToolError> {
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    sqlx::query_scalar("SELECT key FROM custom_objects WHERE deleted_at IS NULL LIMIT 200")
        .fetch_all(&mut *c)
        .await
        .map_err(internal)
}

/// Kiểm cả lô bảng mới: khoá chưa dùng, không vượt trần, liên kết tới bảng có sẵn hoặc cùng lô, mỗi bảng có trường làm tiêu đề.
pub(super) async fn check_objects(ctx: &ActionCx<'_>, specs: &[ObjectSpec]) -> Result<(), ToolError> {
    let live = live_object_keys(ctx).await?;
    if i64::try_from(live.len() + specs.len()).unwrap_or(i64::MAX) > Limits::MAX_OBJECTS {
        return Err(user(format!(
            "Vượt giới hạn {} bảng tuỳ biến (đang có {}).",
            Limits::MAX_OBJECTS,
            live.len()
        )));
    }
    let taken: HashSet<String> = live.into_iter().collect();
    let batch: HashSet<&str> = specs.iter().map(|s| s.key.as_str()).collect();
    if batch.len() != specs.len() {
        return Err(user("Hai bảng trong cùng lần tạo bị trùng khoá."));
    }
    for s in specs {
        if taken.contains(&s.key) {
            return Err(user(format!(
                "Khoá bảng “{}” đã được dùng — hãy chọn khoá khác (hoặc describe_schema để xem bảng đã có).",
                s.key
            )));
        }
    }
    let mut targets = taken.clone();
    targets.extend(batch.iter().map(|k| (*k).to_owned()));
    for s in specs {
        check_fields(&s.fields, &[], &targets)?;
        let titled = s
            .fields
            .iter()
            .any(|f| f.is_title.unwrap_or(TITLE_TYPES.contains(&f.kind.as_str())));
        if !s.fields.is_empty() && !titled {
            return Err(user(format!(
                "Bảng “{}” cần ít nhất một trường văn bản ngắn/số/email/ngày để làm tiêu đề.",
                s.label
            )));
        }
    }
    Ok(())
}

fn describe_fields(s: &ObjectSpec) -> String {
    s.fields
        .iter()
        .map(|f| {
            format!(
                "{} ({}{}{})",
                f.label,
                f.kind,
                if f.required == Some(true) { ", bắt buộc" } else { "" },
                f.target_object
                    .as_deref()
                    .map(|t| format!(" → {t}"))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Bảng xem trước cấu trúc dự kiến (cho `assert_confirmed` và chi tiết).
pub(super) fn object_details(specs: &[ObjectSpec]) -> Vec<Detail> {
    specs
        .iter()
        .filter_map(|s| {
            let body = describe_fields(s);
            line(
                &format!("Bảng {} [{}]", s.label, s.key),
                if body.is_empty() {
                    "(chưa có trường)".to_owned()
                } else {
                    body
                },
                900,
            )
        })
        .collect()
}

fn custom_pair(ctx: &ActionCx<'_>) -> (mod_custom::Ctx, mod_custom::Actor) {
    (ctx.deps.custom_ctx(), ctx.deps.custom_actor(ctx.principal))
}

async fn target_id(ctx: &ActionCx<'_>, f: &FieldSpec) -> Result<Option<i64>, ToolError> {
    let Some(t) = f.target_object.as_deref() else {
        return Ok(None);
    };
    if f.kind != "relation" || t == "contacts" {
        return Ok(None);
    }
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    let id: Option<i32> = sqlx::query_scalar("SELECT id FROM custom_objects WHERE key = $1 AND deleted_at IS NULL")
        .bind(t)
        .fetch_optional(&mut *c)
        .await
        .map_err(internal)?;
    id.map(|i| Some(i64::from(i)))
        .ok_or_else(|| user(format!("Không tìm thấy bảng “{t}” để liên kết")))
}

/// Xoá HẲN các bảng vừa tạo trong lượt này (kèm trường/màn, chưa có bản ghi) để không để lại cấu trúc dở dang. Lỗi chỉ ghi log.
pub(super) async fn purge_created(ctx: &ActionCx<'_>, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let p = ctx.principal;
    let res = async {
        let mut c = ctx.deps.conn(p.company).await.map_err(|e| format!("{e:?}"))?;
        sqlx::query(
            "DELETE FROM custom_objects WHERE key = ANY($1) AND created_by = $2 AND created_at >= now() - interval '10 minutes'",
        )
        .bind(keys)
        .bind(p.user_id)
        .execute(&mut *c)
        .await
        .map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = res {
        tracing::error!("Dọn bảng dựng dở {keys:?} lỗi: {e}");
    }
}

/// Ghi thật: tạo bảng rồi trường. Lỗi giữa chừng ⇒ xoá các bảng vừa tạo trong lượt này.
pub(super) async fn apply_objects(ctx: &ActionCx<'_>, specs: &[ObjectSpec]) -> Result<Vec<String>, ToolError> {
    let (cctx, actor) = custom_pair(ctx);
    let mut created: Vec<String> = Vec::new();
    let res: Result<(), ToolError> = async {
        for s in specs {
            let dto = CreateObject {
                key: s.key.clone(),
                label: s.label.clone(),
                label_plural: s.label_plural.clone(),
                icon: s.icon.clone(),
                description: s.description.clone(),
                show_in_nav: Some(true),
                code_prefix: s.code_prefix.clone(),
                ..CreateObject::default()
            };
            objects::create(&cctx, &actor, &dto).await.map_err(user_err)?;
            created.push(s.key.clone());
        }
        for s in specs {
            for f in &s.fields {
                let tid = target_id(ctx, f).await?;
                fields::create(&cctx, &actor, &s.key, &to_create_field(f, tid))
                    .await
                    .map_err(user_err)?;
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = res {
        purge_created(ctx, &created).await;
        return Err(e);
    }
    Ok(created)
}

/// Một vài khoá tuỳ chọn: chỉ chèn khi có giá trị.
fn put<T: Into<Value>>(m: &mut Map<String, Value>, k: &str, v: Option<T>) {
    if let Some(v) = v {
        m.insert(k.to_owned(), v.into());
    }
}

/// Trường dạng JSON (khoá như đối số của tool và `ObjectSpec` của bản TS) để lưu vào `params` của đề xuất; `parse_field` đọc lại đúng.
pub(super) fn field_json(f: &FieldSpec) -> Value {
    let mut m = Map::new();
    m.insert("label".into(), json!(f.label));
    m.insert("type".into(), json!(f.kind));
    m.insert("key".into(), json!(f.key));
    put(&mut m, "required", f.required);
    put(&mut m, "is_unique", f.is_unique);
    put(&mut m, "is_title", f.is_title);
    put(&mut m, "show_in_list", f.show_in_list);
    put(&mut m, "help_text", f.help_text.clone());
    put(&mut m, "choices", f.choices.clone());
    put(&mut m, "target_object", f.target_object.clone());
    put(&mut m, "multiple", f.multiple);
    put(&mut m, "expression", f.expression.clone());
    put(&mut m, "format", f.format.clone());
    put(&mut m, "decimals", f.decimals);
    Value::Object(m)
}

/// Bảng dạng JSON để lưu vào `params` (xem [`field_json`]).
pub(super) fn object_json(s: &ObjectSpec) -> Value {
    let mut m = Map::new();
    m.insert("key".into(), json!(s.key));
    m.insert("label".into(), json!(s.label));
    m.insert("label_plural".into(), json!(s.label_plural));
    put(&mut m, "icon", s.icon.clone());
    put(&mut m, "description", s.description.clone());
    put(&mut m, "code_prefix", s.code_prefix.clone());
    m.insert("fields".into(), Value::Array(s.fields.iter().map(field_json).collect()));
    Value::Object(m)
}

fn summarize(specs: &[ObjectSpec]) -> (Value, String, Vec<Detail>) {
    let names = specs
        .iter()
        .map(|s| format!("“{}” ({} trường)", s.label, s.fields.len()))
        .collect::<Vec<_>>()
        .join(", ");
    (
        json!({ "objects": specs.iter().map(object_json).collect::<Vec<_>>() }),
        format!("Dựng {} bảng mới: {names}", specs.len()),
        object_details(specs),
    )
}

async fn prepare_create(ctx: &ActionCx<'_>, raw: &[Value], confirmation: Option<&str>) -> Result<Prepared, ToolError> {
    if raw.is_empty() {
        return Err(user("Cần ít nhất một bảng."));
    }
    if raw.len() > MAX_OBJECTS_PER_CALL {
        return Err(user(format!("Mỗi lần tạo tối đa {MAX_OBJECTS_PER_CALL} bảng.")));
    }
    let specs = raw.iter().map(parse_object).collect::<Result<Vec<_>, _>>()?;
    check_objects(ctx, &specs).await?;
    let (params, summary, details) = summarize(&specs);
    assert_confirmed(confirmation, &details)?;
    Ok(prepared(params, &summary, &details, None))
}

/// Dựng bảng từ `params` đã lưu (đọc lại bằng chính `parse_object`).
async fn execute_create(params: &Value, ctx: &ActionCx<'_>) -> Result<Value, ToolError> {
    let raw = params
        .get("objects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let specs = raw.iter().map(parse_object).collect::<Result<Vec<_>, _>>()?;
    let created = apply_objects(ctx, &specs).await?;
    Ok(json!({
        "created_objects": created,
        "open_at": created.iter().map(|k| format!("/x/{k}")).collect::<Vec<_>>(),
    }))
}

fn confirmation_of(args: &Value) -> Option<&str> {
    args.get("confirmed_by_user").and_then(Value::as_str)
}

const MANAGE: &[&str] = &["custom_objects.manage"];
const MANAGE_FEATURES: &[&str] = &["custom_objects.manage", "settings.features"];

pub(crate) static CREATE_OBJECTS: ActionDef = ActionDef {
    name: "create_objects",
    label: "Dựng nhiều bảng tuỳ biến",
    permissions: MANAGE,
    prepare: create_objects_prepare,
    execute: create_execute,
    structure: true,
};

pub(crate) static CREATE_OBJECT: ActionDef = ActionDef {
    name: "create_object",
    label: "Tạo bảng tuỳ biến",
    permissions: MANAGE,
    prepare: create_object_prepare,
    execute: create_execute,
    structure: true,
};

fn create_objects_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let raw = args
            .get("objects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        prepare_create(ctx, &raw, confirmation_of(args)).await
    })
}

fn create_object_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let mut obj = args.clone();
        if let Some(m) = obj.as_object_mut() {
            m.remove("confirmed_by_user");
        }
        prepare_create(ctx, &[obj], confirmation_of(args)).await
    })
}

fn create_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(execute_create(params, ctx))
}

// ---------------------------------------------------------------------------------------------------------------------
// Đọc bảng hiện có
// ---------------------------------------------------------------------------------------------------------------------

pub(super) async fn load_def(ctx: &ActionCx<'_>, key: &str) -> Result<ObjectDef, ToolError> {
    let actor = ctx.deps.custom_actor(ctx.principal);
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    load_visible_object(&mut c, &actor, key, None)
        .await
        .map_err(|e| match user_err(e) {
            ToolError::User(_) => user(format!(
                "Không có bảng “{key}”. Hãy gọi describe_schema để lấy đúng khoá."
            )),
            other => other,
        })
}

fn object_key(args: &Value) -> String {
    clean_text(args.get("object"), 48)
}

// ---------------------------------------------------------------------------------------------------------------------
// Đếm bản ghi bị ảnh hưởng (`impact.ts`)
// ---------------------------------------------------------------------------------------------------------------------

async fn count_records(ctx: &ActionCx<'_>, object_id: i32) -> Result<i64, ToolError> {
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    sqlx::query_scalar("SELECT count(*) FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL")
        .bind(object_id)
        .fetch_one(&mut *c)
        .await
        .map_err(internal)
}

/// Số bản ghi ĐANG CÓ giá trị ở trường `key`.
async fn count_with_value(ctx: &ActionCx<'_>, object_id: i32, key: &str) -> Result<i64, ToolError> {
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    sqlx::query_scalar(
        "SELECT count(*) FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL \
         AND data ? $2::text AND data -> $2::text <> 'null'::jsonb",
    )
    .bind(object_id)
    .bind(key)
    .fetch_one(&mut *c)
    .await
    .map_err(internal)
}

/// Số bản ghi ĐANG DÙNG một trong các lựa chọn `values` của trường select / multi_select.
async fn count_using_choices(
    ctx: &ActionCx<'_>,
    object_id: i32,
    key: &str,
    multi: bool,
    values: &[String],
) -> Result<i64, ToolError> {
    if values.is_empty() {
        return Ok(0);
    }
    let mut c = ctx.deps.conn(ctx.principal.company).await?;
    let q = if multi {
        sqlx::query_scalar(
            "SELECT count(*) FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL \
             AND jsonb_typeof(data -> $2::text) = 'array' AND (data -> $2::text) ?| $3::text[]",
        )
    } else {
        sqlx::query_scalar(
            "SELECT count(*) FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL \
             AND (data ->> $2::text) = ANY($3::text[])",
        )
    };
    q.bind(object_id)
        .bind(key)
        .bind(values)
        .fetch_one(&mut *c)
        .await
        .map_err(internal)
}

const DISPLAY_KEYS: [&str; 3] = ["label", "help_text", "show_in_list"];

/// Giá trị (hoặc nhãn) của một lựa chọn trong `options.choices`: chuỗi ⇒ chính nó, object ⇒ `value` rồi `label`.
fn choice_value(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        o => o
            .get("value")
            .and_then(Value::as_str)
            .or_else(|| o.get("label").and_then(Value::as_str))
            .unwrap_or_default()
            .to_owned(),
    }
}

/// Ảnh hưởng của sửa trường (`fieldImpact`): đổi nhãn/ghi chú/hiện cột = 0 bản ghi; bỏ lựa chọn = số bản ghi đang dùng lựa chọn đó;
/// cờ khác (bắt buộc, duy nhất, tiêu đề, công thức) = số bản ghi có dữ liệu ở trường.
async fn field_impact(
    ctx: &ActionCx<'_>,
    def: &ObjectDef,
    cur: &FieldDef,
    patch: &Map<String, Value>,
) -> Result<Value, ToolError> {
    if patch.keys().all(|k| DISPLAY_KEYS.contains(&k.as_str())) {
        return Ok(impact_json(
            &[],
            &[format!(
                "Chỉ đổi cách hiển thị trường “{}”, dữ liệu không đổi.",
                cur.label
            )],
        ));
    }
    let mut lines: Vec<String> = Vec::new();
    let mut affected = 0_i64;
    let cur_choices = cur.options.get("choices").and_then(Value::as_array);
    if let (Some(opts), Some(old)) = (patch.get("options"), cur_choices) {
        let next: Vec<String> = opts
            .get("choices")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(choice_value).collect())
            .unwrap_or_default();
        let gone: Vec<&Value> = old
            .iter()
            .filter(|c| {
                let v = c.get("value").and_then(Value::as_str).unwrap_or_default();
                let l = c.get("label").and_then(Value::as_str).unwrap_or_default();
                !next.iter().any(|n| n == v) && !next.iter().any(|n| n == l)
            })
            .collect();
        if gone.is_empty() {
            lines.push(format!(
                "Chỉ đổi tên/màu/thứ tự lựa chọn của “{}”; dữ liệu không đổi.",
                cur.label
            ));
        } else {
            let values: Vec<String> = gone
                .iter()
                .map(|c| c.get("value").and_then(Value::as_str).unwrap_or_default().to_owned())
                .collect();
            affected = count_using_choices(ctx, def.obj.id, &cur.key, cur.kind == "multi_select", &values).await?;
            let names: Vec<&str> = gone
                .iter()
                .map(|c| c.get("label").and_then(Value::as_str).unwrap_or_default())
                .collect();
            lines.push(format!(
                "{affected} bản ghi của “{}” đang dùng lựa chọn bị bỏ: {} (lựa chọn còn bản ghi dùng sẽ bị chặn lúc duyệt).",
                def.obj.label,
                names.join(", ")
            ));
        }
    }
    let formula_edit = cur.kind == "formula" && patch.contains_key("options");
    if formula_edit
        || patch
            .keys()
            .any(|k| !DISPLAY_KEYS.contains(&k.as_str()) && k != "options")
    {
        let with_value = count_with_value(ctx, def.obj.id, &cur.key).await?;
        affected = affected.max(with_value);
        lines.insert(
            0,
            format!(
                "{with_value} bản ghi của “{}” đang có dữ liệu ở trường “{}”.",
                def.obj.label, cur.label
            ),
        );
        if patch.get("required") == Some(&json!(true)) && !cur.required {
            let total = count_records(ctx, def.obj.id).await?;
            lines.push(format!(
                "{} bản ghi đang TRỐNG trường này sẽ bị báo lỗi bắt buộc khi sửa lần sau.",
                (total - with_value).max(0)
            ));
        }
        if patch.get("is_title") == Some(&json!(true)) {
            lines.push("Đổi trường tiêu đề: tiêu đề của MỌI bản ghi được tính lại.".to_owned());
        }
    }
    Ok(impact_json(
        &[(def.obj.key.clone(), def.obj.label.clone(), affected)],
        &lines,
    ))
}

// ---------------------------------------------------------------------------------------------------------------------
// update_object
// ---------------------------------------------------------------------------------------------------------------------

pub(crate) static UPDATE_OBJECT: ActionDef = ActionDef {
    name: "update_object",
    label: "Sửa bảng tuỳ biến",
    permissions: MANAGE,
    prepare: update_object_prepare,
    execute: update_object_execute,
    structure: true,
};

fn update_object_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = object_key(args);
        let def = load_def(ctx, &key).await?;
        let mut patch = Map::new();
        for (k, max) in [
            ("label", 100),
            ("label_plural", 100),
            ("icon", 48),
            ("description", 500),
        ] {
            if let Some(v) = opt_clean(args.get(k), max) {
                patch.insert(k.to_owned(), json!(v));
            }
        }
        for k in ["show_in_nav", "is_active"] {
            if let Some(b) = flag(args, k) {
                patch.insert(k.to_owned(), json!(b));
            }
        }
        if let Some(p) = read_prefix(args.get("code_prefix"), &def.obj.label)? {
            patch.insert("code_prefix".into(), json!(p));
        }
        if patch.is_empty() {
            return Err(user("Không có gì để sửa."));
        }
        if let Some(i) = patch.get("icon").and_then(Value::as_str)
            && !CUSTOM_ICONS.contains(&i)
        {
            return Err(user(format!(
                "Biểu tượng không hợp lệ. Dùng một trong: {}.",
                CUSTOM_ICONS.join(", ")
            )));
        }
        let changed: Vec<String> = patch.keys().cloned().collect();
        let new_label = patch.get("label").and_then(Value::as_str).unwrap_or_default();
        let shown_name = if !new_label.is_empty() && new_label != def.obj.label.trim() {
            format!("{} → {new_label}", def.obj.label.trim())
        } else {
            def.obj.label.trim().to_owned()
        };
        let mut details: Vec<Detail> = line("Bảng", format!("{} [{key}]", def.obj.label), 600)
            .into_iter()
            .collect();
        details.extend(
            patch
                .iter()
                .filter_map(|(k, v)| line(k, v.as_str().map_or_else(|| v.to_string(), str::to_owned), 600)),
        );
        let deactivate = patch.get("is_active") == Some(&json!(false));
        let hides = deactivate || patch.get("show_in_nav") == Some(&json!(false));
        let records = if hides {
            count_records(ctx, def.obj.id).await?
        } else {
            0
        };
        let note = if hides {
            format!(
                "{records} bản ghi của “{}” sẽ {}.",
                def.obj.label,
                if deactivate {
                    "bị ẨN với mọi người trừ quản trị viên"
                } else {
                    "không còn mục menu (vẫn mở được qua đường dẫn)"
                }
            )
        } else {
            "Chỉ đổi tên/mô tả/biểu tượng, dữ liệu không đổi.".to_owned()
        };
        let impact = impact_json(&[(key.clone(), def.obj.label.clone(), records)], &[note]);
        let summary = format!(
            "Sửa bảng “{shown_name}”: {}{}",
            changed.join(", "),
            if deactivate { " (ẨN bảng)" } else { "" }
        );
        Ok(prepared(
            json!({ "object": key, "patch": Value::Object(patch) }),
            &summary,
            &details,
            Some(impact),
        ))
    })
}

fn update_object_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let key = params.get("object").and_then(Value::as_str).unwrap_or_default();
        let patch = params.get("patch").cloned().unwrap_or_else(|| json!({}));
        let dto = UpdateObject::from_validated(&patch);
        let (cctx, actor) = custom_pair(ctx);
        objects::update(&cctx, &actor, key, &dto).await.map_err(user_err)?;
        let updated: Vec<String> = patch
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        Ok(json!({ "object": key, "updated": updated }))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// add_field / update_field / archive_field
// ---------------------------------------------------------------------------------------------------------------------

pub(crate) static ADD_FIELD: ActionDef = ActionDef {
    name: "add_field",
    label: "Thêm trường",
    permissions: MANAGE,
    prepare: add_field_prepare,
    execute: add_field_execute,
    structure: true,
};

fn add_field_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = object_key(args);
        let def = load_def(ctx, &key).await?;
        let f = parse_field(args)?;
        let targets: HashSet<String> = live_object_keys(ctx).await?.into_iter().collect();
        check_fields(std::slice::from_ref(&f), &def.fields, &targets)?;
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Bảng", format!("{} [{key}]", def.obj.label), 600));
        details.extend(line("Trường", format!("{} [{}]", f.label, f.key), 600));
        details.extend(line("Kiểu", f.kind.clone(), 600));
        details.extend(line(
            "Bắt buộc",
            if f.required == Some(true) { "Có" } else { "Không" },
            600,
        ));
        details.extend(line(
            "Lựa chọn",
            f.choices
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|c| {
                    c.as_str().map_or_else(
                        || c.get("label").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        str::to_owned,
                    )
                })
                .collect::<Vec<_>>()
                .join(", "),
            600,
        ));
        details.extend(line("Liên kết tới", f.target_object.clone().unwrap_or_default(), 600));
        details.extend(line("Công thức", f.expression.clone().unwrap_or_default(), 600));
        let summary = format!("Thêm trường “{}” ({}) vào bảng “{}”", f.label, f.kind, def.obj.label);
        Ok(prepared(
            json!({ "object": key, "field": field_json(&f) }),
            &summary,
            &details,
            None,
        ))
    })
}

fn add_field_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let key = params.get("object").and_then(Value::as_str).unwrap_or_default();
        let f = parse_field(&params["field"])?;
        let (cctx, actor) = custom_pair(ctx);
        let tid = target_id(ctx, &f).await?;
        let created = fields::create(&cctx, &actor, key, &to_create_field(&f, tid))
            .await
            .map_err(user_err)?;
        Ok(json!({ "object": key, "field": created.get("key").cloned().unwrap_or_else(|| json!(f.key)) }))
    })
}

fn options_patch(args: &Value, kind: &str) -> Result<Option<Value>, ToolError> {
    if let Some(ch) = args.get("choices").and_then(Value::as_array) {
        if kind != "select" && kind != "multi_select" {
            return Err(user("choices chỉ dùng cho trường select / multi_select."));
        }
        let items: Vec<Value> = ch
            .iter()
            .map(|c| match c {
                Value::String(s) => json!({ "label": s }),
                other => other.clone(),
            })
            .collect();
        return Ok(Some(json!({ "choices": items })));
    }
    let has = |k: &str| args.get(k).is_some_and(|v| !v.is_null());
    if kind == "formula" && (has("expression") || has("format") || has("decimals")) {
        let mut o = Map::new();
        for k in ["expression", "format", "decimals"] {
            if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
                o.insert(k.to_owned(), v.clone());
            }
        }
        return Ok(Some(Value::Object(o)));
    }
    Ok(None)
}

pub(crate) static UPDATE_FIELD: ActionDef = ActionDef {
    name: "update_field",
    label: "Sửa trường",
    permissions: MANAGE,
    prepare: update_field_prepare,
    execute: update_field_execute,
    structure: true,
};

fn update_field_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = object_key(args);
        let fkey = clean_text(args.get("field"), 48);
        let def = load_def(ctx, &key).await?;
        let cur = def.fields.iter().find(|x| x.key == fkey).ok_or_else(|| {
            user(format!(
                "Bảng “{key}” không có trường “{fkey}”. Gọi describe_schema để xem."
            ))
        })?;
        let label = opt_clean(args.get("label"), 100);
        let help = opt_clean(args.get("help_text"), 300);
        let options = options_patch(args, &cur.kind)?;
        let mut patch = Map::new();
        if let Some(l) = &label {
            patch.insert("label".into(), json!(l));
        }
        for k in ["required", "is_unique", "is_title", "show_in_list"] {
            if let Some(b) = flag(args, k) {
                patch.insert(k.to_owned(), json!(b));
            }
        }
        if let Some(h) = &help {
            patch.insert("help_text".into(), json!(h));
        }
        if let Some(o) = &options {
            patch.insert("options".into(), o.clone());
        }
        if patch.is_empty() {
            return Err(user("Không có gì để sửa."));
        }
        if let Some(o) = &options {
            build_options(&cur.kind, o, &def.fields, Some(&fkey)).map_err(|e| user(app_msg(e)))?;
        }
        assert_flags_allowed(
            &cur.kind,
            flag(args, "required").unwrap_or(cur.required),
            flag(args, "is_unique").unwrap_or(cur.is_unique),
            flag(args, "is_title").unwrap_or(cur.is_title),
        )
        .map_err(|e| user(app_msg(e)))?;
        let shown_name = match &label {
            Some(l) if l != cur.label.trim() => format!("{} → {l}", cur.label.trim()),
            _ => cur.label.trim().to_owned(),
        };
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Bảng", format!("{} [{key}]", def.obj.label), 600));
        details.extend(line("Trường", format!("{} [{fkey}]", cur.label), 600));
        details.extend(
            patch
                .iter()
                .filter_map(|(k, v)| line(k, v.as_str().map_or_else(|| v.to_string(), str::to_owned), 600)),
        );
        let summary = format!(
            "Sửa trường “{shown_name}” của bảng “{}”: {}",
            def.obj.label,
            patch.keys().map(String::as_str).collect::<Vec<_>>().join(", ")
        );
        let impact = field_impact(ctx, &def, cur, &patch).await?;
        Ok(prepared(
            json!({ "object": key, "field": fkey, "patch": Value::Object(patch) }),
            &summary,
            &details,
            Some(impact),
        ))
    })
}

fn update_field_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let key = params.get("object").and_then(Value::as_str).unwrap_or_default();
        let fkey = params.get("field").and_then(Value::as_str).unwrap_or_default();
        let dto = UpdateField::from_validated(&params["patch"]);
        let (cctx, actor) = custom_pair(ctx);
        fields::update(&cctx, &actor, key, fkey, &dto).await.map_err(user_err)?;
        Ok(json!({ "object": key, "field": fkey }))
    })
}

pub(crate) static ARCHIVE_FIELD: ActionDef = ActionDef {
    name: "archive_field",
    label: "Ẩn trường",
    permissions: MANAGE,
    prepare: archive_field_prepare,
    execute: archive_field_execute,
    structure: true,
};

fn archive_field_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let key = object_key(args);
        let fkey = clean_text(args.get("field"), 48);
        let def = load_def(ctx, &key).await?;
        let cur = def
            .fields
            .iter()
            .find(|x| x.key == fkey)
            .ok_or_else(|| user(format!("Bảng “{key}” không có trường “{fkey}”.")))?;
        if cur.is_title {
            return Err(user(
                "Đây là trường tiêu đề — hãy chọn trường khác làm tiêu đề (update_field is_title) trước.",
            ));
        }
        let used = formulas_referencing(&def.fields, &fkey);
        if !used.is_empty() {
            return Err(user(format!(
                "Không ẩn được: trường công thức “{}” đang dùng trường này.",
                used.iter().map(|f| f.label.as_str()).collect::<Vec<_>>().join("”, “")
            )));
        }
        let with_value = count_with_value(ctx, def.obj.id, &fkey).await?;
        let impact = impact_json(
            &[(key.clone(), def.obj.label.clone(), with_value)],
            &[format!(
                "{with_value} bản ghi của “{}” đang có dữ liệu ở trường “{}” — sẽ KHÔNG còn thấy trên form/danh sách (dữ liệu vẫn giữ, quay lui được).",
                def.obj.label, cur.label
            )],
        );
        let mut details: Vec<Detail> = Vec::new();
        details.extend(line("Bảng", format!("{} [{key}]", def.obj.label), 600));
        details.extend(line("Trường", format!("{} [{fkey}]", cur.label), 600));
        details.extend(line(
            "Hậu quả",
            "Trường biến khỏi form/danh sách; dữ liệu cũ vẫn nằm trong bản ghi",
            600,
        ));
        let summary = format!(
            "Ẩn trường “{}” của bảng “{}” (dữ liệu giữ nguyên)",
            cur.label, def.obj.label
        );
        Ok(prepared(
            json!({ "object": key, "field": fkey }),
            &summary,
            &details,
            Some(impact),
        ))
    })
}

fn archive_field_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let key = params.get("object").and_then(Value::as_str).unwrap_or_default();
        let fkey = params.get("field").and_then(Value::as_str).unwrap_or_default();
        let (cctx, actor) = custom_pair(ctx);
        fields::remove(&cctx, &actor, key, fkey).await.map_err(user_err)?;
        Ok(json!({ "object": key, "field": fkey, "archived": true }))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// restore_structure_version
// ---------------------------------------------------------------------------------------------------------------------

fn diff_tables(diff: &Value) -> Vec<(String, String, String, i64)> {
    diff.get("tables")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| {
                    let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                    (
                        s("key"),
                        s("label"),
                        s("change"),
                        t.get("records").and_then(Value::as_i64).unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) static RESTORE_STRUCTURE_VERSION: ActionDef = ActionDef {
    name: "restore_structure_version",
    label: "Quay lui cấu trúc",
    permissions: MANAGE_FEATURES,
    prepare: restore_prepare,
    execute: restore_execute,
    structure: true,
};

fn restore_prepare<'a>(args: &'a Value, ctx: &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        let id = crate::args::opt_int(args.get("version_id"))
            .ok_or_else(|| user("version_id phải là số nguyên dương (lấy từ list_structure_versions)."))?;
        let tables = {
            let mut c = ctx.deps.conn(p.company).await?;
            let snap = mod_custom::versions::load(&mut c, id)
                .await
                .map_err(|e| match user_err(e) {
                    ToolError::User(_) => user(format!(
                        "Không có phiên bản cấu trúc #{id}. Gọi list_structure_versions."
                    )),
                    other => other,
                })?;
            let diff = mod_custom::versions::diff(&mut c, &snap).await.map_err(user_err)?;
            diff_tables(&diff)
        };
        if tables.is_empty() {
            return Err(user(format!(
                "Cấu trúc hiện tại đã giống phiên bản #{id} — không có gì để quay lui."
            )));
        }
        let details: Vec<Detail> = tables
            .iter()
            .filter_map(|(k, l, ch, n)| line(&format!("{l} [{k}]"), format!("{ch} — {n} bản ghi"), 600))
            .collect();
        let summary = format!(
            "Quay lui cấu trúc về phiên bản #{id}: {}",
            tables.iter().map(|t| t.1.as_str()).collect::<Vec<_>>().join(", ")
        );
        let impact = impact_json(
            &tables
                .iter()
                .map(|(k, l, _, n)| (k.clone(), l.clone(), *n))
                .collect::<Vec<_>>(),
            &tables
                .iter()
                .map(|(_, l, ch, n)| format!("{l}: {ch} ({n} bản ghi)"))
                .collect::<Vec<_>>(),
        );
        Ok(prepared(json!({ "version_id": id }), &summary, &details, Some(impact)))
    })
}

fn restore_execute<'a>(
    params: &'a Value,
    ctx: &'a ActionCx<'a>,
    _draft_id: i32,
) -> BoxFuture<'a, Result<Value, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        let id = crate::args::opt_int(params.get("version_id"))
            .ok_or_else(|| user("version_id phải là số nguyên dương."))?;
        // Khôi phục phải chạy trong MỘT giao dịch (hàm của mod-custom không tự mở).
        let cctx = ctx.deps.custom_ctx();
        let mut tx = cctx.begin(p.company).await.map_err(user_err)?;
        let r = mod_custom::versions::restore(&mut tx, id, p.user_id)
            .await
            .map_err(user_err)?;
        tx.commit().await.map_err(internal)?;
        Ok(r)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_truong_va_bang() {
        let f = parse_field(&json!({ "label": "Ngày sinh", "type": "date", "required": true })).unwrap();
        assert_eq!(
            (f.key.as_str(), f.kind.as_str(), f.required),
            ("ngay_sinh", "date", Some(true))
        );
        assert!(parse_field(&json!({ "label": "x", "type": "lạ" })).is_err());
        assert!(parse_field(&json!({ "type": "text" })).is_err());
        assert!(parse_field(&json!({ "label": "x", "type": "text", "key": "Bad Key" })).is_err());
        let o = parse_object(&json!({
            "label": "Bệnh nhân", "icon": "users",
            "fields": [{ "label": "Họ tên", "type": "text" }, { "label": "Ghi chú", "type": "long_text" }],
        }));
        let o = o.unwrap();
        assert_eq!(
            (o.key.as_str(), o.label_plural.as_str(), o.fields.len()),
            ("benh_nhan", "Bệnh nhân", 2)
        );
        assert!(
            parse_object(&json!({ "label": "A", "fields": [
            { "label": "x", "type": "text" }, { "label": "x", "type": "number" }] }))
            .is_err()
        );
        assert!(parse_object(&json!({ "label": "A", "key": "new" })).is_err());
        assert!(parse_object(&json!({ "label": "A", "icon": "khong-co" })).is_err());
    }

    #[test]
    fn tuy_chon_truong() {
        let f = parse_field(&json!({
            "label": "Giai đoạn", "type": "select", "choices": ["Mới", { "label": "Xong", "color": "green" }],
        }))
        .unwrap();
        let o = field_options(&f, None);
        assert_eq!(o["choices"][0], json!({ "label": "Mới" }));
        assert_eq!(o["choices"][1]["label"], "Xong");
        let r = parse_field(&json!({ "label": "Khách", "type": "relation", "target_object": "contacts" })).unwrap();
        assert_eq!(
            field_options(&r, None),
            json!({ "target": "contact", "multiple": false })
        );
        let r2 =
            parse_field(&json!({ "label": "Đơn", "type": "relation", "target_object": "don_hang", "multiple": true }))
                .unwrap();
        assert_eq!(
            field_options(&r2, Some(7)),
            json!({ "target_object_id": 7, "multiple": true })
        );
    }

    #[test]
    fn kiem_truong_chay_thu() {
        let targets: HashSet<String> = ["don_hang".to_owned()].into();
        let ok = parse_field(&json!({ "label": "Tên", "type": "text" })).unwrap();
        let sel = parse_field(&json!({ "label": "TT", "type": "select", "choices": ["a"] })).unwrap();
        assert!(check_fields(&[ok.clone(), sel], &[], &targets).is_ok());
        let dup = parse_field(&json!({ "label": "Tên", "type": "text" })).unwrap();
        assert!(check_fields(&[ok.clone(), dup], &[], &targets).is_err());
        let rel = parse_field(&json!({ "label": "X", "type": "relation", "target_object": "khong_co" })).unwrap();
        assert!(check_fields(&[rel], &[], &targets).is_err());
        let uniq_phone = parse_field(&json!({ "label": "SĐT", "type": "phone", "is_unique": true })).unwrap();
        assert!(check_fields(&[uniq_phone], &[], &targets).is_err());
    }
}
