//! Bảng tuỳ biến: danh sách, menu, chi tiết, tạo, sửa, xoá mềm (chuyển từ `custom-objects.service.ts`).
//! Quyền `custom_objects.manage` (cấu hình) và `custom_records.view` (menu) do router gác.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{CustomObject, CustomView};

use crate::access::{
    OBJ_COLS, ObjectAccess, VIEW_COLS, is_object_visible, load_access, load_visible_object, present_object,
};
use crate::codes::{normalize_prefix, prefix_taken, rename_prefix};
use crate::types::{CUSTOM_ICONS, FieldDef, Limits, RESERVED_OBJECT_KEYS, valid_key};
use crate::views::is_view_visible;
use crate::{Actor, Ctx, R, bad, conflict, db, is_unique};

/// Trường PATCH: không gửi (giữ), `null` (xoá), giá trị (đặt).
#[derive(Debug, Clone, PartialEq)]
pub enum Patch<T> {
    Keep,
    Clear,
    Set(T),
}

pub fn patch_str(v: &Value, key: &str) -> Patch<String> {
    match v.get(key) {
        None => Patch::Keep,
        Some(Value::String(s)) => Patch::Set(s.clone()),
        Some(_) => Patch::Clear,
    }
}

#[derive(Debug, Clone, Default)]
pub struct CreateObject {
    pub key: String,
    pub label: String,
    pub label_plural: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub show_in_nav: Option<bool>,
    pub nav_order: Option<i32>,
    pub visible_role_ids: Option<Vec<i32>>,
    pub is_active: Option<bool>,
    pub code_prefix: Option<String>,
}

fn role_ids(v: &Value) -> Option<Vec<i32>> {
    v.get("visible_role_ids").and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|x| x.as_i64().and_then(|n| i32::try_from(n).ok()))
            .collect()
    })
}

impl CreateObject {
    /// Từ body đã qua K15 (`CreateCustomObjectDto`, strict).
    pub fn from_validated(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        Self {
            key: s("key").unwrap_or_default(),
            label: s("label").unwrap_or_default(),
            label_plural: s("label_plural").unwrap_or_default(),
            icon: s("icon"),
            description: s("description"),
            show_in_nav: v.get("show_in_nav").and_then(Value::as_bool),
            nav_order: v
                .get("nav_order")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok()),
            visible_role_ids: role_ids(v),
            is_active: v.get("is_active").and_then(Value::as_bool),
            code_prefix: s("code_prefix"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateObject {
    pub label: Option<String>,
    pub label_plural: Option<String>,
    pub icon: Patch<String>,
    pub description: Patch<String>,
    pub show_in_nav: Option<bool>,
    pub nav_order: Option<i32>,
    pub visible_role_ids: Option<Vec<i32>>,
    pub is_active: Option<bool>,
    pub code_prefix: Option<String>,
}

impl UpdateObject {
    pub fn from_validated(v: &Value) -> Self {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        Self {
            label: s("label"),
            label_plural: s("label_plural"),
            icon: patch_str(v, "icon"),
            description: patch_str(v, "description"),
            show_in_nav: v.get("show_in_nav").and_then(Value::as_bool),
            nav_order: v
                .get("nav_order")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok()),
            visible_role_ids: role_ids(v),
            is_active: v.get("is_active").and_then(Value::as_bool),
            code_prefix: s("code_prefix"),
        }
    }
}

fn check_icon(icon: Option<&str>) -> R<Option<String>> {
    match icon {
        None | Some("") => Ok(None),
        Some(i) if CUSTOM_ICONS.contains(&i) => Ok(Some(i.to_owned())),
        Some(_) => Err(bad("Biểu tượng không nằm trong danh sách cho phép")),
    }
}

fn assert_key(key: &str) -> R<()> {
    if !valid_key(key) {
        return Err(bad("Mã chỉ gồm a-z, 0-9, _ , bắt đầu bằng chữ, tối đa 48 ký tự"));
    }
    if RESERVED_OBJECT_KEYS.contains(&key) {
        return Err(bad(format!("Mã “{key}” là từ khoá của hệ thống, hãy chọn mã khác")));
    }
    Ok(())
}

async fn check_role_ids(conn: &mut PgConnection, ids: Option<&[i32]>) -> R<Vec<i32>> {
    let mut uniq: Vec<i32> = Vec::new();
    for i in ids.unwrap_or_default() {
        if !uniq.contains(i) {
            uniq.push(*i);
        }
    }
    if uniq.is_empty() {
        return Ok(uniq);
    }
    let found: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE id = ANY($1)")
        .bind(&uniq)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    if usize::try_from(found).ok() != Some(uniq.len()) {
        return Err(bad("Có vai trò không tồn tại trong danh sách “được thấy”"));
    }
    Ok(uniq)
}

/// `GET /custom-objects`.
pub async fn list(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let objects: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE deleted_at IS NULL ORDER BY nav_order ASC, id ASC"
    )))
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let fc: Vec<(i32, i64)> =
        sqlx::query_as("SELECT object_id, count(*) FROM custom_fields WHERE deleted_at IS NULL GROUP BY object_id")
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
    let rc: Vec<(i32, i64)> =
        sqlx::query_as("SELECT object_id, count(*) FROM custom_records WHERE deleted_at IS NULL GROUP BY object_id")
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
    let fc: BTreeMap<i32, i64> = fc.into_iter().collect();
    let rc: BTreeMap<i32, i64> = rc.into_iter().collect();
    Ok(Value::Array(
        objects
            .iter()
            .map(|o| {
                json!({
                    "id": o.id, "key": o.key, "label": o.label, "label_plural": o.label_plural, "icon": o.icon,
                    "description": o.description, "show_in_nav": o.show_in_nav, "nav_order": o.nav_order,
                    "visible_role_ids": o.visible_role_ids.0, "is_active": o.is_active, "code_prefix": o.code_prefix,
                    "field_count": fc.get(&o.id).copied().unwrap_or(0), "record_count": rc.get(&o.id).copied().unwrap_or(0),
                })
            })
            .collect(),
    ))
}

/// `GET /custom-objects/nav`: bảng bật + hiện menu + người này được thấy, cùng các màn gắn menu của chúng; chung một thứ tự `nav_order`.
pub async fn nav(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let access = load_access(&mut c, actor).await?;
    let objects: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE deleted_at IS NULL AND is_active ORDER BY nav_order ASC, id ASC LIMIT {}",
        Limits::MAX_OBJECTS + 10
    )))
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let visible: Vec<&CustomObject> = objects.iter().filter(|o| is_object_visible(o, &access)).collect();
    let ids: Vec<i32> = visible.iter().map(|o| o.id).collect();
    let views: Vec<CustomView> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {VIEW_COLS} FROM custom_views WHERE deleted_at IS NULL AND show_in_nav AND object_id = ANY($1) LIMIT 200"
        )))
        .bind(&ids)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?
    };
    let mut items: Vec<(i32, String, Value)> = Vec::new();
    for o in visible.iter().filter(|o| o.show_in_nav) {
        items.push((
            o.nav_order,
            o.key.clone(),
            json!({ "key": o.key, "label": o.label, "label_plural": o.label_plural, "icon": o.icon, "nav_order": o.nav_order,
                    "href": format!("/x/{}", o.key), "menu_key": o.key }),
        ));
    }
    for v in views.iter().filter(|v| is_view_visible(v, &access)) {
        let Some(o) = visible.iter().find(|o| o.id == v.object_id) else {
            continue;
        };
        let menu_key = format!("{}__{}", o.key, v.key);
        items.push((
            v.nav_order,
            menu_key.clone(),
            json!({ "key": o.key, "label": v.label, "label_plural": v.label, "icon": v.icon.clone().or_else(|| o.icon.clone()),
                    "nav_order": v.nav_order, "href": format!("/x/{}/v/{}", o.key, v.key), "menu_key": menu_key }),
        ));
    }
    items.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| trinity_kernel::vi::compare(&a.1, &b.1, trinity_kernel::vi::Collation::Root))
    });
    Ok(Value::Array(items.into_iter().map(|i| i.2).collect()))
}

/// Gắn `target_key`/`target_label` cho trường liên kết, chỉ khi người xem thấy được bảng đích (không lộ tên bảng bị ẩn).
async fn with_target_keys(conn: &mut PgConnection, access: &ObjectAccess, fields: Vec<FieldDef>) -> R<Vec<FieldDef>> {
    let mut ids: Vec<i32> = Vec::new();
    for f in &fields {
        if f.kind == "relation"
            && let Some(id) = f
                .options
                .get("target_object_id")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok())
            && id != 0
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Ok(fields);
    }
    let targets: Vec<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {OBJ_COLS} FROM custom_objects WHERE id = ANY($1) AND deleted_at IS NULL"
    )))
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(fields
        .into_iter()
        .map(|mut f| {
            let t = (f.kind == "relation")
                .then(|| f.options.get("target_object_id").and_then(Value::as_i64))
                .flatten()
                .and_then(|id| {
                    targets
                        .iter()
                        .find(|t| i64::from(t.id) == id && is_object_visible(t, access))
                });
            if let (Some(t), Some(o)) = (t, f.options.as_object_mut()) {
                o.insert("target_key".to_owned(), Value::String(t.key.clone()));
                o.insert("target_label".to_owned(), Value::String(t.label_plural.clone()));
            }
            f
        })
        .collect())
}

/// `GET /custom-objects/:key`.
pub async fn get_definition(ctx: &Ctx, actor: &Actor, key: &str) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let access = load_access(&mut c, actor).await?;
    let def = load_visible_object(&mut c, actor, key, Some(&access)).await?;
    let fields = with_target_keys(&mut c, &access, def.fields.clone()).await?;
    Ok(present_object(&def.obj, &fields))
}

/// `POST /custom-objects`.
pub async fn create(ctx: &Ctx, actor: &Actor, dto: &CreateObject) -> R<Value> {
    assert_key(&dto.key)?;
    if trinity_kernel::vi::trim_js(&dto.label).is_empty() || trinity_kernel::vi::trim_js(&dto.label_plural).is_empty() {
        return Err(bad("Tên không được để trống"));
    }
    let icon = check_icon(dto.icon.as_deref())?;
    let mut c = ctx.conn(actor.company).await?;
    let roles = check_role_ids(&mut c, dto.visible_role_ids.as_deref()).await?;
    let live: i64 = sqlx::query_scalar("SELECT count(*) FROM custom_objects WHERE deleted_at IS NULL")
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
    let taken: Option<i32> =
        sqlx::query_scalar("SELECT id FROM custom_objects WHERE key = $1 AND deleted_at IS NULL LIMIT 1")
            .bind(&dto.key)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?;
    let max_order: Option<i32> =
        sqlx::query_scalar("SELECT max(nav_order) FROM custom_objects WHERE deleted_at IS NULL")
            .fetch_one(&mut *c)
            .await
            .map_err(db)?;
    if live >= Limits::MAX_OBJECTS {
        return Err(bad(format!("Tối đa {} tính năng tuỳ biến", Limits::MAX_OBJECTS)));
    }
    if taken.is_some() {
        return Err(conflict(format!("Mã “{}” đã được dùng", dto.key)));
    }
    let prefix = dto.code_prefix.as_deref().map(normalize_prefix).transpose()?;
    if let Some(p) = &prefix
        && prefix_taken(&mut c, p, None).await?
    {
        return Err(conflict(format!("Tiền tố mã “{p}” đã được bảng khác dùng")));
    }
    let description = dto
        .description
        .as_deref()
        .map(trinity_kernel::vi::trim_js)
        .filter(|s| !s.is_empty());
    // `code_prefix` NULL ⇒ trigger DB tự sinh từ tên (duy nhất toàn hệ thống).
    let obj: CustomObject = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "INSERT INTO custom_objects (key, label, label_plural, icon, description, show_in_nav, nav_order, visible_role_ids, is_active, code_prefix, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING {OBJ_COLS}"
    )))
    .bind(&dto.key)
    .bind(trinity_kernel::vi::trim_js(&dto.label))
    .bind(trinity_kernel::vi::trim_js(&dto.label_plural))
    .bind(icon)
    .bind(description)
    .bind(dto.show_in_nav.unwrap_or(true))
    .bind(dto.nav_order.unwrap_or(max_order.unwrap_or(0) + 1))
    .bind(&roles)
    .bind(dto.is_active.unwrap_or(true))
    .bind(prefix)
    .bind(actor.user_id)
    .fetch_one(&mut *c)
    .await
    .map_err(|e| if is_unique(&e) { conflict(format!("Mã “{}” đã được dùng", dto.key)) } else { db(e) })?;
    tracing::info!("custom_object {} tạo bởi user {}", obj.key, actor.user_id);
    Ok(present_object(&obj, &[]))
}

/// `PATCH /custom-objects/:key`.
pub async fn update(ctx: &Ctx, actor: &Actor, key: &str, dto: &UpdateObject) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut c, actor, key, None).await?;
    let empty = |s: &Option<String>| s.as_deref().is_some_and(|s| trinity_kernel::vi::trim_js(s).is_empty());
    if empty(&dto.label) || empty(&dto.label_plural) {
        return Err(bad("Tên không được để trống"));
    }
    let icon = match &dto.icon {
        Patch::Keep => None,
        Patch::Clear => Some(None),
        Patch::Set(i) => Some(check_icon(Some(i))?),
    };
    let roles = match &dto.visible_role_ids {
        Some(r) => Some(check_role_ids(&mut c, Some(r)).await?),
        None => None,
    };
    drop(c);
    if let Some(p) = &dto.code_prefix {
        rename_prefix(ctx, actor.company, def.obj.id, p).await?;
    }
    let mut c = ctx.conn(actor.company).await?;
    let mut qb = QueryBuilder::<Postgres>::new("UPDATE custom_objects SET updated_at = now()");
    if let Some(l) = &dto.label {
        qb.push(", label = ")
            .push_bind(trinity_kernel::vi::trim_js(l).to_owned());
    }
    if let Some(l) = &dto.label_plural {
        qb.push(", label_plural = ")
            .push_bind(trinity_kernel::vi::trim_js(l).to_owned());
    }
    if let Some(i) = icon {
        qb.push(", icon = ").push_bind(i);
    }
    match &dto.description {
        Patch::Keep => {}
        Patch::Clear => {
            qb.push(", description = NULL");
        }
        Patch::Set(d) => {
            let t = trinity_kernel::vi::trim_js(d);
            qb.push(", description = ")
                .push_bind((!t.is_empty()).then(|| t.to_owned()));
        }
    }
    if let Some(v) = dto.show_in_nav {
        qb.push(", show_in_nav = ").push_bind(v);
    }
    if let Some(v) = dto.nav_order {
        qb.push(", nav_order = ").push_bind(v);
    }
    if let Some(v) = dto.is_active {
        qb.push(", is_active = ").push_bind(v);
    }
    if let Some(r) = roles {
        qb.push(", visible_role_ids = ").push_bind(r);
    }
    qb.push(" WHERE id = ")
        .push_bind(def.obj.id)
        .push(" RETURNING ")
        .push(OBJ_COLS);
    let obj: CustomObject = qb.build_query_as().fetch_one(&mut *c).await.map_err(db)?;
    tracing::info!("custom_object {key} sửa bởi user {}", actor.user_id);
    Ok(present_object(&obj, &def.fields))
}

/// `DELETE /custom-objects/:key`: xoá mềm; chặn nếu còn trường liên kết của bảng khác trỏ tới (tránh liên kết treo).
pub async fn remove(ctx: &Ctx, actor: &Actor, key: &str) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut c, actor, key, None).await?;
    let refs: Vec<(String, String)> = sqlx::query_as(
        "SELECT cf.label, co.label FROM custom_fields cf JOIN custom_objects co ON co.id = cf.object_id
         WHERE cf.deleted_at IS NULL AND cf.type = 'relation' AND cf.object_id <> $1 AND co.deleted_at IS NULL
           AND cf.options -> 'target_object_id' = to_jsonb($1::int) LIMIT 10",
    )
    .bind(def.obj.id)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    if !refs.is_empty() {
        let names: Vec<String> = refs.iter().map(|(f, o)| format!("{o} › {f}")).collect();
        return Err(conflict(format!(
            "Không xoá được: còn trường liên kết trỏ tới “{}” ({}). Hãy xoá/đổi các trường đó trước.",
            def.obj.label,
            names.join(", ")
        )));
    }
    sqlx::query("UPDATE custom_objects SET deleted_at = now(), updated_at = now() WHERE id = $1")
        .bind(def.obj.id)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    tracing::warn!("custom_object {key} xoá mềm bởi user {}", actor.user_id);
    Ok(json!({ "ok": true }))
}
