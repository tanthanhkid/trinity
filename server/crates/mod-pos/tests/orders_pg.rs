//! M27: đơn và thanh toán tại quầy trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-pos --test orders_pg -- --ignored`
//! Dữ liệu mang tiền tố `m27`, tự dọn; các test chạy nối tiếp (dùng chung `pos_settings` và ca).

use chrono::Utc;
use mod_pos::orders::{self, CreateOrder, ListOrders, PayOrder, UpdateOrder, VoidOrder};
use mod_pos::reports;
use mod_pos::shifts::{self, CloseShift, OpenShift};
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

fn create_of(v: serde_json::Value) -> CreateOrder {
    let mut c: CreateOrder = serde_json::from_value(v).unwrap();
    c.normalize();
    c.validate().expect("dto hợp lệ");
    c
}

fn pay_of(v: serde_json::Value) -> PayOrder {
    let p: PayOrder = serde_json::from_value(v).unwrap();
    p.validate().expect("dto hợp lệ");
    p
}

async fn exec(c: &mut PgConnection, sql: impl Into<String>) {
    sqlx::query(sqlx::AssertSqlSafe(sql.into()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn clean(c: &mut PgConnection) {
    let users = "SELECT id FROM users WHERE email LIKE 'm27%@test.local'";
    exec(c, format!("DELETE FROM integration_events WHERE event_type = 'pos.order.completed' AND (payload->'order'->>'created_by')::int IN ({users})")).await;
    exec(
        c,
        format!("DELETE FROM pos_payments WHERE shift_id IN (SELECT id FROM pos_shifts WHERE opened_by IN ({users}))"),
    )
    .await;
    exec(
        c,
        format!(
            "DELETE FROM pos_order_items WHERE order_id IN (SELECT id FROM pos_orders WHERE created_by IN ({users}))"
        ),
    )
    .await;
    exec(c, format!("DELETE FROM pos_orders WHERE created_by IN ({users})")).await;
    exec(c, format!("DELETE FROM pos_shifts WHERE opened_by IN ({users})")).await;
    exec(c, "DELETE FROM pos_tables WHERE name LIKE 'm27%'").await;
    exec(c, "DELETE FROM pos_areas WHERE name LIKE 'm27%'").await;
    exec(c, "DELETE FROM pos_modifiers WHERE group_name LIKE 'm27%'").await;
    exec(c, "DELETE FROM products WHERE code LIKE 'm27%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm27%@test.local'").await;
    exec(c, "UPDATE pos_settings SET menu_category_ids = '{}', bank_bin = NULL, bank_account_no = NULL, bank_account_name = NULL").await;
}

async fn user(c: &mut PgConnection, tag: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m27{tag}@test.local', 'x', 'M27', now()) RETURNING id"
    )))
    .fetch_one(c)
    .await
    .unwrap()
}

async fn product(c: &mut PgConnection, code: &str, price: i64) -> i32 {
    sqlx::query_scalar("INSERT INTO products (code, name, price, updated_at) VALUES ($1, $1, $2, now()) RETURNING id")
        .bind(code)
        .bind(price)
        .fetch_one(c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn vong_doi_don() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let boss = user(&mut c, "b").await;
    let mine = OwnerIds::Ids(vec![me]);
    let now = Utc::now();
    let cf = product(&mut c, "m27-cf", 30_000).await;
    let bm = product(&mut c, "m27-bm", 20_000).await;
    let off = product(&mut c, "m27-off", 5_000).await;
    exec(
        &mut c,
        format!("UPDATE products SET is_active = false WHERE id = {off}"),
    )
    .await;
    let size: i32 = sqlx::query_scalar(
        "INSERT INTO pos_modifiers (group_name, name, price_delta) VALUES ('m27 Size', 'L', 5000) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let area: i32 = sqlx::query_scalar("INSERT INTO pos_areas (name) VALUES ('m27 A') RETURNING id")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    let table: i32 = sqlx::query_scalar("INSERT INTO pos_tables (area_id, name) VALUES ($1, 'm27 B1') RETURNING id")
        .bind(area)
        .fetch_one(&mut *c)
        .await
        .unwrap();

    // Chưa mở ca ⇒ 400.
    let body = serde_json::json!({"items": [{"product_id": cf, "quantity": 1}]});
    assert_eq!(
        status(
            orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    let sh = shifts::open(&mut c, me, &OpenShift { opening_cash: 100_000 })
        .await
        .unwrap();

    // Tạo: tổng do BE tính, mã YYYYMMDD-NNNN, ghi chú trim, tuỳ chọn chụp lại.
    let o = orders::create(
        &mut c,
        me,
        &create_of(serde_json::json!({
            "table_id": table, "note": "  ít đá ", "discount_type": "percent", "discount_value": 10,
            "items": [{"product_id": cf, "quantity": 2, "modifier_ids": [size], "note": " nóng "}, {"product_id": bm, "quantity": 1}]
        })),
        now,
        &mine,
    )
    .await
    .unwrap();
    let v = json(&o);
    // (30000 + 5000) × 2 + 20000 = 90000; giảm 10% = 9000.
    assert_eq!(
        (
            v["subtotal"].as_i64(),
            v["discount_amount"].as_i64(),
            v["total"].as_i64()
        ),
        (Some(90_000), Some(9_000), Some(81_000))
    );
    assert_eq!(
        (v["status"].as_str(), v["shift_id"].as_i64(), v["note"].as_str()),
        (Some("open"), Some(sh.id.into()), Some("ít đá"))
    );
    let ymd = (now + chrono::Duration::hours(7)).format("%Y%m%d").to_string();
    assert!(
        v["code"].as_str().unwrap().starts_with(&format!("{ymd}-")),
        "{}",
        v["code"]
    );
    assert_eq!(v["items"][0]["options"][0]["price_delta"], 5_000);
    assert_eq!(v["items"][0]["note"], "nóng");
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(&keys[..4], ["id", "code", "shift_id", "table_id"]);
    assert_eq!(keys.last().unwrap(), "payments");

    // Món ngừng bán / bàn lạ / tuỳ chọn lạ / giảm quá tạm tính ⇒ 400.
    for bad in [
        serde_json::json!({"items": [{"product_id": off, "quantity": 1}]}),
        serde_json::json!({"table_id": 2_000_000_000, "items": [{"product_id": cf, "quantity": 1}]}),
        serde_json::json!({"items": [{"product_id": cf, "quantity": 1, "modifier_ids": [2_000_000_000]}]}),
        serde_json::json!({"discount_type": "amount", "discount_value": 999_999, "items": [{"product_id": cf, "quantity": 1}]}),
    ] {
        assert_eq!(
            status(
                orders::create(&mut c, me, &create_of(bad), now, &mine)
                    .await
                    .unwrap_err()
            )
            .0,
            400
        );
    }

    // Bàn có đơn mở; sửa thay toàn bộ dòng món và bỏ gán bàn bằng null.
    let tables = mod_pos::layout::list_tables(&mut c).await.unwrap();
    assert_eq!(
        tables
            .iter()
            .find(|t| t.id == table)
            .unwrap()
            .open_order
            .as_ref()
            .unwrap()
            .total,
        81_000
    );
    let up: UpdateOrder = serde_json::from_value(serde_json::json!({
        "table_id": null, "discount_type": "none", "items": [{"product_id": bm, "quantity": 3}]
    }))
    .unwrap();
    up.validate().unwrap();
    let o2 = json(&orders::update(&mut c, o.id, &up, &mine).await.unwrap());
    assert_eq!(
        (
            o2["total"].as_i64(),
            o2["table_id"].is_null(),
            o2["items"].as_array().unwrap().len()
        ),
        (Some(60_000), true, 1)
    );
    assert_eq!(o2["discount_value"], 0);

    // QR: chưa cấu hình ngân hàng ⇒ 400; có thì số tiền mặc định = tổng, vượt tổng ⇒ 400, có CRC.
    assert_eq!(status(orders::qr(&mut c, o.id, None).await.unwrap_err()).0, 400);
    exec(
        &mut c,
        "UPDATE pos_settings SET bank_bin = '970436', bank_account_no = '0123456789', bank_account_name = 'QUAN'",
    )
    .await;
    let q = orders::qr(&mut c, o.id, None).await.unwrap();
    assert_eq!((q.amount, q.account_name.as_deref()), (60_000, Some("QUAN")));
    assert!(q.content.starts_with(&format!("HD{ymd}")) && !q.content.contains('-'));
    assert!(q.payload.contains("540560000"), "{}", q.payload);
    assert_eq!(status(orders::qr(&mut c, o.id, Some(60_001)).await.unwrap_err()).0, 400);
    assert_eq!(orders::qr(&mut c, o.id, Some(10_000)).await.unwrap().amount, 10_000);

    // Thu tiền: tổng sai ⇒ 400 và đơn vẫn mở; đúng thì tiền mặt có tiền thối; thu đôi ⇒ 409.
    let wrong = pay_of(serde_json::json!({"payments": [{"method": "cash", "amount": 59_999}]}));
    assert_eq!(
        status(orders::pay(&mut c, o.id, me, &wrong, &mine).await.unwrap_err()).0,
        400
    );
    let good = pay_of(serde_json::json!({"payments": [
        {"method": "cash", "amount": 40_000, "tendered": 50_000, "reference": " tiền lẻ "},
        {"method": "bank_transfer", "amount": 20_000, "reference": "FT123"}
    ]}));
    let paid = json(&orders::pay(&mut c, o.id, me, &good, &mine).await.unwrap());
    assert_eq!(
        (paid["status"].as_str(), paid["paid_by"].as_i64()),
        (Some("paid"), Some(me.into()))
    );
    assert_eq!(
        (
            paid["payments"][0]["change"].as_i64(),
            paid["payments"][0]["reference"].as_str()
        ),
        (Some(10_000), Some("tiền lẻ"))
    );
    assert_eq!(paid["payments"][1]["tendered"], serde_json::Value::Null);
    assert_eq!(
        status(orders::pay(&mut c, o.id, me, &good, &mine).await.unwrap_err()).0,
        409
    );
    assert_eq!(
        status(orders::update(&mut c, o.id, &up, &mine).await.unwrap_err()).0,
        409
    );
    assert_eq!(status(orders::qr(&mut c, o.id, None).await.unwrap_err()).0, 400);

    // Sự kiện outbox cùng giao dịch, tiền là chuỗi.
    let (n, total, paid_at): (i64, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*), MAX(payload->'order'->>'total'), MAX(payload->'order'->>'paid_at') FROM integration_events \
         WHERE event_type = 'pos.order.completed' AND resource_id = $1",
    )
    .bind(o.id.to_string())
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!((n, total.as_deref()), (1, Some("60000")));
    assert!(paid_at.unwrap().ends_with('Z'));
    let amount: Option<String> = sqlx::query_scalar(
        "SELECT payload->'order'->'payments'->0->>'amount' FROM integration_events WHERE event_type = 'pos.order.completed' AND resource_id = $1",
    )
    .bind(o.id.to_string())
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(amount.as_deref(), Some("40000"));

    // Tổng kết ca khớp: tiền mặt 40k, chuyển khoản 20k, dự kiến = đầu ca + tiền mặt.
    let s = shifts::summary(&mut c, sh.id, &mine).await.unwrap().summary.unwrap();
    assert_eq!(
        (s.paid_orders, s.cash_sales, s.transfer_sales, s.expected_cash),
        (1, 40_000, 20_000, 140_000)
    );

    // Huỷ: đơn mở ai cũng huỷ được; đơn đã thu cần pos.manage (403) và rời khỏi tổng kết ca.
    let o3 = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
        .await
        .unwrap();
    let reason = VoidOrder {
        reason: "khách đổi ý".into(),
    };
    let v3 = json(
        &orders::void_order(&mut c, o3.id, me, &reason, false, &mine)
            .await
            .unwrap(),
    );
    assert_eq!(
        (
            v3["status"].as_str(),
            v3["void_reason"].as_str(),
            v3["voided_by"].as_i64()
        ),
        (Some("void"), Some("khách đổi ý"), Some(me.into()))
    );
    assert_eq!(
        status(
            orders::void_order(&mut c, o3.id, me, &reason, true, &mine)
                .await
                .unwrap_err()
        )
        .0,
        409
    );
    assert_eq!(
        status(
            orders::void_order(&mut c, o.id, me, &reason, false, &mine)
                .await
                .unwrap_err()
        )
        .0,
        403
    );
    orders::void_order(&mut c, o.id, boss, &reason, true, &OwnerIds::All)
        .await
        .unwrap();
    let s = shifts::summary(&mut c, sh.id, &mine).await.unwrap().summary.unwrap();
    assert_eq!(
        (s.paid_orders, s.void_orders, s.cash_sales, s.expected_cash),
        (0, 2, 0, 100_000)
    );

    // Phạm vi: người ngoài phạm vi chỉ thấy đơn mở; đơn đã thu/huỷ của người khác ⇒ 404.
    let stranger = OwnerIds::Ids(vec![boss]);
    assert_eq!(
        status(orders::get_by_id(&mut c, o.id, &stranger).await.unwrap_err()).0,
        404
    );
    assert!(orders::get_by_id(&mut c, o.id, &OwnerIds::All).await.is_ok());
    let open = orders::create(&mut c, me, &create_of(body), now, &mine).await.unwrap();
    assert!(orders::get_by_id(&mut c, open.id, &stranger).await.is_ok());
    let page = orders::list(
        &mut c,
        &ListOrders {
            shift_id: Some(sh.id),
            limit: Some(2),
            ..Default::default()
        },
        &stranger,
    )
    .await
    .unwrap();
    assert_eq!((page.data.len(), page.data[0].id), (1, open.id));
    let page = orders::list(
        &mut c,
        &ListOrders {
            shift_id: Some(sh.id),
            limit: Some(2),
            ..Default::default()
        },
        &mine,
    )
    .await
    .unwrap();
    assert_eq!((page.data.len(), page.next_cursor.is_some()), (2, true));
    let page2 = orders::list(
        &mut c,
        &ListOrders {
            shift_id: Some(sh.id),
            cursor: page.next_cursor,
            ..Default::default()
        },
        &mine,
    )
    .await
    .unwrap();
    assert_eq!(page2.data.len(), 1);
    let voids = orders::list(
        &mut c,
        &ListOrders {
            status: Some("void".into()),
            shift_id: Some(sh.id),
            ..Default::default()
        },
        &mine,
    )
    .await
    .unwrap();
    assert_eq!(voids.data.len(), 2);

    // Đóng ca khi còn đơn mở ⇒ 400.
    let close = CloseShift {
        closing_cash_counted: 100_000,
        note: None,
    };
    assert_eq!(
        status(shifts::close(&mut c, sh.id, &close, me, &mine).await.unwrap_err()).0,
        400
    );
    clean(&mut c).await;
}

/// Đơn mẫu thứ `i`: (món A × qa, món B × qb, tuỳ chọn +5000 cho A khi i chẵn, giảm giá) và tổng tính độc lập bằng số học thuần.
fn sample(i: i64) -> (i64, i64, bool, &'static str, i64, i64) {
    let (qa, qb) = (i % 5 + 1, i % 3 + 1);
    let a = 30_000 + if i % 2 == 0 { 5_000 } else { 0 };
    let sub = a * qa + 12_500 * qb;
    let (kind, value, disc) = match i % 4 {
        0 => ("percent", 10, sub * 10 / 100),
        1 => ("amount", 1_000, 1_000),
        _ => ("none", 0, 0),
    };
    (qa, qb, i % 2 == 0, kind, value, sub - disc)
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tong_tien_200_don_mau_khop_tung_dong() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let mine = OwnerIds::Ids(vec![me]);
    let now = Utc::now();
    let a = product(&mut c, "m27-a", 30_000).await;
    let b = product(&mut c, "m27-b", 12_500).await;
    let l: i32 = sqlx::query_scalar(
        "INSERT INTO pos_modifiers (group_name, name, price_delta) VALUES ('m27 Size', 'L', 5000) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let sh = shifts::open(
        &mut c,
        me,
        &OpenShift {
            opening_cash: 1_000_000,
        },
    )
    .await
    .unwrap();

    let (mut want_total, mut want_cash, mut want_transfer, mut want_sub) = (0_i64, 0_i64, 0_i64, 0_i64);
    for i in 0..200_i64 {
        let (qa, qb, big, kind, value, total) = sample(i);
        let mods = if big {
            serde_json::json!([l])
        } else {
            serde_json::json!([])
        };
        let o = orders::create(
            &mut c,
            me,
            &create_of(serde_json::json!({
                "discount_type": kind, "discount_value": value,
                "items": [{"product_id": a, "quantity": qa, "modifier_ids": mods}, {"product_id": b, "quantity": qb}]
            })),
            now,
            &mine,
        )
        .await
        .unwrap();
        assert_eq!(o.total.0, total, "đơn {i}");
        let cash = i % 2 == 0;
        let pay = if cash {
            // Khách đưa tròn lên bội 50.000; tiền thối không được tính vào doanh thu.
            let tendered = (total + 49_999) / 50_000 * 50_000;
            serde_json::json!({"payments": [{"method": "cash", "amount": total, "tendered": tendered}]})
        } else {
            serde_json::json!({"payments": [{"method": "bank_transfer", "amount": total}]})
        };
        let paid = orders::pay(&mut c, o.id, me, &pay_of(pay), &mine).await.unwrap();
        assert_eq!(paid.payments.iter().map(|p| p.amount.0).sum::<i64>(), total);
        want_total += total;
        want_sub += o.subtotal.0;
        if cash {
            want_cash += total;
        } else {
            want_transfer += total;
        }
    }

    // Tổng khớp từng đồng ở mọi nơi: bảng đơn, bảng thanh toán, tổng kết ca, báo cáo ngày.
    let (n, sum_total, sum_sub): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), SUM(total)::int8, SUM(subtotal)::int8 FROM pos_orders WHERE shift_id = $1 AND status = 'paid'",
    )
    .bind(sh.id)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!((n, sum_total, sum_sub), (200, want_total, want_sub));
    let pays: i64 = sqlx::query_scalar("SELECT SUM(amount)::int8 FROM pos_payments WHERE shift_id = $1")
        .bind(sh.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(pays, want_total);
    let s = shifts::summary(&mut c, sh.id, &mine).await.unwrap().summary.unwrap();
    assert_eq!(
        (s.paid_orders, s.cash_sales, s.transfer_sales, s.expected_cash),
        (200, want_cash, want_transfer, 1_000_000 + want_cash)
    );
    let day = reports::daily(&mut c, None, Utc::now()).await.unwrap();
    // Cùng ngày VN với các đơn vừa tạo (trừ khi test vắt qua nửa đêm VN).
    assert!(day.revenue >= want_total && day.order_count >= 200);
    let by_ship: i64 = day.by_method.iter().map(|m| m.amount).sum();
    assert_eq!(by_ship, day.revenue, "tổng theo phương thức khớp doanh thu");

    // Đóng ca: chênh lệch đúng từng đồng.
    let closed = shifts::close(
        &mut c,
        sh.id,
        &CloseShift {
            closing_cash_counted: 1_000_000 + want_cash - 500,
            note: None,
        },
        me,
        &mine,
    )
    .await
    .unwrap();
    let cs = closed.shift.unwrap();
    assert_eq!(
        (cs.expected_cash.unwrap().0, cs.cash_diff.unwrap().0),
        (1_000_000 + want_cash, -500)
    );
    clean(&mut c).await;
}

/// Thu tiền / tạo đơn chạy song song với đóng ca: không bao giờ có ca đã đóng mà tiền mặt dự kiến lệch các khoản đã thu,
/// hay còn đơn mở trong ca đã đóng.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn dong_ca_khong_lech_khi_thu_tien_song_song() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let mine = OwnerIds::Ids(vec![me]);
    let now = Utc::now();
    let p = product(&mut c, "m27-p", 10_000).await;
    let body = serde_json::json!({"items": [{"product_id": p, "quantity": 1}]});

    for round in 0..12 {
        let sh = shifts::open(&mut c, me, &OpenShift { opening_cash: 5_000 })
            .await
            .unwrap();
        let o = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
            .await
            .unwrap();
        let mut pay_conn = conn().await;
        let mut close_conn = conn().await;
        let mut new_conn = conn().await;
        let (mine1, mine2, mine3) = (mine.clone(), mine.clone(), mine.clone());
        let pay = pay_of(serde_json::json!({"payments": [{"method": "cash", "amount": 10_000}]}));
        let body2 = body.clone();
        let t_pay = tokio::spawn(async move { orders::pay(&mut pay_conn, o.id, me, &pay, &mine1).await.map(|_| ()) });
        let t_close = tokio::spawn(async move {
            shifts::close(
                &mut close_conn,
                sh.id,
                &CloseShift {
                    closing_cash_counted: 0,
                    note: None,
                },
                me,
                &mine2,
            )
            .await
            .map(|_| ())
        });
        let t_new = tokio::spawn(async move {
            orders::create(&mut new_conn, me, &create_of(body2), now, &mine3)
                .await
                .map(|_| ())
        });
        let (r_pay, r_close, r_new) = (t_pay.await.unwrap(), t_close.await.unwrap(), t_new.await.unwrap());
        let _ = (round, r_pay.is_ok(), r_new.is_ok());

        let (status_s, expected, opened): (String, Option<i64>, i64) =
            sqlx::query_as("SELECT status, expected_cash, opening_cash FROM pos_shifts WHERE id = $1")
                .bind(sh.id)
                .fetch_one(&mut *c)
                .await
                .unwrap();
        let cash: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(p.amount), 0)::int8 FROM pos_payments p JOIN pos_orders o ON o.id = p.order_id \
             WHERE p.shift_id = $1 AND o.status = 'paid' AND p.method = 'cash'",
        )
        .bind(sh.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
        let open_orders: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pos_orders WHERE shift_id = $1 AND status = 'open'")
                .bind(sh.id)
                .fetch_one(&mut *c)
                .await
                .unwrap();
        if status_s == "closed" {
            assert!(r_close.is_ok(), "vòng {round}");
            assert_eq!(
                expected,
                Some(opened + cash),
                "vòng {round}: tiền mặt dự kiến phải khớp các khoản đã thu"
            );
            assert_eq!(open_orders, 0, "vòng {round}: ca đã đóng không được còn đơn mở");
        } else {
            // Đóng ca bị từ chối (còn đơn mở) thì ca vẫn mở; dọn để vòng sau mở ca mới.
            assert_eq!(status(r_close.unwrap_err()).0, 400, "vòng {round}");
            exec(
                &mut c,
                format!(
                    "UPDATE pos_orders SET status = 'void' WHERE shift_id = {} AND status = 'open'",
                    sh.id
                ),
            )
            .await;
            shifts::close(
                &mut c,
                sh.id,
                &CloseShift {
                    closing_cash_counted: 0,
                    note: None,
                },
                me,
                &mine,
            )
            .await
            .unwrap();
        }
    }
    clean(&mut c).await;
}

/// Các lỗ hổng review #393: huỷ đơn đã thu khi ca đã đóng, mã đơn qua 9999, đổi loại giảm giá, tuỳ chọn trùng, giá đổi
/// sau khi dựng dòng, đơn 0đ.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn huy_don_da_thu_ca_dong_va_cac_bien() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let mine = OwnerIds::Ids(vec![me]);
    let now = Utc::now();
    let p = product(&mut c, "m27-p", 10_000).await;
    let free = product(&mut c, "m27-free", 0).await;
    let size: i32 = sqlx::query_scalar(
        "INSERT INTO pos_modifiers (group_name, name, price_delta) VALUES ('m27 Size', 'L', 1000) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let body = serde_json::json!({"items": [{"product_id": p, "quantity": 1}]});
    let sh = shifts::open(&mut c, me, &OpenShift { opening_cash: 0 }).await.unwrap();

    // Tuỳ chọn trùng id ⇒ 400 ở DTO.
    let dup: CreateOrder = serde_json::from_value(
        serde_json::json!({"items": [{"product_id": p, "quantity": 1, "modifier_ids": [size, size]}]}),
    )
    .unwrap();
    assert!(dup.validate().is_err());
    // Đổi loại giảm giá mà không gửi giá trị ⇒ 400.
    let up: UpdateOrder = serde_json::from_value(serde_json::json!({"discount_type": "percent"})).unwrap();
    assert!(up.validate().is_err());
    let up_ok: UpdateOrder = serde_json::from_value(serde_json::json!({"discount_type": "none"})).unwrap();
    assert!(up_ok.validate().is_ok());

    // Mã đơn qua 9999: sắp theo độ dài rồi chữ, nên 10000 lớn hơn 9999.
    let ymd = (now + chrono::Duration::hours(7)).format("%Y%m%d").to_string();
    let seed = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
        .await
        .unwrap();
    exec(
        &mut c,
        format!("UPDATE pos_orders SET code = '{ymd}-9999' WHERE id = {}", seed.id),
    )
    .await;
    let next = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
        .await
        .unwrap();
    assert_eq!(next.code, format!("{ymd}-10000"));
    let next2 = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
        .await
        .unwrap();
    assert_eq!(next2.code, format!("{ymd}-10001"));
    for id in [seed.id, next.id, next2.id] {
        orders::void_order(&mut c, id, me, &VoidOrder { reason: "dọn".into() }, true, &mine)
            .await
            .unwrap();
    }

    // Đơn 0đ: thu không cần dòng thanh toán, nhưng có một dòng 0đ gắn vào ca nên tính vào số đơn đã thu.
    let z = orders::create(
        &mut c,
        me,
        &create_of(serde_json::json!({"items": [{"product_id": free, "quantity": 2}]})),
        now,
        &mine,
    )
    .await
    .unwrap();
    assert_eq!(z.total.0, 0);
    let zp = orders::pay(&mut c, z.id, me, &pay_of(serde_json::json!({"payments": []})), &mine)
        .await
        .unwrap();
    assert_eq!(
        (
            zp.status.as_str(),
            zp.payments.len(),
            zp.payments[0].amount.0,
            zp.payments[0].shift_id
        ),
        ("paid", 1, 0, sh.id)
    );
    let s = shifts::summary(&mut c, sh.id, &mine).await.unwrap().summary.unwrap();
    assert_eq!((s.paid_orders, s.cash_sales), (1, 0));

    // Giá đổi giữa lúc dựng dòng và lúc khoá ⇒ 409 (mô phỏng bằng khoá chia sẻ thấy giá mới): dựng xong, đổi giá, tạo lại.
    let o = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
        .await
        .unwrap();
    let paid = orders::pay(
        &mut c,
        o.id,
        me,
        &pay_of(serde_json::json!({"payments": [{"method": "cash", "amount": 10_000}]})),
        &mine,
    )
    .await
    .unwrap();
    assert_eq!(paid.status, "paid");
    exec(&mut c, format!("UPDATE products SET is_active = false WHERE id = {p}")).await;
    assert_eq!(
        status(
            orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    exec(&mut c, format!("UPDATE products SET is_active = true WHERE id = {p}")).await;

    // Huỷ đơn đã thu: ca còn mở thì được (tiền rời khỏi tổng kết); ca đã đóng ⇒ 409 và đơn giữ nguyên.
    let o2 = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
        .await
        .unwrap();
    orders::pay(
        &mut c,
        o2.id,
        me,
        &pay_of(serde_json::json!({"payments": [{"method": "cash", "amount": 10_000}]})),
        &mine,
    )
    .await
    .unwrap();
    let reason = VoidOrder {
        reason: "nhầm đơn".into(),
    };
    orders::void_order(&mut c, o2.id, me, &reason, true, &mine)
        .await
        .unwrap();
    let s = shifts::summary(&mut c, sh.id, &mine).await.unwrap().summary.unwrap();
    assert_eq!(s.cash_sales, 10_000, "chỉ còn đơn o");
    shifts::close(
        &mut c,
        sh.id,
        &CloseShift {
            closing_cash_counted: 10_000,
            note: None,
        },
        me,
        &mine,
    )
    .await
    .unwrap();
    let (code, msg) = status(
        orders::void_order(&mut c, o.id, me, &reason, true, &mine)
            .await
            .unwrap_err(),
    );
    assert_eq!(code, 409, "{msg}");
    assert_eq!(orders::get_by_id(&mut c, o.id, &mine).await.unwrap().status, "paid");
    let after = shifts::summary(&mut c, sh.id, &mine).await.unwrap();
    assert_eq!(after.summary.unwrap().expected_cash, 10_000);
    // Đơn mở huỷ được kể cả khi không còn ca mở.
    clean(&mut c).await;
}

/// Huỷ đơn đã thu chạy song song với đóng ca: ca đóng thì tiền mặt dự kiến luôn khớp các khoản còn tính.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn huy_don_da_thu_song_song_voi_dong_ca() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let me = user(&mut c, "a").await;
    let mine = OwnerIds::Ids(vec![me]);
    let now = Utc::now();
    let p = product(&mut c, "m27-p", 10_000).await;
    let body = serde_json::json!({"items": [{"product_id": p, "quantity": 1}]});
    for round in 0..12 {
        let sh = shifts::open(&mut c, me, &OpenShift { opening_cash: 0 }).await.unwrap();
        let o = orders::create(&mut c, me, &create_of(body.clone()), now, &mine)
            .await
            .unwrap();
        orders::pay(
            &mut c,
            o.id,
            me,
            &pay_of(serde_json::json!({"payments": [{"method": "cash", "amount": 10_000}]})),
            &mine,
        )
        .await
        .unwrap();
        let (mut vc, mut cc) = (conn().await, conn().await);
        let (m1, m2) = (mine.clone(), mine.clone());
        let t_void = tokio::spawn(async move {
            orders::void_order(
                &mut vc,
                o.id,
                me,
                &VoidOrder {
                    reason: "song song".into(),
                },
                true,
                &m1,
            )
            .await
            .map(|_| ())
        });
        let t_close = tokio::spawn(async move {
            shifts::close(
                &mut cc,
                sh.id,
                &CloseShift {
                    closing_cash_counted: 0,
                    note: None,
                },
                me,
                &m2,
            )
            .await
            .map(|_| ())
        });
        let (rv, rc) = (t_void.await.unwrap(), t_close.await.unwrap());
        assert!(rc.is_ok(), "vòng {round}: ca không còn đơn mở nên đóng được");
        let (expected,): (Option<i64>,) = sqlx::query_as("SELECT expected_cash FROM pos_shifts WHERE id = $1")
            .bind(sh.id)
            .fetch_one(&mut *c)
            .await
            .unwrap();
        let live: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(p.amount), 0)::int8 FROM pos_payments p JOIN pos_orders o ON o.id = p.order_id WHERE p.shift_id = $1 AND o.status = 'paid' AND p.method = 'cash'",
        )
        .bind(sh.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
        // Huỷ trước đóng ca ⇒ dự kiến 0 và đơn đã huỷ; đóng ca trước ⇒ huỷ bị 409 và dự kiến 10.000.
        match rv {
            Ok(()) => assert_eq!((expected, live), (Some(0), 0), "vòng {round}"),
            Err(e) => {
                assert_eq!(status(e).0, 409, "vòng {round}");
                assert_eq!((expected, live), (Some(10_000), 10_000), "vòng {round}");
            }
        }
    }
    clean(&mut c).await;
}
