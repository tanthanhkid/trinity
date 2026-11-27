//! M15: bảng, cột, nhãn, trường tuỳ biến trên Postgres thật (`public` đã migrate bằng Prisma, như job Rust pg tests).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-kanban --test pg -- --ignored`
//! Dữ liệu mang tiền tố `m15`, tự dọn; các test chạy nối tiếp.

use mod_kanban::boards::{self, CreateBoard, CreateBoardFromTemplate, UpdateBoard};
use mod_kanban::columns::{self, CreateColumn, ReorderColumns, UpdateColumn};
use mod_kanban::field_defs::{self, CreateFieldDef, FieldOption, ReorderFieldDefs, UpdateFieldDef};
use mod_kanban::{Access, labels};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};

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

async fn clean(c: &mut PgConnection) {
    sqlx::query("DELETE FROM kanban_boards WHERE name LIKE 'm15%'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE email = 'm15@test.local'")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM roles WHERE name LIKE 'm15%'")
        .execute(&mut *c)
        .await
        .unwrap();
}

fn admin() -> Access {
    Access {
        can_manage_boards: true,
        role_ids: vec![],
    }
}

fn board(name: &str) -> CreateBoard {
    CreateBoard {
        name: name.into(),
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn board_hien_thi_theo_vai_tro_va_vong_doi() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let uid: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m15@test.local', 'x', 'M15', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let role: i32 = sqlx::query_scalar("INSERT INTO roles (name, updated_at) VALUES ('m15 role', now()) RETURNING id")
        .fetch_one(&mut *c)
        .await
        .unwrap();

    let open = boards::create(&mut c, &board("m15 mở"), uid).await.unwrap();
    assert!(open.visibility_role_ids.0.is_empty());
    assert_eq!(json(&open)["settings"], serde_json::json!({}));
    let limited = boards::create(
        &mut c,
        &CreateBoard {
            visibility_role_ids: Some(vec![role]),
            card_prefix: Some("CV-".into()),
            ..board("m15 hạn chế")
        },
        uid,
    )
    .await
    .unwrap();

    // Người không có kanban.boards: chỉ thấy board mở, hoặc board thuộc vai trò của mình.
    let plain = Access {
        can_manage_boards: false,
        role_ids: vec![],
    };
    let names = |rows: &[boards::BoardListRow]| {
        rows.iter()
            .map(|r| r.name.clone())
            .filter(|n| n.starts_with("m15"))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&boards::find_all_visible(&mut c, &plain).await.unwrap()),
        ["m15 mở"]
    );
    let with_role = Access {
        can_manage_boards: false,
        role_ids: vec![role],
    };
    assert_eq!(
        names(&boards::find_all_visible(&mut c, &with_role).await.unwrap()),
        ["m15 hạn chế", "m15 mở"]
    );
    assert_eq!(
        names(&boards::find_all_visible(&mut c, &admin()).await.unwrap()),
        ["m15 hạn chế", "m15 mở"]
    );
    // Board ngoài phạm vi ⇒ 404 (không phải 403).
    let e = boards::find_one_detail(&mut c, &plain, limited.id).await.unwrap_err();
    assert_eq!(status(e), (404, format!("\"Không tìm thấy board ID {}\"", limited.id)));
    let list = boards::find_all_visible(&mut c, &admin()).await.unwrap();
    let keys: Vec<_> = json(&list[0]).as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys[keys.len() - 2..], ["column_count", "card_count"]);

    // Sửa: null xoá, vắng giữ nguyên; tắt board thì người thường không thấy nữa.
    let upd: UpdateBoard = serde_json::from_str(r#"{"card_prefix":null,"is_active":false}"#).unwrap();
    let u = boards::update(&mut c, open.id, &upd).await.unwrap();
    assert!(!u.is_active);
    assert_eq!(u.name, "m15 mở");
    assert!(!names(&boards::find_all_visible(&mut c, &plain).await.unwrap()).contains(&"m15 mở".to_owned()));
    assert!(names(&boards::find_all_visible(&mut c, &admin()).await.unwrap()).contains(&"m15 mở".to_owned()));
    assert_eq!(
        status(boards::update(&mut c, 0, &UpdateBoard::default()).await.unwrap_err()).0,
        404
    );

    // Xoá mềm: biến mất cả với admin, trả board có deleted_at.
    let gone = boards::remove(&mut c, open.id).await.unwrap();
    assert!(gone.deleted_at.is_some());
    assert_eq!(
        status(boards::find_one_detail(&mut c, &admin(), open.id).await.unwrap_err()).0,
        404
    );
    assert_eq!(status(boards::remove(&mut c, open.id).await.unwrap_err()).0, 404);
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn mau_cot_va_xoa_cot_don_card() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let uid: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m15@test.local', 'x', 'M15', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();

    let t = boards::list_templates();
    assert_eq!(
        t.iter().map(|x| x.key).collect::<Vec<_>>(),
        ["sales", "customer_care", "internal_work"]
    );
    let b = boards::create_from_template(
        &mut c,
        &CreateBoardFromTemplate {
            template_key: "internal_work".into(),
            name: Some("  m15 mẫu ".into()),
        },
        uid,
    )
    .await
    .unwrap();
    assert_eq!(b.name, "m15 mẫu");
    assert_eq!(
        b.columns.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
        ["Cần làm", "Đang làm", "Chờ duyệt", "Xong"]
    );
    assert_eq!(
        b.columns.iter().map(|x| x.is_done).collect::<Vec<_>>(),
        [false, false, false, true]
    );
    assert_eq!(json(&b.columns[2])["position"], 3072);
    let bad = boards::create_from_template(
        &mut c,
        &CreateBoardFromTemplate {
            template_key: "x".into(),
            name: None,
        },
        uid,
    )
    .await;
    assert_eq!(
        status(bad.unwrap_err()),
        (400, "\"template_key không hợp lệ\"".to_owned())
    );

    // Thêm cột vào cuối; sắp lại phải đủ và đúng.
    let extra = columns::create(
        &mut c,
        b.id,
        &CreateColumn {
            name: "m15 thêm".into(),
            color: Some("#abc".into()),
            wip_limit: Some(3),
            is_done: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(json(&extra)["position"], 5120);
    assert_eq!(extra.wip_limit, Some(3));
    let ids: Vec<i32> = b.columns.iter().map(|x| x.id).chain([extra.id]).collect();
    let mut rev = ids.clone();
    rev.reverse();
    let re = columns::reorder(
        &mut c,
        b.id,
        &ReorderColumns {
            column_ids: rev.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(re.iter().map(|x| x.id).collect::<Vec<_>>(), rev);
    let short = columns::reorder(
        &mut c,
        b.id,
        &ReorderColumns {
            column_ids: vec![ids[0]],
        },
    )
    .await;
    assert_eq!(status(short.unwrap_err()).0, 400);

    // Đổi cờ is_done đồng bộ completed_at của card trong cột.
    let todo = b.columns[0].id;
    let card: i32 = sqlx::query_scalar(
        "INSERT INTO kanban_cards (board_id, column_id, position, title, created_by, updated_at) VALUES ($1, $2, 1024, 'c1', $3, now()) RETURNING id",
    )
    .bind(b.id)
    .bind(todo)
    .bind(uid)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let done: UpdateColumn = serde_json::from_str(r#"{"is_done":true,"wip_limit":null}"#).unwrap();
    let col = columns::update(&mut c, todo, &done).await.unwrap();
    assert!(col.is_done && col.wip_limit.is_none());
    let comp = completed(&mut c, card).await;
    assert!(comp.is_some());
    let undone: UpdateColumn = serde_json::from_str(r#"{"is_done":false}"#).unwrap();
    columns::update(&mut c, todo, &undone).await.unwrap();
    assert!(completed(&mut c, card).await.is_none());

    // Xoá cột còn card: bắt buộc cột đích; dồn card kèm activity; cột đích phải cùng board và khác chính nó.
    let no_target = columns::remove(&mut c, todo, None, uid).await;
    assert_eq!(status(no_target.unwrap_err()).0, 400);
    let same = columns::remove(&mut c, todo, Some(todo), uid).await;
    assert_eq!(
        status(same.unwrap_err()),
        (400, "\"Cột đích phải khác cột đang xoá\"".to_owned())
    );
    let other = boards::create(&mut c, &board("m15 khác"), uid).await.unwrap();
    let foreign = columns::create(
        &mut c,
        other.id,
        &CreateColumn {
            name: "f".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let wrong = columns::remove(&mut c, todo, Some(foreign.id), uid).await;
    assert_eq!(status(wrong.unwrap_err()).0, 400);
    let target = b.columns[3].id; // cột hoàn thành
    let r = columns::remove(&mut c, todo, Some(target), uid).await.unwrap();
    assert_eq!((r.deleted, r.moved_cards), (true, 1));
    let (col_id, pos, comp): (i32, f64, bool) =
        sqlx::query_as("SELECT column_id, position, completed_at IS NOT NULL FROM kanban_cards WHERE id = $1")
            .bind(card)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!((col_id, pos, comp), (target, 1024.0, true));
    let act: String =
        sqlx::query_scalar("SELECT payload::text FROM kanban_card_activities WHERE card_id = $1 AND action = 'moved'")
            .bind(card)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert!(
        act.contains("column_deleted") && act.contains(&format!("\"to_column_id\": {target}")),
        "{act}"
    );
    // Cột trống xoá thẳng; không còn thì 404.
    let r = columns::remove(&mut c, extra.id, None, uid).await.unwrap();
    assert_eq!(r.moved_cards, 0);
    assert_eq!(
        status(columns::remove(&mut c, extra.id, None, uid).await.unwrap_err()).0,
        404
    );
    assert_eq!(
        status(columns::create(&mut c, 0, &CreateColumn::default()).await.unwrap_err()).0,
        404
    );
    clean(&mut c).await;
}

mod chrono_free {
    pub type Ts = String;
}

async fn completed(c: &mut PgConnection, card: i32) -> Option<chrono_free::Ts> {
    sqlx::query_scalar("SELECT completed_at::text FROM kanban_cards WHERE id = $1")
        .bind(card)
        .fetch_one(c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn nhan_mau_va_truong_tuy_bien() {
    let _g = serial().lock().await;
    let mut c = conn().await;
    clean(&mut c).await;
    let uid: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m15@test.local', 'x', 'M15', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let b = boards::create(&mut c, &board("m15 nhãn"), uid).await.unwrap();
    let col = columns::create(
        &mut c,
        b.id,
        &CreateColumn {
            name: "c".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // Nhãn: id uuid, tên cắt khoảng trắng; ai thấy board cũng sửa được, board ẩn ⇒ 404.
    let plain = Access {
        can_manage_boards: false,
        role_ids: vec![],
    };
    let l = labels::create(
        &mut c,
        &plain,
        b.id,
        &labels::CreateLabel {
            name: "  Gấp ".into(),
            color: "#eb5a46".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(l.labels.len(), 1);
    assert_eq!(l.labels[0].name, "Gấp");
    assert_eq!(l.labels[0].id.len(), 36);
    let id = l.labels[0].id.clone();
    let up: labels::UpdateLabel = serde_json::from_str(r##"{"color":"#000"}"##).unwrap();
    let l2 = labels::update(&mut c, &plain, b.id, &id, &up).await.unwrap();
    assert_eq!(
        (l2.labels[0].name.as_str(), l2.labels[0].color.as_str()),
        ("Gấp", "#000")
    );
    assert_eq!(
        status(labels::update(&mut c, &plain, b.id, "khong-co", &up).await.unwrap_err()).0,
        404
    );
    let hidden = boards::update(&mut c, b.id, &serde_json::from_str(r#"{"is_active":false}"#).unwrap())
        .await
        .unwrap();
    assert!(!hidden.is_active);
    let e = labels::create(
        &mut c,
        &plain,
        b.id,
        &labels::CreateLabel {
            name: "x".into(),
            color: "#fff".into(),
        },
    )
    .await;
    assert_eq!(status(e.unwrap_err()).0, 404);
    boards::update(&mut c, b.id, &serde_json::from_str(r#"{"is_active":true}"#).unwrap())
        .await
        .unwrap();

    // Xoá nhãn gỡ id khỏi mọi card đang gắn.
    let card: i32 = sqlx::query_scalar(
        "INSERT INTO kanban_cards (board_id, column_id, position, title, created_by, labels, updated_at) VALUES ($1, $2, 1024, 'c', $3, ARRAY[$4, 'giu'], now()) RETURNING id",
    )
    .bind(b.id)
    .bind(col.id)
    .bind(uid)
    .bind(&id)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let after = labels::remove(&mut c, &plain, b.id, &id).await.unwrap();
    assert!(after.labels.is_empty());
    let on_card: Vec<String> = sqlx::query_scalar("SELECT unnest(labels) FROM kanban_cards WHERE id = $1")
        .bind(card)
        .fetch_all(&mut *c)
        .await
        .unwrap();
    assert_eq!(on_card, ["giu"]);
    // Trần 30 nhãn.
    for i in 0..30 {
        labels::create(
            &mut c,
            &plain,
            b.id,
            &labels::CreateLabel {
                name: format!("n{i}"),
                color: "#fff".into(),
            },
        )
        .await
        .unwrap();
    }
    let full = labels::create(
        &mut c,
        &plain,
        b.id,
        &labels::CreateLabel {
            name: "thừa".into(),
            color: "#fff".into(),
        },
    )
    .await;
    assert_eq!(
        status(full.unwrap_err()),
        (400, "\"Board đã đạt trần 30 nhãn\"".to_owned())
    );
    let detail = boards::find_one_detail(&mut c, &plain, b.id).await.unwrap();
    assert_eq!(detail.label_defs.len(), 30);
    assert_eq!(detail.columns.len(), 1);

    // Trường tuỳ biến: select bắt buộc options; khoá trùng ⇒ 409; type không đổi được; sắp lại; xoá.
    let sel = |key: &str| CreateFieldDef {
        key: key.into(),
        label: "Mức độ".into(),
        r#type: "select".into(),
        options: Some(vec![FieldOption {
            value: "high".into(),
            label: "Cao".into(),
        }]),
        required: None,
        show_on_card: Some(true),
    };
    let none = CreateFieldDef {
        options: None,
        ..sel("p")
    };
    assert_eq!(
        status(field_defs::create(&mut c, b.id, &none).await.unwrap_err()).0,
        400
    );
    let f1 = field_defs::create(&mut c, b.id, &sel("muc_do")).await.unwrap();
    assert!(!f1.required && f1.show_on_card);
    assert_eq!(
        json(&f1)["options"],
        serde_json::json!([{"value": "high", "label": "Cao"}])
    );
    let dup = field_defs::create(&mut c, b.id, &sel("muc_do")).await;
    assert_eq!(
        status(dup.unwrap_err()),
        (409, "\"Trường \\\"muc_do\\\" đã tồn tại trong board này\"".to_owned())
    );
    let f2 = field_defs::create(
        &mut c,
        b.id,
        &CreateFieldDef {
            options: None,
            r#type: "text".into(),
            ..sel("ghi_chu")
        },
    )
    .await
    .unwrap();
    assert!(json(&f2)["options"].is_null());
    assert_eq!(json(&f2)["position"], 2048);
    let clear: UpdateFieldDef = serde_json::from_str(r#"{"options":null}"#).unwrap();
    assert_eq!(
        status(field_defs::update(&mut c, f1.id, &clear).await.unwrap_err()).0,
        400
    );
    let ok: UpdateFieldDef = serde_json::from_str(r#"{"label":"Ưu tiên","required":true}"#).unwrap();
    let f1u = field_defs::update(&mut c, f1.id, &ok).await.unwrap();
    assert_eq!(
        (f1u.label.as_str(), f1u.required, f1u.r#type.as_str()),
        ("Ưu tiên", true, "select")
    );
    let t_clear = field_defs::update(&mut c, f2.id, &clear).await.unwrap();
    assert!(t_clear.options.is_none());
    let re = field_defs::reorder(
        &mut c,
        b.id,
        &ReorderFieldDefs {
            field_def_ids: vec![f2.id, f1.id],
        },
    )
    .await
    .unwrap();
    assert_eq!(re.iter().map(|x| x.id).collect::<Vec<_>>(), [f2.id, f1.id]);
    let bad = field_defs::reorder(
        &mut c,
        b.id,
        &ReorderFieldDefs {
            field_def_ids: vec![f1.id],
        },
    )
    .await;
    assert_eq!(status(bad.unwrap_err()).0, 400);
    assert!(field_defs::remove(&mut c, f1.id).await.unwrap().deleted);
    assert_eq!(status(field_defs::remove(&mut c, f1.id).await.unwrap_err()).0, 404);
    assert_eq!(
        status(field_defs::create(&mut c, 0, &sel("x")).await.unwrap_err()).0,
        404
    );
    clean(&mut c).await;
}
