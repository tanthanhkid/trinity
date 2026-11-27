//! Trường của bảng tuỳ biến: thêm, sửa, xoá mềm, đổi thứ tự, xem trước công thức (chuyển từ `custom-fields.service.ts` và
//! `field-definition.ts`). Quyền `custom_objects.manage` do router gác.

use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::models::CustomField;
use trinity_kernel::formula::{RefKind, check_formula, collect_refs, evaluate_formula, parse_formula};

use crate::access::{FIELD_COLS, ObjectDef, load_visible_object};
use crate::objects::Patch;
use crate::types::{
    COMPATIBLE_TYPE_GROUPS, DATE_TYPES, FieldDef, Limits, NUMERIC_TYPES, TITLE_TYPES, UNIQUE_TYPES, is_field_type,
    valid_key,
};
use crate::values::{formula_input, normalize_options, slugify_key};
use crate::{Actor, Ctx, R, bad, conflict, db, is_unique, js_number, not_found};

const LOCK_NS: i32 = 7373;

pub fn ref_kind_of(kind: &str) -> Option<RefKind> {
    if NUMERIC_TYPES.contains(&kind) {
        Some(RefKind::Num)
    } else if DATE_TYPES.contains(&kind) {
        Some(RefKind::Date)
    } else {
        None
    }
}

/// Kiểm công thức; lỗi là câu `Công thức: …` (400).
pub fn validate_formula(expression: &str, fields: &[FieldDef], editing_key: Option<&str>) -> Result<(), String> {
    let ast = parse_formula(expression).map_err(|e| format!("Công thức: {}", e.0))?;
    check_formula(&ast, &|key| {
        if editing_key == Some(key) {
            return None;
        }
        fields.iter().find(|f| f.key == key).and_then(|f| ref_kind_of(&f.kind))
    })
    .map_err(|e| format!("Công thức: {}", e.0))
}

/// Chuẩn hoá tuỳ chọn theo kiểu, và nếu là công thức thì kiểm biểu thức với các trường anh em.
pub fn build_options(kind: &str, raw: &Value, siblings: &[FieldDef], editing_key: Option<&str>) -> R<Value> {
    let options = normalize_options(kind, raw).map_err(|e| bad(e.0))?;
    if kind == "formula" {
        let expr = options.get("expression").and_then(Value::as_str).unwrap_or("");
        validate_formula(expr, siblings, editing_key).map_err(bad)?;
    }
    Ok(options)
}

/// Các trường công thức đang tham chiếu `key`.
pub fn formulas_referencing<'a>(fields: &'a [FieldDef], key: &str) -> Vec<&'a FieldDef> {
    fields
        .iter()
        .filter(|f| {
            f.kind == "formula"
                && f.options
                    .get("expression")
                    .and_then(Value::as_str)
                    .filter(|e| !e.is_empty())
                    .and_then(|e| parse_formula(e).ok())
                    .is_some_and(|ast| collect_refs(&ast).contains(key))
        })
        .collect()
}

pub fn assert_flags_allowed(kind: &str, required: bool, is_unique: bool, is_title: bool) -> R<()> {
    if kind == "formula" && (required || is_unique) {
        return Err(bad(
            "Trường công thức tự tính nên không đặt được “bắt buộc” hay “duy nhất”",
        ));
    }
    if is_unique && !UNIQUE_TYPES.contains(&kind) {
        return Err(bad(
            "Kiểu trường này không đặt được “duy nhất” (chỉ văn bản ngắn, số, tiền, email, đường dẫn, ngày; SĐT không đặt duy nhất được để tránh dò số)",
        ));
    }
    if is_title && !TITLE_TYPES.contains(&kind) {
        return Err(bad("Trường tiêu đề phải là văn bản ngắn, số, email hoặc ngày"));
    }
    Ok(())
}

pub fn types_compatible(a: &str, b: &str) -> bool {
    a == b || COMPATIBLE_TYPE_GROUPS.iter().any(|g| g.contains(&a) && g.contains(&b))
}

async fn field_has_data(conn: &mut PgConnection, object_id: i32, key: &str) -> R<bool> {
    let r: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL AND (data -> $2) IS NOT NULL LIMIT 1",
    )
    .bind(object_id)
    .bind(key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    Ok(r.is_some())
}

async fn used_choice_values(
    conn: &mut PgConnection,
    object_id: i32,
    key: &str,
    kind: &str,
    candidates: &[String],
) -> R<Vec<String>> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let sql = if kind == "multi_select" {
        "SELECT DISTINCT e AS v FROM custom_records r, jsonb_array_elements_text(r.data -> $2) e WHERE r.object_id = $1 AND r.deleted_at IS NULL AND jsonb_typeof(r.data -> $2) = 'array' AND e = ANY($3::text[])"
    } else {
        "SELECT DISTINCT data ->> $2 AS v FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL AND data ->> $2 = ANY($3::text[])"
    };
    sqlx::query_scalar(sql)
        .bind(object_id)
        .bind(key)
        .bind(candidates)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)
}

async fn has_duplicates(conn: &mut PgConnection, object_id: i32, key: &str) -> R<bool> {
    let r: Option<i64> = sqlx::query_scalar(
        "SELECT count(*) FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL AND (data -> $2) IS NOT NULL
         GROUP BY lower(data ->> $2) HAVING count(*) > 1 LIMIT 1",
    )
    .bind(object_id)
    .bind(key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    Ok(r.is_some())
}

async fn rebuild_titles(conn: &mut PgConnection, object_id: i32, field_key: &str) -> R<()> {
    sqlx::query("UPDATE custom_records SET title = NULLIF(left(data ->> $2, $3::int), '') WHERE object_id = $1")
        .bind(object_id)
        .bind(field_key)
        .bind(Limits::MAX_TITLE)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

async fn check_relation_target(conn: &mut PgConnection, kind: &str, options: &Value, self_id: i32) -> R<()> {
    if kind != "relation" || options.get("target").and_then(Value::as_str) == Some("contact") {
        return Ok(());
    }
    let id = options.get("target_object_id").and_then(Value::as_i64).unwrap_or(0);
    if id == i64::from(self_id) {
        return Ok(());
    }
    let t: Option<i32> = sqlx::query_scalar("SELECT id FROM custom_objects WHERE id = $1::int AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    if t.is_none() {
        return Err(bad("Thực thể đích của trường liên kết không tồn tại"));
    }
    Ok(())
}

fn as_type(t: &str) -> R<String> {
    if !is_field_type(t) {
        return Err(bad("Kiểu trường không hợp lệ"));
    }
    Ok(t.to_owned())
}

fn find_field<'a>(def: &'a ObjectDef, key: &str) -> R<&'a FieldDef> {
    def.fields
        .iter()
        .find(|f| f.key == key)
        .ok_or_else(|| not_found("Không tìm thấy trường này"))
}

#[derive(Debug, Clone, Default)]
pub struct CreateField {
    pub key: Option<String>,
    pub label: String,
    pub kind: String,
    pub required: Option<bool>,
    pub is_unique: Option<bool>,
    pub is_title: Option<bool>,
    pub show_in_list: Option<bool>,
    pub options: Option<Value>,
    pub help_text: Option<String>,
}

impl CreateField {
    pub fn from_validated(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        let b = |k: &str| v.get(k).and_then(Value::as_bool);
        Self {
            key: s("key"),
            label: s("label").unwrap_or_default(),
            kind: s("type").unwrap_or_default(),
            required: b("required"),
            is_unique: b("is_unique"),
            is_title: b("is_title"),
            show_in_list: b("show_in_list"),
            options: v.get("options").cloned(),
            help_text: s("help_text"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateField {
    pub label: Option<String>,
    pub kind: Option<String>,
    pub required: Option<bool>,
    pub is_unique: Option<bool>,
    pub is_title: Option<bool>,
    pub show_in_list: Option<bool>,
    pub options: Option<Value>,
    pub help_text: Patch<String>,
}

impl UpdateField {
    pub fn from_validated(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        let b = |k: &str| v.get(k).and_then(Value::as_bool);
        Self {
            label: s("label"),
            kind: s("type"),
            required: b("required"),
            is_unique: b("is_unique"),
            is_title: b("is_title"),
            show_in_list: b("show_in_list"),
            options: v.get("options").cloned(),
            help_text: crate::objects::patch_str(v, "help_text"),
        }
    }
}

fn trimmed(s: &str) -> &str {
    trinity_kernel::vi::trim_js(s)
}

/// `POST /custom-objects/:key/fields`.
pub async fn create(ctx: &Ctx, actor: &Actor, object_key: &str, dto: &CreateField) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut c, actor, object_key, None).await?;
    let kind = as_type(&dto.kind)?;
    let key = dto.key.clone().unwrap_or_else(|| slugify_key(&dto.label));
    if !valid_key(&key) {
        return Err(bad("Mã trường chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ"));
    }
    if is_object_prototype_key(&key) {
        return Err(bad(format!(
            "Mã trường “{key}” là từ khoá của hệ thống, hãy chọn mã khác"
        )));
    }
    if trimmed(&dto.label).is_empty() {
        return Err(bad("Tên trường không được để trống"));
    }
    if def.fields.len() >= Limits::MAX_FIELDS_PER_OBJECT {
        return Err(bad(format!(
            "Mỗi tính năng tối đa {} trường",
            Limits::MAX_FIELDS_PER_OBJECT
        )));
    }
    if def.fields.iter().any(|f| f.key == key) {
        return Err(conflict(format!("Mã trường “{key}” đã tồn tại")));
    }
    if field_has_data(&mut c, def.obj.id, &key).await? {
        return Err(conflict(format!(
            "Mã “{key}” từng được dùng và vẫn còn dữ liệu cũ trong các bản ghi. Hãy chọn mã trường khác."
        )));
    }
    let options = build_options(&kind, dto.options.as_ref().unwrap_or(&Value::Null), &def.fields, None)?;
    check_relation_target(&mut c, &kind, &options, def.obj.id).await?;
    let auto_title =
        dto.is_title.is_none() && !def.fields.iter().any(|f| f.is_title) && TITLE_TYPES.contains(&kind.as_str());
    let (required, is_unique_f, is_title) = (
        dto.required.unwrap_or(false),
        dto.is_unique.unwrap_or(false),
        dto.is_title.unwrap_or(auto_title),
    );
    assert_flags_allowed(&kind, required, is_unique_f, is_title)?;
    let sort = def.fields.iter().map(|f| f.sort_order).max().unwrap_or(0).max(0) + 10;
    drop(c);

    let mut tx = ctx.begin(actor.company).await?;
    let on_err = |e: sqlx::Error| {
        if is_unique(&e) {
            conflict(format!("Mã trường “{key}” đã tồn tại"))
        } else {
            db(e)
        }
    };
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(LOCK_NS)
        .bind(def.obj.id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if is_title {
        sqlx::query("UPDATE custom_fields SET is_title = false, updated_at = now() WHERE object_id = $1 AND is_title AND deleted_at IS NULL")
            .bind(def.obj.id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let row: CustomField = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO custom_fields (object_id, key, label, type, required, is_unique, is_title, show_in_list, sort_order, options, help_text, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING {FIELD_COLS}"
    )))
    .bind(def.obj.id)
    .bind(&key)
    .bind(trimmed(&dto.label))
    .bind(&kind)
    .bind(required)
    .bind(is_unique_f)
    .bind(is_title)
    .bind(dto.show_in_list.unwrap_or(true))
    .bind(sort)
    .bind(&options)
    .bind(dto.help_text.as_deref().map(trimmed).filter(|s| !s.is_empty()))
    .fetch_one(&mut *tx)
    .await
    .map_err(on_err)?;
    if is_title {
        rebuild_titles(&mut tx, def.obj.id, &key).await?;
    }
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    tracing::info!(
        "custom_field {object_key}.{key} ({kind}) tạo bởi user {}",
        actor.user_id
    );
    crate::json_of(&FieldDef::from_row(&row))
}

/// `key in Object.prototype` của bản TS: trong các khoá hợp lệ theo `KEY_REGEX` (chỉ chữ thường) chỉ còn `constructor`.
fn is_object_prototype_key(key: &str) -> bool {
    key == "constructor"
}

/// `PATCH /custom-objects/:key/fields/:fieldKey`.
pub async fn update(ctx: &Ctx, actor: &Actor, object_key: &str, field_key: &str, dto: &UpdateField) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut c, actor, object_key, None).await?;
    let cur = find_field(&def, field_key)?.clone();
    if dto.label.as_deref().is_some_and(|l| trimmed(l).is_empty()) {
        return Err(bad("Tên trường không được để trống"));
    }
    let kind = match &dto.kind {
        Some(t) => as_type(t)?,
        None => cur.kind.clone(),
    };
    let type_changed = kind != cur.kind;
    let has_data = if type_changed || dto.options.is_some() {
        field_has_data(&mut c, def.obj.id, field_key).await?
    } else {
        false
    };
    if type_changed {
        check_type_change(&mut c, &def, &cur, &kind, has_data).await?;
    }
    let options = if dto.options.is_some() || type_changed {
        let raw = dto
            .options
            .clone()
            .unwrap_or_else(|| if type_changed { json!({}) } else { cur.options.clone() });
        build_options(&kind, &raw, &def.fields, Some(field_key))?
    } else {
        cur.options.clone()
    };
    check_options_change(&mut c, &def, &cur, &kind, &options, has_data).await?;
    let is_formula = kind == "formula";
    let required = if is_formula {
        false
    } else {
        dto.required.unwrap_or(cur.required)
    };
    let is_unique_f = if is_formula {
        false
    } else {
        dto.is_unique.unwrap_or(cur.is_unique)
    };
    let is_title = dto.is_title.unwrap_or(cur.is_title);
    if cur.is_title && dto.is_title == Some(false) {
        return Err(conflict(
            "Phải chọn trường khác làm tiêu đề trước khi bỏ tiêu đề của trường này",
        ));
    }
    assert_flags_allowed(&kind, required, is_unique_f, is_title)?;
    if is_unique_f && !cur.is_unique && has_duplicates(&mut c, def.obj.id, field_key).await? {
        return Err(conflict(
            "Đang có bản ghi trùng giá trị ở trường này nên chưa bật được “duy nhất”. Hãy xử lý trùng trước.",
        ));
    }
    drop(c);

    let mut tx = ctx.begin(actor.company).await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(LOCK_NS)
        .bind(def.obj.id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    if is_title && !cur.is_title {
        sqlx::query("UPDATE custom_fields SET is_title = false, updated_at = now() WHERE object_id = $1 AND is_title AND deleted_at IS NULL")
            .bind(def.obj.id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    let help = match &dto.help_text {
        Patch::Keep => (false, None),
        Patch::Clear => (true, None),
        Patch::Set(h) => (true, Some(trimmed(h).to_owned()).filter(|s| !s.is_empty())),
    };
    let row: CustomField = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "UPDATE custom_fields SET label = COALESCE($2, label), type = $3, required = $4, is_unique = $5, is_title = $6,
           show_in_list = COALESCE($7, show_in_list), options = $8, help_text = CASE WHEN $9 THEN $10 ELSE help_text END, updated_at = now()
         WHERE id = $1 RETURNING {FIELD_COLS}"
    )))
    .bind(cur.id)
    .bind(dto.label.as_deref().map(trimmed))
    .bind(&kind)
    .bind(required)
    .bind(is_unique_f)
    .bind(is_title)
    .bind(dto.show_in_list)
    .bind(&options)
    .bind(help.0)
    .bind(help.1)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    if is_title && !cur.is_title {
        rebuild_titles(&mut tx, def.obj.id, field_key).await?;
    }
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    tracing::info!("custom_field {object_key}.{field_key} sửa bởi user {}", actor.user_id);
    crate::json_of(&FieldDef::from_row(&row))
}

async fn check_type_change(
    conn: &mut PgConnection,
    def: &ObjectDef,
    cur: &FieldDef,
    next: &str,
    has_data: bool,
) -> R<()> {
    if has_data && cur.kind == "long_text" && next == "text" {
        let n: Option<i32> = sqlx::query_scalar(
            "SELECT max(length(data ->> $2))::int FROM custom_records WHERE object_id = $1 AND deleted_at IS NULL",
        )
        .bind(def.obj.id)
        .bind(&cur.key)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        if usize::try_from(n.unwrap_or(0)).unwrap_or(0) > Limits::MAX_TEXT {
            return Err(conflict(format!(
                "Có bản ghi dài hơn {} ký tự nên chưa đổi sang “văn bản ngắn” được",
                Limits::MAX_TEXT
            )));
        }
    }
    if has_data && !types_compatible(&cur.kind, next) {
        return Err(conflict(format!(
            "Trường đã có dữ liệu nên không đổi từ “{}” sang “{next}” được. Hãy tạo trường mới rồi chuyển dữ liệu.",
            cur.kind
        )));
    }
    let used = formulas_referencing(&def.fields, &cur.key);
    if !used.is_empty() && ref_kind_of(next) != ref_kind_of(&cur.kind) {
        let names: Vec<&str> = used.iter().map(|f| f.label.as_str()).collect();
        return Err(conflict(format!(
            "Công thức “{}” đang dùng trường này nên chưa đổi sang kiểu khác được",
            names.join("”, “")
        )));
    }
    if cur.kind == "formula" {
        return Err(conflict("Không đổi kiểu của trường công thức; hãy tạo trường mới"));
    }
    Ok(())
}

fn choice_values(opts: &Value) -> Vec<String> {
    opts.get("choices")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| c.get("value").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

async fn check_options_change(
    conn: &mut PgConnection,
    def: &ObjectDef,
    cur: &FieldDef,
    kind: &str,
    next: &Value,
    has_data: bool,
) -> R<()> {
    if kind == "select" || kind == "multi_select" {
        if cur.kind != kind {
            return Ok(());
        }
        let kept = choice_values(next);
        let removed: Vec<String> = choice_values(&cur.options)
            .into_iter()
            .filter(|v| !kept.contains(v))
            .collect();
        let in_use = used_choice_values(conn, def.obj.id, &cur.key, kind, &removed).await?;
        if !in_use.is_empty() {
            let shown: Vec<&str> = in_use.iter().take(5).map(String::as_str).collect();
            return Err(conflict(format!(
                "Không bỏ được lựa chọn đang có bản ghi dùng: {}",
                shown.join(", ")
            )));
        }
    }
    if kind == "relation" && cur.kind == "relation" && has_data {
        let same = cur.options.get("target") == next.get("target")
            && cur.options.get("target_object_id") == next.get("target_object_id");
        let flag = |o: &Value| o.get("multiple") == Some(&Value::Bool(true));
        let multi = flag(&cur.options) == flag(next);
        if !same || !multi {
            return Err(conflict(
                "Trường liên kết đã có dữ liệu nên không đổi nơi trỏ tới / chế độ chọn nhiều được",
            ));
        }
    }
    if kind == "relation" {
        check_relation_target(conn, kind, next, def.obj.id).await?;
    }
    Ok(())
}

/// `DELETE /custom-objects/:key/fields/:fieldKey`: xoá mềm; dữ liệu cũ vẫn nằm trong bản ghi.
pub async fn remove(ctx: &Ctx, actor: &Actor, object_key: &str, field_key: &str) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut c, actor, object_key, None).await?;
    let cur = find_field(&def, field_key)?;
    if cur.is_title {
        return Err(conflict(
            "Đây là trường tiêu đề. Hãy chọn trường khác làm tiêu đề trước khi xoá.",
        ));
    }
    let used = formulas_referencing(&def.fields, field_key);
    if !used.is_empty() {
        let names: Vec<&str> = used.iter().map(|f| f.label.as_str()).collect();
        return Err(conflict(format!(
            "Không xoá được: trường công thức “{}” đang dùng trường này",
            names.join("”, “")
        )));
    }
    sqlx::query("UPDATE custom_fields SET deleted_at = now(), updated_at = now() WHERE id = $1")
        .bind(cur.id)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    tracing::warn!(
        "custom_field {object_key}.{field_key} xoá mềm bởi user {} (dữ liệu cũ vẫn nằm trong bản ghi)",
        actor.user_id
    );
    Ok(json!({ "ok": true }))
}

/// `PUT /custom-objects/:key/fields/order`: danh sách phải gồm đúng và đủ các trường hiện có.
pub async fn reorder(ctx: &Ctx, actor: &Actor, object_key: &str, keys: &[String]) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut c, actor, object_key, None).await?;
    let mut have: Vec<&str> = def.fields.iter().map(|f| f.key.as_str()).collect();
    have.sort_unstable();
    let mut order: Vec<&str> = Vec::new();
    for k in keys {
        if !order.contains(&k.as_str()) {
            order.push(k);
        }
    }
    let mut want = order.clone();
    want.sort_unstable();
    if have != want {
        return Err(bad("Danh sách thứ tự phải gồm đúng và đủ các trường hiện có"));
    }
    drop(c);
    let mut tx = ctx.begin(actor.company).await?;
    for (i, k) in order.iter().enumerate() {
        let id = def.fields.iter().find(|f| f.key == *k).map(|f| f.id).unwrap_or(0);
        sqlx::query("UPDATE custom_fields SET sort_order = $1, updated_at = now() WHERE id = $2")
            .bind(i32::try_from((i + 1) * 10).unwrap_or(i32::MAX))
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    Ok(json!({ "ok": true }))
}

/// `POST /custom-objects/formula/preview`: `{ ok: false, error }` hoặc `{ ok: true, result }` (`null` khi thiếu dữ liệu).
pub async fn preview_formula(ctx: &Ctx, actor: &Actor, body: &Value) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let object_key = body.get("object_key").and_then(Value::as_str).unwrap_or_default();
    let def = load_visible_object(&mut c, actor, object_key, None).await?;
    let expression = body.get("expression").and_then(Value::as_str).unwrap_or_default();
    let editing = body.get("editing_key").and_then(Value::as_str);
    if let Err(error) = validate_formula(expression, &def.fields, editing) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    let Ok(ast) = parse_formula(expression) else {
        return Ok(json!({ "ok": false, "error": "Công thức không hợp lệ" }));
    };
    let empty = Map::new();
    let sample = body.get("sample").and_then(Value::as_object).unwrap_or(&empty);
    let result = evaluate_formula(&ast, &|k| {
        let f = def.fields.iter().find(|x| x.key == k)?;
        formula_input(&f.kind, sample.get(k))
    });
    Ok(json!({ "ok": true, "result": result.map_or(Value::Null, js_number) }))
}
