//! Báo cáo dùng chung (`reports/custom/custom-reports.service.ts`): đọc/ghi định nghĩa (chỉ quản trị viên) và chạy số liệu theo
//! phạm vi quyền người xem. Xem: ai đăng nhập cũng gọi được, nhưng chỉ thấy báo cáo của bảng mình có quyền xem và số liệu theo phạm
//! vi quyền đó. Cấu hình: `custom_objects.manage`.

use chrono::{DateTime, Utc};
use mod_custom::access::{ObjectAccess, load_access, load_visible_object};
use serde_json::{Value, json};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{OwnerIds, can};

use crate::custom_def::{
    DefError, MAX_GROUPS, MAX_MONTHS, MAX_REPORTS, Period, REPORT_DEFS_KEY, ReportDef, normalize_defs, parse_period,
};
use crate::custom_presets::{PRESETS, resolve_report};
use crate::custom_sources::{Field, Labels, Role, Spec, core_sources, custom_source, find_field};
use crate::customers::split_owner;
use crate::period::num;
use crate::{Actor, Ctx, R, db, now};

/// Khoá tư vấn của `save`/`install_preset`: đọc-sửa-ghi danh sách định nghĩa không ghi đè nhau.
const LOCK_NS: i32 = 7380;

fn not_found(m: &str) -> AppError {
    HttpError::not_found(m).into()
}

fn bad(m: impl Into<String>) -> AppError {
    HttpError::bad_request(m.into()).into()
}

fn mc_actor(a: &Actor) -> mod_custom::Actor {
    mod_custom::Actor {
        user_id: a.user_id,
        company: a.company,
        grants: a.grants.clone(),
        is_admin: a.is_admin,
    }
}

pub fn can_manage(a: &Actor) -> bool {
    a.is_admin || can(&a.grants, "custom_objects.manage", None)
}

/// Toàn bộ định nghĩa đã lưu; vắng hoặc hỏng ⇒ rỗng.
pub async fn read_defs(c: &mut PgConnection) -> R<Vec<ReportDef>> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
        .bind(REPORT_DEFS_KEY)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?;
    Ok(raw
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| normalize_defs(&v).ok())
        .unwrap_or_default())
}

async fn write_defs(c: &mut PgConnection, defs: &[ReportDef], user: i32) -> R<()> {
    let value = Value::Array(defs.iter().map(ReportDef::to_json).collect()).to_string();
    sqlx::query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(REPORT_DEFS_KEY)
    .bind(value)
    .bind(user)
    .execute(&mut *c)
    .await
    .map_err(db)?;
    Ok(())
}

async fn lock(c: &mut PgConnection) -> R<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, 1)")
        .bind(LOCK_NS)
        .execute(&mut *c)
        .await
        .map_err(db)?;
    Ok(())
}

/// Bảng nguồn theo khoá: bảng lõi, hoặc `x:<khoá>` nếu người xem thấy bảng đó (không thì 404).
async fn resolve_source(c: &mut PgConnection, a: &Actor, source: &str, acc: Option<&ObjectAccess>) -> R<Spec> {
    if let Some(core) = core_sources().into_iter().find(|s| s.source == source) {
        return Ok(core);
    }
    let Some(key) = source.strip_prefix("x:") else {
        return Err(not_found("Không tìm thấy bảng nguồn"));
    };
    Ok(custom_source(&load_visible_object(c, &mc_actor(a), key, acc).await?))
}

async fn first_source(c: &mut PgConnection, a: &Actor, sources: &[&str], acc: &ObjectAccess) -> Option<Spec> {
    for s in sources {
        if let Ok(spec) = resolve_source(c, a, s, Some(acc)).await {
            return Some(spec);
        }
    }
    None
}

/// Đối chiếu khoá trường trong định nghĩa với danh mục của bảng nguồn (sai ⇒ 400).
fn fields_of<'a>(spec: &'a Spec, d: &ReportDef) -> R<(&'a Field, Vec<&'a Field>, Option<&'a Field>)> {
    let date = find_field(spec, &d.date_field, Role::Date).ok_or_else(|| {
        bad(format!(
            "“{}”: “{}” không phải trường ngày của {}",
            d.name, d.date_field, spec.label
        ))
    })?;
    let mut sums = Vec::new();
    for k in &d.sum_fields {
        sums.push(
            find_field(spec, k, Role::Number)
                .ok_or_else(|| bad(format!("“{}”: “{k}” không phải cột số của {}", d.name, spec.label)))?,
        );
    }
    let group = match &d.group_by {
        Some(g) => Some(
            find_field(spec, g, Role::Group).ok_or_else(|| bad(format!("“{}”: không nhóm được theo “{g}”", d.name)))?,
        ),
        None => None,
    };
    Ok((date, sums, group))
}

/// `GET /reports/custom`: báo cáo người xem mở được (bảng nguồn họ được xem) + có quyền cấu hình không.
pub async fn list(ctx: &Ctx, a: &Actor) -> R<Value> {
    // Tập chủ sở hữu lấy TRƯỚC khi giữ kết nối (không giữ conn rồi xin conn thứ hai).
    let mut allowed: Vec<(&str, bool)> = Vec::new();
    for perm in ["contacts.view", "deals.view", "custom_records.view"] {
        allowed.push((perm, ctx.owner_ids(a, perm).await?.is_some()));
    }
    let mut c = ctx.conn(a.company).await?;
    let defs = read_defs(&mut c).await?;
    let acc = load_access(&mut c, &mc_actor(a)).await?;
    let mut out = Vec::new();
    for d in &defs {
        let Ok(spec) = resolve_source(&mut c, a, &d.source, Some(&acc)).await else {
            continue;
        };
        if allowed.iter().any(|(p, ok)| *p == spec.scope_perm && *ok) {
            let mut j = d.to_json();
            if let Some(o) = j.as_object_mut() {
                o.insert("source_label".into(), json!(spec.label));
            }
            out.push(j);
        }
    }
    Ok(json!({ "reports": out, "can_manage": can_manage(a) }))
}

/// `GET /reports/custom/sources`: danh mục bảng + trường cho màn cấu hình.
pub async fn sources(ctx: &Ctx, a: &Actor) -> R<Value> {
    let mut c = ctx.conn(a.company).await?;
    let acc = load_access(&mut c, &mc_actor(a)).await?;
    let keys: Vec<String> =
        sqlx::query_scalar("SELECT key FROM custom_objects WHERE deleted_at IS NULL ORDER BY id ASC")
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
    let mut specs = core_sources();
    for k in keys {
        if let Ok(s) = resolve_source(&mut c, a, &format!("x:{k}"), Some(&acc)).await {
            specs.push(s);
        }
    }
    Ok(Value::Array(
        specs
            .iter()
            .map(|s| {
                json!({
                    "source": s.source, "label": s.label,
                    "fields": s.fields.iter().map(|f| json!({ "key": f.key, "label": f.label, "role": f.role.as_str() })).collect::<Vec<_>>(),
                })
            })
            .collect(),
    ))
}

/// `GET /reports/custom/definitions`.
pub async fn definitions(ctx: &Ctx, a: &Actor) -> R<Value> {
    let mut c = ctx.conn(a.company).await?;
    Ok(json!({ "reports": read_defs(&mut c).await?.iter().map(ReportDef::to_json).collect::<Vec<_>>() }))
}

/// `PUT /reports/custom`: lưu toàn bộ danh sách (thay thế).
pub async fn save(ctx: &Ctx, a: &Actor, raw: &Value) -> R<Value> {
    let defs = normalize_defs(raw).map_err(|DefError(m)| bad(m))?;
    let mut tx = ctx.begin(a.company).await?;
    lock(&mut tx).await?;
    let acc = load_access(&mut tx, &mc_actor(a)).await?;
    for d in &defs {
        let spec = resolve_source(&mut tx, a, &d.source, Some(&acc))
            .await
            .ok()
            .ok_or_else(|| bad(format!("“{}”: không có bảng nguồn {}", d.name, d.source)))?;
        fields_of(&spec, d)?;
    }
    write_defs(&mut tx, &defs, a.user_id).await?;
    tx.commit().await.map_err(AppError::internal)?;
    Ok(json!({ "reports": defs.iter().map(ReportDef::to_json).collect::<Vec<_>>() }))
}

/// `GET /reports/custom/presets`: bộ mẫu + từng báo cáo cài được không (bảng có chưa) / đã có chưa (trùng mã).
pub async fn presets(ctx: &Ctx, a: &Actor) -> R<Value> {
    let mut c = ctx.conn(a.company).await?;
    let have: Vec<String> = read_defs(&mut c).await?.into_iter().map(|d| d.id).collect();
    let acc = load_access(&mut c, &mc_actor(a)).await?;
    let mut out = Vec::new();
    for p in PRESETS {
        let mut reports = Vec::new();
        for r in p.reports {
            let spec = first_source(&mut c, a, r.sources, &acc).await;
            let installed = have.iter().any(|h| h == r.id);
            reports.push(json!({ "id": r.id, "name": r.name, "source_label": spec.as_ref().map(|s| s.label.clone()), "installed": installed, "installable": spec.is_some() && !installed }));
        }
        out.push(json!({ "key": p.key, "name": p.name, "description": p.description, "reports": reports }));
    }
    Ok(Value::Array(out))
}

/// `POST /reports/custom/presets/:key/install`: thêm báo cáo có bảng nguồn và chưa trùng mã; không ghi đè báo cáo đã có.
pub async fn install_preset(ctx: &Ctx, a: &Actor, key: &str) -> R<Value> {
    let preset = PRESETS
        .iter()
        .find(|p| p.key == key)
        .ok_or_else(|| not_found("Không có bộ mẫu này"))?;
    let mut tx = ctx.begin(a.company).await?;
    lock(&mut tx).await?;
    let mut defs = read_defs(&mut tx).await?;
    let mut have: Vec<String> = defs.iter().map(|d| d.id.clone()).collect();
    let acc = load_access(&mut tx, &mc_actor(a)).await?;
    let mut installed: Vec<&str> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for r in preset.reports {
        if have.iter().any(|h| h == r.id) {
            skipped.push(json!({ "id": r.id, "reason": "đã có" }));
            continue;
        }
        let Some(spec) = first_source(&mut tx, a, r.sources, &acc).await else {
            skipped.push(json!({ "id": r.id, "reason": "chưa có bảng" }));
            continue;
        };
        if defs.len() >= MAX_REPORTS {
            skipped.push(json!({ "id": r.id, "reason": "đủ số báo cáo tối đa" }));
            continue;
        }
        defs.push(resolve_report(r, preset.key, &spec.source, |k, role| {
            find_field(&spec, k, role).is_some()
        }));
        have.push(r.id.to_owned());
        installed.push(r.id);
    }
    if !installed.is_empty() {
        write_defs(&mut tx, &defs, a.user_id).await?;
    }
    tx.commit().await.map_err(AppError::internal)?;
    Ok(json!({ "installed": installed, "skipped": skipped }))
}

#[derive(Debug)]
enum Bind {
    Ints(Vec<i32>),
    Text(String),
}

async fn run_rows(c: &mut PgConnection, binds: &[Bind], sql: String) -> R<Vec<PgRow>> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for b in binds {
        q = match b {
            Bind::Ints(v) => q.bind(v.clone()),
            Bind::Text(t) => q.bind(t.clone()),
        };
    }
    q.fetch_all(&mut *c).await.map_err(db)
}

struct Nums {
    count: i64,
    sums: Vec<f64>,
}

fn nums_json(sums: &[&Field], n: &Nums) -> (Value, Value) {
    let m: serde_json::Map<String, Value> = sums
        .iter()
        .zip(&n.sums)
        .map(|(f, v)| (f.key.clone(), num(*v)))
        .collect();
    (json!(n.count), Value::Object(m))
}

struct Agg {
    total: Nums,
    missing: i64,
    groups: Vec<(Option<String>, Nums)>,
    months: Vec<(String, Nums)>,
}

async fn aggregate(
    c: &mut PgConnection,
    spec: &Spec,
    owners: &OwnerIds,
    period: &Period,
    date: &Field,
    sums: &[&Field],
    group: Option<&Field>,
) -> R<Agg> {
    let mut binds: Vec<Bind> = Vec::new();
    let scope = match split_owner(owners) {
        (true, _) => "TRUE".to_owned(),
        (false, ids) => {
            binds.push(Bind::Ints(ids));
            let n = binds.len();
            format!(
                "({})",
                spec.owner_cols
                    .iter()
                    .map(|col| format!("{col} = ANY(${n}::int[])"))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            )
        }
    };
    let d = format!("({})", date.expr);
    let in_period = match period {
        Period::All => "TRUE".to_owned(),
        Period::Range { from, to, .. } => {
            binds.push(Bind::Text(from.clone()));
            let a = binds.len();
            binds.push(Bind::Text(to.clone()));
            let b = binds.len();
            format!("{d} >= ${a}::text::date AND {d} < ${b}::text::date")
        }
    };
    let filter = format!("{} AND {scope} AND {in_period}", spec.base);
    let sum_cols: String = sums
        .iter()
        .enumerate()
        .map(|(i, s)| format!(", COALESCE(sum({}), 0)::float8 AS s{i}", s.expr))
        .collect();
    let table = spec.table;
    let read = |r: &PgRow| -> Result<Nums, sqlx::Error> {
        let mut v = Vec::new();
        for i in 0..sums.len() {
            v.push(r.try_get::<Option<f64>, _>(format!("s{i}").as_str())?.unwrap_or(0.0));
        }
        Ok(Nums {
            count: i64::from(r.try_get::<i32, _>("n")?),
            sums: v,
        })
    };
    let total_rows = run_rows(&mut *c, &binds, format!("SELECT count(*)::int AS n, count(*) FILTER (WHERE {d} IS NULL)::int AS missing{sum_cols} FROM {table} WHERE {filter}")).await?;
    let t = total_rows
        .first()
        .ok_or_else(|| AppError::internal("thiếu dòng tổng"))?;
    let total = read(t).map_err(db)?;
    let missing = i64::from(t.try_get::<i32, _>("missing").map_err(db)?);
    let mut groups = Vec::new();
    if let Some(g) = group {
        let rows = run_rows(&mut *c, &binds, format!(
            "SELECT ({}) AS k, count(*)::int AS n{sum_cols} FROM {table} WHERE {filter} GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT {MAX_GROUPS}",
            g.expr
        ))
        .await?;
        for r in &rows {
            groups.push((r.try_get::<Option<String>, _>("k").map_err(db)?, read(r).map_err(db)?));
        }
    }
    let rows = run_rows(&mut *c, &binds, format!(
        "SELECT to_char({d}, 'YYYY-MM') AS m, count(*)::int AS n{sum_cols} FROM {table} WHERE {filter} AND {d} IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT {MAX_MONTHS}"
    ))
    .await?;
    let mut months = Vec::new();
    for r in rows.iter().rev() {
        months.push((r.try_get::<String, _>("m").map_err(db)?, read(r).map_err(db)?));
    }
    Ok(Agg {
        total,
        missing,
        groups,
        months,
    })
}

/// Mã nhóm → nhãn (lựa chọn, người dùng, tuỳ chọn hệ thống, khách, bản ghi liên kết). Không có ⇒ "(Trống)". Khách / bản ghi liên
/// kết NGOÀI phạm vi xem của người xem chỉ hiện mã `#id` (như ô liên kết ở danh sách).
async fn label_groups(
    c: &mut PgConnection,
    group: &Field,
    rows: &[(Option<String>, Nums)],
    sums: &[&Field],
    contact_owner: Option<&OwnerIds>,
    record_owner: Option<&OwnerIds>,
) -> R<Vec<Value>> {
    let ids: Vec<i32> = rows
        .iter()
        .filter_map(|(k, _)| k.as_deref())
        .filter_map(|k| k.trim().parse::<f64>().ok())
        .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= f64::from(i32::MAX))
        .map(|n| n as i32)
        .collect();
    let labels = group.labels.clone().unwrap_or(Labels::Raw);
    let mut names: std::collections::BTreeMap<String, String> = Default::default();
    let id_map = |rows: Vec<(i32, Option<String>)>| -> std::collections::BTreeMap<String, String> {
        rows.into_iter()
            .map(|(id, n)| (id.to_string(), n.unwrap_or_else(|| format!("#{id}"))))
            .collect()
    };
    match &labels {
        Labels::Map(pairs) => names = pairs.iter().cloned().collect(),
        _ if ids.is_empty() => {}
        Labels::User => {
            names = id_map(
                sqlx::query_as("SELECT id, full_name FROM users WHERE id = ANY($1)")
                    .bind(&ids)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(db)?,
            );
        }
        Labels::Option => {
            names = id_map(
                sqlx::query_as("SELECT id, label FROM setting_options WHERE id = ANY($1)")
                    .bind(&ids)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(db)?,
            );
        }
        Labels::Contact => {
            if let Some(o) = contact_owner {
                let (all, owners) = split_owner(o);
                names = id_map(
                    sqlx::query_as(
                        "SELECT id, full_name FROM contacts WHERE id = ANY($1) AND deleted_at IS NULL AND ($2 OR assigned_to = ANY($3) OR created_by_id = ANY($3))",
                    )
                    .bind(&ids)
                    .bind(all)
                    .bind(&owners)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(db)?,
                );
            }
        }
        Labels::Record(object_id) => {
            if let Some(o) = record_owner {
                let (all, owners) = split_owner(o);
                names = id_map(
                    sqlx::query_as(
                        "SELECT id, title FROM custom_records WHERE id = ANY($1) AND object_id = $4 AND deleted_at IS NULL AND ($2 OR owner_id = ANY($3) OR created_by = ANY($3))",
                    )
                    .bind(&ids)
                    .bind(all)
                    .bind(&owners)
                    .bind(object_id)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(db)?,
                );
            }
        }
        Labels::Raw => {}
    }
    let raw_fallback = matches!(labels, Labels::Map(_) | Labels::Raw);
    Ok(rows
        .iter()
        .map(|(k, n)| {
            let label = match k.as_deref() {
                None | Some("") => "(Trống)".to_owned(),
                Some(k) => names
                    .get(k)
                    .cloned()
                    .unwrap_or_else(|| if raw_fallback { k.to_owned() } else { format!("#{k}") }),
            };
            let (count, s) = nums_json(sums, n);
            json!({ "key": k, "count": count, "sums": s, "label": label })
        })
        .collect())
}

/// `GET /reports/custom/:id?period=`: số bản ghi, tổng các cột số, theo nhóm, theo tháng.
pub async fn run(ctx: &Ctx, a: &Actor, id: &str, period_raw: Option<&str>) -> R<Value> {
    run_at(ctx, a, id, period_raw, now()).await
}

pub async fn run_at(ctx: &Ctx, a: &Actor, id: &str, period_raw: Option<&str>, at: DateTime<Utc>) -> R<Value> {
    let (def, spec) = {
        let mut c = ctx.conn(a.company).await?;
        let def = read_defs(&mut c)
            .await?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| not_found("Không tìm thấy báo cáo"))?;
        let spec = resolve_source(&mut c, a, &def.source, None).await?;
        (def, spec)
    };
    let owners = ctx
        .owner_ids(a, spec.scope_perm)
        .await?
        .ok_or_else(|| not_found("Không tìm thấy báo cáo"))?;
    let period = parse_period(period_raw, at);
    let (date, sums, group) = fields_of(&spec, &def)?;
    let (contact_owner, record_owner) = match group.and_then(|g| g.labels.as_ref()) {
        Some(Labels::Contact) => (ctx.owner_ids(a, "contacts.view").await?, None),
        Some(Labels::Record(_)) => (None, ctx.owner_ids(a, "custom_records.view").await?),
        _ => (None, None),
    };
    let mut c = ctx.conn(a.company).await?;
    let agg = aggregate(&mut c, &spec, &owners, &period, date, &sums, group).await?;
    let groups = match group {
        Some(g) => {
            label_groups(
                &mut c,
                g,
                &agg.groups,
                &sums,
                contact_owner.as_ref(),
                record_owner.as_ref(),
            )
            .await?
        }
        None => Vec::new(),
    };
    let (count, sums_json) = nums_json(&sums, &agg.total);
    let by_month: Vec<Value> = agg
        .months
        .iter()
        .map(|(m, n)| {
            let (count, s) = nums_json(&sums, n);
            json!({ "month": m, "count": count, "sums": s })
        })
        .collect();
    let (value, label) = match &period {
        Period::All => ("all".to_owned(), "Tất cả".to_owned()),
        Period::Range { label, .. } => (
            period_raw
                .filter(|r| !r.is_empty())
                .map_or_else(|| "this_month".to_owned(), str::to_owned),
            label.clone(),
        ),
    };
    Ok(json!({
        "report": def.to_json(),
        "period": { "value": value, "label": label },
        "count": count, "sums": sums_json, "missing_date": agg.missing,
        "groups": groups, "by_month": by_month,
        "fields": {
            "date": date.label,
            "sums": sums.iter().map(|s| json!({ "key": s.key, "label": s.label })).collect::<Vec<_>>(),
            "group": group.map(|g| g.label.clone()),
        },
    }))
}
