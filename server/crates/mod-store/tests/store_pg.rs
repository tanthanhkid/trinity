//! M56 trên Postgres thật, đa công ty (schema thật do `provision_company` migrate): giữ chỗ địa chỉ cửa hàng, trang công khai,
//! đặt đơn COD và chuyển khoản (QR VietQR), khách và ghi chú, sự kiện `store_order.*`, đơn theo phạm vi, giới hạn đặt đơn.
//!
//! Test tự tạo một DB trống (`<DB của TEST_DATABASE_URL>_m56_<pid>_<n>`), tạo hai công ty rồi xoá DB:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-store --test store_pg -- --ignored`

#![allow(clippy::result_large_err)]

use std::time::Duration;

use trinity_kernel::error::AppError;

use mod_store::settings::{self, StoreSettings};
use mod_store::shop::{self, OrderLimits, StoreError};
use mod_store::vietqr;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_db::platform::Platform;
use trinity_db::provision::{ProvisionInput, provision_company};
use trinity_db::{CompanyRef, Db, DbConfig, migrate};
use trinity_rbac::OwnerIds;

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
    query.map_or_else(|| format!("{server}/{db}"), |q| format!("{server}/{db}?{q}"))
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

struct Env {
    t: TestDb,
    db: Db,
    platform: Platform,
    a: CompanyRef,
    b: CompanyRef,
}

impl Env {
    /// Kết nối thường đã đặt `search_path` về schema công ty.
    async fn conn(&self, c: CompanyRef) -> PgConnection {
        let mut conn = PgConnection::connect(&self.t.url).await.unwrap();
        exec(&mut conn, &format!("SET search_path TO c_{}, public", c.id())).await;
        conn
    }

    async fn scalar(&self, c: CompanyRef, sql: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
            .fetch_one(&mut self.conn(c).await)
            .await
            .unwrap()
    }

    async fn tenant_conn(&self, c: CompanyRef) -> trinity_db::TenantConn {
        self.db.tenant(c).await.unwrap().acquire().await.unwrap()
    }
}

async fn env() -> Env {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let base = base_url();
    let dbname = base
        .split_once('?')
        .map_or(base.as_str(), |(h, _)| h)
        .rsplit_once('/')
        .map(|(_, d)| d.to_owned())
        .unwrap();
    let name = format!(
        "{dbname}_m56_{}_{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let mut admin = PgConnection::connect(&base).await.unwrap();
    exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
    exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
    let url = url_for(&name);
    let t = TestDb { name, url: url.clone() };
    exec(&mut PgConnection::connect(&url).await.unwrap(), SETUP).await;
    let mut cfg = DbConfig::new(url);
    cfg.multi_tenant = true;
    cfg.pool_size = 16;
    cfg.acquire_timeout = Duration::from_secs(30);
    cfg.statement_timeout = Duration::ZERO;
    let db = Db::connect_lazy(&cfg).unwrap();
    let platform = Platform::new(&db, None);
    let mk = |email: &str, name: &str| ProvisionInput {
        company_name: name.to_owned(),
        admin_email: email.to_owned(),
        admin_password: "mat-khau-thu-123".to_owned(),
        admin_name: format!("Chủ {name}"),
    };
    let migrations = migrate::embedded_migrations();
    let latest = migrate::latest_embedded();
    let a = provision_company(&db, &platform, &migrations, latest, &mk("a@m56.test", "Công ty A"))
        .await
        .unwrap()
        .company;
    let b = provision_company(&db, &platform, &migrations, latest, &mk("b@m56.test", "Công ty B"))
        .await
        .unwrap()
        .company;
    Env { t, db, platform, a, b }
}

fn input(v: &Value) -> serde_json::Map<String, Value> {
    v.as_object().unwrap().clone()
}

async fn save(e: &Env, c: CompanyRef, v: Value) -> Result<StoreSettings, trinity_kernel::error::AppError> {
    let mut conn = e.tenant_conn(c).await;
    settings::save(&mut conn, &e.platform, c, &input(&v), 1).await
}

async fn product(e: &Env, c: CompanyRef, code: &str, name: &str, price: Option<i64>, active: bool) -> i32 {
    sqlx::query_scalar(AssertSqlSafe(format!(
        "INSERT INTO c_{}.products (code, name, price, is_active, updated_at) VALUES ('{code}', '{name}', {}, {active}, now()) RETURNING id",
        c.id(),
        price.map_or("NULL".to_owned(), |p| p.to_string())
    )))
    .fetch_one(&mut e.conn(c).await)
    .await
    .unwrap()
}

async fn order(
    e: &Env,
    limits: &OrderLimits,
    c: CompanyRef,
    slug: &str,
    ip: &str,
    body: &Value,
) -> Result<shop::PlacedOrder, StoreError> {
    let mut conn = e.tenant_conn(c).await;
    shop::place_order(&mut conn, limits, true, slug, ip, body).await
}

/// Thông điệp của `AppError` như body phản hồi.
fn msg(e: AppError) -> String {
    match e.response(true).1.message {
        trinity_kernel::error::Message::One(s) => s,
        trinity_kernel::error::Message::Many(m) => m.join("; "),
    }
}

fn describe(e: StoreError) -> String {
    match e {
        StoreError::App(a) => msg(a),
        StoreError::RateLimited { retry_after_sec } => format!("429 {retry_after_sec}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn dia_chi_cua_hang_thuoc_mot_cong_ty() {
    let e = env().await;
    // A giữ địa chỉ; B không lấy được (409), kể cả viết hoa; B có địa chỉ khác thì được.
    let s = save(&e, e.a, json!({ "slug": "Cua-Hang-Ban-Dau", "name": "Shop A" }))
        .await
        .unwrap();
    assert_eq!((s.slug.as_str(), s.owner_user_id), ("cua-hang-ban-dau", Some(1)));
    let err = save(&e, e.b, json!({ "slug": "cua-hang-ban-dau", "name": "Shop B" }))
        .await
        .unwrap_err();
    assert_eq!(
        msg(err),
        "Địa chỉ trang bán hàng này đã có công ty khác dùng — chọn địa chỉ khác"
    );
    let err = save(&e, e.b, json!({ "slug": "CUA-HANG-BAN-DAU", "name": "Shop B" }))
        .await
        .unwrap_err();
    assert!(msg(err).contains("đã có công ty khác dùng"));
    save(&e, e.b, json!({ "slug": "shop-cua-b", "name": "Shop B" }))
        .await
        .unwrap();
    // Link công khai tìm công ty theo địa chỉ, không cần `?cid=`.
    use trinity_db::platform::RouteKind;
    assert_eq!(
        e.platform
            .company_for_route(RouteKind::StoreSlug, "cua-hang-ban-dau")
            .await
            .unwrap(),
        Some(e.a.id())
    );
    assert_eq!(
        e.platform
            .company_for_route(RouteKind::StoreSlug, "shop-cua-b")
            .await
            .unwrap(),
        Some(e.b.id())
    );
    // A đổi địa chỉ ⇒ nhả địa chỉ cũ; B lấy được.
    save(&e, e.a, json!({ "slug": "dia-chi-moi" })).await.unwrap();
    assert_eq!(
        e.platform
            .company_for_route(RouteKind::StoreSlug, "cua-hang-ban-dau")
            .await
            .unwrap(),
        None
    );
    save(&e, e.b, json!({ "slug": "cua-hang-ban-dau" })).await.unwrap();
    assert_eq!(
        e.platform
            .company_for_route(RouteKind::StoreSlug, "cua-hang-ban-dau")
            .await
            .unwrap(),
        Some(e.b.id())
    );
    // Lưu lại đúng địa chỉ của mình thì không sao; không đổi được giá trị client không được ghi.
    let s = save(
        &e,
        e.b,
        json!({ "slug": "cua-hang-ban-dau", "bank_notice": "x", "public_path": "/hack", "banks": [] }),
    )
    .await
    .unwrap();
    assert_eq!(s.bank_notice, None);
    let mut conn = e.tenant_conn(e.b).await;
    let view = settings::view(settings::load(&mut conn).await.unwrap(), true, e.b.id());
    assert_eq!(view.public_path, Some(format!("/s/cua-hang-ban-dau?cid={}", e.b.id())));
    assert_eq!(view.banks.len(), 45);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn dat_don_cod_chuyen_khoan_khach_va_su_kien() {
    let e = env().await;
    let a = e.a;
    let p1 = product(&e, a, "SP1", "Áo thun", Some(150_000), true).await;
    let p2 = product(&e, a, "SP2", "Quần jean", Some(300_000), true).await;
    let hidden = product(&e, a, "SP3", "Ẩn", Some(1000), false).await;
    let no_price = product(&e, a, "SP4", "Chưa giá", None, true).await;
    save(
        &e,
        a,
        json!({ "slug": "shop-m56", "name": "Shop M56", "cod": true, "bank_transfer": true, "bank_bin": "MBBank",
                 "bank_account": "0123456789", "bank_account_name": "NGUYEN VAN A", "published": true,
                 "product_ids": [p2, p1, hidden, no_price] }),
    )
    .await
    .unwrap();
    let limits = OrderLimits::default();
    let mut conn = e.tenant_conn(a).await;

    // Trang công khai: chỉ sản phẩm đang bán và có giá, đúng thứ tự cấu hình; cờ chuyển khoản có.
    let page = shop::public_store(&mut conn, true, "SHOP-M56").await.unwrap();
    assert_eq!(page.products.iter().map(|p| p.id).collect::<Vec<_>>(), vec![p2, p1]);
    assert!(page.payment.cod && page.payment.bank_transfer);
    // Tính năng tắt, sai địa chỉ ⇒ 404 như nhau.
    for r in [
        shop::public_store(&mut conn, false, "shop-m56").await,
        shop::public_store(&mut conn, true, "khac").await,
    ] {
        assert_eq!(msg(r.unwrap_err()), "Không có cửa hàng này.");
    }
    drop(conn);

    // Đơn COD: giá lấy từ danh mục (client gửi giá gian lận thì bỏ qua), sản phẩm ẩn/không giá bị bỏ.
    let body = json!({ "name": "  Trần Thị B ", "phone": "+84 912 345 678", "address": "1 Lê Lợi", "note": "giao giờ hành chính",
        "items": [ { "product_id": p1, "quantity": 2, "price": 1 }, { "product_id": p2, "quantity": 1 },
                   { "product_id": hidden, "quantity": 1 }, { "product_id": no_price, "quantity": 1 }, { "product_id": 999_999, "quantity": 1 } ] });
    let placed = order(&e, &limits, a, "shop-m56", "1.1.1.1", &body).await.unwrap();
    assert_eq!((placed.total, placed.payment_method.as_str()), (600_000, "cod"));
    assert!(placed.payment.is_none());
    assert!(
        placed.code.starts_with("DH-") && placed.code.len() == 9,
        "{}",
        placed.code
    );
    // Khách mới thuộc người phụ trách cấu hình; hồ sơ có ghi chú tạo từ trang và ghi chú đơn; sự kiện `store_order.created`.
    let a_count = |sql: String| {
        let e = &e;
        async move { e.scalar(a, &sql).await }
    };
    assert_eq!(
        a_count("SELECT count(*) FROM contacts WHERE phone = '0912345678'".into()).await,
        1
    );
    assert_eq!(
        a_count("SELECT assigned_to::bigint FROM contacts WHERE phone = '0912345678'".into()).await,
        1
    );
    assert_eq!(
        a_count("SELECT count(*) FROM activities WHERE details->>'source' = 'connector:store'".into()).await,
        1
    );
    let descr: String =
        sqlx::query_scalar("SELECT details->>'description' FROM activities WHERE details->>'source' = 'store'")
            .fetch_one(&mut e.conn(a).await)
            .await
            .unwrap();
    assert_eq!(
        descr,
        format!("Đơn online {} — 600.000đ (Áo thun ×2, Quần jean ×1) · COD", placed.code)
    );
    let ev: Value =
        sqlx::query_scalar("SELECT payload FROM integration_events WHERE event_type = 'store_order.created'")
            .fetch_one(&mut e.conn(a).await)
            .await
            .unwrap();
    assert_eq!(
        (
            ev["order"]["code"].as_str(),
            ev["order"]["total"].as_i64(),
            ev["order"]["contact_assigned_to"].as_i64()
        ),
        (Some(placed.code.as_str()), Some(600_000), Some(1))
    );
    assert_eq!(ev["order"]["items"][0]["name"], "Áo thun");
    let contact_events =
        a_count("SELECT count(*) FROM integration_events WHERE event_type = 'contact.created'".into()).await;
    assert_eq!(contact_events, 1);

    // Đặt lại cùng SĐT: không tạo khách thứ hai.
    order(
        &e,
        &limits,
        a,
        "shop-m56",
        "1.1.1.2",
        &json!({ "name": "B", "phone": "0912345678", "address": "x", "items": [{ "product_id": p1, "quantity": 1 }] }),
    )
    .await
    .unwrap();
    assert_eq!(
        a_count("SELECT count(*) FROM contacts WHERE phone = '0912345678'".into()).await,
        1
    );

    // Chuyển khoản: QR khớp hàm thuần, nội dung = mã đơn, đơn ở trạng thái mới (không tự khớp tiền); không cần địa chỉ.
    let bt = order(&e, &limits, a, "shop-m56", "1.1.1.3", &json!({ "name": "C", "phone": "0987654321", "payment_method": "bank_transfer", "items": [{ "product_id": p2, "quantity": 2 }] }))
        .await
        .unwrap();
    let pay = bt.payment.expect("có QR");
    assert_eq!(
        pay.qr_data,
        vietqr::build("970422", "0123456789", 600_000, &bt.code).unwrap()
    );
    assert_eq!(
        (
            pay.transfer_content.as_str(),
            pay.bank.bank.as_str(),
            pay.bank.account_name.as_deref()
        ),
        (bt.code.as_str(), "MBBank", Some("NGUYEN VAN A"))
    );
    assert!(pay.qr_data.contains(&format!("0809{}", bt.code)) || pay.qr_data.contains(&bt.code));
    assert_eq!(
        a_count(format!(
            "SELECT count(*) FROM store_orders WHERE code = '{}' AND status = 'new'",
            bt.code
        ))
        .await,
        1
    );

    // Kiểm đầu vào.
    let items = json!([{ "product_id": p1, "quantity": 1 }]);
    let cases = [
        (
            json!({ "name": "", "phone": "0912345678", "address": "x", "items": items }),
            "Vui lòng nhập họ tên.",
        ),
        (
            json!({ "name": "A", "phone": "123", "address": "x", "items": items }),
            "Số điện thoại không hợp lệ.",
        ),
        (
            json!({ "name": "A", "phone": "0912345678", "items": items }),
            "Vui lòng nhập địa chỉ giao hàng.",
        ),
        (
            json!({ "name": "A", "phone": "0912345678", "address": "x", "items": [] }),
            "Giỏ hàng trống hoặc sản phẩm không còn bán.",
        ),
        (
            json!({ "name": "A", "phone": "0912345678", "address": "x", "items": [{ "product_id": p1, "quantity": 100 }] }),
            "Giỏ hàng trống hoặc sản phẩm không còn bán.",
        ),
    ];
    for (i, (b, want)) in cases.iter().enumerate() {
        let err = order(&e, &limits, a, "shop-m56", &format!("2.2.2.{i}"), b)
            .await
            .unwrap_err();
        assert_eq!(describe(err), *want);
    }
    // Chuyển khoản dưới 1.000đ; cửa hàng chưa nhận chuyển khoản; không nhận COD.
    let cheap = product(&e, a, "SP5", "Rẻ", Some(500), true).await;
    save(&e, a, json!({ "product_ids": [p1, cheap] })).await.unwrap();
    let err = order(&e, &limits, a, "shop-m56", "3.3.3.1", &json!({ "name": "A", "phone": "0912345678", "payment_method": "bank_transfer", "items": [{ "product_id": cheap, "quantity": 1 }] })).await.unwrap_err();
    assert_eq!(describe(err), "Tổng đơn phải từ 1.000đ tới 10 tỷ để chuyển khoản.");
    save(&e, a, json!({ "bank_transfer": false })).await.unwrap();
    let err = order(
        &e,
        &limits,
        a,
        "shop-m56",
        "3.3.3.2",
        &json!({ "name": "A", "phone": "0912345678", "payment_method": "bank_transfer", "items": items }),
    )
    .await
    .unwrap_err();
    assert_eq!(describe(err), "Cửa hàng chưa nhận chuyển khoản.");
    save(&e, a, json!({ "cod": false, "bank_transfer": true }))
        .await
        .unwrap();
    let err = order(
        &e,
        &limits,
        a,
        "shop-m56",
        "3.3.3.3",
        &json!({ "name": "A", "phone": "0912345678", "address": "x", "items": items }),
    )
    .await
    .unwrap_err();
    assert_eq!(describe(err), "Cửa hàng không nhận thanh toán khi nhận hàng.");

    // Công ty B không thấy gì của A.
    let mut cb = e.tenant_conn(e.b).await;
    assert_eq!(
        msg(shop::public_store(&mut cb, true, "shop-m56").await.unwrap_err()),
        "Không có cửa hàng này."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn gioi_han_dat_don_tra_cuu_va_trang_thai_don() {
    let e = env().await;
    let a = e.a;
    let p = product(&e, a, "SP1", "Áo", Some(100_000), true).await;
    save(
        &e,
        a,
        json!({ "slug": "shop-gh", "name": "Shop", "published": true, "product_ids": [p] }),
    )
    .await
    .unwrap();
    let limits = OrderLimits::default();
    let item = json!([{ "product_id": p, "quantity": 1 }]);
    let body = |phone: &str| json!({ "name": "K", "phone": phone, "address": "x", "items": item });

    // 5 đơn / 10 phút / IP: đơn thứ 6 ⇒ 429; IP khác vẫn đặt được.
    for i in 0..5 {
        order(
            &e,
            &limits,
            a,
            "shop-gh",
            "9.9.9.9",
            &body(&format!("09000000{:02}", i + 10)),
        )
        .await
        .unwrap();
    }
    let err = order(&e, &limits, a, "shop-gh", "9.9.9.9", &body("0900000099"))
        .await
        .unwrap_err();
    assert!(
        matches!(err, StoreError::RateLimited { retry_after_sec } if retry_after_sec >= 1),
        "{err:?}"
    );
    let first = order(&e, &limits, a, "shop-gh", "8.8.8.8", &body("0900000098"))
        .await
        .unwrap();
    // IP không tin được: khoá theo SĐT, và có trần chung theo peer.
    let k1 = limits
        .client_key(None, "peer-1", &json!({ "phone": "0900 000 097" }))
        .unwrap();
    assert_eq!(k1, "u:phone:0900000097");
    assert_eq!(limits.client_key(Some("1.2.3.4"), "x", &json!({})).unwrap(), "1.2.3.4");
    assert_eq!(limits.client_key(None, "peer-1", &json!({})).unwrap(), "u:phone:none");

    // Khách xem đơn: cần đúng mã + SĐT (mã không phân biệt hoa thường).
    let mut conn = e.tenant_conn(a).await;
    let st = shop::order_status(&mut conn, true, "shop-gh", &first.code.to_lowercase(), "0900 000 098")
        .await
        .unwrap();
    assert_eq!((st.status.as_str(), st.total), ("new", 100_000));
    for (code, phone) in [
        (first.code.as_str(), "0900000001"),
        ("DH-XXXXXX", "0900000098"),
        (first.code.as_str(), ""),
    ] {
        let err = shop::order_status(&mut conn, true, "shop-gh", code, phone)
            .await
            .unwrap_err();
        assert_eq!(msg(err), "Không tìm thấy đơn.");
    }

    // Danh sách theo phạm vi: chưa ghép khách chỉ thấy khi phạm vi "tất cả"; SĐT che theo `contacts.phone_full`.
    let all = OwnerIds::All;
    let rows = shop::list_orders(&mut conn, Some(&all), Some(&all), None, None)
        .await
        .unwrap();
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0].customer_phone, "0900000098");
    let masked = shop::list_orders(&mut conn, Some(&all), None, Some("new"), Some("2"))
        .await
        .unwrap();
    assert_eq!(masked.len(), 2);
    assert_eq!(masked[0].customer_phone, "***098");
    // Phạm vi hẹp: người phụ trách khách là user 1 (cấu hình); phạm vi của người khác ⇒ rỗng.
    let own = OwnerIds::Ids(vec![1]);
    assert_eq!(
        shop::list_orders(&mut conn, Some(&own), Some(&own), None, None)
            .await
            .unwrap()
            .len(),
        6
    );
    let other = OwnerIds::Ids(vec![777]);
    assert!(
        shop::list_orders(&mut conn, Some(&other), Some(&all), None, None)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        shop::list_orders(&mut conn, None, Some(&all), None, None)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        shop::list_orders(&mut conn, Some(&all), Some(&all), None, Some("0"))
            .await
            .unwrap()
            .len(),
        6
    );

    // Đổi trạng thái: sai giá trị ⇒ 400; ngoài phạm vi ⇒ 404; cùng trạng thái không ghi sự kiện; sang `paid` ghi thêm `store_order.paid`.
    let id = rows[0].id;
    assert_eq!(
        msg(shop::update_order_status(&mut conn, Some(&all), Some(&all), id, "xong")
            .await
            .unwrap_err()),
        "Trạng thái không hợp lệ."
    );
    assert_eq!(
        msg(
            shop::update_order_status(&mut conn, Some(&other), Some(&all), id, "paid")
                .await
                .unwrap_err()
        ),
        "Không tìm thấy"
    );
    assert_eq!(
        msg(
            shop::update_order_status(&mut conn, Some(&all), Some(&all), 999_999, "paid")
                .await
                .unwrap_err()
        ),
        "Không có đơn này."
    );
    let same = shop::update_order_status(&mut conn, Some(&all), Some(&all), id, "new")
        .await
        .unwrap();
    assert_eq!(same.status, "new");
    assert_eq!(
        e.scalar(
            a,
            "SELECT count(*) FROM integration_events WHERE event_type = 'store_order.status_changed'"
        )
        .await,
        0
    );
    let paid = shop::update_order_status(&mut conn, Some(&own), Some(&all), id, "paid")
        .await
        .unwrap();
    assert_eq!(paid.status, "paid");
    assert_eq!(
        e.scalar(
            a,
            "SELECT count(*) FROM integration_events WHERE event_type = 'store_order.status_changed'"
        )
        .await,
        1
    );
    assert_eq!(
        e.scalar(
            a,
            "SELECT count(*) FROM integration_events WHERE event_type = 'store_order.paid'"
        )
        .await,
        1
    );
    let ev: Value =
        sqlx::query_scalar("SELECT payload FROM integration_events WHERE event_type = 'store_order.status_changed'")
            .fetch_one(&mut e.conn(a).await)
            .await
            .unwrap();
    assert_eq!(
        (ev["previous_status"].as_str(), ev["order"]["status"].as_str()),
        (Some("new"), Some("paid"))
    );
    // PATCH che SĐT theo `contacts.phone_full`; không còn phát sự kiện khi trạng thái đã đúng (so trạng thái hiện tại).
    let shipped = shop::update_order_status(&mut conn, Some(&all), None, id, "shipped")
        .await
        .unwrap();
    assert!(shipped.customer_phone.starts_with("***"), "{}", shipped.customer_phone);
    let again = shop::update_order_status(&mut conn, Some(&all), Some(&all), id, "shipped")
        .await
        .unwrap();
    assert_eq!(again.customer_phone, "0900000098");
    assert_eq!(
        e.scalar(
            a,
            "SELECT count(*) FROM integration_events WHERE event_type = 'store_order.status_changed'"
        )
        .await,
        2
    );
    shop::update_order_status(&mut conn, Some(&all), Some(&all), id, "done")
        .await
        .unwrap();
    assert_eq!(
        e.scalar(
            a,
            "SELECT count(*) FROM integration_events WHERE event_type = 'store_order.paid'"
        )
        .await,
        1
    );

    // Người phụ trách bị khoá ⇒ khách mới chưa có người phụ trách (không gán cho tài khoản không hoạt động).
    sqlx::query("UPDATE users SET status = 'locked' WHERE id = 1")
        .execute(&mut e.conn(a).await)
        .await
        .unwrap();
    order(&e, &limits, a, "shop-gh", "7.7.7.7", &body("0900000555"))
        .await
        .unwrap();
    assert_eq!(
        e.scalar(
            a,
            "SELECT count(*) FROM contacts WHERE phone = '0900000555' AND assigned_to IS NULL"
        )
        .await,
        1
    );

    // Giá × số lượng tràn i64 ⇒ 400 (không panic).
    let huge = product(&e, a, "SPX", "Tỷ phú", Some(i64::MAX / 50), true).await;
    save(&e, a, json!({ "product_ids": [p, huge] })).await.unwrap();
    let err = order(
        &e,
        &limits,
        a,
        "shop-gh",
        "6.6.6.6",
        &json!({ "name": "K", "phone": "0900000556", "address": "x", "items": [{ "product_id": huge, "quantity": 99 }] }),
    )
    .await
    .unwrap_err();
    assert_eq!(describe(err), "Tổng đơn quá lớn.");
}
