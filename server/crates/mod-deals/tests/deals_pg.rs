//! M08: hoạt động, thương vụ, dòng tương tác trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-deals --test deals_pg -- --ignored`

use chrono::{Duration, Utc};
use mod_deals::deals::{CreateDeal, DealQuery, UpdateDeal, create, find_all, find_one, remove, search_sales, update};
use mod_deals::interactions::{InteractionQuery, Sources, list, stats, thread};
use mod_deals::{Actor, Scopes, activities};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_kernel::error::{AppError, Message};
use trinity_rbac::OwnerIds;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn tenant() -> TenantDb {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 3;
    Db::connect(&cfg)
        .await
        .expect("nối DB")
        .tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
}

fn err(e: AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    match b.message {
        Message::One(m) => (s, m),
        Message::Many(m) => (s, m.join("; ")),
    }
}

fn js<T: serde::Serialize>(v: &T) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

async fn clean(c: &mut PgConnection) {
    for sql in [
        "DELETE FROM facebook_messages WHERE conversation_id IN (SELECT id FROM facebook_conversations WHERE page_id LIKE 'm08-%')",
        "DELETE FROM facebook_conversations WHERE page_id LIKE 'm08-%'",
        "DELETE FROM facebook_comments WHERE page_id LIKE 'm08-%'",
        "DELETE FROM facebook_comment_rules WHERE name LIKE 'M08 %'",
        "DELETE FROM facebook_pages WHERE page_id LIKE 'm08-%'",
        "DELETE FROM zalo_oa_messages WHERE thread_id IN (SELECT id FROM zalo_oa_threads WHERE oa_id LIKE 'm08-%')",
        "DELETE FROM zalo_oa_threads WHERE oa_id LIKE 'm08-%'",
        "DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone LIKE '0908%')",
        "DELETE FROM deals WHERE title LIKE 'M08 %'",
        "DELETE FROM contacts WHERE phone LIKE '0908%'",
        "DELETE FROM notification_logs WHERE recipient_id IN (SELECT id FROM users WHERE email LIKE 'm08%@test.local')",
        "DELETE FROM integration_events WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE 'm08%@test.local')",
        "DELETE FROM users WHERE email LIKE 'm08%@test.local'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

async fn user(c: &mut PgConnection, n: u8, name: &str) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ($1, 'x', $2, now()) RETURNING id",
    )
    .bind(format!("m08{n}@test.local"))
    .bind(name)
    .fetch_one(c)
    .await
    .unwrap()
}

async fn contact(c: &mut PgConnection, phone: &str, name: &str, owner: i32) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, updated_at) VALUES ($1, $2, $3, $3, now()) RETURNING id",
    )
    .bind(phone)
    .bind(name)
    .bind(owner)
    .fetch_one(c)
    .await
    .unwrap()
}

fn actor(id: i32) -> Actor {
    Actor {
        user_id: id,
        is_admin: false,
        email: Some(format!("m08{id}@test.local")),
    }
}

fn all() -> Scopes {
    let a = || Some(OwnerIds::All);
    Scopes {
        deals_view: a(),
        deals_manage: a(),
        deals_delete: a(),
        contacts_view: a(),
        phone_full: a(),
    }
}

fn own(id: i32) -> Scopes {
    let o = || Some(OwnerIds::Ids(vec![id]));
    Scopes {
        deals_view: o(),
        deals_manage: o(),
        deals_delete: o(),
        contacts_view: o(),
        phone_full: None,
    }
}

fn dto(v: Value) -> CreateDeal {
    serde_json::from_value(v).unwrap()
}

fn patch(v: Value) -> UpdateDeal {
    serde_json::from_value(v).unwrap()
}

fn dq(v: Value) -> DealQuery {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn dong_thoi_gian_hoat_dong_theo_khach() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let a = user(&mut c, 1, "Sale A").await;
    let b = user(&mut c, 2, "Sale B").await;
    let mine = contact(&mut c, "0908000101", "Khách của A", a).await;
    let theirs = contact(&mut c, "0908000102", "Khách của B", b).await;
    let mut ids = Vec::new();
    for i in 0..5 {
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO activities (contact_id, action, details, created_by) VALUES ($1, 'note', $2::text::jsonb, $3) RETURNING id",
        )
        .bind(mine)
        .bind(json!({ "text": format!("ghi chú {i}") }).to_string())
        .bind(if i == 0 { None } else { Some(a) })
        .fetch_one(&mut *c)
        .await
        .unwrap();
        ids.push(id);
    }
    let sa = own(a);
    // Trang 1: 2 dòng mới nhất, kèm người tạo; có con trỏ.
    let p1 = activities::find_by_contact(&mut c, &sa, mine, None, Some("2"))
        .await
        .unwrap();
    let v = js(&p1);
    assert_eq!(v["data"].as_array().unwrap().len(), 2);
    assert_eq!(v["data"][0]["id"], ids[4]);
    assert_eq!(v["data"][0]["user"]["full_name"], "Sale A");
    assert_eq!(v["next_cursor"], ids[3]);
    // Trang 2 theo con trỏ; trang cuối không còn con trỏ; dòng không có người tạo ⇒ user null.
    let p2 = activities::find_by_contact(&mut c, &sa, mine, Some(&ids[3].to_string()), Some("2"))
        .await
        .unwrap();
    assert_eq!(js(&p2)["data"][0]["id"], ids[2]);
    let p3 = activities::find_by_contact(&mut c, &sa, mine, Some(&ids[1].to_string()), Some("10"))
        .await
        .unwrap();
    let v3 = js(&p3);
    assert_eq!(v3["data"].as_array().unwrap().len(), 1);
    assert_eq!(v3["data"][0]["user"], Value::Null);
    assert_eq!(v3["next_cursor"], Value::Null);
    // Ngoài phạm vi ⇒ 404; khách không tồn tại ⇒ 404 có ID.
    assert_eq!(
        err(activities::find_by_contact(&mut c, &sa, theirs, None, None)
            .await
            .unwrap_err())
        .0,
        404
    );
    assert_eq!(
        err(activities::find_by_contact(&mut c, &sa, 999_999, None, None)
            .await
            .unwrap_err()),
        (404, "Không tìm thấy khách hàng ID 999999".to_owned())
    );
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn thuong_vu_tao_xem_sua_xoa_va_su_kien() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let boss = user(&mut c, 1, "Trưởng phòng").await;
    let a = user(&mut c, 2, "Sale An").await;
    let b = user(&mut c, 3, "Sale Bình").await;
    let locked = user(&mut c, 4, "Sale Khoá").await;
    sqlx::query("UPDATE users SET status = 'locked' WHERE id = $1")
        .bind(locked)
        .execute(&mut *c)
        .await
        .unwrap();
    let cb = contact(&mut c, "0908000201", "Khách của B", b).await;
    let ca = contact(&mut c, "0908000202", "Khách của A", a).await;
    let ab = actor(boss);
    let team = Scopes {
        deals_manage: Some(OwnerIds::Ids(vec![a])),
        ..all()
    };

    // Tạo: ngoài phạm vi deals.manage ⇒ 403; người nhận bị khoá ⇒ 400; khách không có ⇒ 400; khách ngoài phạm vi xem ⇒ 404.
    assert_eq!(
        err(
            create(&db, &team, &ab, &dto(json!({ "title": "M08 x", "assigned_to": b })))
                .await
                .unwrap_err()
        )
        .0,
        403
    );
    assert_eq!(
        err(create(
            &db,
            &all(),
            &ab,
            &dto(json!({ "title": "M08 x", "assigned_to": locked }))
        )
        .await
        .unwrap_err())
        .0,
        400
    );
    assert_eq!(
        err(create(
            &db,
            &all(),
            &ab,
            &dto(json!({ "title": "M08 x", "assigned_to": a, "contact_id": 999_999 }))
        )
        .await
        .unwrap_err())
        .0,
        400
    );
    let narrow = Scopes {
        contacts_view: Some(OwnerIds::Ids(vec![a])),
        ..all()
    };
    assert_eq!(
        err(create(
            &db,
            &narrow,
            &ab,
            &dto(json!({ "title": "M08 x", "assigned_to": a, "contact_id": cb }))
        )
        .await
        .unwrap_err())
        .0,
        404
    );

    // Tạo thẳng ở `won`: có ngày thắng, bắn deal.created + deal.won, thông báo cho người được giao.
    let made = create(
        &db,
        &all(),
        &ab,
        &dto(json!({ "title": "M08 Thương vụ Á", "description": "mô tả", "value": 1500000000_i64, "status": "won", "assigned_to": a, "contact_id": ca })),
    )
    .await
    .unwrap();
    let v = js(&made.deal);
    assert_eq!(v["value"], 1_500_000_000_i64);
    assert_eq!(v["status"], "won");
    assert_eq!(v["contact"]["phone"], "0908000202", "phone_full all ⇒ số thật");
    assert_eq!(v["assignee"]["full_name"], "Sale An");
    assert_eq!(made.notifications.len(), 1);
    assert_eq!(made.notifications[0].recipient_id, a);
    assert_eq!(
        made.notifications[0].action_url.as_deref(),
        Some(format!("/contacts/{ca}").as_str())
    );
    let id1 = made.deal.id;
    let types: Vec<String> =
        sqlx::query_scalar("SELECT event_type FROM integration_events WHERE resource_id = $1 ORDER BY id")
            .bind(id1.to_string())
            .fetch_all(&mut *c)
            .await
            .unwrap();
    assert_eq!(types, ["deal.created", "deal.won"]);
    let won_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar("SELECT won_at FROM deals WHERE id = $1")
        .bind(id1)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(won_at.is_some());

    // Danh sách theo phạm vi + che SĐT theo chủ của khách + tìm không dấu + con trỏ.
    let id2 = create(
        &db,
        &all(),
        &ab,
        &dto(json!({ "title": "M08 Báo giá Đông", "assigned_to": b, "contact_id": cb })),
    )
    .await
    .unwrap()
    .deal
    .id;
    let id3 = create(
        &db,
        &all(),
        &ab,
        &dto(json!({ "title": "M08 Hợp đồng", "assigned_to": a })),
    )
    .await
    .unwrap()
    .deal
    .id;
    let sa = own(a);
    let l = find_all(&mut c, &sa, &dq(json!({ "search": "M08" }))).await.unwrap();
    let ids: Vec<i32> = l.data.iter().map(|d| d.id).collect();
    assert_eq!(
        ids,
        [id3, id1],
        "chỉ thương vụ của A (người được giao), mới nhất trước: {ids:?}"
    );
    let masked = js(&l.data[1]);
    assert_eq!(masked["contact"]["phone"], "***202", "own không có phone_full ⇒ che");
    assert_eq!(
        find_all(&mut c, &all(), &dq(json!({ "search": "bao gia dong" })))
            .await
            .unwrap()
            .data[0]
            .id,
        id2
    );
    assert_eq!(
        find_all(&mut c, &all(), &dq(json!({ "search": "M08 100%" })))
            .await
            .unwrap()
            .data
            .len(),
        0
    );
    let p1 = find_all(&mut c, &all(), &dq(json!({ "search": "M08", "limit": 2 })))
        .await
        .unwrap();
    assert_eq!(p1.data.len(), 2);
    assert_eq!(p1.meta.next_cursor, Some(id2));
    let p2 = find_all(
        &mut c,
        &all(),
        &dq(json!({ "search": "M08", "limit": 2, "cursor": id2 })),
    )
    .await
    .unwrap();
    assert_eq!(p2.data.iter().map(|d| d.id).collect::<Vec<_>>(), [id1]);
    assert_eq!(p2.meta.next_cursor, None);
    assert!(
        find_all(&mut c, &all(), &dq(json!({ "cursor": 999_999 })))
            .await
            .unwrap()
            .data
            .is_empty()
    );
    assert_eq!(
        find_all(&mut c, &all(), &dq(json!({ "search": "M08", "status": "won" })))
            .await
            .unwrap()
            .data
            .len(),
        1
    );

    // Chi tiết: ngoài phạm vi ⇒ 404.
    assert_eq!(
        js(&find_one(&mut c, &sa, id1).await.unwrap())["title"],
        "M08 Thương vụ Á"
    );
    assert_eq!(
        err(find_one(&mut c, &sa, id2).await.unwrap_err()),
        (404, "Không tìm thấy".to_owned())
    );

    // Sửa: rời `won` xoá ngày thắng và bắn stage_changed; lưu lại `won` giữ mốc; null xoá mô tả; ngoài phạm vi ⇒ 404.
    let upd = update(
        &db,
        &all(),
        &ab,
        id1,
        &patch(json!({ "status": "lost", "description": null, "value": null })),
    )
    .await
    .unwrap();
    let uv = js(&upd);
    assert_eq!(
        (uv["status"].as_str(), uv["description"].clone(), uv["value"].clone()),
        (Some("lost"), Value::Null, Value::Null)
    );
    let won_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar("SELECT won_at FROM deals WHERE id = $1")
        .bind(id1)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(won_at.is_none());
    let types: Vec<String> =
        sqlx::query_scalar("SELECT event_type FROM integration_events WHERE resource_id = $1 ORDER BY id")
            .bind(id1.to_string())
            .fetch_all(&mut *c)
            .await
            .unwrap();
    assert_eq!(types, ["deal.created", "deal.won", "deal.stage_changed", "deal.lost"]);
    update(&db, &all(), &ab, id1, &patch(json!({ "note": "ghi chú" })))
        .await
        .unwrap();
    let still: i64 = sqlx::query_scalar("SELECT count(*) FROM integration_events WHERE resource_id = $1")
        .bind(id1.to_string())
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(still, 4, "không đổi status ⇒ không thêm sự kiện");
    assert_eq!(
        err(update(&db, &sa, &ab, id2, &patch(json!({ "title": "M08 sửa" })))
            .await
            .unwrap_err())
        .0,
        404
    );

    // Xoá: ngoài phạm vi ⇒ 404; trong phạm vi ⇒ success.
    assert_eq!(err(remove(&mut c, &sa, id2).await.unwrap_err()).0, 404);
    assert!(
        js(&remove(&mut c, &sa, id3).await.unwrap())["success"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(err(find_one(&mut c, &all(), id3).await.unwrap_err()).0, 404);

    // Tìm người gán: <2 ký tự ⇒ rỗng; trong phạm vi deals.manage; không phân biệt hoa thường; % không phải ký tự đại diện.
    assert!(search_sales(&mut c, &all(), Some("S")).await.unwrap().is_empty());
    let found = search_sales(&mut c, &all(), Some("sale")).await.unwrap();
    let names: Vec<String> = found.iter().filter_map(|s| s.full_name.clone()).collect();
    assert!(
        names.contains(&"Sale An".to_owned()) && names.contains(&"Sale Bình".to_owned()),
        "{names:?}"
    );
    assert!(!names.contains(&"Sale Khoá".to_owned()), "người bị khoá không được gán");
    let only_a = search_sales(&mut c, &team, Some("sale")).await.unwrap();
    assert_eq!(only_a.iter().map(|s| s.id).collect::<Vec<_>>(), [a]);
    assert!(search_sales(&mut c, &all(), Some("%%")).await.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn dong_tuong_tac_gop_thong_ke_va_chuoi_binh_luan() {
    let _s = SERIAL.lock().await;
    let db = tenant().await;
    let mut c = db.acquire().await.unwrap();
    clean(&mut c).await;
    let a = user(&mut c, 1, "Sale A").await;
    let kh = contact(&mut c, "0908000301", "Khách Lan", a).await;
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, default_assignee_id, contact_source_id, connected_by, updated_at)
         SELECT 'm08-page', 'Page M08', 'x', $1, COALESCE((SELECT id FROM setting_options LIMIT 1), 0), $1, now()",
    )
    .bind(a)
    .execute(&mut *c)
    .await
    .unwrap();
    let rule: i32 = sqlx::query_scalar(
        "INSERT INTO facebook_comment_rules (name, created_by, updated_at) VALUES ('M08 Luật giá', $1, now()) RETURNING id",
    )
    .bind(a)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let now = Utc::now();
    let ins = |cid: &'static str,
               from: &'static str,
               msg: &'static str,
               rule: Option<i32>,
               status: &'static str,
               actions: Value,
               ago: Duration,
               contact: Option<i32>| {
        let at = now - ago;
        (cid, from, msg, rule, status, actions, at, contact)
    };
    let rows = [
        ins(
            "c1",
            "u1",
            "Giá bao nhiêu 100%",
            None,
            "done",
            json!({}),
            Duration::hours(2),
            Some(kh),
        ),
        ins(
            "c2",
            "u1",
            "Còn hàng không",
            Some(rule),
            "done",
            json!({ "public_reply": { "text": "x", "id": "r1" } }),
            Duration::hours(1),
            Some(kh),
        ),
        ins(
            "c3",
            "u2",
            "Ship tỉnh?",
            None,
            "done",
            json!({ "manual": [{ "mode": "private", "text": "t", "id": "m", "by": 1, "at": "x" }] }),
            Duration::hours(3),
            None,
        ),
    ];
    for (cid, from, msg, rule, status, actions, at, contact) in &rows {
        sqlx::query(
            "INSERT INTO facebook_comments (comment_id, page_id, post_id, from_id, from_name, message, commented_at, contact_id, rule_id, status, actions)
             VALUES ($1, 'm08-page', 'p_1', $2, $2, $3, $4, $5, $6, $7, $8::text::jsonb)",
        )
        .bind(cid)
        .bind(from)
        .bind(msg)
        .bind(at)
        .bind(contact)
        .bind(rule)
        .bind(status)
        .bind(actions.to_string())
        .execute(&mut *c)
        .await
        .unwrap();
    }
    let conv: i32 = sqlx::query_scalar(
        "INSERT INTO facebook_conversations (page_id, psid, customer_name, contact_id, last_inbound_at, last_message_at, last_message_preview)
         VALUES ('m08-page', 'ps1', 'Khách Lan', $1, now(), now() - interval '10 minutes', 'Xin chào') RETURNING id",
    )
    .bind(kh)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    sqlx::query("UPDATE facebook_conversations SET last_inbound_at = last_message_at WHERE id = $1")
        .bind(conv)
        .execute(&mut *c)
        .await
        .unwrap();
    for (i, d) in [("in", "chào"), ("out", "dạ em chào")].iter().enumerate() {
        sqlx::query("INSERT INTO facebook_messages (conversation_id, mid, direction, text, sent_at) VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval)")
            .bind(conv)
            .bind(format!("m08-mid-{i}"))
            .bind(d.0)
            .bind(d.1)
            .bind((5 - i).to_string())
            .execute(&mut *c)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO zalo_oa_threads (oa_id, zalo_user_id, display_name, last_message_at, last_inbound_at, last_message_preview, updated_at) VALUES ('m08-oa', 'z1', 'Zalo Mai', now() - interval '30 minutes', now() - interval '40 minutes', 'đã trả lời', now())")
        .execute(&mut *c)
        .await
        .unwrap();

    let both = Sources {
        facebook: true,
        zalo: true,
    };
    let q = |f: &dyn Fn(&mut InteractionQuery)| {
        let mut q = InteractionQuery {
            q: Some("M08".into()),
            ..InteractionQuery::default()
        };
        q.q = None;
        f(&mut q);
        q
    };
    let page = |l: &mod_deals::interactions::InteractionList| {
        l.data
            .iter()
            .filter(|i| i.page_id.as_deref() == Some("m08-page") || i.channel == "zalo" && i.channel_name == "Zalo OA")
            .cloned()
            .collect::<Vec<_>>()
    };
    let all_items = list(&mut c, both, &q(&|_| {})).await.unwrap();
    let mine = page(&all_items);
    let keys: Vec<&str> = mine.iter().map(|i| i.key.as_str()).collect();
    assert!(keys.contains(&format!("fb-conv:{conv}").as_str()));
    assert!(mine.windows(2).all(|w| w[0].at >= w[1].at), "mới nhất trước");
    let c2 = mine
        .iter()
        .find(|i| i.text.as_deref() == Some("Còn hàng không"))
        .unwrap();
    assert_eq!(c2.status, "auto");
    assert_eq!(c2.rule_name.as_deref(), Some("M08 Luật giá"));
    assert_eq!(
        c2.auto_result.as_deref(),
        Some("Luật \"M08 Luật giá\": đã trả lời công khai")
    );
    assert_eq!(c2.channel_name, "Page M08");
    assert_eq!(c2.post_url.as_deref(), Some("https://www.facebook.com/p_1"));
    assert_eq!(
        mine.iter()
            .find(|i| i.text.as_deref() == Some("Ship tỉnh?"))
            .unwrap()
            .status,
        "staff"
    );
    assert_eq!(
        mine.iter()
            .find(|i| i.text.as_deref() == Some("Giá bao nhiêu 100%"))
            .unwrap()
            .status,
        "unanswered"
    );
    assert_eq!(
        mine.iter().find(|i| i.key == format!("fb-conv:{conv}")).unwrap().status,
        "unanswered"
    );
    assert_eq!(mine.iter().find(|i| i.channel == "zalo").unwrap().status, "answered");

    // Bộ lọc: kênh, loại, luật, chưa trả lời, tìm theo chữ (% là chữ), giới hạn + next_before.
    let only_zalo = list(&mut c, both, &q(&|x| x.channel = Some("zalo".into())))
        .await
        .unwrap();
    assert!(only_zalo.data.iter().all(|i| i.channel == "zalo"));
    let with_rule = list(
        &mut c,
        both,
        &q(&|x| {
            x.has_rule = Some(true);
            x.page_id = Some("m08-page".into());
        }),
    )
    .await
    .unwrap();
    assert_eq!(with_rule.data.len(), 1);
    let unanswered = list(
        &mut c,
        both,
        &q(&|x| {
            x.unanswered_only = true;
            x.page_id = Some("m08-page".into());
        }),
    )
    .await
    .unwrap();
    assert_eq!(unanswered.data.len(), 2, "bình luận c1 + hội thoại");
    let pct = list(&mut c, both, &q(&|x| x.q = Some("100%".into()))).await.unwrap();
    assert_eq!(
        pct.data
            .iter()
            .filter(|i| i.page_id.as_deref() == Some("m08-page"))
            .count(),
        1
    );
    let lim = list(
        &mut c,
        both,
        &q(&|x| {
            x.limit = Some(1);
            x.page_id = Some("m08-page".into());
            x.channel = Some("facebook".into());
        }),
    )
    .await
    .unwrap();
    assert_eq!(lim.data.len(), 1);
    assert_eq!(lim.next_before.as_deref(), Some(lim.data[0].at.as_str()));
    let off = list(
        &mut c,
        Sources {
            facebook: false,
            zalo: false,
        },
        &q(&|_| {}),
    )
    .await
    .unwrap();
    assert!(off.data.is_empty());

    // Thống kê hôm nay (giờ VN) tính từ dữ liệu vừa tạo.
    let st = stats(&mut c, both, now).await.unwrap();
    let sv = js(&st);
    assert!(sv["comments_today"].as_i64().unwrap() >= 0 && sv["channels"]["facebook"].as_bool().unwrap());
    assert!(sv["unanswered_7d"].as_i64().unwrap() >= 2);

    // Chuỗi bình luận: cùng người cùng bài + hội thoại + tin nhắn cũ → mới; cổng nguồn Facebook; id lạ ⇒ 404 trơn.
    let c1_id: i64 = sqlx::query_scalar("SELECT id FROM facebook_comments WHERE comment_id = 'c1'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    let t = thread(&mut c, both, &c1_id.to_string(), now).await.unwrap();
    assert_eq!(
        t["comments"].as_array().unwrap().len(),
        2,
        "c1 và c2 cùng người u1 trên bài p_1"
    );
    assert_eq!(t["conversation"]["customer_name"], "Khách Lan");
    assert_eq!(t["messages"].as_array().unwrap().len(), 2);
    assert_eq!(t["messages"][0]["direction"], "in", "tin cũ trước");
    assert_eq!(t["comments"][0]["can_private_reply"], true);
    let manual_id: i64 = sqlx::query_scalar("SELECT id FROM facebook_comments WHERE comment_id = 'c3'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    let t3 = thread(&mut c, both, &manual_id.to_string(), now).await.unwrap();
    assert_eq!(t3["conversation"], Value::Null);
    assert_eq!(t3["comments"][0]["can_private_reply"], false, "đã nhắn riêng tay");
    let late = thread(&mut c, both, &c1_id.to_string(), now + Duration::days(8))
        .await
        .unwrap();
    assert_eq!(late["comments"][0]["can_private_reply"], false, "quá 7 ngày");
    for bad in ["abc", "", "-1", "99999999999"] {
        assert_eq!(err(thread(&mut c, both, bad, now).await.unwrap_err()).0, 404, "{bad}");
    }
    assert_eq!(
        err(thread(
            &mut c,
            Sources {
                facebook: false,
                zalo: true
            },
            &c1_id.to_string(),
            now
        )
        .await
        .unwrap_err())
        .0,
        404
    );
}
