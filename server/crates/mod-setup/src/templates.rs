//! Mẫu bảng dựng sẵn (`custom-object-templates.service.ts`): `GET /custom-objects/templates` và
//! `POST /custom-objects/templates/:template/apply`. Áp mẫu tạo các thực thể + trường + liên kết trong MỘT giao dịch có khoá để
//! hai lần bấm song song không nhân đôi. IDEMPOTENT theo `key`: thực thể đã có (kể cả do người dùng tự tạo) được GIỮ NGUYÊN và báo
//! ở `existing`; dữ liệu mẫu (GIẢ) chỉ sinh cho thực thể MỚI tạo ở lần gọi này.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{Datelike, Duration, NaiveDate, Utc};
use mod_custom::types::{FieldDef, Limits};
use mod_custom::values::normalize_options;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::pg_error::db_error;
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_kernel::vn_time::vn_date;
use trinity_rbac::can;

use crate::catalog::{Sample, TField, TObject, Template, catalog, find_template};
use crate::sample_value::{self, Field};
use crate::samples::{self, SampleIds};
use crate::{Actor, Ctx, R, bad, db};

const LOCK_NS: i32 = 7374;

/// Kết quả áp mẫu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub created: Vec<String>,
    pub existing: Vec<String>,
    pub sample_records: usize,
}

impl Applied {
    pub fn to_json(&self) -> Value {
        json!({ "created": self.created, "existing": self.existing, "sample_records": self.sample_records })
    }
}

/// Tuỳ chọn khi DỰNG HỆ THỐNG từ wizard: chỉ sinh mẫu cho `sample_objects` thực thể đầu của mẫu và ghi id vào danh sách mẫu để
/// tự xoá khi có bản ghi thật đầu tiên.
#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    pub sample_objects: Option<usize>,
    pub track_samples: bool,
}

/// `GET /custom-objects/templates`.
pub async fn list(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let keys: Vec<String> = sqlx::query_scalar("SELECT key FROM custom_objects WHERE deleted_at IS NULL")
        .fetch_all(&mut *c)
        .await
        .map_err(db)?;
    let have: BTreeSet<&str> = keys.iter().map(String::as_str).collect();
    let out: Vec<Value> = catalog()
        .templates
        .iter()
        .map(|t| {
            json!({
                "key": t.key, "label": t.label, "description": t.description,
                "objects": t.objects.iter().map(|o| json!({ "key": o.key, "label": o.label_plural, "applied": have.contains(o.key.as_str()) })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(Value::Array(out))
}

/// `POST /custom-objects/templates/:template/apply`.
pub async fn apply(ctx: &Ctx, actor: &Actor, template: &str, with_sample_data: bool) -> R<Value> {
    let tpl = find_template(template).ok_or_else(|| AppError::from(HttpError::not_found("Không tìm thấy mẫu này")))?;
    if with_sample_data && !can(&actor.grants, "custom_records.manage", None) {
        return Err(
            HttpError::forbidden("Tạo dữ liệu mẫu cần thêm quyền “Thêm/sửa dữ liệu của tính năng tuỳ biến”").into(),
        );
    }
    for o in &tpl.objects {
        assert_template_valid(o)?;
    }
    let mut tx = ctx.begin(actor.company).await?;
    let r = apply_in_tx(&mut tx, actor, tpl, with_sample_data, Options::default()).await?;
    tx.commit().await.map_err(AppError::internal)?;
    tracing::info!(
        "template {template} áp bởi user {}: tạo {:?} giữ {:?} mẫu {}",
        actor.user_id,
        r.created,
        r.existing,
        r.sample_records
    );
    Ok(r.to_json())
}

/// Kiểm mẫu hợp lệ TRƯỚC khi ghi: đúng 1 tiêu đề, công thức qua parser hệ thống (không tham chiếu trường lạ / công thức khác).
pub fn assert_template_valid(o: &TObject) -> R<()> {
    if o.fields.iter().filter(|f| f.is_title).count() != 1 {
        return Err(bad(format!("Mẫu lỗi: “{}” phải có đúng 1 trường tiêu đề", o.key)));
    }
    let defs: Vec<FieldDef> = o
        .fields
        .iter()
        .enumerate()
        .map(|(i, f)| FieldDef {
            id: i32::try_from(i + 1).unwrap_or(0),
            key: f.key.clone(),
            label: f.label.clone(),
            kind: f.kind.clone(),
            required: f.required,
            is_unique: f.is_unique,
            is_title: f.is_title,
            show_in_list: true,
            sort_order: i32::try_from(i).unwrap_or(0),
            options: if f.kind == "formula" {
                json!({ "expression": f.expression })
            } else {
                json!({})
            },
            help_text: None,
        })
        .collect();
    for f in o.fields.iter().filter(|f| f.kind == "formula") {
        mod_custom::fields::validate_formula(f.expression.as_deref().unwrap_or(""), &defs, Some(&f.key))
            .map_err(bad)?;
    }
    Ok(())
}

/// Áp mẫu TRONG giao dịch của người gọi (dựng hệ thống ghép thêm bước ghi cùng giao dịch: hỏng ở đó thì bảng cũng rollback).
pub async fn apply_in_tx(
    conn: &mut PgConnection,
    actor: &Actor,
    tpl: &Template,
    with_samples: bool,
    opts: Options,
) -> R<Applied> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, 1)")
        .bind(LOCK_NS)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let live: Vec<(i32, String, i32)> =
        sqlx::query_as("SELECT id, key, nav_order FROM custom_objects WHERE deleted_at IS NULL")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let mut ids: BTreeMap<String, i32> = live.iter().map(|(id, k, _)| (k.clone(), *id)).collect();
    let to_create: Vec<&TObject> = tpl.objects.iter().filter(|o| !ids.contains_key(&o.key)).collect();
    if i64::try_from(live.len() + to_create.len()).unwrap_or(i64::MAX) > Limits::MAX_OBJECTS {
        return Err(bad(format!("Vượt giới hạn {} tính năng tuỳ biến", Limits::MAX_OBJECTS)));
    }
    let mut order = live.iter().map(|(_, _, n)| *n).max().unwrap_or(0).max(0);
    for o in &to_create {
        order += 1;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO custom_objects (key, label, label_plural, icon, description, show_in_nav, nav_order, visible_role_ids, is_active, created_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, true, $6, '{}', true, $7, now()) RETURNING id",
        )
        .bind(&o.key)
        .bind(&o.label)
        .bind(&o.label_plural)
        .bind(&o.icon)
        .bind(&o.description)
        .bind(order)
        .bind(actor.user_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| {
            // Có người vừa tạo thực thể trùng mã giữa lúc đọc và ghi (tạo thủ công không dùng chung khoá) ⇒ báo thử lại, không 500.
            if db_error(&e).is(DbErrorKind::UniqueViolation, None) {
                HttpError::conflict("Vừa có người tạo tính năng trùng mã. Hãy thử áp mẫu lại.").into()
            } else {
                db(e)
            }
        })?;
        ids.insert(o.key.clone(), id);
    }
    let mut defs: BTreeMap<&str, Vec<FieldDef>> = BTreeMap::new();
    for o in &to_create {
        defs.insert(o.key.as_str(), create_fields(conn, &ids, o).await?);
    }
    let mut samples_made = 0;
    if with_samples && !to_create.is_empty() {
        // Chọn trong các thực thể MỚI tạo (không theo thứ tự thô của mẫu): thực thể đầu của mẫu đã có sẵn thì lấy thực thể mới kế tiếp.
        let only: Option<BTreeSet<&str>> = opts
            .sample_objects
            .map(|n| to_create.iter().take(n).map(|o| o.key.as_str()).collect());
        let created: BTreeSet<&str> = to_create.iter().map(|o| o.key.as_str()).collect();
        let seeded = seed_samples(conn, actor, tpl, &created, &ids, &defs, only.as_ref()).await?;
        samples_made = seeded.len();
        if opts.track_samples && !seeded.is_empty() {
            samples::register(
                conn,
                &SampleIds {
                    contacts: Vec::new(),
                    records: seeded,
                },
                Some(actor.user_id),
            )
            .await?;
        }
    }
    let created_keys: Vec<String> = to_create.iter().map(|o| o.key.clone()).collect();
    let existing = tpl
        .objects
        .iter()
        .filter(|o| !created_keys.contains(&o.key))
        .map(|o| o.key.clone())
        .collect();
    Ok(Applied {
        created: created_keys,
        existing,
        sample_records: samples_made,
    })
}

fn field_options(f: &TField, ids: &BTreeMap<String, i32>) -> R<Value> {
    let norm = |kind: &str, raw: Value| normalize_options(kind, &raw).map_err(|e| bad(e.0));
    match f.kind.as_str() {
        "select" | "multi_select" => norm(&f.kind, json!({ "choices": f.choices })),
        "formula" => norm(
            "formula",
            json!({ "expression": f.expression, "format": f.format, "decimals": f.decimals }),
        ),
        "relation" => {
            if f.relation.as_deref() == Some("contact") {
                return norm("relation", json!({ "target": "contact", "multiple": f.multiple }));
            }
            let target = f.relation.as_deref().and_then(|k| ids.get(k));
            match target {
                Some(t) => norm("relation", json!({ "target_object_id": t, "multiple": f.multiple })),
                None => Err(HttpError::conflict(format!(
                    "Thiếu tính năng “{}” để liên kết (mẫu cần tạo/giữ nó trước)",
                    f.relation.as_deref().unwrap_or("")
                ))
                .into()),
            }
        }
        _ => Ok(json!({})),
    }
}

async fn create_fields(conn: &mut PgConnection, ids: &BTreeMap<String, i32>, o: &TObject) -> R<Vec<FieldDef>> {
    let object_id = ids[&o.key];
    let mut out = Vec::new();
    let mut sort = 0;
    for f in &o.fields {
        let options = field_options(f, ids)?;
        sort += 10;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO custom_fields (object_id, key, label, type, required, is_unique, is_title, show_in_list, sort_order, options, help_text, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING id",
        )
        .bind(object_id)
        .bind(&f.key)
        .bind(&f.label)
        .bind(&f.kind)
        .bind(f.required)
        .bind(f.is_unique)
        .bind(f.is_title)
        .bind(f.show_in_list)
        .bind(sort)
        .bind(&options)
        .bind(&f.help_text)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        out.push(FieldDef {
            id,
            key: f.key.clone(),
            label: f.label.clone(),
            kind: f.kind.clone(),
            required: f.required,
            is_unique: f.is_unique,
            is_title: f.is_title,
            show_in_list: f.show_in_list,
            sort_order: sort,
            options,
            help_text: f.help_text.clone(),
        });
    }
    Ok(out)
}

/// Thực thể được sinh dữ liệu mẫu: vừa MỚI tạo VÀ mọi trường liên kết BẮT BUỘC trỏ tới thực thể cũng sinh mẫu, để không tạo bản ghi
/// mẫu thiếu trường bắt buộc. Duyệt theo thứ tự mẫu (đích đứng trước nguồn).
fn seedable_objects<'a>(tpl: &'a Template, created: &BTreeSet<&str>) -> BTreeSet<&'a str> {
    let mut ok: BTreeSet<&str> = BTreeSet::new();
    for o in &tpl.objects {
        if !created.contains(o.key.as_str()) {
            continue;
        }
        let needs = o
            .fields
            .iter()
            .filter(|f| f.kind == "relation" && f.required && f.relation.as_deref().is_some_and(|r| r != "contact"));
        if needs
            .into_iter()
            .all(|f| f.relation.as_deref().is_some_and(|r| ok.contains(r)))
        {
            ok.insert(o.key.as_str());
        }
    }
    ok
}

/// `{today}` → ngày hôm nay; `{"$add_months": "<trường>"}` → ngày hôm nay cộng số tháng ở trường đó (kẹp cuối tháng).
fn expand(v: &Value, today: &str, data: &Map<String, Value>) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("{today}", today)),
        Value::Object(o) if o.len() == 1 && o.contains_key("$add_months") => {
            let months = o
                .get("$add_months")
                .and_then(Value::as_str)
                .and_then(|k| data.get(k))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            Value::String(add_months(today, months))
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| expand(x, today, data)).collect()),
        other => other.clone(),
    }
}

/// `addMonths(ymd, months)` của mẫu giáo dục: cộng tháng, ngày kẹp về cuối tháng.
pub fn add_months(ymd: &str, months: i64) -> String {
    let Ok(d) = NaiveDate::parse_from_str(ymd, "%Y-%m-%d") else {
        return ymd.to_owned();
    };
    let total = i64::from(d.year()) * 12 + i64::from(d.month0()) + months;
    let (y, m) = (
        i32::try_from(total.div_euclid(12)).unwrap_or(d.year()),
        u32::try_from(total.rem_euclid(12)).unwrap_or(0) + 1,
    );
    let first = NaiveDate::from_ymd_opt(y, m, 1).unwrap_or(d);
    let next = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1)
    };
    let last = next.map_or(28, |n| (n - Duration::days(1)).day());
    NaiveDate::from_ymd_opt(y, m, d.day().min(last))
        .unwrap_or(first)
        .format("%Y-%m-%d")
        .to_string()
}

fn title_of(fields: &[FieldDef], data: &Map<String, Value>) -> Option<String> {
    let f = fields.iter().find(|f| f.is_title)?;
    let s = match data.get(&f.key)? {
        Value::Null => return None,
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let t: String = trinity_kernel::vi::trim_js(&s).chars().take(200).collect();
    (!t.is_empty()).then_some(t)
}

async fn seed_samples(
    conn: &mut PgConnection,
    actor: &Actor,
    tpl: &Template,
    created: &BTreeSet<&str>,
    ids: &BTreeMap<String, i32>,
    defs: &BTreeMap<&str, Vec<FieldDef>>,
    only: Option<&BTreeSet<&str>>,
) -> R<Vec<i32>> {
    let today = vn_date(Utc::now()).format("%Y-%m-%d").to_string();
    let seedable = seedable_objects(tpl, created);
    let mut created_ids: BTreeMap<&str, Vec<i32>> = BTreeMap::new();
    let mut made = Vec::new();
    for s in &tpl.samples {
        if !seedable.contains(s.object.as_str()) || only.is_some_and(|o| !o.contains(s.object.as_str())) {
            continue;
        }
        let fields = &defs[s.object.as_str()];
        let data = sample_data(tpl, s, fields, &created_ids, &today)?;
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO custom_records (object_id, data, title, owner_id, created_by, updated_at) VALUES ($1, $2, $3, $4, $4, now()) RETURNING id",
        )
        .bind(ids[&s.object])
        .bind(Value::Object(data.clone()))
        .bind(title_of(fields, &data))
        .bind(actor.user_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        created_ids.entry(s.object.as_str()).or_default().push(id);
        made.push(id);
    }
    Ok(made)
}

/// `data` của một bản ghi mẫu: giá trị đã chuẩn hoá theo trường + liên kết tới bản ghi mẫu đã tạo (`refs`).
fn sample_data(
    tpl: &Template,
    s: &Sample,
    fields: &[FieldDef],
    created_ids: &BTreeMap<&str, Vec<i32>>,
    today: &str,
) -> R<Map<String, Value>> {
    let mut data = Map::new();
    for (k, v) in &s.data {
        let Some(f) = fields.iter().find(|f| f.key == *k) else {
            return Err(bad(format!(
                "Mẫu lỗi: bản ghi mẫu của “{}” có trường lạ “{k}”",
                s.object
            )));
        };
        let raw = expand(v, today, &s.data);
        let val = sample_value::normalize(
            &Field {
                label: &f.label,
                kind: &f.kind,
                options: &f.options,
            },
            &raw,
        )
        .map_err(bad)?;
        data.insert(k.clone(), val);
    }
    for (k, r) in s.refs.iter().flatten() {
        if !fields.iter().any(|f| f.key == *k) {
            continue;
        }
        let target = tpl
            .objects
            .iter()
            .find(|o| o.key == s.object)
            .and_then(|o| o.fields.iter().find(|x| x.key == *k))
            .and_then(|x| x.relation.as_deref());
        let Some(pool) = target.and_then(|t| created_ids.get(t)) else {
            continue;
        };
        match r {
            Value::Array(list) => {
                let picked: Vec<i32> = list
                    .iter()
                    .filter_map(|i| i.as_u64().and_then(|i| pool.get(usize::try_from(i).ok()?)).copied())
                    .collect();
                if !picked.is_empty() {
                    data.insert(k.clone(), json!(picked));
                }
            }
            other => {
                if let Some(id) = other.as_u64().and_then(|i| pool.get(usize::try_from(i).ok()?)) {
                    data.insert(k.clone(), json!(id));
                }
            }
        }
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cong_thang_kep_cuoi_thang() {
        assert_eq!(add_months("2026-03-15", 6), "2026-09-15");
        assert_eq!(add_months("2026-01-31", 1), "2026-02-28");
        assert_eq!(add_months("2027-12-09", 12), "2028-12-09");
        assert_eq!(add_months("2026-11-30", 3), "2027-02-28");
    }

    #[test]
    fn mau_trong_danh_muc_hop_le() {
        for t in &catalog().templates {
            for o in &t.objects {
                assert_template_valid(o).unwrap_or_else(|e| panic!("{}: {e:?}", o.key));
            }
        }
    }

    #[test]
    fn du_lieu_mau_qua_chuan_hoa() {
        // Dựng thử trong RAM: trường nào của bản ghi mẫu cũng chuẩn hoá được, refs trỏ đúng bản ghi đã tạo.
        let ids: BTreeMap<String, i32> = catalog()
            .templates
            .iter()
            .flat_map(|t| t.objects.iter())
            .zip(1..)
            .map(|(o, i)| (o.key.clone(), i))
            .collect();
        for t in &catalog().templates {
            let mut defs: BTreeMap<&str, Vec<FieldDef>> = BTreeMap::new();
            for o in &t.objects {
                let fields = o
                    .fields
                    .iter()
                    .enumerate()
                    .map(|(i, f)| FieldDef {
                        id: i32::try_from(i).unwrap_or(0),
                        key: f.key.clone(),
                        label: f.label.clone(),
                        kind: f.kind.clone(),
                        required: f.required,
                        is_unique: f.is_unique,
                        is_title: f.is_title,
                        show_in_list: f.show_in_list,
                        sort_order: 0,
                        options: field_options(f, &ids).unwrap_or_else(|e| panic!("{}.{}: {e:?}", o.key, f.key)),
                        help_text: None,
                    })
                    .collect();
                defs.insert(o.key.as_str(), fields);
            }
            let mut pool: BTreeMap<&str, Vec<i32>> = BTreeMap::new();
            for (next, s) in (100..).zip(t.samples.iter()) {
                let data = sample_data(t, s, &defs[s.object.as_str()], &pool, "2026-03-15")
                    .unwrap_or_else(|e| panic!("{} {}: {e:?}", t.key, s.object));
                assert!(
                    title_of(&defs[s.object.as_str()], &data).is_some(),
                    "{} thiếu tiêu đề",
                    s.object
                );
                pool.entry(s.object.as_str()).or_default().push(next);
            }
        }
    }
}
