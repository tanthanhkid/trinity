//! M26: sơ đồ bàn, tuỳ chọn, cấu hình, menu, ca và báo cáo ngày trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-pos --test pg -- --ignored`
//! Dữ liệu mang tiền tố `m26`, tự dọn; các test chạy nối tiếp (dùng chung `pos_settings` và ca).

use chrono::{DateTime, Utc};
use mod_pos::catalog::{self, MenuQuery, UpdateSettings};
use mod_pos::layout::{self, CreateArea, CreateModifier, CreateTable, UpdateArea, UpdateModifier, UpdateTable};
use mod_pos::reports;
use mod_pos::shifts::{self, CloseShift, ListShifts, OpenShift};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_rbac::OwnerIds;

async fn conn() -> trinity_db::TenantConn {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 2;
    let db = Db::connect(&cfg).await.expect("nối DB");
    db.tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
        .acquire()
        .await
        .expect("acquire")
}

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn json(v: &impl serde::Serialize) -> serde_json::Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

async fn exec(c: &mut PgConnection, sql: impl Into<String>) {
    sqlx::query(sqlx::AssertSqlSafe(sql.into()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn clean(c: &mut PgConnection) {
    exec(
        c,
        "DELETE FROM pos_payments WHERE order_id IN (SELECT id FROM pos_orders WHERE code LIKE 'm26%')",
    )
    .await;
    exec(
        c,
        "DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE code LIKE 'm26%')",
    )
    .await;
    exec(c, "DELETE FROM pos_orders WHERE code LIKE 'm26%'").await;
    exec(
        c,
        "DELETE FROM pos_shifts WHERE opened_by IN (SELECT id FROM users WHERE email LIKE 'm26%@test.local')",
    )
    .await;
    exec(c, "DELETE FROM pos_areas WHERE name LIKE 'm26%'").await;
    exec(c, "DELETE FROM pos_modifiers WHERE group_name LIKE 'm26%'").await;
    exec(c, "DELETE FROM products WHERE code LIKE 'm26%'").await;
    exec(c, "DELETE FROM product_categories WHERE code LIKE 'm26%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm26%@test.local'").await;
}

async fn user(c: &mut PgConnection, tag: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m26{tag}@test.local', 'x', 'M26', now()) RETURNING id"
    )))
    .fetch_one(c)
    .await
    .unwrap()
}

async fn order(
    c: &mut PgConnection,
    code: &str,
    shift: i32,
    status: &str,
    total: i64,
    uid: i32,
    table: Option<i32>,
) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO pos_orders (code, shift_id, table_id, status, subtotal, total, created_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5, $6, now()) RETURNING id",
    )
    .bind(code)
    .bind(shift)
    .bind(table)
    .bind(status)
    .bind(total)
    .bind(uid)
    .fetch_one(c)
    .await
    .unwrap()
}

async fn pay(c: &mut PgConnection, order: i32, shift: i32, method: &str, amount: i64, uid: i32) {
    sqlx::query(
        "INSERT INTO pos_payments (order_id, shift_id, method, amount, created_by) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(order)
    .bind(shift)
    .bind(method)
    .bind(amount)
    .bind(uid)
    .execute(c)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn khu_vuc_ban_tuy_chon() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let uid = user(&mut c, "a").await;

    // Khu vực: tạo, trùng tên 409, sửa, 404.
    let a = layout::create_area(
        &mut c,
        &CreateArea {
            name: "m26 Tầng 1".into(),
            sort_order: Some(2),
        },
    )
    .await
    .unwrap();
    assert_eq!((a.sort_order, a.is_active), (2, true));
    let dup = layout::create_area(
        &mut c,
        &CreateArea {
            name: "m26 Tầng 1".into(),
            sort_order: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(status(dup), (409, "\"Tên khu vực đã tồn tại\"".to_owned()));
    let a2 = layout::update_area(
        &mut c,
        a.id,
        &UpdateArea {
            is_active: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(!a2.is_active);
    assert_eq!(a2.name, "m26 Tầng 1");
    let miss = layout::update_area(&mut c, 2_000_000_000, &UpdateArea::default())
        .await
        .unwrap_err();
    assert_eq!(status(miss).0, 404);
    let keys: Vec<_> = json(&a).as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["id", "name", "sort_order", "is_active", "created_at"]);
    let list = layout::list_areas(&mut c).await.unwrap();
    assert!(list.iter().any(|x| x.id == a.id));

    // Bàn: khu vực không có 404, tạo, trùng tên trong khu vực 409, bàn cùng tên khu khác được.
    let miss = layout::create_table(
        &mut c,
        &CreateTable {
            area_id: 2_000_000_000,
            name: "B1".into(),
            sort_order: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(status(miss), (404, "\"Khu vực không tồn tại\"".to_owned()));
    let t = layout::create_table(
        &mut c,
        &CreateTable {
            area_id: a.id,
            name: "B1".into(),
            sort_order: Some(1),
        },
    )
    .await
    .unwrap();
    let dup = layout::create_table(
        &mut c,
        &CreateTable {
            area_id: a.id,
            name: "B1".into(),
            sort_order: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(status(dup), (409, "\"Tên bàn đã tồn tại trong khu vực\"".to_owned()));
    let a_b = layout::create_area(
        &mut c,
        &CreateArea {
            name: "m26 Sân".into(),
            sort_order: None,
        },
    )
    .await
    .unwrap();
    layout::create_table(
        &mut c,
        &CreateTable {
            area_id: a_b.id,
            name: "B1".into(),
            sort_order: None,
        },
    )
    .await
    .unwrap();
    let t2 = layout::update_table(
        &mut c,
        t.id,
        &UpdateTable {
            name: Some("B9".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(t2.name, "B9");

    // `open_order` lấy đơn đang mở ở bàn; đơn đã thu không tính.
    let tables = layout::list_tables(&mut c).await.unwrap();
    assert!(tables.iter().find(|x| x.id == t.id).unwrap().open_order.is_none());
    exec(
        &mut c,
        &format!("INSERT INTO pos_shifts (opened_by, opening_cash) VALUES ({uid}, 0)"),
    )
    .await;
    let shift: i32 = sqlx::query_scalar("SELECT id FROM pos_shifts WHERE opened_by = $1")
        .bind(uid)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    order(&mut c, "m26-paid", shift, "paid", 10_000, uid, Some(t.id)).await;
    let open_id = order(&mut c, "m26-open", shift, "open", 45_000, uid, Some(t.id)).await;
    let tables = layout::list_tables(&mut c).await.unwrap();
    let v = json(tables.iter().find(|x| x.id == t.id).unwrap());
    assert_eq!(
        v["open_order"],
        serde_json::json!({"id": open_id, "code": "m26-open", "total": 45_000})
    );
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "area_id",
            "name",
            "sort_order",
            "is_active",
            "created_at",
            "open_order"
        ]
    );

    // Tuỳ chọn: giá âm, trùng (nhóm, tên) 409, người không có pos.manage không thấy mục đã ẩn.
    let m = layout::create_modifier(
        &mut c,
        &CreateModifier {
            group_name: "m26 Size".into(),
            name: "Nhỏ".into(),
            price_delta: Some(-5_000),
            sort_order: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(m.price_delta.0, -5_000);
    let dup = layout::create_modifier(
        &mut c,
        &CreateModifier {
            group_name: "m26 Size".into(),
            name: "Nhỏ".into(),
            price_delta: None,
            sort_order: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(status(dup).0, 409);
    layout::update_modifier(
        &mut c,
        m.id,
        &UpdateModifier {
            is_active: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let has = |v: &[trinity_db::models::PosModifier]| v.iter().any(|x| x.id == m.id);
    assert!(!has(&layout::list_modifiers(&mut c, true, false).await.unwrap()));
    assert!(!has(&layout::list_modifiers(&mut c, false, true).await.unwrap()));
    assert!(has(&layout::list_modifiers(&mut c, true, true).await.unwrap()));
    let miss = layout::update_modifier(&mut c, 2_000_000_000, &UpdateModifier::default())
        .await
        .unwrap_err();
    assert_eq!(status(miss).0, 404);
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn cau_hinh_va_menu() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    exec(&mut c, "UPDATE pos_settings SET menu_category_ids = '{}'").await;

    let s = catalog::get_settings(&mut c).await.unwrap();
    assert_eq!(s.id, 1);
    // "" ⇒ NULL; null ⇒ NULL; không gửi ⇒ giữ nguyên.
    let up: UpdateSettings =
        serde_json::from_str(r#"{"store_name":"m26 Quán","address":"1 Lê Lợi","phone":"","bank_bin":"970436"}"#)
            .unwrap();
    let s = catalog::update_settings(&mut c, &up).await.unwrap();
    assert_eq!(
        (s.store_name.as_str(), s.address.as_deref(), s.phone.as_deref()),
        ("m26 Quán", Some("1 Lê Lợi"), None)
    );
    let up: UpdateSettings = serde_json::from_str(r#"{"address":null}"#).unwrap();
    let s = catalog::update_settings(&mut c, &up).await.unwrap();
    assert_eq!(
        (s.address, s.bank_bin.as_deref(), s.store_name.as_str()),
        (None, Some("970436"), "m26 Quán")
    );

    // Menu: danh mục + sản phẩm đang bán có giá; loại xoá mềm, không giá, ngừng bán.
    let cat_a: i32 = sqlx::query_scalar("INSERT INTO product_categories (code, name, sort_order, updated_at) VALUES ('m26a', 'm26 Cà phê', 1, now()) RETURNING id")
        .fetch_one(&mut *c).await.unwrap();
    let cat_b: i32 = sqlx::query_scalar("INSERT INTO product_categories (code, name, sort_order, updated_at) VALUES ('m26b', 'm26 Bánh', 2, now()) RETURNING id")
        .fetch_one(&mut *c).await.unwrap();
    for (code, name, price, cat, active, deleted, featured) in [
        ("m26-cf", "m26 Cà phê sữa", Some(30_000_i64), cat_a, true, false, false),
        ("m26-cf2", "m26 Bạc xỉu", Some(35_000), cat_a, true, false, true),
        ("m26-bn", "m26 Bánh mì", Some(20_000), cat_b, true, false, false),
        ("m26-np", "m26 Không giá", None, cat_a, true, false, false),
        ("m26-off", "m26 Ngừng bán", Some(1_000), cat_a, false, false, false),
        ("m26-del", "m26 Đã xoá", Some(1_000), cat_a, true, true, false),
    ] {
        sqlx::query(
            "INSERT INTO products (code, name, price, category_id, is_active, is_featured, deleted_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END, now())",
        )
        .bind(code)
        .bind(name)
        .bind(price)
        .bind(cat_a.min(cat).max(cat))
        .bind(active)
        .bind(featured)
        .bind(deleted)
        .execute(&mut *c)
        .await
        .unwrap();
    }
    let names = |m: &catalog::Menu| {
        m.products
            .iter()
            .filter(|p| p.code.starts_with("m26"))
            .map(|p| p.code.clone())
            .collect::<Vec<_>>()
    };
    let m = catalog::menu(&mut c, &MenuQuery::default()).await.unwrap();
    // Nổi bật trước, rồi tên.
    assert_eq!(names(&m), ["m26-cf2", "m26-bn", "m26-cf"]);
    assert_eq!(m.products.iter().find(|p| p.code == "m26-cf").unwrap().price, 30_000);
    assert!(m.categories.iter().any(|x| x.code == "m26a") && m.categories.iter().any(|x| x.code == "m26b"));

    // Tìm theo tên hoặc mã, không phân biệt hoa/thường, `%` là ký tự thường.
    let q = |t: &str| MenuQuery {
        category_id: None,
        q: Some(t.into()),
    };
    assert_eq!(names(&catalog::menu(&mut c, &q("BÁNH")).await.unwrap()), ["m26-bn"]);
    assert_eq!(names(&catalog::menu(&mut c, &q("m26-cf2")).await.unwrap()), ["m26-cf2"]);
    assert!(names(&catalog::menu(&mut c, &q("%")).await.unwrap()).is_empty());

    // Cấu hình danh mục menu: chỉ danh mục đó; lọc ngoài danh mục menu ⇒ rỗng.
    catalog::update_settings(
        &mut c,
        &UpdateSettings {
            menu_category_ids: Some(vec![cat_b]),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let m = catalog::menu(&mut c, &MenuQuery::default()).await.unwrap();
    assert_eq!(names(&m), ["m26-bn"]);
    assert_eq!(m.categories.iter().map(|x| x.id).collect::<Vec<_>>(), [cat_b]);
    let out = catalog::menu(
        &mut c,
        &MenuQuery {
            category_id: Some(cat_a),
            q: None,
        },
    )
    .await
    .unwrap();
    assert!(out.products.is_empty());
    let inn = catalog::menu(
        &mut c,
        &MenuQuery {
            category_id: Some(cat_b),
            q: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(names(&inn), ["m26-bn"]);

    exec(
        &mut c,
        "UPDATE pos_settings SET menu_category_ids = '{}', store_name = 'Quán của tôi', bank_bin = NULL",
    )
    .await;
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn vong_doi_ca() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let other = user(&mut c, "b").await;
    let mine = OwnerIds::Ids(vec![me]);

    assert!(shifts::current(&mut c, me).await.unwrap().shift.is_none());
    assert_eq!(status(shifts::require_open_shift(&mut c, me).await.unwrap_err()).0, 400);
    let s = shifts::open(&mut c, me, &OpenShift { opening_cash: 500_000 })
        .await
        .unwrap();
    assert_eq!((s.status.as_str(), s.opening_cash.0), ("open", 500_000));
    let dup = shifts::open(&mut c, me, &OpenShift { opening_cash: 0 })
        .await
        .unwrap_err();
    assert_eq!(status(dup), (409, "\"Bạn đang có một ca mở\"".to_owned()));
    // Hai người mở ca độc lập.
    let so = shifts::open(&mut c, other, &OpenShift { opening_cash: 0 })
        .await
        .unwrap();

    // Đơn: 1 thu tiền mặt, 1 thu hai phương thức, 1 huỷ (tiền không tính), 1 đang mở.
    let o1 = order(&mut c, "m26-1", s.id, "paid", 100_000, me, None).await;
    pay(&mut c, o1, s.id, "cash", 100_000, me).await;
    let o2 = order(&mut c, "m26-2", s.id, "paid", 80_000, me, None).await;
    pay(&mut c, o2, s.id, "cash", 30_000, me).await;
    pay(&mut c, o2, s.id, "bank_transfer", 50_000, me).await;
    let o3 = order(&mut c, "m26-3", s.id, "void", 999_000, me, None).await;
    pay(&mut c, o3, s.id, "cash", 999_000, me).await;
    let o4 = order(&mut c, "m26-4", s.id, "open", 10_000, me, None).await;

    let cur = shifts::current(&mut c, me).await.unwrap();
    let sum = cur.summary.clone().unwrap();
    assert_eq!(
        (
            sum.paid_orders,
            sum.void_orders,
            sum.cash_sales,
            sum.transfer_sales,
            sum.expected_cash
        ),
        (2, 1, 130_000, 50_000, 630_000)
    );
    let v = json(&cur);
    let keys: Vec<_> = v["shift"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "id",
            "opened_by",
            "opened_at",
            "opening_cash",
            "status",
            "closed_by",
            "closed_at",
            "closing_cash_counted",
            "expected_cash",
            "cash_diff",
            "note"
        ]
    );

    // Phạm vi: ca của người khác ngoài phạm vi ⇒ 404 cho summary và close; người có phạm vi rộng thì thấy.
    assert_eq!(status(shifts::summary(&mut c, so.id, &mine).await.unwrap_err()).0, 404);
    let c_in = CloseShift {
        closing_cash_counted: 0,
        note: None,
    };
    assert_eq!(
        status(shifts::close(&mut c, so.id, &c_in, me, &mine).await.unwrap_err()).0,
        404
    );
    assert!(shifts::summary(&mut c, so.id, &OwnerIds::All).await.is_ok());
    assert_eq!(
        status(shifts::summary(&mut c, 2_000_000_000, &mine).await.unwrap_err()).0,
        404
    );

    // Còn đơn mở ⇒ 400; thu xong thì đóng được; chênh lệch = đếm − dự kiến.
    let close = CloseShift {
        closing_cash_counted: 620_000,
        note: Some("thiếu 10k".into()),
    };
    let (code, msg) = status(shifts::close(&mut c, s.id, &close, me, &mine).await.unwrap_err());
    assert_eq!(code, 400);
    assert!(msg.contains("Còn 1 đơn chưa thanh toán"), "{msg}");
    exec(
        &mut c,
        &format!("UPDATE pos_orders SET status = 'void' WHERE id = {o4}"),
    )
    .await;
    let done = shifts::close(&mut c, s.id, &close, me, &mine).await.unwrap();
    let sh = done.shift.unwrap();
    assert_eq!(
        (
            sh.status.as_str(),
            sh.closed_by,
            sh.closing_cash_counted.map(|v| v.0),
            sh.expected_cash.map(|v| v.0),
            sh.cash_diff.map(|v| v.0)
        ),
        ("closed", Some(me), Some(620_000), Some(630_000), Some(-10_000))
    );
    assert_eq!(sh.note.as_deref(), Some("thiếu 10k"));
    assert_eq!(done.summary.unwrap().void_orders, 2);
    assert_eq!(
        status(shifts::close(&mut c, s.id, &close, me, &mine).await.unwrap_err()),
        (409, "\"Ca đã đóng\"".to_owned())
    );
    assert!(shifts::current(&mut c, me).await.unwrap().shift.is_none());
    // Đóng ca xong mở ca mới được.
    let s2 = shifts::open(&mut c, me, &OpenShift { opening_cash: 1 }).await.unwrap();

    // Danh sách: mới nhất trước, chỉ ca của mình, phân trang bằng cursor.
    let page = shifts::list(
        &mut c,
        &ListShifts {
            cursor: None,
            limit: Some(1),
        },
        &mine,
    )
    .await
    .unwrap();
    assert_eq!(
        (page.data.len(), page.data[0].id, page.next_cursor),
        (1, s2.id, Some(s2.id))
    );
    let page = shifts::list(
        &mut c,
        &ListShifts {
            cursor: page.next_cursor,
            limit: Some(1),
        },
        &mine,
    )
    .await
    .unwrap();
    assert_eq!((page.data.len(), page.data[0].id, page.next_cursor), (1, s.id, None));
    let all = shifts::list(&mut c, &ListShifts::default(), &OwnerIds::All)
        .await
        .unwrap();
    assert!(all.data.iter().any(|x| x.id == so.id));
    let none = shifts::list(&mut c, &ListShifts::default(), &OwnerIds::Ids(vec![]))
        .await
        .unwrap();
    assert!(none.data.is_empty());
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn bao_cao_ngay_gio_vn() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let s = shifts::open(&mut c, me, &OpenShift { opening_cash: 0 }).await.unwrap();

    // Ngày 2031-03-05 giờ VN = [2031-03-04T17:00Z, 2031-03-05T17:00Z). Hai đơn trong ngày, một ngay trước, một ngay sau.
    let mk = |code: &'static str, paid: &'static str, total: i64, status: &'static str| (code, paid, total, status);
    let rows = [
        mk("m26-r0", "2031-03-04T16:59:59Z", 7_000, "paid"),
        mk("m26-r1", "2031-03-04T17:00:00Z", 100_000, "paid"),
        mk("m26-r2", "2031-03-05T05:30:00Z", 50_001, "paid"),
        mk("m26-r3", "2031-03-05T16:59:59Z", 3_000, "void"),
        mk("m26-r4", "2031-03-05T17:00:00Z", 9_000, "paid"),
    ];
    for (code, paid, total, st) in rows {
        let id = order(&mut c, code, s.id, st, total, me, None).await;
        sqlx::query("UPDATE pos_orders SET paid_at = $2::timestamptz, discount_amount = CASE WHEN $3 = 50001 THEN 1 ELSE 0 END, subtotal = total + CASE WHEN $3 = 50001 THEN 1 ELSE 0 END WHERE id = $1")
            .bind(id).bind(paid).bind(total).execute(&mut *c).await.unwrap();
        pay(
            &mut c,
            id,
            s.id,
            if total == 100_000 { "cash" } else { "bank_transfer" },
            total,
            me,
        )
        .await;
        sqlx::query("INSERT INTO pos_order_items (order_id, product_id, product_name, unit_price, quantity, line_total) VALUES ($1, 7, 'Cà phê', $2, 2, $3)")
            .bind(id).bind(total / 2).bind(total).execute(&mut *c).await.unwrap();
    }
    let now: DateTime<Utc> = "2031-03-05T10:00:00Z".parse().unwrap();
    let r = reports::daily(&mut c, Some("2031-03-05"), now).await.unwrap();
    assert_eq!(
        (r.order_count, r.revenue, r.subtotal, r.discount),
        (2, 150_001, 150_002, 1)
    );
    assert_eq!(r.avg_order_value, 75_000, "làm tròn xuống");
    assert_eq!(
        json(&r.by_method),
        serde_json::json!([{"method": "bank_transfer", "amount": 50_001}, {"method": "cash", "amount": 100_000}])
    );
    assert_eq!(
        json(&r.by_product),
        serde_json::json!([{"product_id": 7, "product_name": "Cà phê", "quantity": 4, "revenue": 150_001}])
    );
    // 17:00Z = 00:00 VN; 05:30Z = 12:30 VN.
    assert_eq!(
        json(&r.by_hour),
        serde_json::json!([{"hour": 0, "orders": 1, "revenue": 100_000}, {"hour": 12, "orders": 1, "revenue": 50_001}])
    );
    assert!(!r.by_product_truncated);
    let keys: Vec<_> = json(&r).as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "date",
            "order_count",
            "revenue",
            "subtotal",
            "discount",
            "avg_order_value",
            "by_method",
            "by_product",
            "by_hour",
            "by_product_truncated"
        ]
    );

    // Vắng date ⇒ hôm nay giờ VN (10:00Z ngày 5 = 17:00 VN ngày 5); ngày trống ⇒ số không.
    assert_eq!(reports::daily(&mut c, None, now).await.unwrap().order_count, 2);
    let e = reports::daily(&mut c, Some("2031-03-09"), now).await.unwrap();
    assert_eq!(
        (e.order_count, e.revenue, e.avg_order_value, e.by_hour.len()),
        (0, 0, 0, 0)
    );
    assert_eq!(
        status(reports::daily(&mut c, Some("2031-02-30"), now).await.unwrap_err()),
        (400, "\"Ngày không hợp lệ\"".to_owned())
    );
    clean(&mut c).await;
}
