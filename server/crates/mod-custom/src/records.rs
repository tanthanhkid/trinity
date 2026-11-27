//! Bản ghi tuỳ biến: kiểm dữ liệu, tạo, sửa, xoá mềm kèm outbox cùng giao dịch, danh sách, chi tiết, tra cứu, liên kết ngược
//! (chuyển từ `custom-records.service.ts`, `custom-records-list.service.ts`, `record-validator.service.ts`,
//! `record-events.ts`). Phạm vi theo `owner_id ∪ created_by`: ngoài phạm vi theo id ⇒ 404; SĐT che theo `custom_records.phone_full`.

use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{CustomField, CustomObject};
use trinity_db::outbox::publish_integration_event;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::json::js_json;
use trinity_rbac::{OwnerIds, assert_in_scope, can, push_scope};

use crate::access::{FIELD_COLS, OBJ_COLS, ObjectDef, is_object_visible, load_access, load_visible_object};
use crate::present::{Env, ids_of, present};
use crate::record_query::{ROW_COLS, RawRow, RowQuery, query_rows, read_row};
use crate::record_values::{is_empty_value, normalize_value};
use crate::refs::{Ref, RefAccess, RefType, linking_fields, resolve_tokens, sync_links, targets_for};
use crate::types::{FieldDef, Limits};
use crate::{Actor, Ctx, R, db, forbidden, not_found};

/// Khoá advisory tuần tự hoá ghi của bảng có trường "duy nhất".
const LOCK_NS: i32 = 7373;

const MSG_INVALID: &str = "Dữ liệu không hợp lệ";

fn invalid(errors: Map<String, Value>) -> AppError {
    HttpError::field_errors(MSG_INVALID, Value::Object(errors)).into()
}

/// `String.prototype.slice(0, n)` theo đơn vị UTF-16 (không cắt giữa ký tự).
fn js_slice(s: &str, n: usize) -> String {
    let mut used = 0;
    s.chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= n
        })
        .collect()
}

/// Tiêu đề cache từ trường tiêu đề (tối đa 200 ký tự); không có trường tiêu đề ⇒ `None`.
pub fn title_of(def: &ObjectDef, data: &Map<String, Value>) -> Option<String> {
    let f = def.fields.iter().find(|x| x.is_title)?;
    let v = data.get(&f.key).filter(|v| !v.is_null())?;
    let s = js_slice(
        trinity_kernel::vi::trim_js(&crate::refs::plain(v)),
        usize::try_from(Limits::MAX_TITLE).unwrap_or(200),
    );
    (!s.is_empty()).then_some(s)
}

/// `objectRef` của sự kiện outbox.
pub fn object_ref(def: &ObjectDef) -> Value {
    let o = &def.obj;
    json!({ "id": o.id, "key": o.key, "label": o.label, "is_active": o.is_active, "visible_role_ids": o.visible_role_ids.0 })
}

/// `recordSnapshot`: ảnh chụp THÔ cho outbox: chỉ trường sống, không công thức; SĐT liệt kê ở `phone_fields`.
pub fn record_snapshot(def: &ObjectDef, row: &RawRow) -> Value {
    let empty = Map::new();
    let raw = row.data.as_object().unwrap_or(&empty);
    let mut data = Map::new();
    for f in def.fields.iter().filter(|f| f.kind != "formula") {
        if let Some(v) = raw.get(&f.key) {
            data.insert(f.key.clone(), v.clone());
        }
    }
    let phones: Vec<&str> = def
        .fields
        .iter()
        .filter(|f| f.kind == "phone")
        .map(|f| f.key.as_str())
        .collect();
    json!({
        "id": row.id, "title": row.title, "owner_id": row.owner_id, "created_by": row.created_by, "data": data,
        "phone_fields": phones, "created_at": row.created_at, "updated_at": row.updated_at,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Kiểm dữ liệu

pub struct Validated {
    pub data: Map<String, Value>,
    /// Khoá trường có giá trị đổi so với bản cũ (để phát sự kiện + kiểm trùng).
    pub changed: Vec<String>,
}

/// Số id (không trùng) thật sự tồn tại VÀ người ghi được phép tham chiếu.
async fn count_accessible(
    conn: &mut PgConnection,
    actor: &Actor,
    acc: &RefAccess,
    f: &FieldDef,
    ids: &[i64],
) -> R<usize> {
    let owners = &acc.owners;
    let count = |mut qb: QueryBuilder<Postgres>| async move {
        qb.build_query_scalar::<i64>().fetch_one(&mut *conn).await.map_err(db)
    };
    let n = if f.kind == "user" {
        // Chỉ chọn được nhân viên TRONG phạm vi xem của người ghi (cùng nguồn với danh sách chọn), không dò thư mục theo id.
        let Some(o) = &owners.record else { return Ok(0) };
        let in_scope: Vec<i64> = match o {
            OwnerIds::All => ids.to_vec(),
            OwnerIds::Ids(list) => ids
                .iter()
                .copied()
                .filter(|i| *i == i64::from(actor.user_id) || list.iter().any(|l| i64::from(*l) == *i))
                .collect(),
        };
        let mut qb = QueryBuilder::<Postgres>::new(
            "SELECT count(*)::bigint FROM users WHERE status = 'active' AND deleted_at IS NULL AND id = ANY(",
        );
        qb.push_bind(in_scope).push("::int8[])");
        count(qb).await?
    } else if f.options.get("target").and_then(Value::as_str) == Some("contact") {
        let Some(o) = &owners.contact else { return Ok(0) };
        let mut qb = QueryBuilder::<Postgres>::new(
            "SELECT count(*)::bigint FROM contacts WHERE deleted_at IS NULL AND id = ANY(",
        );
        qb.push_bind(ids.to_vec()).push("::int8[]) AND (");
        push_scope(&mut qb, o, &["assigned_to", "created_by_id"]);
        qb.push(")");
        count(qb).await?
    } else {
        let target = f
            .options
            .get("target_object_id")
            .and_then(Value::as_i64)
            .and_then(|t| i32::try_from(t).ok());
        let (Some(t), Some(o)) = (target, &owners.record) else {
            return Ok(0);
        };
        if !acc.objects.contains_key(&t) {
            return Ok(0);
        }
        let mut qb = QueryBuilder::<Postgres>::new(
            "SELECT count(*)::bigint FROM custom_records WHERE deleted_at IS NULL AND object_id = ",
        );
        qb.push_bind(t)
            .push(" AND id = ANY(")
            .push_bind(ids.to_vec())
            .push("::int8[]) AND (");
        push_scope(&mut qb, o, &["owner_id", "created_by"]);
        qb.push(")");
        count(qb).await?
    };
    Ok(usize::try_from(n).unwrap_or(0))
}

/// Kiểm dữ liệu bản ghi theo định nghĩa trường (kiểu, bắt buộc, lựa chọn, liên kết tồn tại + TRONG PHẠM VI người ghi, kích thước)
/// và trả dữ liệu đã chuẩn hoá. Lỗi gom theo trường ⇒ 400 `{message, errors:{khoá: thông báo}}`.
pub async fn validate(
    conn: &mut PgConnection,
    actor: &Actor,
    acc: &RefAccess,
    def: &ObjectDef,
    input: &Map<String, Value>,
    existing: Option<&Map<String, Value>>,
) -> R<Validated> {
    let mut errors = Map::new();
    let mut merged = existing.cloned().unwrap_or_default();
    let mut changed: Vec<String> = Vec::new();
    for (key, raw) in input {
        let Some(f) = def.fields.iter().find(|f| f.key == *key) else {
            errors.insert(key.clone(), json!("Trường không tồn tại"));
            continue;
        };
        match normalize_value(f, raw) {
            Ok(v) => {
                let before = js_json(merged.get(key).unwrap_or(&Value::Null));
                let same = js_json(v.as_ref().unwrap_or(&Value::Null)) == before;
                match v {
                    None => {
                        merged.remove(key);
                    }
                    Some(v) => {
                        merged.insert(key.clone(), v);
                    }
                }
                if !same {
                    changed.push(key.clone());
                }
            }
            Err(e) => {
                errors.insert(key.clone(), json!(e.0));
            }
        }
    }
    for f in &def.fields {
        if f.required && f.kind != "formula" && is_empty_value(merged.get(&f.key)) && !errors.contains_key(&f.key) {
            errors.insert(f.key.clone(), json!(format!("“{}” là bắt buộc", f.label)));
        }
    }
    for f in &def.fields {
        if (f.kind != "relation" && f.kind != "user") || !changed.contains(&f.key) || errors.contains_key(&f.key) {
            continue;
        }
        let ids = merged.get(&f.key).map(ids_of).unwrap_or_default();
        if ids.is_empty() {
            continue;
        }
        if count_accessible(conn, actor, acc, f, &ids).await? != ids.len() {
            errors.insert(
                f.key.clone(),
                json!(format!(
                    "“{}”: có mục không tồn tại hoặc bạn không có quyền chọn",
                    f.label
                )),
            );
        }
    }
    check_links(conn, acc, def, &mut merged, &changed, &mut errors).await?;
    if js_json(&Value::Object(merged.clone())).len() > Limits::MAX_DATA_BYTES {
        errors.insert(
            "_data".into(),
            json!(format!(
                "Dữ liệu một bản ghi tối đa {} KB",
                Limits::MAX_DATA_BYTES / 1024
            )),
        );
    }
    if !errors.is_empty() {
        return Err(invalid(errors));
    }
    Ok(Validated { data: merged, changed })
}

/// Trường "Liên kết": mã/`loại:id` thành tham chiếu `loại:id` CHỈ khi người ghi thấy được bản ghi đích (không gắn được thứ mình
/// không xem, không dò được mã có tồn tại hay không: mọi lỗi chung một câu).
async fn check_links(
    conn: &mut PgConnection,
    acc: &RefAccess,
    def: &ObjectDef,
    data: &mut Map<String, Value>,
    changed: &[String],
    errors: &mut Map<String, Value>,
) -> R<()> {
    for f in def
        .fields
        .iter()
        .filter(|f| f.kind == "link" && changed.contains(&f.key))
    {
        if errors.contains_key(&f.key) {
            continue;
        }
        let Some(list) = data.get(&f.key).and_then(Value::as_array) else {
            continue;
        };
        let tokens: Vec<String> = list.iter().filter_map(Value::as_str).map(str::to_owned).collect();
        let (refs, missing) = resolve_tokens(conn, acc, &tokens).await?;
        if !missing.is_empty() {
            let shown = missing.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
            errors.insert(
                f.key.clone(),
                json!(format!(
                    "“{}”: không tìm thấy {shown} (hoặc bạn không có quyền xem)",
                    f.label
                )),
            );
        } else if refs.is_empty() {
            data.remove(&f.key);
        } else {
            data.insert(
                f.key.clone(),
                Value::Array(refs.iter().map(|r| json!(r.reference())).collect()),
            );
        }
    }
    Ok(())
}

/// Kiểm trùng cho trường "duy nhất": gọi TRONG giao dịch đã giữ khoá thực thể.
pub async fn assert_unique(
    conn: &mut PgConnection,
    def: &ObjectDef,
    data: &Map<String, Value>,
    changed: &[String],
    exclude_id: Option<i32>,
) -> R<()> {
    let mut errors = Map::new();
    for f in def.fields.iter().filter(|f| f.is_unique) {
        let Some(v) = data.get(&f.key).filter(|v| !v.is_null()) else {
            continue;
        };
        if exclude_id.is_some() && !changed.contains(&f.key) {
            continue;
        }
        let mut qb = QueryBuilder::<Postgres>::new("SELECT 1 FROM custom_records WHERE object_id = ");
        qb.push_bind(def.obj.id)
            .push(" AND deleted_at IS NULL AND id <> ")
            .push_bind(exclude_id.unwrap_or(0))
            .push(" AND ");
        match v {
            Value::String(s) => {
                qb.push("lower(data ->> ")
                    .push_bind(f.key.clone())
                    .push(") = ")
                    .push_bind(s.to_lowercase());
            }
            other => {
                qb.push("(data -> ")
                    .push_bind(f.key.clone())
                    .push(") = ")
                    .push_bind(js_json(other))
                    .push("::text::jsonb");
            }
        }
        qb.push(" LIMIT 1");
        let hit = qb.build().fetch_optional(&mut *conn).await.map_err(db)?;
        if hit.is_some() {
            errors.insert(
                f.key.clone(),
                json!(format!("“{}” đã tồn tại, không được trùng", f.label)),
            );
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(invalid(errors))
    }
}

/// Tuần tự hoá ghi của thực thể có trường "duy nhất" (hai yêu cầu song song không cùng lọt qua kiểm trùng).
async fn lock_if_unique(conn: &mut PgConnection, def: &ObjectDef) -> R<()> {
    if def.fields.iter().any(|f| f.is_unique) {
        sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
            .bind(LOCK_NS)
            .bind(def.obj.id)
            .execute(&mut *conn)
            .await
            .map_err(db)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Đọc

fn row_sql(tail: &str) -> sqlx::AssertSqlSafe<String> {
    sqlx::AssertSqlSafe(format!("SELECT {ROW_COLS} FROM custom_records {tail}"))
}

/// Hàng theo id (kể cả đã xoá mềm), 404 nếu không có.
pub async fn load_row(conn: &mut PgConnection, id: i32) -> R<RawRow> {
    let r = sqlx::query(row_sql("WHERE id = $1"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    r.as_ref()
        .map(read_row)
        .transpose()
        .map_err(db)?
        .ok_or_else(|| not_found("Không tìm thấy bản ghi"))
}

async fn find_row(conn: &mut PgConnection, def: &ObjectDef, id: i32) -> R<RawRow> {
    let r = sqlx::query(row_sql("WHERE id = $1 AND object_id = $2 AND deleted_at IS NULL"))
        .bind(id)
        .bind(def.obj.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    r.as_ref()
        .map(read_row)
        .transpose()
        .map_err(db)?
        .ok_or_else(|| not_found("Không tìm thấy bản ghi"))
}

fn in_scope(owners: Option<&OwnerIds>, row: &RawRow) -> R<()> {
    assert_in_scope(owners, &[row.owner_id, row.created_by]).map_err(|e| AppError::from(*e))
}

/// Id trong đường dẫn: lớn hơn `int4` không thể có trong DB ⇒ 404.
fn int4_id(id: i64) -> R<i32> {
    i32::try_from(id).map_err(|_| not_found("Không tìm thấy bản ghi"))
}

fn str_of<'a>(q: &'a Value, k: &str) -> Option<&'a str> {
    q.get(k).and_then(Value::as_str)
}

/// Trang n (từ 1) thành số dòng bỏ qua; `cursor` thắng `page`.
pub fn page_offset(cursor: Option<&str>, page: Option<i64>, limit: Option<i64>) -> i64 {
    match page {
        Some(p) if p >= 2 && cursor.is_none_or(str::is_empty) => {
            (p - 1).saturating_mul(limit.unwrap_or(Limits::DEFAULT_LIST_LIMIT))
        }
        _ => 0,
    }
}

/// Tham số danh sách đã kiểm (`ListCustomRecordsQueryDto`) thành truy vấn lõi.
pub fn row_query(q: &Value, with_total_default: bool) -> RowQuery {
    let cursor = str_of(q, "cursor").filter(|c| !c.is_empty()).map(str::to_owned);
    let page = q.get("page").and_then(Value::as_i64);
    let limit = q.get("limit").and_then(Value::as_i64);
    RowQuery {
        q: str_of(q, "q").map(str::to_owned),
        limit: limit.unwrap_or(Limits::DEFAULT_LIST_LIMIT),
        offset: page_offset(cursor.as_deref(), page, limit),
        with_total: with_total_default && (cursor.is_none() || page.is_some()),
        cursor,
        sort: str_of(q, "sort").map(str::to_owned),
        desc: str_of(q, "dir") != Some("asc"),
        filter: str_of(q, "filter").map(str::to_owned),
    }
}

/// `GET /custom-objects/:key/records`
pub async fn list(ctx: &Ctx, actor: &Actor, key: &str, q: &Value) -> R<Value> {
    let env = Env::load(ctx, actor).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut conn, actor, key, None).await?;
    let Some(owners) = env.owners.record.clone() else {
        return Ok(json!({ "items": [], "next_cursor": null, "total": 0 }));
    };
    let page = query_rows(&mut conn, &def, &[owners], &row_query(q, true)).await?;
    let items = present(&mut conn, actor, &def, &page.rows, &env, None).await?;
    Ok(json!({ "items": items, "next_cursor": page.next, "total": page.total }))
}

/// `GET /custom-objects/:key/records/:id`
pub async fn get_one(ctx: &Ctx, actor: &Actor, key: &str, id: i64) -> R<Value> {
    let env = Env::load(ctx, actor).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut conn, actor, key, None).await?;
    let row = find_row(&mut conn, &def, int4_id(id)?).await?;
    in_scope(env.owners.record.as_ref(), &row)?;
    Ok(present(&mut conn, actor, &def, &[row], &env, None).await?.remove(0))
}

/// `GET /custom-objects/:key/lookup`: combobox liên kết, chỉ bản ghi TRONG phạm vi xem, chỉ `{id, code, title}`.
pub async fn lookup(ctx: &Ctx, actor: &Actor, key: &str, q: &Value) -> R<Value> {
    let env = Env::load(ctx, actor).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut conn, actor, key, None).await?;
    let Some(owners) = &env.owners.record else {
        return Ok(json!([]));
    };
    let term = str_of(q, "q")
        .map(trinity_kernel::vi::trim_js)
        .filter(|t| !t.is_empty());
    let mut qb = QueryBuilder::<Postgres>::new("SELECT id, title, code FROM custom_records WHERE object_id = ");
    qb.push_bind(def.obj.id).push(" AND deleted_at IS NULL");
    if let Some(t) = term {
        // Thoát `\`, `%`, `_` (khác `contains` của Prisma vốn không thoát): ký tự đại diện trong ô tìm không khớp mọi thứ.
        qb.push(" AND (title ILIKE ")
            .push_bind(format!("%{}%", trinity_kernel::vi::escape_like(t)))
            .push(" ESCAPE '\\' OR code LIKE ")
            .push_bind(format!("{}%", trinity_kernel::vi::escape_like(&t.to_uppercase())))
            .push(" ESCAPE '\\')");
    }
    qb.push(" AND (");
    push_scope(&mut qb, owners, &["owner_id", "created_by"]);
    let take = q
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(Limits::LOOKUP_LIMIT)
        .min(50);
    qb.push(") ORDER BY id DESC LIMIT ").push_bind(take);
    let rows: Vec<(i32, Option<String>, Option<String>)> =
        qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, title, code)| json!({ "id": id, "code": code, "title": title.unwrap_or_else(|| format!("{} #{id}", def.obj.label)) }))
            .collect(),
    ))
}

/// `GET /custom-objects/:key/records/:id/related`: bản ghi của thực thể KHÁC đang trỏ tới bản ghi này, chỉ phần người xem được.
pub async fn related(ctx: &Ctx, actor: &Actor, key: &str, id: i64) -> R<Value> {
    let env = Env::load(ctx, actor).await?;
    let mut conn = ctx.conn(actor.company).await?;
    let def = load_visible_object(&mut conn, actor, key, None).await?;
    let id = int4_id(id)?;
    let row = find_row(&mut conn, &def, id).await?;
    in_scope(env.owners.record.as_ref(), &row)?;
    let access = load_access(&mut conn, actor).await?;
    let fields: Vec<CustomField> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FIELD_COLS} FROM custom_fields WHERE deleted_at IS NULL AND type = 'relation' \
         AND object_id IN (SELECT id FROM custom_objects WHERE deleted_at IS NULL) \
         AND options #> '{{target_object_id}}' = to_jsonb($1::int4) ORDER BY id ASC LIMIT $2"
    )))
    .bind(def.obj.id)
    .bind(Limits::MAX_RELATED_GROUPS)
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    let Some(owners) = &env.owners.record else {
        return Ok(json!([]));
    };
    let mut groups = Vec::new();
    for rf in &fields {
        let obj: Option<CustomObject> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {OBJ_COLS} FROM custom_objects WHERE id = $1"
        )))
        .bind(rf.object_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        let Some(obj) = obj.filter(|o| is_object_visible(o, &access)) else {
            continue;
        };
        let f = FieldDef::from_row(rf);
        let where_sql = |qb: &mut QueryBuilder<Postgres>| {
            qb.push(" WHERE object_id = ")
                .push_bind(rf.object_id)
                .push(" AND deleted_at IS NULL AND (");
            push_scope(qb, owners, &["owner_id", "created_by"]);
            qb.push(") AND ((data -> ")
                .push_bind(f.key.clone())
                .push(") @> ")
                .push_bind(id.to_string())
                .push("::text::jsonb)");
        };
        let mut qb = QueryBuilder::<Postgres>::new("SELECT id, code, title FROM custom_records");
        where_sql(&mut qb);
        qb.push(" ORDER BY id DESC LIMIT ").push_bind(Limits::RELATED_PER_GROUP);
        let items: Vec<(i32, Option<String>, Option<String>)> =
            qb.build_query_as().fetch_all(&mut *conn).await.map_err(db)?;
        let mut cq = QueryBuilder::<Postgres>::new("SELECT count(*)::bigint FROM custom_records");
        where_sql(&mut cq);
        let total: i64 = cq.build_query_scalar().fetch_one(&mut *conn).await.map_err(db)?;
        if total == 0 {
            continue;
        }
        groups.push(json!({
            "object": { "key": obj.key, "label_plural": obj.label_plural },
            "field": { "key": f.key, "label": f.label },
            "total": total,
            "items": items.into_iter().map(|(i, c, t)| json!({ "id": i, "code": c, "title": t.unwrap_or_else(|| format!("{} #{i}", obj.label)) })).collect::<Vec<_>>(),
        }));
    }
    Ok(Value::Array(groups))
}

// ---------------------------------------------------------------------------------------------------------------
// Ghi

/// Phản hồi sau khi ghi: bản ghi đầy đủ CHỈ khi nó nằm trong phạm vi XEM của người ghi (phạm vi sửa có thể rộng hơn); ngoài ra chỉ
/// trả `{id}` để PATCH không thành đường ĐỌC dữ liệu ngoài phạm vi.
async fn respond(ctx: &Ctx, actor: &Actor, def: &ObjectDef, env: &Env, id: i32) -> R<Value> {
    let mut conn = ctx.conn(actor.company).await?;
    let row = load_row(&mut conn, id).await?;
    let visible = env
        .owners
        .record
        .as_ref()
        .is_some_and(|o| o.contains_any(&[row.owner_id, row.created_by]));
    if visible {
        Ok(present(&mut conn, actor, def, &[row], env, None).await?.remove(0))
    } else {
        Ok(json!({ "id": row.id }))
    }
}

async fn owner_ids_of(ctx: &Ctx, actor: &Actor, perm: &str) -> R<Option<OwnerIds>> {
    ctx.scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, perm)
        .await
        .map_err(AppError::internal)
}

fn owner_error(msg: &str) -> AppError {
    let mut e = Map::new();
    e.insert("owner_id".into(), json!(msg));
    invalid(e)
}

/// Người phụ trách: mặc định = người ghi; người khác phải active và nằm trong phạm vi quyền sửa của người ghi.
async fn resolve_owner(
    conn: &mut PgConnection,
    actor: &Actor,
    manage: Option<&OwnerIds>,
    requested: Option<i64>,
) -> R<i32> {
    let Some(req) = requested.filter(|r| *r != i64::from(actor.user_id)) else {
        return Ok(actor.user_id);
    };
    let allowed = match manage {
        None => false,
        Some(OwnerIds::All) => true,
        Some(OwnerIds::Ids(ids)) => ids.iter().any(|i| i64::from(*i) == req),
    };
    if !allowed {
        return Err(owner_error("Không giao được cho người này (ngoài phạm vi của bạn)"));
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM users WHERE id = $1::int8 AND status = 'active' AND deleted_at IS NULL",
    )
    .bind(req)
    .fetch_one(&mut *conn)
    .await
    .map_err(db)?;
    if n == 0 {
        return Err(owner_error("Người phụ trách không tồn tại hoặc đã khoá"));
    }
    Ok(i32::try_from(req).unwrap_or(actor.user_id))
}

fn body_data(v: &Value) -> Map<String, Value> {
    v.get("data").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn body_owner(v: &Value) -> Option<i64> {
    v.get("owner_id").and_then(Value::as_i64)
}

/// `POST /custom-objects/:key/records`. Mọi nơi gọi (route, MCP, nhập Sheet, chương trình con) đi qua đây ⇒ kiểm quyền ghi ở tầng này.
pub async fn create(ctx: &Ctx, actor: &Actor, key: &str, body: &Value) -> R<Value> {
    if !can(&actor.grants, "custom_records.manage", None) {
        return Err(forbidden("Không đủ quyền tạo bản ghi tuỳ biến"));
    }
    let env = Env::load(ctx, actor).await?;
    let manage = owner_ids_of(ctx, actor, "custom_records.manage").await?;
    let (def, owner, v, targets) = {
        let mut conn = ctx.conn(actor.company).await?;
        let def = load_visible_object(&mut conn, actor, key, None).await?;
        let owner = resolve_owner(&mut conn, actor, manage.as_ref(), body_owner(body)).await?;
        let acc = RefAccess::build(&mut conn, actor, env.owners.clone()).await?;
        let v = validate(&mut conn, actor, &acc, &def, &body_data(body), None).await?;
        let targets = targets_for(&mut conn, &acc, &def, &v.data, None).await?;
        (def, owner, v, targets)
    };
    let mut tx = ctx.begin(actor.company).await?;
    lock_if_unique(&mut tx, &def).await?;
    assert_unique(&mut tx, &def, &v.data, &v.changed, None).await?;
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO custom_records (object_id, data, title, owner_id, created_by) VALUES ($1, $2::text::jsonb, $3, $4, $5) RETURNING {ROW_COLS}"
    )))
    .bind(def.obj.id)
    .bind(js_json(&Value::Object(v.data.clone())))
    .bind(title_of(&def, &v.data))
    .bind(owner)
    .bind(actor.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let row = read_row(&r).map_err(db)?;
    publish_integration_event(
        &mut tx,
        "custom_record.created",
        &json!({ "object": object_ref(&def), "record": record_snapshot(&def, &row) }),
        row.id,
        Some(actor.user_id),
    )
    .await
    .map_err(AppError::internal)?;
    sync_links(
        &mut tx,
        Ref {
            ty: RefType::Record,
            id: row.id,
        },
        &targets,
        Some(actor.user_id),
    )
    .await?;
    tx.commit().await.map_err(AppError::internal)?;
    respond(ctx, actor, &def, &env, row.id).await
}

/// `PATCH /custom-objects/:key/records/:id`: chỉ trường gửi lên đổi; `null` xoá giá trị.
pub async fn update(ctx: &Ctx, actor: &Actor, key: &str, id: i64, body: &Value) -> R<Value> {
    let env = Env::load(ctx, actor).await?;
    let manage = owner_ids_of(ctx, actor, "custom_records.manage").await?;
    let id = int4_id(id)?;
    let (def, acc, owner_wanted) = {
        let mut conn = ctx.conn(actor.company).await?;
        let def = load_visible_object(&mut conn, actor, key, None).await?;
        let pre = find_row(&mut conn, &def, id).await?;
        in_scope(manage.as_ref(), &pre)?;
        let wanted = match body_owner(body) {
            Some(o) if Some(o) != pre.owner_id.map(i64::from) => {
                Some(resolve_owner(&mut conn, actor, manage.as_ref(), Some(o)).await?)
            }
            _ => None,
        };
        let acc = RefAccess::build(&mut conn, actor, env.owners.clone()).await?;
        (def, acc, wanted)
    };
    let mut tx = ctx.begin(actor.company).await?;
    // Khoá DÒNG rồi mới đọc-gộp-kiểm: hai PATCH song song (khác trường) không ghi đè nhau (lost update).
    let locked =
        sqlx::query("SELECT id FROM custom_records WHERE id = $1 AND object_id = $2 AND deleted_at IS NULL FOR UPDATE")
            .bind(id)
            .bind(def.obj.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    if locked.is_none() {
        return Err(not_found("Không tìm thấy bản ghi"));
    }
    let cur = load_row(&mut tx, id).await?;
    let owner = owner_wanted.or(cur.owner_id);
    let empty = Map::new();
    let v = validate(
        &mut tx,
        actor,
        &acc,
        &def,
        &body_data(body),
        Some(cur.data.as_object().unwrap_or(&empty)),
    )
    .await?;
    lock_if_unique(&mut tx, &def).await?;
    assert_unique(&mut tx, &def, &v.data, &v.changed, Some(id)).await?;
    let r = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE custom_records SET data = $2::text::jsonb, title = $3, owner_id = $4, updated_at = now() WHERE id = $1 RETURNING {ROW_COLS}"
    )))
    .bind(id)
    .bind(js_json(&Value::Object(v.data.clone())))
    .bind(title_of(&def, &v.data))
    .bind(owner)
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let row = read_row(&r).map_err(db)?;
    let mut changed = v.changed.clone();
    if owner != cur.owner_id {
        changed.push("owner_id".into());
    }
    let link_keys: Vec<String> = linking_fields(&def)
        .iter()
        .map(|f| f.key.clone())
        .filter(|k| v.changed.contains(k))
        .collect();
    if !link_keys.is_empty() {
        let targets = targets_for(&mut tx, &acc, &def, &v.data, Some(&link_keys)).await?;
        sync_links(
            &mut tx,
            Ref {
                ty: RefType::Record,
                id,
            },
            &targets,
            Some(actor.user_id),
        )
        .await?;
    }
    publish_integration_event(
        &mut tx,
        "custom_record.updated",
        &json!({ "object": object_ref(&def), "record": record_snapshot(&def, &row), "changed_fields": changed }),
        id,
        Some(actor.user_id),
    )
    .await
    .map_err(AppError::internal)?;
    tx.commit().await.map_err(AppError::internal)?;
    respond(ctx, actor, &def, &env, id).await
}

/// `DELETE /custom-objects/:key/records/:id`: xoá mềm.
pub async fn remove(ctx: &Ctx, actor: &Actor, key: &str, id: i64) -> R<Value> {
    let delete = owner_ids_of(ctx, actor, "custom_records.delete").await?;
    let id = int4_id(id)?;
    let (def, cur) = {
        let mut conn = ctx.conn(actor.company).await?;
        let def = load_visible_object(&mut conn, actor, key, None).await?;
        let cur = find_row(&mut conn, &def, id).await?;
        in_scope(delete.as_ref(), &cur)?;
        (def, cur)
    };
    let mut tx = ctx.begin(actor.company).await?;
    sqlx::query("UPDATE custom_records SET deleted_at = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    publish_integration_event(
        &mut tx,
        "custom_record.deleted",
        &json!({ "object": object_ref(&def), "record": record_snapshot(&def, &cur) }),
        id,
        Some(actor.user_id),
    )
    .await
    .map_err(AppError::internal)?;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(json!({ "ok": true }))
}
