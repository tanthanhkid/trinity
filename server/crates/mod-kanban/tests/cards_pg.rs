//! M16: thẻ, checklist, đính kèm, lịch sử trên Postgres thật (`public` đã migrate bằng Prisma).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-kanban --test cards_pg -- --ignored`
//! Dữ liệu mang tiền tố `m16`, tự dọn; các test chạy nối tiếp.

use mod_kanban::activities::{self, CreateComment};
use mod_kanban::attachments::{self, CreateAttachment};
use mod_kanban::cards::{self, CreateCard, ListCards, MoveCard, UpdateCard};
use mod_kanban::checklist::{self, CreateItem, ReorderItems, UpdateItem};
use mod_kanban::{Access, Actor};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig, TenantConn};
use trinity_kernel::error::{AppError, Message};
use trinity_rbac::OwnerIds;

async fn conn() -> TenantConn {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 2;
    Db::connect(&cfg)
        .await
        .expect("nối DB")
        .tenant(CompanyRef::DEFAULT)
        .await
        .expect("tenant")
        .acquire()
        .await
        .expect("acquire")
}

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
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
        "DELETE FROM kanban_boards WHERE name LIKE 'm16%'",
        "DELETE FROM contacts WHERE phone LIKE '0916%'",
        "DELETE FROM users WHERE email LIKE 'm16%@test.local'",
    ] {
        sqlx::query(sql).execute(&mut *c).await.unwrap();
    }
}

async fn user(c: &mut PgConnection, n: u8) -> i32 {
    sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ($1, 'x', $2, now()) RETURNING id",
    )
    .bind(format!("m16{n}@test.local"))
    .bind(format!("M16 user {n}"))
    .fetch_one(c)
    .await
    .unwrap()
}

fn actor(id: i32, admin: bool, owner: OwnerIds) -> Actor {
    Actor {
        user_id: id,
        is_admin: admin,
        access: Access {
            can_manage_boards: admin,
            role_ids: vec![],
        },
        card_owner: Some(owner),
        can_view_contacts: true,
        contact_view: Some(OwnerIds::All),
        contact_phone_full: None,
    }
}

fn create(v: Value) -> CreateCard {
    serde_json::from_value(v).unwrap()
}

fn patch(v: Value) -> UpdateCard {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn the_ma_pham_vi_sua_xoa_khoi_phuc() {
    let _s = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let a = user(&mut c, 1).await;
    let b = user(&mut c, 2).await;
    let outsider = user(&mut c, 3).await;
    let board: i32 = sqlx::query_scalar(
        "INSERT INTO kanban_boards (name, created_by, updated_at) VALUES ('m16 board', $1, now()) RETURNING id",
    )
    .bind(a)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let todo: i32 = sqlx::query_scalar("INSERT INTO kanban_columns (board_id, name, position, updated_at) VALUES ($1, 'Làm', 1024, now()) RETURNING id").bind(board).fetch_one(&mut *c).await.unwrap();
    let done: i32 = sqlx::query_scalar("INSERT INTO kanban_columns (board_id, name, position, is_done, wip_limit, updated_at) VALUES ($1, 'Xong', 2048, true, 1, now()) RETURNING id").bind(board).fetch_one(&mut *c).await.unwrap();
    sqlx::query("INSERT INTO kanban_field_defs (board_id, key, label, type, required, position, updated_at) VALUES ($1, 'gia', 'Giá', 'money', true, 1024, now())").bind(board).execute(&mut *c).await.unwrap();
    let contact: i32 = sqlx::query_scalar("INSERT INTO contacts (phone, full_name, assigned_to, created_by_id, updated_at) VALUES ('0916000001', 'Khách M16', $1, $1, now()) RETURNING id").bind(a).fetch_one(&mut *c).await.unwrap();

    let admin = actor(a, true, OwnerIds::All);
    let mine_b = actor(b, false, OwnerIds::Ids(vec![b]));
    let nobody = actor(outsider, false, OwnerIds::Ids(vec![outsider]));

    // Tạo: thiếu trường bắt buộc ⇒ 400; đủ ⇒ mã do trigger sinh, nối cuối cột, có hoạt động `created`.
    let r = cards::create(
        &mut c,
        &admin,
        &create(json!({ "column_id": todo, "title": "Thiếu giá" })),
    )
    .await;
    assert_eq!(err(r.unwrap_err()), (400, "Trường \"Giá\" là bắt buộc".to_owned()));
    let c1 = cards::create(&mut c, &admin, &create(json!({ "column_id": todo, "title": "Thẻ một", "attributes": { "gia": 5000 }, "assignee_ids": [b, b], "contact_id": contact, "labels": ["x"] }))).await.unwrap();
    let j1 = js(&c1);
    assert!(j1["code"].as_str().is_some_and(|x| x.starts_with("CV")), "{j1}");
    assert_eq!(j1["position"], 1024);
    assert_eq!(j1["assignee_ids"], json!([b]));
    assert_eq!(j1["contact"]["phone"], "***001");
    assert_eq!(j1["contact"]["masked"], true);
    let c2 = cards::create(
        &mut c,
        &admin,
        &create(json!({ "column_id": todo, "title": "Thẻ hai", "attributes": { "gia": 1 } })),
    )
    .await
    .unwrap();
    assert_eq!(js(&c2)["position"], 2048);
    let id1 = c1.id;
    let id2 = c2.id;

    // Phạm vi: B (người phụ trách thẻ 1) thấy thẻ 1, không thấy thẻ 2; người ngoài 404 ở mọi đường, kể cả endpoint con.
    assert_eq!(cards::find_one(&mut c, &mine_b, id1).await.unwrap().id, id1);
    assert_eq!(
        err(cards::find_one(&mut c, &mine_b, id2).await.unwrap_err()),
        (404, format!("Không tìm thấy card ID {id2}"))
    );
    assert_eq!(err(cards::find_one(&mut c, &nobody, id1).await.unwrap_err()).0, 404);
    assert_eq!(err(checklist::list(&mut c, &nobody, id1).await.unwrap_err()).0, 404);
    assert_eq!(err(activities::list(&mut c, &nobody, id1).await.unwrap_err()).0, 404);
    let l = cards::list(&mut c, &mine_b, &ListCards::default()).await.unwrap();
    assert_eq!(l.cards.iter().map(|x| x.id).collect::<Vec<_>>(), [id1]);
    let all = cards::list(
        &mut c,
        &admin,
        &ListCards {
            column_id: Some(todo),
            limit: Some(1),
            ..ListCards::default()
        },
    )
    .await
    .unwrap();
    assert!(all.has_more && all.next_cursor == Some(id1));
    let p2 = cards::list(
        &mut c,
        &admin,
        &ListCards {
            column_id: Some(todo),
            limit: Some(1),
            cursor: all.next_cursor,
            ..ListCards::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(p2.cards[0].id, id2);
    assert_eq!(
        cards::list(
            &mut c,
            &admin,
            &ListCards {
                label: Some("x".into()),
                board_id: Some(board),
                ..ListCards::default()
            }
        )
        .await
        .unwrap()
        .cards
        .len(),
        1
    );
    assert_eq!(
        cards::list(
            &mut c,
            &admin,
            &ListCards {
                search: Some("HAI".into()),
                board_id: Some(board),
                ..ListCards::default()
            }
        )
        .await
        .unwrap()
        .cards
        .len(),
        1
    );
    // Khách ngoài quyền xem bị ẩn kể cả id.
    let mut no_contacts = admin.clone();
    no_contacts.can_view_contacts = false;
    let hidden = js(&cards::find_one(&mut c, &no_contacts, id1).await.unwrap());
    assert_eq!(
        (hidden["contact"].clone(), hidden["contact_id"].clone()),
        (Value::Null, Value::Null)
    );

    // Sửa: gửi lại người cũ + attributes một phần; hoạt động `updated` giữ đúng thứ tự khoá gửi.
    let upd = cards::update(
        &mut c,
        &admin,
        id1,
        &patch(json!({ "title": "Đổi tên", "attributes": { "gia": 7000 }, "priority": "high", "assignee_ids": [] })),
    )
    .await
    .unwrap();
    let uj = js(&upd);
    assert_eq!(
        (
            uj["title"].as_str(),
            uj["attributes"]["gia"].clone(),
            uj["assignee_ids"].clone()
        ),
        (Some("Đổi tên"), json!(7000), json!([]))
    );
    let acts = activities::list(&mut c, &admin, id1).await.unwrap();
    let kinds: Vec<&str> = acts.iter().map(|a| a.activity.action.as_str()).collect();
    assert_eq!(kinds, ["updated", "assigned", "contact_linked", "created"]);
    assert_eq!(
        js(&acts[0])["payload"]["fields"],
        json!(["title", "attributes", "priority", "assignee_ids"])
    );
    assert_eq!(
        err(cards::update(
            &mut c,
            &admin,
            id1,
            &patch(json!({ "assignee_ids": [outsider, 999_999] }))
        )
        .await
        .unwrap_err())
        .0,
        400
    );

    // Chuyển: sang cột hoàn thành đặt completed_at và cảnh báo WIP (giới hạn 1); chèn giữa; before sai ⇒ 400.
    let mv = cards::move_card(
        &mut c,
        &admin,
        id1,
        &MoveCard {
            column_id: done,
            before_card_id: None,
            after_card_id: None,
        },
    )
    .await
    .unwrap();
    assert!(mv.card.completed_at.is_some() && mv.wip_warning.is_none());
    let mv2 = cards::move_card(
        &mut c,
        &admin,
        id2,
        &MoveCard {
            column_id: done,
            before_card_id: Some(id1),
            after_card_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        mv2.wip_warning.as_deref(),
        Some("Cột \"Xong\" đang vượt giới hạn WIP (2/1)")
    );
    assert!(js(&mv2.card)["position"].as_f64().unwrap() > js(&mv.card)["position"].as_f64().unwrap());
    let back = cards::move_card(
        &mut c,
        &admin,
        id1,
        &MoveCard {
            column_id: todo,
            before_card_id: None,
            after_card_id: None,
        },
    )
    .await
    .unwrap();
    assert!(back.card.completed_at.is_none());
    assert_eq!(
        err(cards::move_card(
            &mut c,
            &admin,
            id1,
            &MoveCard {
                column_id: todo,
                before_card_id: Some(id2),
                after_card_id: None
            }
        )
        .await
        .unwrap_err()),
        (400, "before_card_id không hợp lệ".to_owned())
    );
    // Khoảng cách cạn ⇒ sắp lại cả cột rồi vẫn chuyển được.
    sqlx::query("UPDATE kanban_cards SET position = 1 WHERE id = $1")
        .bind(id1)
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("UPDATE kanban_cards SET position = 1.0000001 WHERE id = $1")
        .bind(id2)
        .execute(&mut *c)
        .await
        .unwrap();
    cards::move_card(
        &mut c,
        &admin,
        id2,
        &MoveCard {
            column_id: done,
            before_card_id: None,
            after_card_id: None,
        },
    )
    .await
    .unwrap();
    let c3 = cards::create(
        &mut c,
        &admin,
        &create(json!({ "column_id": done, "title": "Thẻ ba", "attributes": { "gia": 1 } })),
    )
    .await
    .unwrap();
    let renorm = cards::move_card(
        &mut c,
        &admin,
        c3.id,
        &MoveCard {
            column_id: done,
            before_card_id: Some(id2),
            after_card_id: None,
        },
    )
    .await
    .unwrap();
    assert!(js(&renorm.card)["position"].as_f64().unwrap() > 0.0);

    // Xoá: chỉ người tạo hoặc Quản trị; khôi phục chỉ người xoá/Quản trị, quá 10 phút ⇒ 410; ngoài phạm vi ⇒ 404.
    let owner_b = cards::create(
        &mut c,
        &mine_b_admin(b),
        &create(json!({ "column_id": todo, "title": "Thẻ của B", "attributes": { "gia": 1 } })),
    )
    .await
    .unwrap();
    assert_eq!(
        err(cards::remove(&mut c, &actor(a, false, OwnerIds::All), owner_b.id)
            .await
            .unwrap_err())
        .0,
        403
    );
    assert_eq!(
        cards::remove(&mut c, &mine_b_admin(b), owner_b.id).await.unwrap(),
        cards::Removed { deleted: true }
    );
    assert_eq!(
        err(cards::find_one(&mut c, &admin, owner_b.id).await.unwrap_err()).0,
        404
    );
    assert_eq!(
        err(cards::restore(&mut c, &nobody, owner_b.id).await.unwrap_err()).0,
        404
    );
    assert_eq!(
        err(cards::restore(&mut c, &actor(a, false, OwnerIds::All), owner_b.id)
            .await
            .unwrap_err())
        .0,
        403
    );
    assert_eq!(
        cards::restore(&mut c, &admin, owner_b.id).await.unwrap(),
        cards::Restored { restored: true }
    );
    cards::remove(&mut c, &admin, owner_b.id).await.unwrap();
    sqlx::query("UPDATE kanban_cards SET deleted_at = now() - interval '11 minutes' WHERE id = $1")
        .bind(owner_b.id)
        .execute(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        err(cards::restore(&mut c, &admin, owner_b.id).await.unwrap_err()).0,
        410
    );
    clean(&mut c).await;
}

fn mine_b_admin(b: i32) -> Actor {
    // Người tạo thẻ (không phải Quản trị) nhưng thấy mọi board.
    Actor {
        access: Access {
            can_manage_boards: true,
            role_ids: vec![],
        },
        ..actor(b, false, OwnerIds::All)
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn checklist_dinh_kem_va_binh_luan() {
    let _s = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let a = user(&mut c, 1).await;
    let b = user(&mut c, 2).await;
    let board: i32 = sqlx::query_scalar(
        "INSERT INTO kanban_boards (name, created_by, updated_at) VALUES ('m16 cl', $1, now()) RETURNING id",
    )
    .bind(a)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let col: i32 = sqlx::query_scalar("INSERT INTO kanban_columns (board_id, name, position, updated_at) VALUES ($1, 'Cột', 1024, now()) RETURNING id").bind(board).fetch_one(&mut *c).await.unwrap();
    let admin = actor(a, true, OwnerIds::All);
    let other = Actor {
        access: Access {
            can_manage_boards: true,
            role_ids: vec![],
        },
        ..actor(b, false, OwnerIds::All)
    };
    let card = cards::create(
        &mut c,
        &admin,
        &create(json!({ "column_id": col, "title": "Thẻ checklist" })),
    )
    .await
    .unwrap()
    .id;

    let i1 = checklist::create(&mut c, &admin, card, &CreateItem { text: "Một".into() })
        .await
        .unwrap();
    let i2 = checklist::create(&mut c, &admin, card, &CreateItem { text: "Hai".into() })
        .await
        .unwrap();
    assert_eq!(
        (js(&i1)["position"].clone(), js(&i2)["position"].clone()),
        (json!(1024), json!(2048))
    );
    let done = checklist::update(
        &mut c,
        &admin,
        i1.id,
        &UpdateItem {
            text: None,
            is_done: Some(true),
        },
    )
    .await
    .unwrap();
    assert!(done.is_done);
    checklist::update(
        &mut c,
        &admin,
        i1.id,
        &UpdateItem {
            text: Some("Một (sửa)".into()),
            is_done: Some(true),
        },
    )
    .await
    .unwrap();
    let r = checklist::reorder(&mut c, &admin, card, &ReorderItems { item_ids: vec![i2.id] }).await;
    assert_eq!(err(r.unwrap_err()).0, 400);
    let re = checklist::reorder(
        &mut c,
        &admin,
        card,
        &ReorderItems {
            item_ids: vec![i2.id, i1.id],
        },
    )
    .await
    .unwrap();
    assert_eq!(re.iter().map(|i| i.id).collect::<Vec<_>>(), [i2.id, i1.id]);
    let dto = cards::find_one(&mut c, &admin, card).await.unwrap();
    assert_eq!((dto.checklist_total, dto.checklist_done), (2, 1));
    // Người khác (không phải người tạo mục, chủ thẻ, Quản trị) xoá ⇒ 400.
    assert_eq!(err(checklist::remove(&mut c, &other, i1.id).await.unwrap_err()).0, 400);
    assert!(checklist::remove(&mut c, &admin, i1.id).await.unwrap().deleted);

    let at = attachments::create(
        &mut c,
        &admin,
        card,
        &CreateAttachment {
            url: "https://example.com/a".into(),
            title: Some("  ".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(at.title, None, "tiêu đề trắng thành null");
    assert_eq!(
        err(attachments::remove(&mut c, &other, at.id).await.unwrap_err()).0,
        403
    );
    assert_eq!(attachments::list(&mut c, &admin, card).await.unwrap().len(), 1);
    assert!(attachments::remove(&mut c, &admin, at.id).await.unwrap().deleted);

    let cm = activities::add_comment(
        &mut c,
        &admin,
        card,
        &CreateComment {
            content: "Xong rồi".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(js(&cm)["action"], "comment");
    assert_eq!(cards::find_one(&mut c, &admin, card).await.unwrap().comment_count, 1);
    let acts = activities::list(&mut c, &admin, card).await.unwrap();
    assert_eq!(acts[0].activity.action, "comment");
    assert!(acts.iter().any(|x| x.activity.action == "checklist_item_toggled"));
    assert_eq!(
        acts.iter()
            .filter(|x| x.activity.action == "checklist_item_toggled")
            .count(),
        1,
        "chỉ ghi khi trạng thái xong đổi"
    );
    clean(&mut c).await;
}
