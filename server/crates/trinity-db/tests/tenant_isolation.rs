//! X09: cô lập giữa các công ty trên Postgres thật (PLAN 10.2, mục "Đa công ty"), port từ
//! `tenant-isolation.pg.spec.ts`: id trùng giữa công ty, B không chạm được dòng của A dù đoán id,
//! email thuộc công ty khác, công ty bị tạm ngưng, công ty không tồn tại, số công ty lớn hơn pool.
//!
//! Cần Postgres và quyền tạo DB; mỗi test tạo một DB trống riêng (`<DB của TEST_DATABASE_URL>_x09_<ca>_<pid>`):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test tenant_isolation -- --ignored`

use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::migrate;
use trinity_db::platform::{Platform, PlatformError};
use trinity_db::provision::{ProvisionInput, provision_company};
use trinity_db::{CompanyRef, Db, DbConfig, DbError};

/// Dàn dựng tối thiểu của schema `public` (đủ cho `ensure` và `provision_company`).
const SETUP: &str = "
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
";

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
        let name = format!("{dbname}_x09_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        let mut c = PgConnection::connect(&url).await.unwrap();
        exec(&mut c, SETUP).await;
        Self { name, url }
    }

    /// Một `Db` mới mỗi lần gọi: cổng kiểm công ty có cache theo `Db`, nên đổi trạng thái công ty rồi gọi lại.
    fn db(&self, pool: u32) -> (Db, Platform) {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.multi_tenant = true;
        cfg.pool_size = pool;
        cfg.acquire_timeout = Duration::from_secs(20);
        cfg.statement_timeout = Duration::ZERO;
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

fn input(email: &str) -> ProvisionInput {
    ProvisionInput {
        company_name: "Công ty Thử".to_owned(),
        admin_email: email.to_owned(),
        admin_password: "mat-khau-thu-123".to_owned(),
        admin_name: "Quản trị Thử".to_owned(),
    }
}

/// Tạo `n` công ty qua đường đăng ký thật (`c_2`, `c_3`, …) (khách chèn riêng bằng `seed_contacts`).
async fn provision(t: &TestDb, n: usize) -> (Db, Platform, Vec<CompanyRef>) {
    let (db, platform) = t.db(4);
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();
    let mut companies = Vec::new();
    for i in 0..n {
        let res = provision_company(&db, &platform, &migrations, latest, &input(&format!("Chu{i}@Thu.vn")))
            .await
            .unwrap();
        companies.push(res.company);
    }
    (db, platform, companies)
}

async fn seed_contacts(db: &Db, company: CompanyRef, secret: &str) {
    let tdb = db.tenant(company).await.unwrap();
    let mut tx = tdb.begin().await.unwrap();
    for (id, phone) in [(1, "0911000001"), (2, "0911000002")] {
        sqlx::query(
            "INSERT INTO contacts (id, phone, full_name, updated_at) VALUES ($1, $2, $3, now())",
        )
        .bind(id)
        .bind(phone)
        .bind(format!("{secret} {id}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

async fn name_of(db: &Db, company: CompanyRef, id: i32) -> Option<String> {
    let tdb = db.tenant(company).await.unwrap();
    let mut c = tdb.acquire().await.unwrap();
    sqlx::query_scalar("SELECT full_name FROM contacts WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn a_id_trung_giua_cong_ty_va_b_khong_cham_duoc_dong_cua_a() {
    let t = TestDb::new("a").await;
    let (db, _platform, cs) = provision(&t, 2).await;
    let (a, b) = (cs[0], cs[1]);
    assert_ne!(a.id(), b.id());
    seed_contacts(&db, a, "Bí mật của A").await;
    seed_contacts(&db, b, "Bí mật của B").await;

    // Cùng id 1 và 2 ở hai công ty, mỗi bên chỉ thấy dòng của mình.
    assert_eq!(name_of(&db, a, 1).await.as_deref(), Some("Bí mật của A 1"));
    assert_eq!(name_of(&db, b, 1).await.as_deref(), Some("Bí mật của B 1"));

    // B đoán id: sửa, xoá, đếm theo số điện thoại của A đều không trúng dòng của A.
    let tb = db.tenant(b).await.unwrap();
    let mut c = tb.acquire().await.unwrap();
    let hit = sqlx::query("UPDATE contacts SET full_name = 'hacked' WHERE phone = '0911000001' AND full_name LIKE '%A%'")
        .execute(&mut *c)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(hit, 0);
    let hit = sqlx::query("DELETE FROM contacts WHERE full_name LIKE 'Bí mật của A%'")
        .execute(&mut *c)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(hit, 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM contacts")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n, 2, "B chỉ thấy 2 dòng của mình");
    // `search_path` của kết nối B chỉ có schema của B.
    let path: String = sqlx::query_scalar("SELECT current_schemas(false)::text")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(path.contains(&b.schema()) && !path.contains(&a.schema()), "{path}");
    drop(c);

    // Dòng của A còn nguyên sau mọi thao tác của B.
    assert_eq!(name_of(&db, a, 1).await.as_deref(), Some("Bí mật của A 1"));
    assert_eq!(name_of(&db, a, 2).await.as_deref(), Some("Bí mật của A 2"));

    // Sửa id 1 ở A không đổi id 1 của B.
    let ta = db.tenant(a).await.unwrap();
    let mut c = ta.acquire().await.unwrap();
    sqlx::query("UPDATE contacts SET full_name = 'A đổi' WHERE id = 1")
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    assert_eq!(name_of(&db, b, 1).await.as_deref(), Some("Bí mật của B 1"));
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn b_email_thuoc_cong_ty_khac_bi_tu_choi_va_dang_nhap_dinh_tuyen_dung() {
    let t = TestDb::new("b").await;
    let (db, platform, cs) = provision(&t, 2).await;
    let (a, b) = (cs[0], cs[1]);

    // Đăng nhập định tuyến theo email, không phân biệt hoa thường và khoảng trắng.
    assert_eq!(platform.company_for_email("chu0@thu.vn").await.unwrap(), Some(a.id()));
    assert_eq!(platform.company_for_email("  CHU1@thu.VN ").await.unwrap(), Some(b.id()));
    assert_eq!(platform.company_for_email("la@thu.vn").await.unwrap(), None);

    // Email của B không dùng được ở A (409 với đúng câu hiện có); email của chính A thì qua.
    match platform.assert_email_available("chu1@thu.vn", a).await {
        Err(PlatformError::Conflict(m)) => {
            assert_eq!(m, "Email này đã được dùng cho một công ty khác trên Trinity");
        }
        other => panic!("{other:?}"),
    }
    platform.assert_email_available("chu0@thu.vn", a).await.unwrap();
    platform.assert_email_available("moi@thu.vn", a).await.unwrap();

    // Đăng ký lại bằng email đã có ở công ty khác: bị từ chối, không để lại công ty thứ ba.
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();
    let again = provision_company(&db, &platform, &migrations, latest, &input("CHU1@thu.vn")).await;
    assert!(again.is_err(), "{again:?}");
    let mut c = t.conn().await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.companies WHERE id <> 1")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(n, 2);
    db.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn c_cong_ty_tam_ngung_va_khong_ton_tai_bi_chan_cong_ty_khac_van_chay() {
    let t = TestDb::new("c").await;
    let (db, _platform, cs) = provision(&t, 2).await;
    let (a, b) = (cs[0], cs[1]);
    seed_contacts(&db, a, "A").await;
    seed_contacts(&db, b, "B").await;
    db.close().await;

    let mut c = t.conn().await;
    exec(&mut c, &format!("UPDATE platform.companies SET status = 'suspended' WHERE id = {}", a.id())).await;

    // `Db` mới (cổng kiểm cache theo `Db`) và `Platform` mới (cache công ty).
    let (db, platform) = t.db(4);
    match db.tenant(a).await {
        Err(DbError::CompanyInactive { company, status }) => {
            assert_eq!(company, a.id());
            assert_eq!(status, "suspended");
        }
        other => panic!("{other:?}"),
    }
    assert!(platform.active_company(i64::from(a.id())).await.unwrap().is_none());
    let active = platform.list_active_companies().await.unwrap();
    assert!(active.iter().all(|c| c.id() != a.id()) && active.iter().any(|c| c.id() == b.id()));
    // Công ty B không bị ảnh hưởng.
    assert_eq!(name_of(&db, b, 1).await.as_deref(), Some("B 1"));

    // Công ty không tồn tại (id giả, id ngoài i32, id không dương).
    assert!(db.tenant(CompanyRef::new(9999).unwrap()).await.is_err());
    assert!(platform.active_company(9999).await.unwrap().is_none());
    assert!(platform.active_company(i64::from(i32::MAX) + 1).await.unwrap().is_none());
    assert!(platform.active_company(0).await.unwrap().is_none());
    assert!(platform.active_company(-3).await.unwrap().is_none());
    assert!(CompanyRef::new(0).is_err());

    // Mở lại thì dùng được và dữ liệu còn nguyên.
    exec(&mut c, &format!("UPDATE platform.companies SET status = 'active' WHERE id = {}", a.id())).await;
    let (db2, _p2) = t.db(4);
    assert_eq!(name_of(&db2, a, 1).await.as_deref(), Some("A 1"));
    db.close().await;
    db2.close().await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn d_nhieu_cong_ty_hon_pool_xen_ke_khong_lan_du_lieu() {
    let t = TestDb::new("d").await;
    // 5 công ty trên pool 2 kết nối: mỗi kết nối phục vụ nhiều công ty liên tiếp.
    let (db, platform) = t.db(2);
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();
    let mut cs = Vec::new();
    for i in 0..5 {
        let r = provision_company(&db, &platform, &migrations, latest, &input(&format!("p{i}@thu.vn")))
            .await
            .unwrap();
        cs.push(r.company);
        seed_contacts(&db, r.company, &format!("Công ty {}", r.company.id())).await;
    }
    let mut tasks = Vec::new();
    for round in 0..60usize {
        let db = db.clone();
        let company = cs[round % cs.len()];
        tasks.push(tokio::spawn(async move {
            let got = name_of(&db, company, 1 + (round % 2) as i32).await;
            (company, round, got)
        }));
    }
    for task in tasks {
        let (company, round, got) = task.await.unwrap();
        let want = format!("Công ty {} {}", company.id(), 1 + round % 2);
        assert_eq!(got.as_deref(), Some(want.as_str()));
    }
    db.close().await;
}
