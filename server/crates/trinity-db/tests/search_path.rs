//! Spike R005 (PLAN 4.3): định tuyến công ty bằng `search_path` trên pool dùng chung, statement cache của sqlx bật.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://localhost/trinity_<tên> cargo test -p trinity-db --test search_path -- --ignored`
//! Test tự tạo và xoá các schema `c_9xxx` riêng của mình trong DB đó.

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{AssertSqlSafe, Connection, PgConnection, PgPool, Row};

/// Schema không tồn tại: kết nối chưa gắn công ty mà chạy truy vấn không định danh schema sẽ lỗi (fail-closed).
const NO_COMPANY: &str = "\"trinity_no_company\"";

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

/// Pool như PLAN 4.3: `after_connect` và `after_release` đặt `search_path` về schema không tồn tại.
async fn pool(max: u32) -> PgPool {
    PgPoolOptions::new()
        .max_connections(max)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SELECT set_config('search_path', $1, false)")
                    .bind(NO_COMPANY)
                    .execute(&mut *conn)
                    .await?;
                Ok(())
            })
        })
        .after_release(|conn, _| {
            Box::pin(async move {
                sqlx::query("SELECT set_config('search_path', $1, false), pg_advisory_unlock_all()")
                    .bind(NO_COMPANY)
                    .execute(&mut *conn)
                    .await?;
                Ok(true)
            })
        })
        .connect_with(url().parse::<PgConnectOptions>().expect("URL hợp lệ"))
        .await
        .expect("nối được DB")
}

/// Tương đương `TenantDb::acquire(company)` (K06): luôn đặt `search_path` chỉ gồm schema công ty, không thêm `public`.
async fn use_company(conn: &mut PgConnection, company: i32) {
    sqlx::query("SELECT set_config('search_path', $1, false)")
        .bind(format!("\"c_{company}\""))
        .execute(&mut *conn)
        .await
        .expect("đặt search_path");
}

async fn exec(conn: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *conn)
        .await
        .expect(sql);
}

async fn teardown(conn: &mut PgConnection, companies: &[i32]) {
    for c in companies {
        exec(conn, &format!("DROP SCHEMA IF EXISTS c_{c} CASCADE")).await;
    }
}

const Q: &str = "SELECT id, company, name FROM spike_contacts WHERE id = $1";

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn xen_ke_1000_luot_tren_mot_ket_noi_khong_lan_cong_ty() {
    let companies = [9001, 9002];
    let pool = pool(1).await;
    {
        let mut c = pool.acquire().await.unwrap();
        setup_named(&mut c, &companies, &[9002]).await;
    }

    let mut pids = std::collections::BTreeSet::new();
    let mut wrong = 0;
    for i in 0..1000 {
        let company = companies[i % 2];
        let id = (i % 50) as i32 + 1;
        // Mỗi lượt lấy lại kết nối từ pool (pool 1 kết nối ⇒ luôn cùng một backend), như một nhóm truy vấn của handler.
        let mut conn = pool.acquire().await.unwrap();
        use_company(&mut conn, company).await;
        let row = sqlx::query(Q)
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .expect("truy vấn công ty");
        let got: i32 = row.get("company");
        let name: String = row.get("name");
        if got != company || name != format!("kh {id} cty {company}") {
            wrong += 1;
        }
        pids.insert(
            sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
                .fetch_one(&mut *conn)
                .await
                .unwrap(),
        );
    }
    assert_eq!(wrong, 0, "có dòng sai công ty");
    assert_eq!(pids.len(), 1, "phải chạy trên đúng một kết nối");

    // Câu lệnh chỉ được chuẩn bị một lần trên backend đó (statement cache của sqlx dùng lại, Postgres tự lập lại
    // kế hoạch khi search_path đổi).
    let mut conn = pool.acquire().await.unwrap();
    let prepared: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_prepared_statements WHERE statement = $1")
        .bind(Q)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(prepared, 1, "cùng một prepared statement cho cả hai công ty");
    teardown(&mut conn, &companies).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn xen_ke_song_song_tren_pool_nhieu_ket_noi() {
    let companies = [9011, 9012];
    let pool = pool(4).await;
    {
        let mut c = pool.acquire().await.unwrap();
        setup_named(&mut c, &companies, &[9012]).await;
    }
    let mut tasks = Vec::new();
    for t in 0..8 {
        let pool = pool.clone();
        tasks.push(tokio::spawn(async move {
            let mut wrong = 0;
            for i in 0..250 {
                let company = companies[(i + t) % 2];
                let mut conn = pool.acquire().await.unwrap();
                use_company(&mut conn, company).await;
                let rows = sqlx::query("SELECT id, company, name FROM spike_contacts WHERE id <= $1 ORDER BY id")
                    .bind(5)
                    .fetch_all(&mut *conn)
                    .await
                    .unwrap();
                wrong += rows.iter().filter(|r| r.get::<i32, _>("company") != company).count();
                tokio::task::yield_now().await;
            }
            wrong
        }));
    }
    let mut wrong = 0;
    for t in tasks {
        wrong += t.await.unwrap();
    }
    assert_eq!(wrong, 0, "có dòng sai công ty");
    let mut conn = pool.acquire().await.unwrap();
    teardown(&mut conn, &companies).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn ket_noi_chua_gan_cong_ty_thi_loi_va_tra_ve_pool_thi_xoa_cong_ty() {
    let companies = [9021];
    let pool = pool(1).await;
    let mut conn = pool.acquire().await.unwrap();
    setup_named(&mut conn, &companies, &[]).await;

    // Kết nối mới: không có công ty ⇒ bảng không định danh schema không tìm thấy (42P01).
    let err = sqlx::query(Q)
        .bind(1)
        .fetch_one(&mut *conn)
        .await
        .expect_err("phải lỗi khi chưa gắn công ty");
    assert_eq!(
        err.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("42P01"),
        "{err}"
    );

    // Gắn công ty, trả về pool, lấy lại: search_path đã về schema không tồn tại.
    use_company(&mut conn, 9021).await;
    sqlx::query(Q)
        .bind(1)
        .fetch_one(&mut *conn)
        .await
        .expect("đã gắn công ty");
    drop(conn);
    let mut conn = pool.acquire().await.unwrap();
    let sp: String = sqlx::query_scalar("SELECT current_setting('search_path')")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(sp, NO_COMPANY);
    sqlx::query(Q)
        .bind(1)
        .fetch_one(&mut *conn)
        .await
        .expect_err("sau khi trả về pool phải lỗi lại");

    // Cạm bẫy: set_config(..., false) bên trong giao dịch bị ROLLBACK thì cũng bị hoàn tác. TenantTx phải đặt
    // search_path TRƯỚC `BEGIN` (hoặc đặt lại sau rollback), không tin trạng thái cũ.
    use_company(&mut conn, 9021).await;
    let mut tx = conn.begin().await.unwrap();
    sqlx::query("SELECT set_config('search_path', $1, false)")
        .bind(NO_COMPANY)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    let sp: String = sqlx::query_scalar("SELECT current_setting('search_path')")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(sp, "\"c_9021\"", "rollback hoàn tác set_config trong giao dịch");

    teardown(&mut conn, &companies).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn hai_schema_khac_cot_cung_cau_lenh_liet_ke_cot_khong_loi() {
    // 9031: (id, company, name); 9032: thêm cột `extra` ở đầu, thứ tự cột khác. Câu lệnh liệt kê cột: kiểu kết quả
    // giống nhau ⇒ Postgres lập lại kế hoạch mà không báo `cached plan must not change result type`.
    let companies = [9031, 9032];
    let mut conn = PgConnection::connect(&url()).await.unwrap();
    setup_named(&mut conn, &companies, &[9032]).await;
    for i in 0..200 {
        let company = companies[i % 2];
        use_company(&mut conn, company).await;
        let row = sqlx::query(Q)
            .bind(1)
            .fetch_one(&mut conn)
            .await
            .unwrap_or_else(|e| panic!("lượt {i}: {e}"));
        assert_eq!(row.get::<i32, _>("company"), company);
        // UPDATE … RETURNING liệt kê cột cũng vậy.
        let back: i32 = sqlx::query_scalar("UPDATE spike_contacts SET name = name WHERE id = $1 RETURNING company")
            .bind(2)
            .fetch_one(&mut conn)
            .await
            .unwrap_or_else(|e| panic!("lượt {i}: {e}"));
        assert_eq!(back, company);
    }
    // Trong giao dịch cũng vậy (sqlx không có cơ hội chuẩn bị lại trong giao dịch, nên đây là ca phải đạt thật).
    for i in 0..200 {
        let company = companies[i % 2];
        use_company(&mut conn, company).await;
        let mut tx = conn.begin().await.unwrap();
        let row = sqlx::query(Q)
            .bind(1)
            .fetch_one(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("lượt {i}: {e}"));
        assert_eq!(row.get::<i32, _>("company"), company);
        let back: i32 = sqlx::query_scalar("UPDATE spike_contacts SET name = name WHERE id = $1 RETURNING company")
            .bind(2)
            .fetch_one(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("lượt {i}: {e}"));
        assert_eq!(back, company);
        tx.commit().await.unwrap();
    }
    teardown(&mut conn, &companies).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn kieu_ket_qua_doi_ngoai_giao_dich_sqlx_tu_chuan_bi_lai_trong_giao_dich_thi_loi() {
    // Hai ca kiểu kết quả đổi giữa hai schema: `SELECT *` khi khác cột (9052 có thêm cột), và cùng tên cột nhưng
    // khác kiểu (9003: `name varchar(40)` thay vì `text`). Postgres báo 0A000 `cached plan must not change result
    // type`; sqlx 0.9.1 bắt lỗi này (`check_stale_plan` trong executor.rs): NGOÀI giao dịch thì bỏ statement và
    // chuẩn bị lại một lần (đúng dữ liệu, tốn thêm vòng gọi), TRONG giao dịch thì trả lỗi và giao dịch hỏng.
    let companies = [9051, 9052, 9003];
    let mut conn = PgConnection::connect(&url()).await.unwrap();
    setup_named(&mut conn, &companies, &[9052]).await;
    const STAR: &str = "SELECT * FROM spike_contacts WHERE id = $1";

    // Ngoài giao dịch: luôn đúng dòng, đúng số cột.
    for i in 0..100 {
        let company = [9051, 9052][i % 2];
        use_company(&mut conn, company).await;
        let row = sqlx::query(STAR)
            .bind(1)
            .fetch_one(&mut conn)
            .await
            .unwrap_or_else(|e| panic!("lượt {i}: {e}"));
        assert_eq!(row.get::<i32, _>("company"), company);
        assert_eq!(row.len(), if company == 9052 { 4 } else { 3 });
    }
    for i in 0..100 {
        let company = [9051, 9003][i % 2];
        use_company(&mut conn, company).await;
        let row = sqlx::query(Q)
            .bind(1)
            .fetch_one(&mut conn)
            .await
            .unwrap_or_else(|e| panic!("lượt {i}: {e}"));
        assert_eq!(row.get::<i32, _>("company"), company);
        assert_eq!(row.get::<String, _>("name"), format!("kh 1 cty {company}"));
    }

    // Trong giao dịch: statement đã chuẩn bị với schema kia ⇒ lỗi 0A000, giao dịch phải rollback.
    for (sql, other) in [(STAR, 9052), (Q, 9003)] {
        use_company(&mut conn, 9051).await;
        sqlx::query(sql).bind(1).fetch_one(&mut conn).await.unwrap();
        use_company(&mut conn, other).await;
        let mut tx = conn.begin().await.unwrap();
        let err = sqlx::query(sql)
            .bind(1)
            .fetch_one(&mut *tx)
            .await
            .expect_err("trong giao dịch phải lỗi");
        assert!(
            err.to_string().contains("cached plan must not change result type"),
            "{err}"
        );
        assert_eq!(err.as_database_error().and_then(|e| e.code()).as_deref(), Some("0A000"));
        let after = sqlx::query("SELECT 1")
            .execute(&mut *tx)
            .await
            .expect_err("giao dịch đã hỏng");
        assert_eq!(
            after.as_database_error().and_then(|e| e.code()).as_deref(),
            Some("25P02")
        );
        tx.rollback().await.unwrap();
        // sqlx đã bỏ statement hỏng khỏi cache: giao dịch mới chạy được.
        let mut tx = conn.begin().await.unwrap();
        let row = sqlx::query(sql)
            .bind(1)
            .fetch_one(&mut *tx)
            .await
            .expect("sau rollback chạy được");
        assert_eq!(row.get::<i32, _>("company"), other);
        tx.commit().await.unwrap();
    }

    use_company(&mut conn, 9051).await;
    teardown(&mut conn, &companies).await;
}

/// Tạo schema `c_<id>` cho từng công ty với bảng `spike_contacts` 50 dòng. Công ty trong `extra_cols` có thêm cột
/// `extra` ở đầu và thứ tự cột khác (như đang giữa hai bản migration); 9003 đổi kiểu cột `name` (ca xấu nhất).
async fn setup_named(conn: &mut PgConnection, companies: &[i32], extra_cols: &[i32]) {
    for c in companies {
        exec(
            conn,
            &format!("DROP SCHEMA IF EXISTS c_{c} CASCADE; CREATE SCHEMA c_{c};"),
        )
        .await;
        let ddl = if extra_cols.contains(c) {
            "CREATE TABLE spike_contacts (extra text DEFAULT 'x', id int PRIMARY KEY, company int NOT NULL, name text NOT NULL)"
        } else if *c == 9003 {
            "CREATE TABLE spike_contacts (id int PRIMARY KEY, company int NOT NULL, name varchar(40) NOT NULL)"
        } else {
            "CREATE TABLE spike_contacts (id int PRIMARY KEY, company int NOT NULL, name text NOT NULL)"
        };
        exec(conn, &format!("SET search_path = c_{c}; {ddl}; INSERT INTO spike_contacts (id, company, name) SELECT g, {c}, 'kh ' || g || ' cty {c}' FROM generate_series(1, 50) g;")).await;
    }
    exec(conn, &format!("SET search_path = {NO_COMPANY}")).await;
}
