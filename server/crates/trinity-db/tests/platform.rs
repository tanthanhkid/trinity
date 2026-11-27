//! K08: schema `platform`, trigger đồng bộ `trinity-sync-v3` và tra cứu định tuyến (PLAN 1.5, 4.5).
//!
//! Cần Postgres và quyền tạo DB (CI: user `test` là superuser). Mỗi test tạo một DB trống riêng
//! (`<DB của TEST_DATABASE_URL>_k08_<ca>_<pid>`), dàn dựng bằng `fixtures/platform-setup.sql` rồi xoá:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-db --test platform -- --ignored`
//!
//! Bản đóng băng `fixtures/platform-schema.txt` do mã Node sinh (`scripts/gen-platform-fixture.cjs`); test chạy cùng
//! dàn dựng với mã Rust và so từng byte.

use std::time::Duration;

use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::platform::{
    EMAIL_TAKEN_TRIGGER_MESSAGE, Platform, PlatformError, ROUTE_TAKEN_TRIGGER_MESSAGE, RouteKind,
    conflict_from_trigger, install_sync_triggers,
};
use trinity_db::{CompanyRef, Db, DbConfig};

const SETUP: &str = include_str!("fixtures/platform-setup.sql");
const SNAPSHOT: &str = include_str!("fixtures/platform-snapshot.sql");
const FROZEN: &str = include_str!("fixtures/platform-schema.txt");

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

/// URL của DB khác trên cùng máy chủ.
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

/// DB trống riêng cho một ca, đã chạy `platform-setup.sql`. Drop thì xoá DB.
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
        let name = format!("{dbname}_k08_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        let mut c = PgConnection::connect(&url).await.unwrap();
        exec(&mut c, SETUP).await;
        Self { name, url }
    }

    fn db(&self, multi_tenant: bool) -> Db {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.multi_tenant = multi_tenant;
        cfg.pool_size = 4;
        cfg.acquire_timeout = Duration::from_secs(5);
        Db::connect_lazy(&cfg).unwrap()
    }

    async fn conn(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.unwrap()
    }
}

/// Xoá DB của ca kể cả khi test panic (Drop không await được: chạy trên luồng riêng với runtime riêng).
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
                    let _ = try_exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
                }
            });
        })
        .join();
    }
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn try_exec(c: &mut PgConnection, sql: &str) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .map(|_| ())
}

fn co(id: i64) -> CompanyRef {
    CompanyRef::new(id).unwrap()
}

/// `ensure` rồi ghi công ty 2 (`c_2`) và cài trigger cho nó, như script Node.
async fn platform_with_company_2(t: &TestDb) -> (Db, Platform) {
    let db = t.db(true);
    let p = Platform::new(&db, None);
    p.ensure().await.unwrap();
    let mut tx = db.platform().begin().await.unwrap();
    exec(
        &mut tx,
        "INSERT INTO platform.companies (id, name, schema_name) VALUES (2, 'Công ty B', 'c_2')",
    )
    .await;
    install_sync_triggers(&mut tx, co(2)).await.unwrap();
    tx.commit().await.unwrap();
    (db, p)
}

async fn snapshot(t: &TestDb) -> String {
    let mut c = t.conn().await;
    exec(&mut c, "SET search_path TO pg_catalog").await;
    let lines: Vec<String> = sqlx::query_scalar(AssertSqlSafe(SNAPSHOT.to_owned()))
        .fetch_all(&mut c)
        .await
        .unwrap();
    lines.join("\n") + "\n"
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn a_schema_platform_khop_ban_dong_bang_cua_node() {
    let t = TestDb::new("a").await;
    let (db, _) = platform_with_company_2(&t).await;
    let got = snapshot(&t).await;
    assert_eq!(got, FROZEN, "schema platform lệch bản đóng băng (Node)");

    // Gọi lại (tiến trình khác boot): không đổi gì, không cài lại trigger.
    let mut c = t.conn().await;
    let before: i64 = sqlx::query_scalar("SELECT max(oid::int8) FROM pg_trigger")
        .fetch_one(&mut c)
        .await
        .unwrap();
    // Nhiều lời gọi đồng thời trên một Platform: một lần chạy (single-flight), đều thành công.
    let p2 = Platform::new(&db, Some("Tên khác"));
    let (r1, r2, r3) = tokio::join!(p2.ensure(), p2.ensure(), p2.ensure());
    r1.unwrap();
    r2.unwrap();
    r3.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT max(oid::int8) FROM pg_trigger")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(before, after, "boot lại không được cài lại trigger");
    assert_eq!(snapshot(&t).await, FROZEN);
    db.close().await;
    drop(c);
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn b_hai_cong_ty_cung_email_hoac_cung_page_loi_dung_cau() {
    let t = TestDb::new("b").await;
    let (db, p) = platform_with_company_2(&t).await;
    let mut c = t.conn().await;

    // Email của công ty 1 (chép bù, chữ hoa trong public.users) không thêm được vào công ty 2.
    let e = try_exec(&mut c, "INSERT INTO c_2.users (email) VALUES ('OWNER@example.com')")
        .await
        .unwrap_err();
    assert!(e.to_string().contains("TRINITY_EMAIL_TAKEN"), "{e}");
    assert_eq!(conflict_from_trigger(&e), Some(EMAIL_TAKEN_TRIGGER_MESSAGE));
    assert_eq!(
        EMAIL_TAKEN_TRIGGER_MESSAGE,
        "Email này đã được dùng cho một công ty khác trên Trinity"
    );
    match p.assert_email_available(" Owner@Example.com ", co(2)).await {
        Err(PlatformError::Conflict(m)) => {
            assert_eq!(m, "Email này đã được dùng cho một công ty khác trên Trinity");
        }
        other => panic!("{other:?}"),
    }
    p.assert_email_available("owner@example.com", co(1)).await.unwrap();
    p.assert_email_available("moi@example.com", co(2)).await.unwrap();

    // Page / OA của công ty 1 không kết nối được ở công ty 2.
    for (sql, kind, ext, msg) in [
        (
            "INSERT INTO c_2.facebook_pages (page_id) VALUES ('page-public-1')",
            RouteKind::FacebookPage,
            "page-public-1",
            "Trang Facebook này đã được một công ty khác kết nối với Trinity",
        ),
        (
            "INSERT INTO c_2.zalo_oa_connections (oa_id) VALUES ('oa-public-1')",
            RouteKind::ZaloOa,
            "oa-public-1",
            "Zalo OA này đã được một công ty khác kết nối với Trinity",
        ),
    ] {
        let e = try_exec(&mut c, sql).await.unwrap_err();
        assert!(e.to_string().contains("TRINITY_ROUTE_TAKEN"), "{e}");
        assert_eq!(conflict_from_trigger(&e), Some(ROUTE_TAKEN_TRIGGER_MESSAGE));
        match p.assert_route_available(kind, ext, co(2)).await {
            Err(PlatformError::Conflict(m)) => assert_eq!(m, msg),
            other => panic!("{other:?}"),
        }
        p.assert_route_available(kind, ext, co(1)).await.unwrap();
        assert_eq!(p.company_for_route(kind, ext).await.unwrap(), Some(1));
    }
    assert_eq!(
        ROUTE_TAKEN_TRIGGER_MESSAGE,
        "Trang/kênh này đã được một công ty khác kết nối với Trinity"
    );

    // Đồng bộ chiều thuận: thêm, đổi, xoá ở công ty 2.
    exec(&mut c, "INSERT INTO c_2.users (email) VALUES ('Sale@B.vn')").await;
    assert_eq!(p.company_for_email("  sale@b.VN ").await.unwrap(), Some(2));
    exec(
        &mut c,
        "UPDATE c_2.users SET email = 'sale2@b.vn' WHERE email = 'Sale@B.vn'",
    )
    .await;
    assert_eq!(p.company_for_email("sale@b.vn").await.unwrap(), None);
    assert_eq!(p.company_for_email("sale2@b.vn").await.unwrap(), Some(2));
    exec(&mut c, "DELETE FROM c_2.users WHERE email = 'sale2@b.vn'").await;
    assert_eq!(p.company_for_email("sale2@b.vn").await.unwrap(), None);
    exec(&mut c, "INSERT INTO c_2.facebook_pages (page_id) VALUES ('page-b')").await;
    assert_eq!(
        p.company_for_route(RouteKind::FacebookPage, "page-b").await.unwrap(),
        Some(2)
    );
    // Công ty 1 cũng bị chặn theo chiều ngược lại.
    let e = try_exec(&mut c, "INSERT INTO public.facebook_pages (page_id) VALUES ('page-b')")
        .await
        .unwrap_err();
    assert_eq!(conflict_from_trigger(&e), Some(ROUTE_TAKEN_TRIGGER_MESSAGE));

    // Tra cứu công ty.
    assert_eq!(p.active_company(2).await.unwrap(), Some(co(2)));
    assert_eq!(p.active_company(9).await.unwrap(), None);
    assert_eq!(p.active_company(0).await.unwrap(), None);
    assert_eq!(p.list_active_companies().await.unwrap(), vec![co(1), co(2)]);
    exec(
        &mut c,
        "UPDATE platform.companies SET status = 'suspended' WHERE id = 2",
    )
    .await;
    assert_eq!(
        p.active_company(2).await.unwrap(),
        Some(co(2)),
        "cache 30 giây như Node"
    );
    p.forget_company(Some(2));
    assert_eq!(p.active_company(2).await.unwrap(), None);
    assert_eq!(p.list_active_companies().await.unwrap(), vec![co(1)]);
    let row = p.company(1).await.unwrap().unwrap();
    assert_eq!(
        (row.name.as_str(), row.schema_name.as_str()),
        ("Công ty mặc định", "public")
    );

    db.close().await;
    drop(c);
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn c_oauth_state_nhan_ma_va_khoa_kenh() {
    let t = TestDb::new("c").await;
    let (db, p) = platform_with_company_2(&t).await;
    let mut c = t.conn().await;

    // OAuth state: nhớ công ty mở luồng; cắt 255 đơn vị; state quá 1 ngày bị dọn.
    let long = "s".repeat(300);
    p.remember_oauth_state(&long, co(2)).await.unwrap();
    assert_eq!(p.company_for_oauth_state(&long).await.unwrap(), Some(2));
    assert_eq!(p.company_for_oauth_state(&"s".repeat(255)).await.unwrap(), Some(2));
    assert_eq!(p.company_for_oauth_state("").await.unwrap(), None);
    p.remember_oauth_state("st-old", co(1)).await.unwrap();
    exec(
        &mut c,
        "UPDATE platform.company_routes SET created_at = now() - interval '25 hours' WHERE external_id = 'st-old'",
    )
    .await;
    p.remember_oauth_state("st-new", co(1)).await.unwrap();
    assert_eq!(p.company_for_oauth_state("st-old").await.unwrap(), None);
    assert_eq!(p.company_for_oauth_state("st-new").await.unwrap(), Some(1));

    // Slug trang bán hàng: công ty đầu thắng, slug viết thường; nhận lại của mình không lỗi.
    p.claim_route(RouteKind::StoreSlug, "Shop-A", co(1)).await.unwrap();
    p.claim_route(RouteKind::StoreSlug, "shop-a", co(1)).await.unwrap();
    // Công ty 1 còn dùng slug (settings) ⇒ công ty 2 bị từ chối, kể cả khi mã đã cũ.
    exec(
        &mut c,
        r#"INSERT INTO public.settings (key, value) VALUES ('online_store', '{"slug":" Shop-A "}');
           UPDATE platform.company_routes SET created_at = now() - interval '3 minutes' WHERE kind = 'store_slug'"#,
    )
    .await;
    match p.claim_route(RouteKind::StoreSlug, "SHOP-A", co(2)).await {
        Err(PlatformError::Conflict(m)) => {
            assert_eq!(
                m,
                "Địa chỉ trang bán hàng này đã có công ty khác dùng — chọn địa chỉ khác"
            );
        }
        other => panic!("{other:?}"),
    }
    // Công ty 1 bỏ slug ⇒ mã mồ côi, công ty 2 nhận được.
    exec(&mut c, "DELETE FROM public.settings WHERE key = 'online_store'").await;
    p.claim_route(RouteKind::StoreSlug, "shop-a", co(2)).await.unwrap();
    assert_eq!(
        p.company_for_route(RouteKind::StoreSlug, "shop-a").await.unwrap(),
        Some(2)
    );
    // Nhả bằng cùng cách chuẩn hoá (chữ hoa vẫn nhả được), rồi nhận lại.
    p.release_route(RouteKind::StoreSlug, "SHOP-A", co(2)).await.unwrap();
    assert_eq!(p.company_for_route(RouteKind::StoreSlug, "shop-a").await.unwrap(), None);
    p.claim_route(RouteKind::StoreSlug, "Shop-A", co(2)).await.unwrap();
    // Mã vừa nhận (dưới 2 phút) không bị chiếm dù bên giữ chưa lưu dòng trang bán hàng.
    p.claim_route(RouteKind::StoreSlug, "moi-nhan", co(1)).await.unwrap();
    match p.claim_route(RouteKind::StoreSlug, "moi-nhan", co(2)).await {
        Err(PlatformError::Conflict(m)) => {
            assert_eq!(
                m,
                "Địa chỉ trang bán hàng này đã có công ty khác dùng — chọn địa chỉ khác"
            );
        }
        other => panic!("{other:?}"),
    }
    // Nhả: chỉ mã của mình.
    p.release_route(RouteKind::StoreSlug, "moi-nhan", co(2)).await.unwrap();
    assert_eq!(
        p.company_for_route(RouteKind::StoreSlug, "moi-nhan").await.unwrap(),
        Some(1)
    );
    p.release_route(RouteKind::StoreSlug, "moi-nhan", co(1)).await.unwrap();
    assert_eq!(
        p.company_for_route(RouteKind::StoreSlug, "moi-nhan").await.unwrap(),
        None
    );
    assert!(matches!(
        p.claim_route(RouteKind::FacebookPage, "x", co(1)).await,
        Err(PlatformError::WrongKind(RouteKind::FacebookPage))
    ));

    // Khoá kênh.
    let l = p.channel_lock(2).await.unwrap();
    assert!(!l.locked && l.reason.is_none() && l.locked_at.is_none());
    assert!(p.set_channel_lock(2, true, Some("  ")).await.unwrap());
    let l = p.channel_lock(2).await.unwrap();
    assert!(l.locked && l.locked_at.is_some());
    assert_eq!(l.reason.as_deref(), Some("Chủ nền tảng tạm khoá kênh gửi ra ngoài"));
    assert!(p.set_channel_lock(2, true, Some(&"x".repeat(600))).await.unwrap());
    assert_eq!(p.channel_lock(2).await.unwrap().reason.unwrap().len(), 500);
    let all = p.list_channel_locks().await.unwrap();
    assert_eq!(all.len(), 2);
    assert!(all[1].lock.locked && !all[0].lock.locked);
    assert!(p.set_channel_lock(2, false, Some("bỏ qua")).await.unwrap());
    assert_eq!(p.channel_lock(2).await.unwrap(), Default::default());
    assert!(!p.set_channel_lock(99, true, None).await.unwrap());
    // Đổi ngoài tiến trình: cache 10 giây giữ giá trị cũ (như Node); tiến trình khác thấy ngay.
    assert!(!p.channel_lock(1).await.unwrap().locked);
    exec(
        &mut c,
        "UPDATE platform.companies SET channels_locked = true WHERE id = 1",
    )
    .await;
    assert!(!p.channel_lock(1).await.unwrap().locked);
    assert!(Platform::new(&db, None).channel_lock(1).await.unwrap().locked);

    db.close().await;
    drop(c);
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn d_trigger_mat_thi_cai_lai_va_chep_bu_ma_cai_dat() {
    let t = TestDb::new("d").await;
    let (db, _) = platform_with_company_2(&t).await;
    let mut c = t.conn().await;
    exec(
        &mut c,
        r#"DROP TRIGGER trinity_platform_sync_login ON c_2.users;
           INSERT INTO c_2.settings (key, value) VALUES ('online_store', '{"slug":" Shop-B "}');
           INSERT INTO platform.company_routes (kind, external_id, company_id, created_at)
             VALUES ('shopee_shop', 's-b', 2, now() - interval '1 hour'),
                    ('lazada_seller', 'l-b', 2, now() - interval '1 hour');"#,
    )
    .await;
    // Tiến trình mới boot: cài lại trigger c_2, chép bù slug, xoá loại route đã gỡ.
    let p = Platform::new(&db, None);
    p.ensure().await.unwrap();
    assert_eq!(
        snapshot(&t).await.lines().filter(|l| l.starts_with("trigger ")).count(),
        6
    );
    exec(&mut c, "INSERT INTO c_2.users (email) VALUES ('new@b.vn')").await;
    assert_eq!(p.company_for_email("new@b.vn").await.unwrap(), Some(2));
    assert_eq!(
        p.company_for_route(RouteKind::StoreSlug, "shop-b").await.unwrap(),
        Some(2)
    );
    // Loại route đã gỡ (G06) bị xoá hết.
    let mut c = t.conn().await;
    let left: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM platform.company_routes WHERE kind IN ('shopee_shop', 'lazada_seller')",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    assert_eq!(left, 0);
    db.close().await;
    drop(c);
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn f_backfill_slug_mo_coi_va_cong_ty_2_giu_truoc() {
    let t = TestDb::new("f").await;
    let (db, p) = platform_with_company_2(&t).await;
    let mut c = t.conn().await;
    // Công ty 2 giữ `dung-chung` từ trước (đã quá 2 phút) và vẫn dùng; công ty 1 sau đó cũng lưu cùng slug.
    // `mo-coi` (quá 2 phút) và `moi-nhan` (vừa nhận) đều không còn trang bán hàng nào dùng.
    exec(
        &mut c,
        r#"INSERT INTO c_2.settings (key, value) VALUES ('online_store', '{"slug":"Dung-Chung"}');
           INSERT INTO public.settings (key, value) VALUES ('online_store', '{"slug":" dung-chung "}');
           INSERT INTO platform.company_routes (kind, external_id, company_id, created_at)
             VALUES ('store_slug', 'dung-chung', 2, now() - interval '1 hour'),
                    ('store_slug', 'mo-coi', 2, now() - interval '1 hour');
           INSERT INTO platform.company_routes (kind, external_id, company_id)
             VALUES ('store_slug', 'moi-nhan', 2);"#,
    )
    .await;
    p.backfill_setting_routes().await.unwrap();
    // Ngược thứ tự id: công ty 2 giữ trước thì GIỮ (công ty 1 chép bù không đè được), công ty 1 không giành được.
    assert_eq!(
        p.company_for_route(RouteKind::StoreSlug, "dung-chung").await.unwrap(),
        Some(2)
    );
    // Mã mồ côi quá 2 phút bị dọn, mã vừa nhận được giữ.
    assert_eq!(p.company_for_route(RouteKind::StoreSlug, "mo-coi").await.unwrap(), None);
    assert_eq!(
        p.company_for_route(RouteKind::StoreSlug, "moi-nhan").await.unwrap(),
        Some(2)
    );
    // Chạy lại không đổi gì (idempotent).
    p.backfill_setting_routes().await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.company_routes WHERE kind = 'store_slug'")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(n, 2);
    db.close().await;
    drop(c);
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn e_ban_mot_cong_ty_khong_co_platform() {
    let t = TestDb::new("e").await;
    let db = t.db(false);
    let p = Platform::new(&db, Some("  Cửa hàng X "));
    p.ensure().await.unwrap();
    assert_eq!(p.company_for_email("ai@dau.vn").await.unwrap(), Some(1));
    assert_eq!(p.company_for_route(RouteKind::ZaloOa, "x").await.unwrap(), Some(1));
    assert_eq!(p.list_active_companies().await.unwrap(), vec![co(1)]);
    assert_eq!(p.company(1).await.unwrap().unwrap().name, "Cửa hàng X");
    assert!(p.company(2).await.unwrap().is_none());
    assert!(!p.channel_lock(1).await.unwrap().locked);
    assert!(matches!(
        p.set_channel_lock(1, true, None).await,
        Err(PlatformError::NotMultiTenant)
    ));
    p.assert_email_available("owner@example.com", co(1)).await.unwrap();
    let mut c = t.conn().await;
    let has: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'platform')")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert!(!has, "bản một công ty không tạo schema platform");
    db.close().await;
    drop(c);
}
