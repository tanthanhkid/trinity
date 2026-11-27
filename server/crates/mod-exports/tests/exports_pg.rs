//! X15b: vòng đời `platform.export_files` trên Postgres thật.
//!
//! Cần quyền tạo DB (mỗi test một DB riêng `<DB của TEST_DATABASE_URL>_x15b_<ca>_<pid>`):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-exports --test exports_pg -- --ignored`

use std::time::Duration;

use mod_exports::store::{MAX_ACTIVE_PER_USER, Store};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::{Db, DbConfig};

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

struct TestDb {
    name: String,
    url: String,
}

impl TestDb {
    async fn new(case: &str) -> Self {
        let base = base_url();
        let (head, query) = base
            .split_once('?')
            .map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
        let (server, dbname) = head.rsplit_once('/').expect("URL có tên DB");
        let name = format!("{dbname}_x15b_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = match query {
            Some(q) => format!("{server}/{name}?{q}"),
            None => format!("{server}/{name}"),
        };
        Self { name, url }
    }

    fn db(&self) -> Db {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.pool_size = 4;
        cfg.acquire_timeout = Duration::from_secs(20);
        Db::connect_lazy(&cfg).unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(mut admin) = PgConnection::connect(&base_url()).await {
                    let _ = sqlx::raw_sql(AssertSqlSafe(format!(
                        "DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"
                    )))
                    .execute(&mut admin)
                    .await;
                }
            });
        })
        .join();
    }
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn vong_doi_xep_viec_dung_tai() {
    let t = TestDb::new("vong").await;
    let s = Store::new(&t.db());
    let id = s.create(1, 10, "contacts").await.unwrap().unwrap();

    let st = s.status(id, 1, 10).await.unwrap().unwrap();
    assert_eq!((st.status.as_str(), st.progress), ("queued", 0));
    assert!(s.file(id, 1, 10).await.unwrap().is_none(), "chưa xong thì không có tệp");

    assert!(s.mark_running(id, 1).await.unwrap());
    s.set_progress(id, 1, 90).await.unwrap();
    s.set_progress(id, 1, 50).await.unwrap();
    let st = s.status(id, 1, 10).await.unwrap().unwrap();
    assert_eq!((st.status.as_str(), st.progress), ("running", 90), "tiến độ chỉ tăng");

    s.finish(id, 1, "khach-hang.xlsx", "application/x", vec![1, 2, 3]).await.unwrap();
    let st = s.status(id, 1, 10).await.unwrap().unwrap();
    assert_eq!((st.status.as_str(), st.progress, st.size_bytes), ("done", 100, Some(3)));
    assert!(st.finished_at.is_some());
    let f = s.file(id, 1, 10).await.unwrap().unwrap();
    assert_eq!((f.filename.as_str(), f.data), ("khach-hang.xlsx", vec![1, 2, 3]));
    assert!(!s.mark_running(id, 1).await.unwrap(), "việc đã xong không chạy lại");
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn nguoi_khac_va_cong_ty_khac_khong_thay() {
    let t = TestDb::new("quyen").await;
    let s = Store::new(&t.db());
    let id = s.create(1, 10, "contacts").await.unwrap().unwrap();
    s.mark_running(id, 1).await.unwrap();
    s.finish(id, 1, "a.xlsx", "application/x", vec![9]).await.unwrap();
    assert!(s.status(id, 1, 11).await.unwrap().is_none(), "người khác cùng công ty");
    assert!(s.status(id, 2, 10).await.unwrap().is_none(), "công ty khác");
    assert!(s.file(id, 1, 11).await.unwrap().is_none());
    assert!(s.file(id, 2, 10).await.unwrap().is_none());
    assert!(!s.mark_running(id, 2).await.unwrap());
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn gioi_han_viec_dang_chay_va_viec_loi() {
    let t = TestDb::new("gioihan").await;
    let s = Store::new(&t.db());
    let mut ids = Vec::new();
    for _ in 0..MAX_ACTIVE_PER_USER {
        ids.push(s.create(1, 10, "contacts").await.unwrap().unwrap());
    }
    assert!(s.create(1, 10, "contacts").await.unwrap().is_none(), "quá giới hạn");
    assert!(s.create(1, 11, "contacts").await.unwrap().is_some(), "người khác không bị ảnh hưởng");

    s.mark_running(ids[0], 1).await.unwrap();
    s.fail(ids[0], 1, &"x".repeat(900)).await.unwrap();
    let st = s.status(ids[0], 1, 10).await.unwrap().unwrap();
    assert_eq!(st.status, "failed");
    assert_eq!(st.error.map(|e| e.chars().count()), Some(500));
    assert!(s.create(1, 10, "contacts").await.unwrap().is_some(), "việc lỗi không còn tính là đang chạy");
}
