//! Bộ kiểm bất biến dữ liệu (X11, docs/rust/PLAN.md mục 6.5 và 6.6).
//!
//! Trong giai đoạn lai Node và Rust cùng ghi một DB; bộ này chạy chỉ-đọc trên mọi schema công ty (`public`, `c_<id>`)
//! để bắt dữ liệu sai sớm. Năm kiểu kiểm:
//! 1. **Đếm theo bảng**: số dòng không giảm bất thường so với lần chạy sạch trước (cần tệp trạng thái);
//! 2. **`updated_at` không lùi**: `max(updated_at)` mỗi bảng không nhỏ hơn lần trước, và không dòng nào có
//!    `updated_at < created_at` (Prisma đặt `@updatedAt` ở client nên Rust phải tự gán);
//! 3. **mã tự sinh không trùng**: `code` của contacts, deals, kanban_cards, custom_records, pos_orders, store_orders;
//! 4. **JSON đọc được bằng bộ đọc của bản TS**: cột Json không bị mã hoá hai lần (chuỗi chứa JSON) và đúng kiểu
//!    (mảng/đối tượng) mà giá trị mặc định của cột nêu;
//! 5. **không dòng mồ côi** ở các quan hệ soft-FK chính ([`SOFT_FKS`]).
//!
//! Mọi truy vấn chạy trong phiên `READ ONLY`; bộ kiểm không ghi gì vào DB (trạng thái nằm ở tệp ngoài).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, PgConnection, Row};
use trinity_db::Db;

/// Bảng có cột `code` tự sinh (trigger DB hoặc mã đơn) và phải duy nhất trong schema.
pub const CODE_TABLES: &[&str] = &[
    "contacts",
    "deals",
    "kanban_cards",
    "custom_records",
    "pos_orders",
    "store_orders",
];

/// Quan hệ soft-FK chính: (bảng con, cột, bảng cha). Cột cha luôn là `id`.
pub const SOFT_FKS: &[(&str, &str, &str)] = &[
    ("contacts", "product_id", "products"),
    ("kanban_cards", "contact_id", "contacts"),
    ("kanban_cards", "assignee_id", "users"),
    ("kanban_cards", "created_by", "users"),
    ("kanban_card_assignees", "user_id", "users"),
    ("pos_order_items", "product_id", "products"),
    ("pos_orders", "created_by", "users"),
    ("users", "manager_id", "users"),
    ("teams", "team_lead_id", "users"),
    ("recruitment_candidates", "recruiter_id", "users"),
];

#[derive(Debug, thiserror::Error)]
pub enum OpsError {
    #[error("lỗi DB: {0}")]
    Db(#[from] sqlx::Error),
    #[error("tệp trạng thái {path}: {msg}")]
    State { path: String, msg: String },
}

/// Ngưỡng cho kiểm đếm số dòng: sụt khi mất ít nhất `min_rows` dòng **và** ít nhất `pct` phần trăm.
#[derive(Debug, Clone)]
pub struct Options {
    pub min_drop_rows: i64,
    pub drop_pct: i64,
    /// Chỉ kiểm các schema này (rỗng = mọi schema công ty).
    pub schemas: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            min_drop_rows: 10,
            drop_pct: 20,
            schemas: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    RowCountDrop,
    UpdatedAtRegress,
    DuplicateCode,
    JsonUnreadable,
    OrphanSoftFk,
}

#[derive(Debug, Clone, Serialize)]
pub struct Violation {
    pub kind: Kind,
    pub schema: String,
    pub table: String,
    pub column: Option<String>,
    pub count: i64,
    /// Không chứa giá trị dữ liệu, chỉ id/mã khoá để tra.
    pub detail: String,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Report {
    pub schemas_checked: Vec<String>,
    pub tables_checked: usize,
    pub orphan_rules_checked: usize,
    pub json_columns_checked: usize,
    pub violations: Vec<Violation>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.violations.is_empty()
    }

    pub fn kinds(&self) -> BTreeSet<Kind> {
        self.violations.iter().map(|v| v.kind).collect()
    }
}

/// Trạng thái lần chạy sạch trước, lưu ở tệp JSON.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// schema -> bảng -> số liệu.
    pub schemas: BTreeMap<String, BTreeMap<String, TableStat>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStat {
    pub rows: i64,
    /// `max(updated_at)` theo UTC, định dạng cố định để so chuỗi.
    pub max_updated_at: Option<String>,
}

impl Snapshot {
    /// Tệp không có = chưa có mốc (lần chạy đầu), không phải lỗi.
    pub fn load(path: &Path) -> Result<Self, OpsError> {
        let state = |msg: String| OpsError::State {
            path: path.display().to_string(),
            msg,
        };
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| state(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(state(e.to_string())),
        }
    }

    /// Ghi qua tệp tạm rồi đổi tên để không để lại tệp dở.
    pub fn save(&self, path: &Path) -> Result<(), OpsError> {
        let state = |msg: String| OpsError::State {
            path: path.display().to_string(),
            msg,
        };
        let tmp = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(self).map_err(|e| state(e.to_string()))?;
        std::fs::write(&tmp, bytes).map_err(|e| state(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| state(e.to_string()))
    }
}

fn q(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

#[derive(Debug, Clone)]
struct Column {
    data_type: String,
    default: Option<String>,
}

type TableCols = BTreeMap<String, BTreeMap<String, Column>>;

/// Chạy mọi kiểm. `prev` là mốc lần sạch trước; trả về báo cáo và mốc mới đo lần này.
pub async fn run(db: &Db, prev: &Snapshot, opts: &Options) -> Result<(Report, Snapshot), OpsError> {
    let mut conn = db.raw_pool().acquire().await?;
    sqlx::raw_sql("SET default_transaction_read_only = on")
        .execute(&mut *conn)
        .await?;
    let mut report = Report::default();
    let mut now = Snapshot::default();
    for schema in list_schemas(&mut conn, &opts.schemas).await? {
        let tables = load_columns(&mut conn, &schema).await?;
        let mut stats = BTreeMap::new();
        for (table, cols) in &tables {
            report.tables_checked += 1;
            let stat = table_stats(&mut conn, &schema, table, cols).await?;
            compare_stats(&mut report, prev, opts, &schema, table, &stat);
            stats.insert(table.clone(), stat);
            if cols.contains_key("updated_at") && cols.contains_key("created_at") {
                updated_before_created(&mut conn, &mut report, &schema, table).await?;
            }
            for (name, col) in cols {
                if matches!(col.data_type.as_str(), "json" | "jsonb") {
                    report.json_columns_checked += 1;
                    json_readable(&mut conn, &mut report, &schema, table, name, col).await?;
                }
            }
        }
        for table in CODE_TABLES {
            if tables.get(*table).is_some_and(|c| c.contains_key("code")) {
                duplicate_codes(&mut conn, &mut report, &schema, table).await?;
            }
        }
        for (child, col, parent) in SOFT_FKS {
            let has = |t: &str, c: &str| tables.get(t).is_some_and(|m| m.contains_key(c));
            if has(child, col) && has(child, "id") && has(parent, "id") {
                report.orphan_rules_checked += 1;
                orphans(&mut conn, &mut report, &schema, child, col, parent).await?;
            }
        }
        report.schemas_checked.push(schema.clone());
        now.schemas.insert(schema, stats);
    }
    Ok((report, now))
}

async fn list_schemas(conn: &mut PgConnection, only: &[String]) -> Result<Vec<String>, OpsError> {
    let rows = sqlx::query(
        "SELECT n.nspname FROM pg_namespace n
         WHERE (n.nspname = 'public' OR n.nspname ~ '^c_[0-9]+$')
           AND EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = '_prisma_migrations')
         ORDER BY n.nspname",
    )
    .fetch_all(&mut *conn)
    .await?;
    let all: Vec<String> = rows.iter().map(|r| r.get::<String, _>(0)).collect();
    Ok(if only.is_empty() {
        all
    } else {
        all.into_iter().filter(|s| only.contains(s)).collect()
    })
}

async fn load_columns(conn: &mut PgConnection, schema: &str) -> Result<TableCols, OpsError> {
    let rows = sqlx::query(
        "SELECT c.table_name, c.column_name, c.data_type, c.column_default
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
         WHERE c.table_schema = $1 AND c.table_name <> '_prisma_migrations'",
    )
    .bind(schema)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = TableCols::new();
    for r in rows {
        out.entry(r.get::<String, _>(0)).or_default().insert(
            r.get::<String, _>(1),
            Column {
                data_type: r.get::<String, _>(2),
                default: r.get::<Option<String>, _>(3),
            },
        );
    }
    Ok(out)
}

async fn table_stats(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
    cols: &BTreeMap<String, Column>,
) -> Result<TableStat, OpsError> {
    let max = if cols.contains_key("updated_at") {
        "to_char(max(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
    } else {
        "NULL::text"
    };
    let sql = format!("SELECT count(*), {max} FROM {}.{}", q(schema), q(table));
    let row = sqlx::query(AssertSqlSafe(sql)).fetch_one(&mut *conn).await?;
    Ok(TableStat {
        rows: row.get::<i64, _>(0),
        max_updated_at: row.get::<Option<String>, _>(1),
    })
}

fn compare_stats(report: &mut Report, prev: &Snapshot, opts: &Options, schema: &str, table: &str, now: &TableStat) {
    let Some(old) = prev.schemas.get(schema).and_then(|t| t.get(table)) else {
        return;
    };
    let lost = old.rows - now.rows;
    if lost >= opts.min_drop_rows.max(1) && lost * 100 >= old.rows * opts.drop_pct {
        report.violations.push(Violation {
            kind: Kind::RowCountDrop,
            schema: schema.to_owned(),
            table: table.to_owned(),
            column: None,
            count: lost,
            detail: format!("số dòng {} -> {}", old.rows, now.rows),
        });
    }
    if let (Some(a), Some(b)) = (&old.max_updated_at, &now.max_updated_at)
        && b < a
    {
        report.violations.push(Violation {
            kind: Kind::UpdatedAtRegress,
            schema: schema.to_owned(),
            table: table.to_owned(),
            column: Some("updated_at".to_owned()),
            count: 1,
            detail: format!("max(updated_at) lùi {a} -> {b}"),
        });
    }
}

async fn updated_before_created(
    conn: &mut PgConnection,
    report: &mut Report,
    schema: &str,
    table: &str,
) -> Result<(), OpsError> {
    let sql = format!(
        "SELECT count(*) FROM {s}.{t} WHERE updated_at < created_at",
        s = q(schema),
        t = q(table)
    );
    let n: i64 = sqlx::query_scalar(AssertSqlSafe(sql)).fetch_one(&mut *conn).await?;
    if n > 0 {
        report.violations.push(Violation {
            kind: Kind::UpdatedAtRegress,
            schema: schema.to_owned(),
            table: table.to_owned(),
            column: Some("updated_at".to_owned()),
            count: n,
            detail: "updated_at < created_at".to_owned(),
        });
    }
    Ok(())
}

async fn duplicate_codes(
    conn: &mut PgConnection,
    report: &mut Report,
    schema: &str,
    table: &str,
) -> Result<(), OpsError> {
    let sql = format!(
        "SELECT code, count(*) FROM {s}.{t} WHERE code IS NOT NULL GROUP BY code HAVING count(*) > 1 ORDER BY code LIMIT 5",
        s = q(schema),
        t = q(table)
    );
    let rows = sqlx::query(AssertSqlSafe(sql)).fetch_all(&mut *conn).await?;
    if !rows.is_empty() {
        let codes: Vec<String> = rows.iter().map(|r| r.get::<String, _>(0)).collect();
        report.violations.push(Violation {
            kind: Kind::DuplicateCode,
            schema: schema.to_owned(),
            table: table.to_owned(),
            column: Some("code".to_owned()),
            count: i64::try_from(rows.len()).unwrap_or(i64::MAX),
            detail: format!("mã trùng (tối đa 5): {}", codes.join(", ")),
        });
    }
    Ok(())
}

/// Kiểu JSON mà giá trị mặc định của cột nêu (`'[]'::jsonb` mảng, `'{}'::jsonb` đối tượng).
fn expected_type(default: Option<&str>) -> Option<&'static str> {
    let d = default?.trim_start();
    if d.starts_with("'[]'") {
        Some("array")
    } else if d.starts_with("'{}'") {
        Some("object")
    } else {
        None
    }
}

async fn json_readable(
    conn: &mut PgConnection,
    report: &mut Report,
    schema: &str,
    table: &str,
    column: &str,
    col: &Column,
) -> Result<(), OpsError> {
    let (s, t, c) = (q(schema), q(table), q(column));
    // Mã hoá hai lần: kiểu chuỗi mà nội dung là JSON đối tượng/mảng. Bộ đọc TS trả về nguyên chuỗi chứ không
    // phải đối tượng, nên `.map`/truy cập trường sẽ hỏng.
    let sql =
        format!("SELECT ({c}::jsonb #>> '{{}}') FROM {s}.{t} WHERE jsonb_typeof({c}::jsonb) = 'string' LIMIT 1000");
    let rows = sqlx::query(AssertSqlSafe(sql)).fetch_all(&mut *conn).await?;
    let double = rows
        .iter()
        .filter(|r| {
            r.get::<Option<String>, _>(0)
                .and_then(|v| serde_json::from_str::<serde_json::Value>(v.trim()).ok())
                .is_some_and(|v| v.is_object() || v.is_array())
        })
        .count();
    if double > 0 {
        report.violations.push(Violation {
            kind: Kind::JsonUnreadable,
            schema: schema.to_owned(),
            table: table.to_owned(),
            column: Some(column.to_owned()),
            count: i64::try_from(double).unwrap_or(i64::MAX),
            detail: "JSON bị mã hoá hai lần (chuỗi chứa JSON)".to_owned(),
        });
    }
    if let Some(want) = expected_type(col.default.as_deref()) {
        let sql =
            format!("SELECT count(*) FROM {s}.{t} WHERE {c} IS NOT NULL AND jsonb_typeof({c}::jsonb) <> '{want}'");
        let n: i64 = sqlx::query_scalar(AssertSqlSafe(sql)).fetch_one(&mut *conn).await?;
        // Chuỗi mã hoá hai lần đã báo ở trên; ở đây chỉ đếm phần sai kiểu còn lại.
        let n = n - i64::try_from(double).unwrap_or(0);
        if n > 0 {
            report.violations.push(Violation {
                kind: Kind::JsonUnreadable,
                schema: schema.to_owned(),
                table: table.to_owned(),
                column: Some(column.to_owned()),
                count: n,
                detail: format!("cột mặc định {want} nhưng có dòng khác kiểu"),
            });
        }
    }
    Ok(())
}

async fn orphans(
    conn: &mut PgConnection,
    report: &mut Report,
    schema: &str,
    child: &str,
    col: &str,
    parent: &str,
) -> Result<(), OpsError> {
    let sql = format!(
        "SELECT count(*), (array_agg(c.id ORDER BY c.id))[1:5]::text
         FROM {s}.{c} c
         WHERE c.{k} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM {s}.{p} p WHERE p.id = c.{k})",
        s = q(schema),
        c = q(child),
        k = q(col),
        p = q(parent)
    );
    let row = sqlx::query(AssertSqlSafe(sql)).fetch_one(&mut *conn).await?;
    let n: i64 = row.get(0);
    if n > 0 {
        report.violations.push(Violation {
            kind: Kind::OrphanSoftFk,
            schema: schema.to_owned(),
            table: child.to_owned(),
            column: Some(col.to_owned()),
            count: n,
            detail: format!(
                "{parent}.id không tồn tại; id mẫu {}",
                row.get::<Option<String>, _>(1).unwrap_or_default()
            ),
        });
    }
    Ok(())
}
