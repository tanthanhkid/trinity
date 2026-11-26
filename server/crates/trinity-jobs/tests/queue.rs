//! K21: hàng đợi `platform.jobs` — SKIP LOCKED, thử lại, khoá trùng, việc lỗi (PLAN 4.9).
//!
//! Cần Postgres và quyền tạo DB (mỗi test một DB riêng `<DB của TEST_DATABASE_URL>_k21_<ca>_<pid>`):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-jobs --test queue -- --ignored`

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::{Db, DbConfig};
use trinity_jobs::{NewJob, Queue, Worker, WorkerConfig};

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn url_for(db: &str) -> String {
    let base = base_url();
    let (head, query) = base
        .split_once('?')
        .map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
    let (server, _) = head.rsplit_once('/').expect("URL có tên DB");
    match query {
        Some(q) => format!("{server}/{db}?{q}"),
        None => format!("{server}/{db}"),
    }
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
        let dbname = base
            .split_once('?')
            .map_or(base.as_str(), |(h, _)| h)
            .rsplit_once('/')
            .map(|(_, d)| d.to_owned())
            .unwrap();
        let name = format!("{dbname}_k21_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        Self { name, url }
    }

    /// Một tiến trình giả: pool riêng + hàng đợi riêng (bản một công ty, không cần schema `public`).
    fn queue(&self, node: &str) -> (Queue, Db) {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.pool_size = 6;
        cfg.acquire_timeout = Duration::from_secs(20);
        let db = Db::connect_lazy(&cfg).unwrap();
        (Queue::new(&db, node).with_lease_margin(Duration::ZERO), db)
    }

    async fn conn(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.unwrap()
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

fn kinds() -> Vec<String> {
    ["x", "loi", "doc"].map(str::to_owned).to_vec()
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn a_1000_viec_4_worker_khong_viec_nao_chay_hai_lan() {
    let t = TestDb::new("a").await;
    let (q0, db0) = t.queue("seed");
    for i in 0..1000 {
        q0.enqueue(NewJob::new(1, "dem", serde_json::json!({ "i": i })))
            .await
            .unwrap();
    }
    let seen: Arc<Mutex<HashMap<i64, u32>>> = Arc::default();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut runs = Vec::new();
    let mut dbs = Vec::new();
    for n in 0..4 {
        let (q, db) = t.queue(&format!("w{n}"));
        dbs.push(db);
        let mut w = Worker::new(
            &q,
            WorkerConfig {
                concurrency: 2,
                lease: Duration::from_secs(30),
                poll: Duration::from_millis(20),
            },
        );
        let seen = seen.clone();
        w.handle("dem", move |j| {
            let seen = seen.clone();
            async move {
                *seen.lock().unwrap().entry(j.id).or_insert(0) += 1;
                Ok(())
            }
        });
        let rx = stop_rx.clone();
        runs.push(tokio::spawn(async move { w.run(rx).await }));
    }
    let mut c = t.conn().await;
    for _ in 0..600 {
        let left: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.jobs")
            .fetch_one(&mut c)
            .await
            .unwrap();
        if left == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    stop_tx.send(true).unwrap();
    for r in runs {
        r.await.unwrap().unwrap();
    }
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1000, "có việc chưa chạy");
        assert!(seen.values().all(|n| *n == 1), "có việc chạy hai lần");
    }
    db0.close().await;
    for d in dbs {
        d.close().await;
    }
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn b_worker_chet_giua_chung_thi_viec_duoc_nhan_lai() {
    let t = TestDb::new("b").await;
    let (q1, db1) = t.queue("chet");
    let (q2, db2) = t.queue("song");
    let id = q1
        .enqueue(NewJob::new(1, "x", serde_json::json!({})))
        .await
        .unwrap()
        .unwrap();
    let dead = q1.claim(Duration::from_millis(400), &kinds()).await.unwrap().unwrap();
    assert_eq!((dead.id, dead.attempts), (id, 1));
    // Còn hạn thuê: không ai khác nhận được.
    assert!(q2.claim(Duration::from_secs(30), &kinds()).await.unwrap().is_none());
    tokio::time::sleep(Duration::from_millis(500)).await;
    let again = q2.claim(Duration::from_secs(30), &kinds()).await.unwrap().unwrap();
    assert_eq!((again.id, again.attempts), (id, 2));
    // Worker "chết" tỉnh dậy: kết quả của lần nhận cũ bị bỏ qua, không xoá việc của lần sau.
    assert!(!q1.complete(&dead).await.unwrap());
    assert!(!q1.fail(&dead, "muộn").await.unwrap());
    assert!(q2.complete(&again).await.unwrap());
    db1.close().await;
    db2.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn c_thu_lai_co_backoff_roi_giu_viec_loi_va_dat_lai() {
    let t = TestDb::new("c").await;
    let (q, db) = t.queue("n");
    let id = q
        .enqueue(NewJob::new(1, "loi", serde_json::json!({})).max_attempts(2))
        .await
        .unwrap()
        .unwrap();
    let j1 = q.claim(Duration::from_secs(30), &kinds()).await.unwrap().unwrap();
    assert!(q.fail(&j1, "lần 1").await.unwrap());
    // Backoff 5 giây: chưa đến hạn.
    assert!(q.claim(Duration::from_secs(30), &kinds()).await.unwrap().is_none());
    let mut c = t.conn().await;
    exec(&mut c, "UPDATE platform.jobs SET run_at = now()").await;
    let j2 = q.claim(Duration::from_secs(30), &kinds()).await.unwrap().unwrap();
    assert_eq!(j2.attempts, 2);
    assert!(q.fail(&j2, "lần 2").await.unwrap());
    // Hết lần thử: giữ lại ở failed kèm lỗi, không nhận nữa.
    assert!(q.claim(Duration::from_secs(30), &kinds()).await.unwrap().is_none());
    let failed = q.list_failed(10).await.unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!((failed[0].id, failed[0].attempts), (id, 2));
    assert_eq!(failed[0].last_error.as_deref(), Some("lần 2"));
    // Đặt lại: chạy lại từ đầu.
    assert!(q.requeue_failed(id).await.unwrap());
    assert!(!q.requeue_failed(id).await.unwrap());
    let j3 = q.claim(Duration::from_secs(30), &kinds()).await.unwrap().unwrap();
    assert_eq!(j3.attempts, 1);
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn d_khoa_trung_va_viec_het_lan_thu_vi_worker_chet() {
    let t = TestDb::new("d").await;
    let (q, db) = t.queue("n");
    let first = q
        .enqueue(NewJob::new(1, "x", serde_json::json!({})).dedupe("k-1"))
        .await
        .unwrap();
    let dup = q
        .enqueue(NewJob::new(1, "x", serde_json::json!({})).dedupe("k-1"))
        .await
        .unwrap();
    assert!(first.is_some() && dup.is_none());
    // Xong thì khoá được dùng lại.
    let j = q.claim(Duration::from_secs(30), &kinds()).await.unwrap().unwrap();
    q.complete(&j).await.unwrap();
    assert!(
        q.enqueue(NewJob::new(1, "x", serde_json::json!({})).dedupe("k-1"))
            .await
            .unwrap()
            .is_some()
    );

    // Việc làm chết worker mỗi lần: hết lần thử thì failed, không nhận mãi.
    let id = q
        .enqueue(NewJob::new(1, "doc", serde_json::json!({})).max_attempts(2))
        .await
        .unwrap()
        .unwrap();
    let mut c = t.conn().await;
    exec(&mut c, "DELETE FROM platform.jobs WHERE kind = 'x'").await;
    for n in 1..=2 {
        let j = q.claim(Duration::from_millis(100), &kinds()).await.unwrap().unwrap();
        assert_eq!((j.id, j.attempts), (id, n));
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(q.claim(Duration::from_secs(30), &kinds()).await.unwrap().is_none());
    let failed = q.list_failed(10).await.unwrap();
    assert_eq!(failed.len(), 1);
    assert!(failed[0].last_error.as_deref().unwrap().contains("hết số lần thử"));
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn e_panic_va_kind_la_khong_giet_worker() {
    let t = TestDb::new("e").await;
    let (q, db) = t.queue("n");
    q.enqueue(NewJob::new(1, "no", serde_json::json!({})).max_attempts(1))
        .await
        .unwrap();
    q.enqueue(NewJob::new(1, "la", serde_json::json!({}))).await.unwrap();
    q.enqueue(NewJob::new(1, "ok", serde_json::json!({}))).await.unwrap();
    let mut w = Worker::new(&q, WorkerConfig::default());
    w.handle("no", |_| async { panic!("nổ") });
    w.handle("ok", |_| async { Ok(()) });
    for _ in 0..2 {
        assert!(w.run_once().await.unwrap());
    }
    // Kind không có bộ xử lý không bị nhận: vẫn nằm ở hàng đợi cho worker khác.
    assert!(!w.run_once().await.unwrap());
    let failed = q.list_failed(10).await.unwrap();
    assert_eq!(failed.len(), 1);
    assert!(failed[0].last_error.as_deref().unwrap().contains("dừng bất thường"));
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.jobs WHERE kind = 'la' AND status = 'queued'")
        .fetch_one(&mut t.conn().await)
        .await
        .unwrap();
    assert_eq!(left, 1);
    db.close().await;
}

#[test]
fn f_backoff_nhan_doi_co_tran() {
    use trinity_jobs::queue::{BACKOFF_MAX, backoff};
    assert_eq!(backoff(1), Duration::from_secs(5));
    assert_eq!(backoff(2), Duration::from_secs(10));
    assert_eq!(backoff(3), Duration::from_secs(20));
    assert_eq!(backoff(50), BACKOFF_MAX);
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn g_khoa_trung_theo_cong_ty_va_viec_failed_nha_khoa() {
    let t = TestDb::new("g").await;
    let (q, db) = t.queue("n");
    let p = serde_json::json!({});
    assert!(
        q.enqueue(NewJob::new(1, "x", p.clone()).dedupe("k"))
            .await
            .unwrap()
            .is_some()
    );
    // Công ty khác cùng khoá: được.
    assert!(
        q.enqueue(NewJob::new(2, "x", p.clone()).dedupe("k"))
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        q.enqueue(NewJob::new(1, "x", p.clone()).dedupe("k"))
            .await
            .unwrap()
            .is_none()
    );
    // Việc failed không giữ khoá.
    let mut c = t.conn().await;
    exec(
        &mut c,
        "UPDATE platform.jobs SET status = 'failed' WHERE company_id = 1",
    )
    .await;
    assert!(
        q.enqueue(NewJob::new(1, "x", p.clone()).dedupe("k"))
            .await
            .unwrap()
            .is_some()
    );
    // Đặt lại việc failed khi đã có việc cùng khoá đang chờ sẽ đụng khoá: chỉ kiểm requeue xoá lỗi trên việc khác.
    exec(
        &mut c,
        "UPDATE platform.jobs SET status = 'failed', last_error = 'cũ', dedupe_key = NULL WHERE company_id = 2",
    )
    .await;
    let id: i64 = sqlx::query_scalar("SELECT id FROM platform.jobs WHERE company_id = 2")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert!(q.requeue_failed(id).await.unwrap());
    let err: Option<String> = sqlx::query_scalar("SELECT last_error FROM platform.jobs WHERE id = $1")
        .bind(id)
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert!(err.is_none());
    // Giới hạn tham số.
    assert!(q.claim(Duration::ZERO, &kinds()).await.is_err());
    assert!(
        q.enqueue(NewJob::new(1, "x", p).run_in(Duration::from_secs(40 * 86_400)))
            .await
            .is_err()
    );
    db.close().await;
}
