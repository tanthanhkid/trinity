//! Dựng điều kiện SQL cho danh sách bản ghi tuỳ biến (chuyển từ `record-query.ts` phần dựng SQL, `custom-records-list.service.ts`
//! `recordSearchSql`/`queryRows`). KHÔNG nội suy chuỗi người dùng vào SQL: khoá trường luôn là tham số (`data -> $n`) SAU
//! khi đối chiếu với trường THẬT của bảng; hướng sắp xếp, phép so sánh và kiểu ép (`numeric`…) là hằng của mình.

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use regex::Regex;
use serde_json::Value;
use sqlx::{PgConnection, Postgres, QueryBuilder, Row};
use trinity_db::types::{JsonValue, Timestamp};
use trinity_kernel::vi::{SQL_FOLD_FROM, SQL_FOLD_TO, escape_like, fold_contains, fold_vi, trim_js};
use trinity_rbac::{OwnerIds, push_scope};

use crate::access::ObjectDef;
use crate::dates::{iso, parse_instant, valid_ymd};
use crate::filters::choice_values;
use crate::types::{FILTERABLE_TYPES, FieldDef, Limits, SORTABLE_TYPES};
use crate::{R, bad, db};

/// Kiểu cột sắp xếp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKind {
    Id,
    Ts,
    Text,
    Num,
}

#[derive(Debug, Clone)]
pub struct SortSpec {
    pub kind: SortKind,
    /// Khoá trường khi sắp theo `field:<khoá>`.
    pub field: Option<String>,
    column: &'static str,
}

impl SortSpec {
    fn push_expr(&self, qb: &mut QueryBuilder<Postgres>) {
        match (&self.field, self.kind) {
            (Some(k), SortKind::Num) => {
                qb.push("((data ->> ").push_bind(k.clone()).push(")::numeric)");
            }
            (Some(k), _) => {
                qb.push("(data ->> ").push_bind(k.clone()).push(")");
            }
            (None, _) => {
                qb.push(self.column);
            }
        }
    }

    fn cast(&self) -> &'static str {
        match self.kind {
            SortKind::Num => "numeric",
            SortKind::Ts => "timestamptz",
            _ => "text",
        }
    }
}

/// `buildSort`: `id` (mặc định) | `updated_at` | `title` | `field:<khoá>` (trường sống, kiểu sắp xếp được).
pub fn build_sort(def: &ObjectDef, sort: Option<&str>) -> R<SortSpec> {
    let simple = |kind, column| SortSpec {
        kind,
        field: None,
        column,
    };
    match sort {
        None | Some("") | Some("id") => Ok(simple(SortKind::Id, "id")),
        Some("updated_at") => Ok(simple(SortKind::Ts, "updated_at")),
        Some("title") => Ok(simple(SortKind::Text, "title")),
        Some(s) => {
            let Some(key) = s.strip_prefix("field:") else {
                return Err(bad("Cách sắp xếp không hợp lệ"));
            };
            let f = def
                .fields
                .iter()
                .find(|x| x.key == key)
                .filter(|f| SORTABLE_TYPES.contains(&f.kind.as_str()))
                .ok_or_else(|| bad("Không sắp xếp được theo trường này"))?;
            let kind = if matches!(f.kind.as_str(), "number" | "currency" | "percent") {
                SortKind::Num
            } else {
                SortKind::Text
            };
            Ok(SortSpec {
                kind,
                field: Some(f.key.clone()),
                column: "",
            })
        }
    }
}

fn push_order(qb: &mut QueryBuilder<Postgres>, s: &SortSpec, desc: bool) {
    let d = if desc { "DESC" } else { "ASC" };
    if s.kind == SortKind::Id {
        qb.push(" ORDER BY id ").push(d);
        return;
    }
    qb.push(" ORDER BY (");
    s.push_expr(qb);
    qb.push(" IS NULL), ");
    s.push_expr(qb);
    qb.push(" ").push(d).push(", id ").push(d);
}

// ---------------------------------------------------------------------------------------------------------------
// Con trỏ

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub v: Option<String>,
    pub id: i64,
}

const B64: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// `base64url(JSON.stringify({v, id}))`.
pub fn encode_cursor(c: &Cursor) -> String {
    let mut s = String::from("{\"v\":");
    match &c.v {
        Some(v) => trinity_kernel::json::write_js_string(v, &mut s),
        None => s.push_str("null"),
    }
    s.push_str(&format!(",\"id\":{}}}", c.id));
    B64.encode(s.as_bytes())
}

pub fn decode_cursor(raw: &str) -> R<Cursor> {
    let fail = || bad("Con trỏ phân trang không hợp lệ");
    let norm: String = raw
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect();
    let bytes = B64.decode(norm.trim_end_matches('=')).map_err(|_| fail())?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
    let id = v
        .get("id")
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        .ok_or_else(fail)? as i64;
    let v = match v.get("v") {
        Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        _ => return Err(fail()),
    };
    Ok(Cursor { v, id })
}

static NUM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?[0-9]+(\.[0-9]+)?$").expect("regex hợp lệ"));
static TS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$")
        .expect("regex hợp lệ")
});

/// Dạng và ngày THẬT: V8 chấp nhận "2026-02-30" nhưng Postgres ném 22008.
fn valid_timestamp(v: &str) -> bool {
    let Some(m) = TS_RE.captures(v) else { return false };
    let t = |i: usize| m[i].parse::<u32>().unwrap_or(99);
    valid_ymd(&m[1]) && t(2) < 24 && t(3) < 60 && t(4) < 60
}

/// Giá trị trong con trỏ do client gửi lại PHẢI đúng kiểu ép (`::numeric`/`::timestamptz`), nếu không Postgres ném 22P02.
fn assert_cursor_value(spec: &SortSpec, v: &str) -> R<()> {
    let ok = match spec.kind {
        SortKind::Num => NUM_RE.is_match(v),
        SortKind::Ts => valid_timestamp(v),
        _ => v.encode_utf16().count() <= 1000 && !v.contains('\0'),
    };
    if ok {
        Ok(())
    } else {
        Err(bad("Con trỏ phân trang không hợp lệ"))
    }
}

/// Bản ghi đứng SAU con trỏ theo đúng thứ tự trên (NULL xếp cuối cả hai chiều).
fn push_cursor(qb: &mut QueryBuilder<Postgres>, spec: &SortSpec, desc: bool, c: &Cursor) -> R<()> {
    let cmp = if desc { "<" } else { ">" };
    if spec.kind == SortKind::Id {
        qb.push("id ").push(cmp).push(" ").push_bind(c.id);
        return Ok(());
    }
    let Some(v) = &c.v else {
        qb.push("(");
        spec.push_expr(qb);
        qb.push(" IS NULL AND id ")
            .push(cmp)
            .push(" ")
            .push_bind(c.id)
            .push(")");
        return Ok(());
    };
    assert_cursor_value(spec, v)?;
    let cast = spec.cast();
    qb.push("(");
    spec.push_expr(qb);
    qb.push(" IS NULL OR ");
    spec.push_expr(qb);
    qb.push(" ")
        .push(cmp)
        .push(" ")
        .push_bind(v.clone())
        .push("::")
        .push(cast)
        .push(" OR (");
    spec.push_expr(qb);
    qb.push(" = ")
        .push_bind(v.clone())
        .push("::")
        .push(cast)
        .push(" AND id ")
        .push(cmp)
        .push(" ")
        .push_bind(c.id)
        .push("))");
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Bộ lọc

/// Một điều kiện lọc đã kiểm, chờ ghép vào SQL.
#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    /// `(data ->> key) = ANY(vals)`
    Select {
        key: String,
        vals: Vec<String>,
    },
    /// `(data -> key) ?| vals`
    Multi {
        key: String,
        vals: Vec<String>,
    },
    /// một trong các id nằm trong mảng/giá trị của trường
    Ids {
        key: String,
        ids: Vec<i64>,
    },
    Bool {
        key: String,
        value: bool,
    },
    /// `(data ->> key)::numeric <op> lit`
    Num {
        key: String,
        op: &'static str,
        lit: String,
    },
    /// `(data ->> key) <op> text` (ngày thuần và ngày giờ ISO so như chuỗi)
    Text {
        key: String,
        op: &'static str,
        text: String,
    },
}

fn as_array(v: &Value) -> Vec<&Value> {
    match v.as_array() {
        Some(a) => a.iter().collect(),
        None => vec![v],
    }
}

fn num_range(f: &FieldDef, v: &Value) -> R<Vec<Filter>> {
    let mut out = Vec::new();
    for (k, op) in [("min", ">="), ("max", "<=")] {
        match v.get(k) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s.is_empty() => {}
            Some(Value::Number(n)) => out.push(Filter::Num {
                key: f.key.clone(),
                op,
                lit: trinity_kernel::json::js_number(n.as_f64().unwrap_or(f64::NAN)),
            }),
            Some(_) => return Err(bad(format!("Bộ lọc “{}” cần số hợp lệ", f.label))),
        }
    }
    Ok(out)
}

const DAY_MS: i64 = 86_400_000;

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

fn date_range(f: &FieldDef, v: &Value) -> R<Vec<Filter>> {
    let mut out = Vec::new();
    let invalid = || bad(format!("Bộ lọc “{}” cần ngày hợp lệ", f.label));
    for (k, op, strict_lt) in [("from", ">=", false), ("to", "<=", true)] {
        let x = match v.get(k) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) if s.is_empty() => continue,
            Some(Value::String(s)) => s.as_str(),
            Some(_) => return Err(invalid()),
        };
        let ok = if f.kind == "date" {
            is_ymd(x)
        } else {
            parse_instant(x).is_some()
        };
        if !ok {
            return Err(invalid());
        }
        let key = f.key.clone();
        if f.kind == "date" {
            out.push(Filter::Text {
                key,
                op,
                text: x.to_owned(),
            });
            continue;
        }
        // datetime lưu ISO UTC. Ngày thuần YYYY-MM-DD hiểu theo NGÀY VN (+07:00): `from` = 00:00 VN của ngày đó;
        // `to` = hết ngày đó (trước 00:00 VN của ngày kế tiếp).
        if is_ymd(x) {
            let start = parse_instant(&format!("{x}T00:00:00+07:00")).map(|t| t.timestamp_millis());
            let Some(start) = start.filter(|_| valid_ymd(x)) else {
                return Err(invalid());
            };
            let (op2, ms) = if strict_lt {
                ("<", start + DAY_MS)
            } else {
                (">=", start)
            };
            let at = trinity_kernel::vn_time::from_millis(ms).ok_or_else(invalid)?;
            out.push(Filter::Text {
                key,
                op: op2,
                text: iso(at),
            });
            continue;
        }
        let at = parse_instant(x).ok_or_else(invalid)?;
        out.push(Filter::Text { key, op, text: iso(at) });
    }
    Ok(out)
}

fn one_filter(f: &FieldDef, v: &Value) -> R<Vec<Filter>> {
    match f.kind.as_str() {
        "select" => Ok(vec![Filter::Select {
            key: f.key.clone(),
            vals: choice_values(f, v).map_err(bad)?,
        }]),
        "multi_select" => Ok(vec![Filter::Multi {
            key: f.key.clone(),
            vals: choice_values(f, v).map_err(bad)?,
        }]),
        "relation" | "user" => {
            let ids: Vec<i64> = as_array(v)
                .into_iter()
                .filter_map(|x| crate::values::js_int(Some(x)).filter(|_| x.is_number()))
                .take(Limits::MAX_FILTER_VALUES)
                .collect();
            if ids.is_empty() {
                return Err(bad(format!("Bộ lọc “{}” cần mã hợp lệ", f.label)));
            }
            Ok(vec![Filter::Ids {
                key: f.key.clone(),
                ids,
            }])
        }
        "boolean" => match v {
            Value::Bool(b) => Ok(vec![Filter::Bool {
                key: f.key.clone(),
                value: *b,
            }]),
            _ => Err(bad(format!("Bộ lọc “{}” cần đúng/sai", f.label))),
        },
        "number" | "currency" | "percent" => num_range(f, v),
        _ => date_range(f, v),
    }
}

/// `buildFilters`: `filter` = JSON `{khoá_trường: giá trị}`; chỉ trường SỐNG, kiểu cho phép lọc (không phone/text/url: chống dò).
pub fn build_filters(def: &ObjectDef, raw: Option<&str>) -> R<Vec<Filter>> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(Vec::new());
    };
    // Postgres không nhận NUL trong text (22021): chặn cả dạng escape `\u0000` trong JSON.
    if raw.contains('\0') || raw.to_ascii_lowercase().contains("\\u0000") {
        return Err(bad("Bộ lọc chứa ký tự không hợp lệ"));
    }
    let Ok(obj) = serde_json::from_str::<Value>(raw) else {
        return Err(bad("Bộ lọc không phải JSON hợp lệ"));
    };
    let Some(map) = obj.as_object() else {
        return Err(bad("Bộ lọc phải là object"));
    };
    if map.len() > Limits::MAX_FILTER_KEYS {
        return Err(bad(format!("Tối đa {} bộ lọc", Limits::MAX_FILTER_KEYS)));
    }
    let mut out = Vec::new();
    for (key, v) in map {
        let f = def
            .fields
            .iter()
            .find(|x| x.key == *key)
            .filter(|f| FILTERABLE_TYPES.contains(&f.kind.as_str()));
        let Some(f) = f else {
            let short: String = key.chars().take(30).collect();
            return Err(bad(format!("Không lọc được theo trường “{short}”")));
        };
        out.extend(one_filter(f, v)?);
    }
    Ok(out)
}

fn push_filter(qb: &mut QueryBuilder<Postgres>, f: &Filter) {
    match f {
        Filter::Select { key, vals } => {
            qb.push("(data ->> ")
                .push_bind(key.clone())
                .push(") = ANY(")
                .push_bind(vals.clone())
                .push("::text[])");
        }
        Filter::Multi { key, vals } => {
            qb.push("(data -> ")
                .push_bind(key.clone())
                .push(") ?| ")
                .push_bind(vals.clone())
                .push("::text[]");
        }
        Filter::Ids { key, ids } => {
            qb.push("(");
            for (i, id) in ids.iter().enumerate() {
                if i > 0 {
                    qb.push(" OR ");
                }
                qb.push("(data -> ")
                    .push_bind(key.clone())
                    .push(") @> ")
                    .push_bind(id.to_string())
                    .push("::text::jsonb");
            }
            qb.push(")");
        }
        Filter::Bool { key, value } => {
            qb.push("(data -> ")
                .push_bind(key.clone())
                .push(") = ")
                .push_bind(value.to_string())
                .push("::text::jsonb");
        }
        Filter::Num { key, op, lit } => {
            qb.push("(data ->> ")
                .push_bind(key.clone())
                .push(")::numeric ")
                .push(op)
                .push(" ")
                .push_bind(lit.clone())
                .push("::numeric");
        }
        Filter::Text { key, op, text } => {
            qb.push("(data ->> ")
                .push_bind(key.clone())
                .push(") ")
                .push(op)
                .push(" ")
                .push_bind(text.clone());
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Ô tìm

/// Kiểu trường chữ được ô tìm quét thêm (không gồm phone: SĐT bị che theo quyền, tìm chứa là oracle dò số).
pub const TEXT_SEARCH_TYPES: [&str; 4] = ["text", "long_text", "email", "url"];

/// `translate(lower(<biểu thức>), từ, sang) LIKE %từ khoá đã gập% ESCAPE '\'`: không phân biệt hoa/thường/dấu.
fn push_fold_match(qb: &mut QueryBuilder<Postgres>, expr: impl FnOnce(&mut QueryBuilder<Postgres>), q: &str) {
    qb.push("translate(lower(");
    expr(qb);
    qb.push("), ")
        .push_bind(SQL_FOLD_FROM)
        .push(", ")
        .push_bind(SQL_FOLD_TO)
        .push(") LIKE ");
    qb.push_bind(fold_contains(q)).push(" ESCAPE '\\'");
}

fn push_json(qb: &mut QueryBuilder<Postgres>, key: &str) {
    qb.push("(custom_records.data->").push_bind(key.to_owned()).push(")");
}

/// `recordSearchSql`: khớp khi tiêu đề chứa từ khoá, mã bắt đầu bằng từ khoá, một trường chữ chứa, nhãn lựa chọn chứa, hoặc TÊN
/// của bản ghi / khách hàng / người dùng được liên kết chứa.
pub fn push_search(qb: &mut QueryBuilder<Postgres>, def: &ObjectDef, q: &str) {
    let term = fold_vi(trim_js(q));
    qb.push("(");
    push_fold_match(
        qb,
        |b| {
            b.push("title");
        },
        q,
    );
    qb.push(" OR code LIKE ")
        .push_bind(format!("{}%", escape_like(&trim_js(q).to_uppercase())))
        .push(" ESCAPE '\\'");
    for f in &def.fields {
        let kind = f.kind.as_str();
        if TEXT_SEARCH_TYPES.contains(&kind) {
            qb.push(" OR ");
            push_fold_match(
                qb,
                |b| {
                    b.push("(data->>").push_bind(f.key.clone()).push(")");
                },
                q,
            );
        } else if kind == "select" || kind == "multi_select" {
            let hit: Vec<String> = f
                .options
                .get("choices")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter(|c| fold_vi(c.get("label").and_then(Value::as_str).unwrap_or_default()).contains(&term))
                        .filter_map(|c| c.get("value").and_then(Value::as_str).map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if hit.is_empty() {
                continue;
            }
            if kind == "select" {
                qb.push(" OR (data->>")
                    .push_bind(f.key.clone())
                    .push(") = ANY(")
                    .push_bind(hit)
                    .push("::text[])");
            } else {
                qb.push(" OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(");
                push_json(qb, &f.key);
                qb.push(") = 'array' THEN ");
                push_json(qb, &f.key);
                qb.push(" END) v WHERE v = ANY(").push_bind(hit).push("::text[]))");
            }
        } else if kind == "user" {
            qb.push(" OR EXISTS (SELECT 1 FROM users u WHERE ");
            push_json(qb, &f.key);
            qb.push(" @> to_jsonb(u.id) AND ");
            push_fold_match(
                qb,
                |b| {
                    b.push("u.full_name");
                },
                q,
            );
            qb.push(")");
        } else if kind == "relation" && f.options.get("target").and_then(Value::as_str) == Some("contact") {
            qb.push(" OR EXISTS (SELECT 1 FROM contacts c WHERE c.deleted_at IS NULL AND ");
            push_json(qb, &f.key);
            qb.push(" @> to_jsonb(c.id) AND ");
            push_fold_match(
                qb,
                |b| {
                    b.push("c.full_name");
                },
                q,
            );
            qb.push(")");
        } else if kind == "relation"
            && let Some(target) = f
                .options
                .get("target_object_id")
                .and_then(Value::as_i64)
                .filter(|n| *n != 0)
        {
            qb.push(" OR EXISTS (SELECT 1 FROM custom_records t WHERE t.object_id = ")
                .push_bind(target)
                .push(" AND t.deleted_at IS NULL AND ");
            push_json(qb, &f.key);
            qb.push(" @> to_jsonb(t.id) AND ");
            push_fold_match(
                qb,
                |b| {
                    b.push("t.title");
                },
                q,
            );
            qb.push(")");
        }
    }
    qb.push(")");
}

// ---------------------------------------------------------------------------------------------------------------
// Truy vấn lõi

/// Cột của `custom_records` mà [`read_row`] đọc.
pub const ROW_COLS: &str = "id, data, title, code, owner_id, created_by, created_at, updated_at";

/// Hàng thô của `custom_records` (đã lọc phạm vi).
#[derive(Debug, Clone)]
pub struct RawRow {
    pub id: i32,
    pub data: Value,
    pub title: Option<String>,
    pub code: Option<String>,
    pub owner_id: Option<i32>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone)]
pub struct RowQuery {
    pub q: Option<String>,
    pub limit: i64,
    pub cursor: Option<String>,
    /// Bỏ qua bấy nhiêu dòng đầu (phân trang theo số trang). Bỏ qua khi có `cursor`.
    pub offset: i64,
    pub sort: Option<String>,
    pub desc: bool,
    pub filter: Option<String>,
    pub with_total: bool,
}

pub struct RowPage {
    pub rows: Vec<RawRow>,
    pub next: Option<String>,
    pub total: Option<i64>,
}

fn push_base(
    qb: &mut QueryBuilder<Postgres>,
    def: &ObjectDef,
    scopes: &[OwnerIds],
    filters: &[Filter],
    q: Option<&str>,
) {
    qb.push("(object_id = ")
        .push_bind(def.obj.id)
        .push(") AND (deleted_at IS NULL)");
    for s in scopes {
        qb.push(" AND (");
        push_scope(qb, s, &["owner_id", "created_by"]);
        qb.push(")");
    }
    for f in filters {
        qb.push(" AND (");
        push_filter(qb, f);
        qb.push(")");
    }
    if let Some(q) = q {
        qb.push(" AND (");
        push_search(qb, def, q);
        qb.push(")");
    }
}

/// Đếm theo cùng điều kiện nền.
pub async fn count_where(
    conn: &mut PgConnection,
    def: &ObjectDef,
    scopes: &[OwnerIds],
    filters: &[Filter],
    q: Option<&str>,
) -> R<i64> {
    let mut qb = QueryBuilder::<Postgres>::new("SELECT count(*)::bigint FROM custom_records WHERE ");
    push_base(&mut qb, def, scopes, filters, q);
    qb.build_query_scalar::<i64>().fetch_one(&mut *conn).await.map_err(db)
}

pub fn read_row(r: &sqlx::postgres::PgRow) -> Result<RawRow, sqlx::Error> {
    Ok(RawRow {
        id: r.try_get("id")?,
        data: r.try_get::<JsonValue, _>("data")?.0,
        title: r.try_get("title")?,
        code: r.try_get("code")?,
        owner_id: r.try_get("owner_id")?,
        created_by: r.try_get("created_by")?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

/// Truy vấn lõi, dùng chung cho danh sách và xuất tệp. `scopes` PHẢI chứa điều kiện phạm vi (mỗi phần tử là một phạm vi, GIAO).
pub async fn query_rows(conn: &mut PgConnection, def: &ObjectDef, scopes: &[OwnerIds], o: &RowQuery) -> R<RowPage> {
    let sort = build_sort(def, o.sort.as_deref())?;
    let filters = build_filters(def, o.filter.as_deref())?;
    let q = o.q.as_deref().map(trim_js).filter(|s| !s.is_empty());
    let cursor = o.cursor.as_deref().map(decode_cursor).transpose()?;
    let mut qb =
        QueryBuilder::<Postgres>::new("SELECT id, data, title, code, owner_id, created_by, created_at, updated_at, ");
    if sort.kind == SortKind::Id {
        qb.push("NULL::text");
    } else {
        qb.push("(");
        sort.push_expr(&mut qb);
        qb.push(")::text");
    }
    qb.push(" AS sort_v FROM custom_records WHERE ");
    push_base(&mut qb, def, scopes, &filters, q);
    if let Some(c) = &cursor {
        qb.push(" AND (");
        push_cursor(&mut qb, &sort, o.desc, c)?;
        qb.push(")");
    }
    push_order(&mut qb, &sort, o.desc);
    qb.push(" LIMIT ").push_bind(o.limit.saturating_add(1));
    qb.push(" OFFSET ")
        .push_bind(if cursor.is_some() { 0 } else { o.offset });
    let raw = qb.build().fetch_all(&mut *conn).await.map_err(db)?;
    let more = i64::try_from(raw.len()).unwrap_or(i64::MAX) > o.limit;
    let keep = if more {
        usize::try_from(o.limit).unwrap_or(0)
    } else {
        raw.len()
    };
    let mut rows = Vec::with_capacity(keep);
    for r in raw.iter().take(keep) {
        rows.push(read_row(r).map_err(db)?);
    }
    let next = match (more, raw.get(keep.wrapping_sub(1)).filter(|_| keep > 0)) {
        (true, Some(last)) => {
            let v = if sort.kind == SortKind::Id {
                None
            } else {
                last.try_get::<Option<String>, _>("sort_v").map_err(db)?
            };
            Some(encode_cursor(&Cursor {
                v,
                id: i64::from(rows[keep - 1].id),
            }))
        }
        _ => None,
    };
    let total = if o.with_total {
        Some(count_where(conn, def, scopes, &filters, q).await?)
    } else {
        None
    };
    Ok(RowPage { rows, next, total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn con_tro_khu_hoi() {
        let c = Cursor {
            v: Some("a\"b".into()),
            id: 7,
        };
        assert_eq!(decode_cursor(&encode_cursor(&c)).unwrap(), c);
        let n = Cursor { v: None, id: 3 };
        assert_eq!(decode_cursor(&encode_cursor(&n)).unwrap(), n);
        assert_eq!(encode_cursor(&n), B64.encode(br#"{"v":null,"id":3}"#));
        for bad in ["", "!!!", "e30", "eyJpZCI6MX0"] {
            assert!(decode_cursor(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn kieu_con_tro() {
        let num = SortSpec {
            kind: SortKind::Num,
            field: Some("g".into()),
            column: "",
        };
        assert!(assert_cursor_value(&num, "-1.5").is_ok());
        assert!(assert_cursor_value(&num, "1e5").is_err());
        let ts = SortSpec {
            kind: SortKind::Ts,
            field: None,
            column: "updated_at",
        };
        assert!(assert_cursor_value(&ts, "2026-11-27 10:00:00.123+00").is_ok());
        assert!(assert_cursor_value(&ts, "2026-02-30 10:00:00+00").is_err());
        assert!(assert_cursor_value(&ts, "x").is_err());
    }
}
