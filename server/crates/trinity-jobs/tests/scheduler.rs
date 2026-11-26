//! K20: scheduler theo công ty — nhận lượt qua `platform.job_runs`, con trỏ, budget, sở hữu job (PLAN 4.9).
//!
//! Cần Postgres và quyền tạo DB. Mỗi test tạo một DB trống riêng (`<DB của TEST_DATABASE_URL>_k20_<ca>_<pid>`) rồi xoá:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-jobs --test scheduler -- --ignored`

use std::sync::Arc;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_jobs::{JobSpec, Scheduler, TickStatus, ensure_job_tables};
use trinity_kernel::ownership::Ownership;

const SETUP: &str = "
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
";

const JOB: &str = "test.job";

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
    /// `companies`: id các công ty đang hoạt động ngoài công ty 1 (chỉ khi `multi`).
    async fn new(case: &str, companies: &[i32], multi: bool) -> Self {
        let base = base_url();
        let dbname = base
            .split_once('?')
            .map_or(base.as_str(), |(h, _)| h)
            .rsplit_once('/')
            .map(|(_, d)| d.to_owned())
            .unwrap();
        let name = format!("{dbname}_k20_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        let mut c = PgConnection::connect(&url).await.unwrap();
        exec(&mut c, SETUP).await;
        let t = Self { name, url };
        if multi {
            let (db, platform) = t.db(true, 4);
            platform.ensure().await.unwrap();
            for id in companies {
                exec(
                    &mut c,
                    &format!("INSERT INTO platform.companies (id, name, schema_name) VALUES ({id}, 'c{id}', 'c_{id}')"),
                )
                .await;
            }
            ensure_job_tables(&db).await.unwrap();
            db.close().await;
        }
        t
    }

    fn db(&self, multi: bool, pool: u32) -> (Db, Platform) {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.multi_tenant = multi;
        cfg.pool_size = pool;
        cfg.acquire_timeout = Duration::from_secs(10);
        let db = Db::connect_lazy(&cfg).unwrap();
        let platform = Platform::new(&db, None);
        (db, platform)
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

fn owned() -> Ownership {
    Ownership::parse(&format!(r#"{{"jobs": {{"{JOB}": "rust"}}}}"#), "test").unwrap()
}

fn scheduler(t: &TestDb, multi: bool, node: &str, own: Ownership) -> (Scheduler, Db) {
    let (db, platform) = t.db(multi, 4);
    (Scheduler::new(&db, &platform, own, node), db)
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn a_hai_tien_trinh_khong_chay_trung_mot_job_cho_mot_cong_ty() {
    let t = TestDb::new("a", &[2], true).await;
    // Công ty 1 luôn có trong danh sách: khoá nó lại để chỉ còn công ty 2.
    exec(
        &mut t.conn().await,
        "UPDATE platform.companies SET status = 'suspended' WHERE id = 1",
    )
    .await;
    let runs = Arc::new(AtomicUsize::new(0));
    let (s1, db1) = scheduler(&t, true, "node-1", owned());
    let (s2, db2) = scheduler(&t, true, "node-2", owned());
    for s in [&s1, &s2] {
        let runs = runs.clone();
        s.register(JobSpec::new(
            JOB,
            Duration::from_secs(60),
            Duration::from_secs(5),
            move |_| {
                let runs = runs.clone();
                async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    Ok(())
                }
            },
        ));
    }
    let (r1, r2) = tokio::join!(s1.tick(JOB), s2.tick(JOB));
    let (r1, r2) = (r1.unwrap(), r2.unwrap());
    assert_eq!(runs.load(Ordering::SeqCst), 1, "{r1:?} {r2:?}");
    let all: Vec<_> = r1
        .outcomes
        .iter()
        .chain(&r2.outcomes)
        .map(|o| o.status.clone())
        .collect();
    assert_eq!(all.iter().filter(|s| **s == TickStatus::Ran).count(), 1);
    assert_eq!(all.iter().filter(|s| **s == TickStatus::Busy).count(), 1);
    db1.close().await;
    db2.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn b_cong_ty_loi_khong_chan_cong_ty_khac() {
    let t = TestDb::new("b", &[2, 3, 4], true).await;
    let (s, db) = scheduler(&t, true, "node-1", owned());
    s.register(JobSpec::new(
        JOB,
        Duration::from_secs(60),
        Duration::from_secs(5),
        |c| async move { if c.id() == 3 { Err("hỏng".to_owned()) } else { Ok(()) } },
    ));
    let r = s.tick(JOB).await.unwrap();
    assert_eq!(r.ran(), vec![1, 2, 4]);
    let failed: Vec<_> = r.failed().map(|o| o.company).collect();
    assert_eq!(failed, vec![3]);
    let err: Option<String> =
        sqlx::query_scalar("SELECT last_error FROM platform.job_runs WHERE job = $1 AND company_id = 3")
            .bind(JOB)
            .fetch_one(&mut t.conn().await)
            .await
            .unwrap();
    assert_eq!(err.as_deref(), Some("hỏng"));
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn c_het_budget_thi_luot_sau_tiep_tuc_dung_cho() {
    let t = TestDb::new("c", &[2, 3], true).await; // công ty 1, 2, 3
    let (s, db) = scheduler(&t, true, "node-1", owned());
    // Mỗi công ty 80 ms, budget 100 ms ⇒ phần bắt đầu mới là 60 ms: mỗi lượt chỉ kịp một công ty.
    s.register(JobSpec::new(
        JOB,
        Duration::from_secs(60),
        Duration::from_millis(100),
        |_| async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            Ok(())
        },
    ));
    let mut seen = Vec::new();
    for _ in 0..4 {
        let r = s.tick(JOB).await.unwrap();
        assert!(r.budget_exhausted);
        seen.push(r.ran());
    }
    assert_eq!(seen, vec![vec![1], vec![2], vec![3], vec![1]]);
    assert_eq!(s.cursor(JOB), Some(1));
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn d_huy_task_giua_chung_thi_qua_locked_until_van_chay() {
    let t = TestDb::new("d", &[], true).await; // chỉ công ty 1
    let (s, db) = scheduler(&t, true, "node-1", owned());
    let calls = Arc::new(AtomicI32::new(0));
    {
        let calls = calls.clone();
        s.register(JobSpec::new(
            JOB,
            Duration::from_secs(60),
            Duration::from_millis(800),
            move |_| {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                    Ok(())
                }
            },
        ));
    }
    let task = {
        let s = s.clone();
        tokio::spawn(async move { s.tick(JOB).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    task.abort();
    let _ = task.await;
    // Còn trong thời hạn thuê: bỏ qua.
    let r = s.tick(JOB).await.unwrap();
    assert_eq!(r.outcomes[0].status, TickStatus::Busy, "{r:?}");
    // Quá `locked_until`: chạy lại.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let r = s.tick(JOB).await.unwrap();
    assert_eq!(r.ran(), vec![1], "{r:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn e_khong_giu_ket_noi_pool_khi_job_dang_cho() {
    let t = TestDb::new("e", &[2], true).await;
    let (db, platform) = t.db(true, 2);
    let s = Scheduler::new(&db, &platform, owned(), "node-1");
    let in_use = Arc::new(AtomicUsize::new(usize::MAX));
    {
        let (db, in_use) = (db.clone(), in_use.clone());
        s.register(JobSpec::new(
            JOB,
            Duration::from_secs(60),
            Duration::from_secs(5),
            move |_| {
                let (db, in_use) = (db.clone(), in_use.clone());
                async move {
                    // Như gọi mạng: chờ lâu, rồi đo số kết nối đang bị mượn (kích thước pool trừ kết nối rảnh).
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    let pool = db.raw_pool();
                    in_use.fetch_min(pool.size() as usize - pool.num_idle(), Ordering::SeqCst);
                    Ok(())
                }
            },
        ));
    }
    let r = s.tick(JOB).await.unwrap();
    assert!(r.failed().next().is_none(), "{r:?}");
    assert_eq!(in_use.load(Ordering::SeqCst), 0);
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn f_chu_cua_job_doc_tu_tep_so_huu_va_tep_hong_giu_bang_cu() {
    let t = TestDb::new("f", &[], true).await;
    let (s, db) = scheduler(&t, true, "node-1", Ownership::default());
    let runs = Arc::new(AtomicUsize::new(0));
    {
        let runs = runs.clone();
        s.register(JobSpec::new(
            JOB,
            Duration::from_secs(60),
            Duration::from_secs(5),
            move |_| {
                let runs = runs.clone();
                async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            },
        ));
    }
    assert!(s.tick(JOB).await.unwrap().not_owner);
    assert_eq!(runs.load(Ordering::SeqCst), 0);

    let dir = std::env::temp_dir().join(format!("trinity-k20-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("own.json");
    std::fs::write(&file, format!(r#"{{"jobs": {{"{JOB}": "rust"}}}}"#)).unwrap();
    s.reload_ownership(&file).unwrap();
    assert_eq!(s.tick(JOB).await.unwrap().ran(), vec![1]);
    // Tệp hỏng: lỗi, giữ bảng cũ (Rust vẫn là chủ).
    std::fs::write(&file, "{ hỏng").unwrap();
    assert!(s.reload_ownership(&file).is_err());
    assert_eq!(s.tick(JOB).await.unwrap().ran(), vec![1]);
    // Giao lại cho Node.
    std::fs::write(&file, format!(r#"{{"jobs": {{"{JOB}": "node"}}}}"#)).unwrap();
    s.reload_ownership(&file).unwrap();
    assert!(s.tick(JOB).await.unwrap().not_owner);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
    let _ = std::fs::remove_dir_all(&dir);
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn g_ban_mot_cong_ty_co_job_runs_va_chi_chay_cong_ty_1() {
    let t = TestDb::new("g", &[], false).await;
    let (db, platform) = t.db(false, 4);
    ensure_job_tables(&db).await.unwrap();
    ensure_job_tables(&db).await.unwrap(); // idempotent
    let s = Scheduler::new(&db, &platform, owned(), "node-1");
    s.register(JobSpec::new(
        JOB,
        Duration::from_secs(60),
        Duration::from_secs(5),
        |_| async { Ok(()) },
    ));
    assert_eq!(s.tick(JOB).await.unwrap().ran(), vec![1]);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.job_runs")
        .fetch_one(&mut t.conn().await)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let has_companies: bool = sqlx::query_scalar("SELECT to_regclass('platform.companies') IS NOT NULL")
        .fetch_one(&mut t.conn().await)
        .await
        .unwrap();
    assert!(!has_companies, "bản một công ty không có bảng công ty");
    db.close().await;
}
