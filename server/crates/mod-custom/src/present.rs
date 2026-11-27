//! Dựng bản ghi để TRẢ RA API (chuyển từ `record-presenter.service.ts`): chỉ trường còn sống, che SĐT theo
//! `custom_records.phone_full` (một lần lấy phạm vi), tính công thức, và giải nhãn liên kết theo LÔ chỉ với bản ghi người
//! xem được (không rò tiêu đề).

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder, Row};
use trinity_kernel::formula::{Val, evaluate_formula, parse_formula};
use trinity_rbac::{OwnerIds, PhoneMasker, push_scope};

use crate::access::ObjectDef;
use crate::record_query::RawRow;
use crate::record_values::number_value;
use crate::refs::{Owners, Ref, RefAccess, RefView, parse_ref, resolve_refs};
use crate::types::FieldDef;
use crate::values::formula_input;
use crate::{Actor, Ctx, R, db};

/// Phạm vi xem cần để dựng bản ghi, lấy TRƯỚC khi giữ kết nối.
#[derive(Debug, Clone)]
pub struct Env {
    pub owners: Owners,
    pub phone: Option<OwnerIds>,
}

impl Env {
    pub async fn load(ctx: &Ctx, actor: &Actor) -> R<Self> {
        let phone = ctx
            .scopes
            .owner_ids(actor.company, actor.user_id, &actor.grants, "custom_records.phone_full")
            .await
            .map_err(trinity_kernel::error::AppError::internal)?;
        Ok(Self {
            owners: Owners::load(ctx, actor).await?,
            phone,
        })
    }
}

/// `idsOf`: một số hoặc mảng số.
pub fn ids_of(v: &Value) -> Vec<i64> {
    match v {
        Value::Number(n) => n.as_i64().into_iter().collect(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_i64().filter(|_| x.is_number())).collect(),
        _ => Vec::new(),
    }
}

/// Tính các trường công thức từ dữ liệu thô. Lỗi hoặc thiếu dữ liệu ⇒ `None` (không ném).
pub fn compute_formulas(fields: &[FieldDef], data: &Map<String, Value>) -> HashMap<String, Option<f64>> {
    let mut out = HashMap::new();
    for f in fields {
        if f.kind != "formula" {
            continue;
        }
        let Some(expr) = f
            .options
            .get("expression")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
        else {
            continue;
        };
        let v = parse_formula(expr).ok().and_then(|ast| {
            evaluate_formula(&ast, &|k| -> Option<Val> {
                let r = fields.iter().find(|x| x.key == k)?;
                formula_input(&r.kind, data.get(k))
            })
        });
        out.insert(f.key.clone(), v);
    }
    out
}

#[derive(Clone)]
struct Label {
    id: i64,
    title: Option<String>,
}

fn label_json(l: &Label) -> Value {
    json!({ "id": l.id, "title": l.title, "accessible": l.title.is_some() })
}

fn link_labels(v: &Value, links: &HashMap<String, RefView>) -> Value {
    let items = v
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).filter_map(parse_ref))
        .into_iter()
        .flatten();
    Value::Array(
        items
            .map(|r| match links.get(&r.key()) {
                Some(x) => json!({
                    "id": r.id, "type": r.ty.as_str(), "title": x.title, "accessible": true,
                    "code": x.code, "table": x.table, "href": x.href,
                }),
                None => json!({ "id": r.id, "type": r.ty.as_str(), "title": null, "accessible": false }),
            })
            .collect(),
    )
}

fn label_key(f: &FieldDef) -> String {
    if f.kind == "user" {
        "user".into()
    } else if f.options.get("target").and_then(Value::as_str) == Some("contact") {
        "contact".into()
    } else {
        format!(
            "obj{}",
            f.options.get("target_object_id").and_then(Value::as_i64).unwrap_or(0)
        )
    }
}

fn labels_for(f: &FieldDef, v: &Value, labels: &HashMap<(String, i64), Label>) -> Value {
    let kind = label_key(f);
    let one = |id: i64| label_json(labels.get(&(kind.clone(), id)).unwrap_or(&Label { id, title: None }));
    let ids = ids_of(v);
    if f.kind == "relation" && f.options.get("multiple").and_then(Value::as_bool) == Some(true) {
        Value::Array(ids.into_iter().map(one).collect())
    } else {
        one(ids.first().copied().unwrap_or(0))
    }
}

async fn owner_names(conn: &mut PgConnection, rows: &[RawRow]) -> R<HashMap<i32, String>> {
    let mut ids: Vec<i32> = rows.iter().filter_map(|r| r.owner_id).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let r: Vec<(i32, String)> = sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
        .bind(ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    Ok(r.into_iter()
        .map(|(id, n)| (id, if n.is_empty() { format!("Nhân viên #{id}") } else { n }))
        .collect())
}

/// Nhãn cho mọi tham chiếu relation/user trong `rows`, khoá (`obj<id>` | `contact` | `user`, id).
async fn resolve_labels(
    conn: &mut PgConnection,
    def: &ObjectDef,
    rows: &[RawRow],
    env: &Env,
    acc: Option<&RefAccess>,
) -> R<HashMap<(String, i64), Label>> {
    let mut objs: HashMap<i32, Vec<i64>> = HashMap::new();
    let (mut contacts, mut users): (Vec<i64>, Vec<i64>) = (Vec::new(), Vec::new());
    for f in &def.fields {
        if f.kind != "relation" && f.kind != "user" {
            continue;
        }
        for r in rows {
            let ids = r.data.get(&f.key).map(ids_of).unwrap_or_default();
            if f.kind == "user" {
                users.extend(ids);
            } else if f.options.get("target").and_then(Value::as_str) == Some("contact") {
                contacts.extend(ids);
            } else if let Some(t) = f
                .options
                .get("target_object_id")
                .and_then(Value::as_i64)
                .filter(|t| *t != 0)
                && let Ok(t) = i32::try_from(t)
            {
                objs.entry(t).or_default().extend(ids);
            }
        }
    }
    let mut out = HashMap::new();
    if let (Some(acc), Some(owners)) = (acc, &env.owners.record) {
        for (obj_id, ids) in &objs {
            let Some(target) = acc.objects.get(obj_id) else {
                continue;
            };
            let mut qb = QueryBuilder::<Postgres>::new("SELECT id, title FROM custom_records WHERE object_id = ");
            qb.push_bind(*obj_id)
                .push(" AND deleted_at IS NULL AND id = ANY(")
                .push_bind(ids.clone())
                .push("::int8[]) AND (");
            push_scope(&mut qb, owners, &["owner_id", "created_by"]);
            qb.push(")");
            for r in qb.build().fetch_all(&mut *conn).await.map_err(db)? {
                let id: i32 = r.try_get("id").map_err(db)?;
                let t: Option<String> = r.try_get("title").map_err(db)?;
                out.insert(
                    (format!("obj{obj_id}"), i64::from(id)),
                    Label {
                        id: i64::from(id),
                        title: Some(t.unwrap_or_else(|| format!("{} #{id}", target.label))),
                    },
                );
            }
        }
    }
    if let (false, Some(owners)) = (contacts.is_empty(), &env.owners.contact) {
        let mut qb =
            QueryBuilder::<Postgres>::new("SELECT id, full_name FROM contacts WHERE deleted_at IS NULL AND id = ANY(");
        qb.push_bind(contacts).push("::int8[]) AND (");
        push_scope(&mut qb, owners, &["assigned_to", "created_by_id"]);
        qb.push(")");
        for r in qb.build().fetch_all(&mut *conn).await.map_err(db)? {
            let id: i32 = r.try_get("id").map_err(db)?;
            let n: Option<String> = r.try_get("full_name").map_err(db)?;
            let title = n.filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Khách #{id}"));
            out.insert(
                ("contact".into(), i64::from(id)),
                Label {
                    id: i64::from(id),
                    title: Some(title),
                },
            );
        }
    }
    if !users.is_empty() {
        // Chỉ tên hiển thị, KHÔNG lùi về email (không lộ định danh của người ngoài phạm vi).
        let r: Vec<(i32, String)> = sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1::int8[])")
            .bind(users)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
        for (id, n) in r {
            let title = if n.is_empty() { format!("Nhân viên #{id}") } else { n };
            out.insert(
                ("user".into(), i64::from(id)),
                Label {
                    id: i64::from(id),
                    title: Some(title),
                },
            );
        }
    }
    Ok(out)
}

/// Dựng bản ghi để TRẢ RA API. `acc` nạp sẵn thì dùng lại, không thì tự nạp khi bảng có trường liên kết.
pub async fn present(
    conn: &mut PgConnection,
    actor: &Actor,
    def: &ObjectDef,
    rows: &[RawRow],
    env: &Env,
    acc: Option<&RefAccess>,
) -> R<Vec<Value>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let needs_acc = def
        .fields
        .iter()
        .any(|f| f.kind == "link" || (f.kind == "relation" && f.options.get("target_object_id").is_some()));
    let built;
    let acc = match (acc, needs_acc) {
        (Some(a), _) => Some(a),
        (None, true) => {
            built = RefAccess::build(conn, actor, env.owners.clone()).await?;
            Some(&built)
        }
        (None, false) => None,
    };
    let mask = PhoneMasker::new(env.phone.clone());
    let labels = resolve_labels(conn, def, rows, env, acc).await?;
    let owners = owner_names(conn, rows).await?;
    let link_keys: Vec<&str> = def
        .fields
        .iter()
        .filter(|f| f.kind == "link")
        .map(|f| f.key.as_str())
        .collect();
    let links = match acc {
        Some(a) if !link_keys.is_empty() => {
            let refs: Vec<Ref> = rows
                .iter()
                .flat_map(|r| link_keys.iter().filter_map(move |k| r.data.get(*k)))
                .filter_map(Value::as_array)
                .flat_map(|a| a.iter().filter_map(Value::as_str).filter_map(parse_ref))
                .collect();
            if refs.is_empty() {
                HashMap::new()
            } else {
                resolve_refs(conn, a, &refs).await?
            }
        }
        _ => HashMap::new(),
    };
    let empty = Map::new();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let raw = r.data.as_object().unwrap_or(&empty);
        let formulas = compute_formulas(&def.fields, raw);
        let (mut data, mut relations) = (Map::new(), Map::new());
        for f in &def.fields {
            if f.kind == "formula" {
                let v = formulas.get(&f.key).copied().flatten();
                data.insert(f.key.clone(), v.map_or(Value::Null, number_value));
                continue;
            }
            let Some(v) = raw.get(&f.key).filter(|v| !v.is_null()) else {
                continue;
            };
            let shown = match (f.kind.as_str(), v) {
                ("phone", Value::String(s)) => mask
                    .mask(&[r.owner_id, r.created_by], Some(s))
                    .map_or(Value::Null, Value::String),
                _ => v.clone(),
            };
            data.insert(f.key.clone(), shown);
            if f.kind == "relation" || f.kind == "user" {
                relations.insert(f.key.clone(), labels_for(f, v, &labels));
            }
            if f.kind == "link" {
                relations.insert(f.key.clone(), link_labels(v, &links));
            }
        }
        out.push(json!({
            "id": r.id,
            "code": r.code,
            "title": r.title.clone().unwrap_or_else(|| format!("{} #{}", def.obj.label, r.id)),
            "owner_id": r.owner_id,
            "owner_name": r.owner_id.and_then(|o| owners.get(&o)),
            "created_by": r.created_by,
            "created_at": r.created_at,
            "updated_at": r.updated_at,
            "data": data,
            "relations": relations,
        }));
    }
    Ok(out)
}
