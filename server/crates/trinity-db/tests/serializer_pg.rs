//! Test pg (K10): struct model sinh tự động và serializer JSON khớp bản Node.
//!
//! - `server/contracts/cases/serializer.json`: cột `out` là `JSON.stringify` của bản Node sau khi Prisma đọc (sinh bởi
//!   `services/crm/src/__pg__/serializer-cases.pg.spec.ts`); Rust đọc cùng giá trị bằng sqlx và ghi JSON, so từng byte.
//! - Mọi model trong [`trinity_db::models::MODELS`] khớp `information_schema` (tên bảng, cột, kiểu, NULL).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p trinity-db --tests -- --ignored`.

use serde::Serialize;
use serde_json::Value;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{FromRow, Row};
use trinity_db::models::{Contact, LoginWifiCheckTarget, MODELS, Model, NewsfeedMediaType, Product};
use trinity_db::types::{DbDate, DecimalJs, JsBigInt, JsNumber, JsonValue, NaiveTimestamp, PgList, Timestamp};

async fn pool() -> PgPool {
    let url = std::env::var("TEST_DATABASE_URL")
        .expect("test pg cần TEST_DATABASE_URL (Postgres 16 đã migrate bằng Prisma, xem server/README.md)");
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("nối TEST_DATABASE_URL")
}

fn table() -> Value {
    let path = format!("{}/../../contracts/cases/serializer.json", manifest_dir());
    serde_json::from_str(&std::fs::read_to_string(path).expect("đọc serializer.json")).expect("serializer.json hợp lệ")
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("ghi JSON")
}

fn get<T>(row: &PgRow) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres>,
{
    row.try_get::<T, _>("v").expect("đọc cột v")
}

/// Đọc cột `v` theo kiểu Rust ứng với nhãn `rust` của ca rồi ghi JSON.
fn decode(tag: &str, row: &PgRow) -> String {
    match tag {
        "timestamp" => json(&get::<Timestamp>(row)),
        "naive_timestamp" => json(&get::<NaiveTimestamp>(row)),
        "date" => json(&get::<DbDate>(row)),
        "decimal" => json(&get::<DecimalJs>(row)),
        "bigint" => json(&get::<JsBigInt>(row)),
        "float" => json(&get::<JsNumber>(row)),
        "json" => json(&get::<JsonValue>(row)),
        "int_array" => json(&get::<PgList<i32>>(row)),
        "text_array" => json(&get::<PgList<String>>(row)),
        "uuid" => json(&get::<uuid::Uuid>(row)),
        "enum_newsfeed_media_type" => json(&get::<NewsfeedMediaType>(row)),
        "opt_timestamp" => json(&get::<Option<Timestamp>>(row)),
        "opt_decimal" => json(&get::<Option<DecimalJs>>(row)),
        other => panic!("nhãn kiểu lạ: {other}"),
    }
}

/// Đọc một dòng của model `M` (đủ cột theo thứ tự trong `INFO`) và ghi JSON.
async fn read_model<M>(db: &PgPool) -> String
where
    M: Model + Serialize + for<'r> FromRow<'r, PgRow> + Send + Unpin,
{
    let cols: Vec<String> = M::INFO.columns.iter().map(|c| format!("\"{}\"", c.name)).collect();
    let sql = format!(
        "SELECT {} FROM \"{}\" ORDER BY id LIMIT 1",
        cols.join(", "),
        M::INFO.table
    );
    json(
        &sqlx::query_as::<_, M>(sqlx::AssertSqlSafe(sql))
            .fetch_one(db)
            .await
            .expect("đọc model"),
    )
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn serializer_khop_ban_node() {
    let db = pool().await;
    let t = table();
    let mut bad = Vec::new();
    let mut n = 0;
    for c in t["scalar"].as_array().expect("scalar") {
        let sql = c["sql"].as_str().expect("sql");
        let row = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {sql} AS v")))
            .fetch_one(&db)
            .await
            .expect(sql);
        let got = decode(c["rust"].as_str().expect("rust"), &row);
        if got != c["out"].as_str().expect("out") {
            bad.push(format!("{sql}\n  Node {}\n  Rust {got}", c["out"]));
        }
        n += 1;
    }
    for c in t["model"].as_array().expect("model") {
        let tbl = c["table"].as_str().expect("table");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "TRUNCATE \"{tbl}\" RESTART IDENTITY CASCADE"
        )))
        .execute(&db)
        .await
        .expect("truncate");
        sqlx::query(sqlx::AssertSqlSafe(c["insert"].as_str().expect("insert").to_owned()))
            .execute(&db)
            .await
            .expect("insert");
        let got = match c["model"].as_str().expect("model") {
            "LoginWifiCheckTarget" => read_model::<LoginWifiCheckTarget>(&db).await,
            "Contact" => read_model::<Contact>(&db).await,
            "Product" => read_model::<Product>(&db).await,
            other => panic!("model lạ: {other}"),
        };
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "TRUNCATE \"{tbl}\" RESTART IDENTITY CASCADE"
        )))
        .execute(&db)
        .await
        .expect("truncate");
        if got != c["out"].as_str().expect("out") {
            bad.push(format!("model {}\n  Node {}\n  Rust {got}", c["model"], c["out"]));
        }
        n += 1;
    }
    assert!(bad.is_empty(), "{} ca lệch:\n{}", bad.len(), bad.join("\n"));
    assert!(n >= 40, "bảng chỉ có {n} ca");
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn models_khop_information_schema() {
    let db = pool().await;
    assert_eq!(MODELS.len(), 107);
    let mut bad = Vec::new();
    for m in MODELS {
        let rows = sqlx::query(
            "SELECT column_name::text AS name, udt_name::text AS ty, is_nullable = 'YES' AS nullable \
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        )
        .bind(m.table)
        .fetch_all(&db)
        .await
        .expect("information_schema");
        if rows.is_empty() {
            bad.push(format!("{}: không có bảng {}", m.name, m.table));
            continue;
        }
        for c in m.columns {
            let found = rows.iter().find(|r| r.get::<String, _>("name") == c.name);
            match found {
                None => bad.push(format!("{}.{}: không có cột", m.table, c.name)),
                Some(r) => {
                    let (ty, nullable) = (r.get::<String, _>("ty"), r.get::<bool, _>("nullable"));
                    if ty != c.pg_type || nullable != c.nullable {
                        bad.push(format!(
                            "{}.{}: DB {ty}/{nullable}, model {}/{}",
                            m.table, c.name, c.pg_type, c.nullable
                        ));
                    }
                }
            }
        }
        // Cột DB không có trong model thì `SELECT` theo INFO vẫn đúng; chỉ báo để biết schema.prisma có thiếu.
        for r in &rows {
            let name: String = r.get("name");
            if !m.columns.iter().any(|c| c.name == name) {
                bad.push(format!("{}.{name}: có trong DB, không có trong model", m.table));
            }
        }
    }
    assert!(bad.is_empty(), "{} chỗ lệch:\n{}", bad.len(), bad.join("\n"));
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn jsonb_so_ngoai_f64_khong_lam_hong_ca_dong() {
    let db = pool().await;
    let sql = r#"SELECT '[1e999, {"a": -1e999, "b": 1.5, "c": 106.66009616851807}]'::jsonb AS v"#;
    let row = sqlx::query(sql).fetch_one(&db).await.expect("jsonb");
    // Prisma/Node báo lỗi cả dòng ở số này (`number out of range`); Rust ra `null` ở số đó, phần còn lại giữ nguyên.
    assert_eq!(
        json(&get::<JsonValue>(&row)),
        r#"[null,{"a":null,"b":1.5,"c":106.66009616851807}]"#
    );
    let row = sqlx::query(r#"SELECT '{"x": 1e999}'::json AS v"#)
        .fetch_one(&db)
        .await
        .expect("json");
    assert_eq!(json(&get::<JsonValue>(&row)), r#"{"x":null}"#);
}

/// Gốc crate lúc CHẠY: cargo đặt `CARGO_MANIFEST_DIR` khi chạy test. Không nhúng lúc biên dịch, vì các worktree dùng chung
/// `CARGO_TARGET_DIR` có thể dùng lại tệp thực thi do worktree khác biên dịch (đọc nhầm hợp đồng/migration của cây kia).
fn manifest_dir() -> String {
    std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned())
}
