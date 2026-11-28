//! Bản cài thật của các port tool Fanpage (`fanpage_deps`) trên Postgres thật: Page, luật bình luận, link chat, gửi hàng loạt
//! (kiểm, xem trước, tạo, gửi, huỷ) và các câu lỗi nghiệp vụ trả thành `ToolError::User`. Không gọi Graph (mọi thao tác chỉ
//! chạm DB). `FlowsPort` cắm sẵn (FlowsAdapter), không kiểm ở đây.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-mcp --test fanpage_ports_pg -- --ignored`
//! Dữ liệu mang tiền tố `fp44`, tự dọn. Pool chỉ 1 kết nối: mã giữ kết nối khi gọi dịch vụ khác sẽ làm test treo rồi hết hạn chờ.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use chrono::Utc;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::ingest::FacebookIngest;
use mod_mcp::ToolError;
use mod_mcp::tools::fanpage_deps;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn env() -> Env {
    Arc::new(|k: &str| match k {
        "FACEBOOK_APP_ID" => Some("123".into()),
        "FACEBOOK_APP_SECRET" => Some("shh".into()),
        _ => None,
    })
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn clean(c: &mut PgConnection) {
    exec(
        c,
        "DELETE FROM facebook_broadcast_recipients WHERE broadcast_id IN \
         (SELECT id FROM facebook_broadcasts WHERE page_id LIKE 'fp44%')",
    )
    .await;
    exec(c, "DELETE FROM facebook_broadcasts WHERE page_id LIKE 'fp44%'").await;
    exec(c, "DELETE FROM facebook_chat_links WHERE page_id LIKE 'fp44%'").await;
    exec(c, "DELETE FROM facebook_comment_rules WHERE name LIKE 'fp44%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'fp44%'").await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'fp44%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'fp44%@test.local'").await;
}

struct Fixture {
    ingest: Arc<FacebookIngest>,
    company: CompanyRef,
    user: i32,
}

/// Page `fp44p` đang kết nối và một người dùng. Pool 1 kết nối.
async fn setup() -> Fixture {
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let company = CompanyRef::DEFAULT;
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user: i32 = sqlx::query_scalar(
        "INSERT INTO users (email, password_hash, full_name, status, updated_at) \
         VALUES ('fp44a@test.local', 'x', 'FP44', 'active', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let src: i32 = sqlx::query_scalar(
        "INSERT INTO setting_options (group_key, value, label, updated_at) \
         VALUES ('contact_source', 'fp44_fb', 'Facebook', now()) RETURNING id",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, \
         contact_source_id, connected_by, updated_at) \
         VALUES ('fp44p', 'Quán FP44', 'x', true, 'active', true, $1, $2, $1, now())",
    )
    .bind(user)
    .bind(src)
    .execute(&mut *c)
    .await
    .unwrap();
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi mô-đun
    let e = env();
    let e2 = e.clone();
    let ingest = Arc::new(FacebookIngest::new(
        db,
        e,
        Arc::new(move |_| GraphClient::new(e2.clone(), Arc::new(|_| {}))),
    ));
    Fixture { ingest, company, user }
}

fn user_msg(e: ToolError) -> String {
    match e {
        ToolError::User(m) => m,
        other => panic!("cần ToolError::User, được {other:?}"),
    }
}

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn page_va_flows_trong() {
    let _g = serial().lock().await;
    let f = setup().await;
    let ports = fanpage_deps(f.ingest.clone(), false, None, None);
    // FlowsAdapter luôn được cắm; posts chỉ có khi truyền PostsDeps.
    assert!(ports.flows.is_some() && ports.posts.is_none());
    let pages = ports.pages.as_ref().unwrap().pages(f.company).await.unwrap();
    let p = pages.iter().find(|p| p.page_id == "fp44p").expect("có Page fp44p");
    assert_eq!(p.name, "Quán FP44");
    assert!(p.is_active);
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn luat_binh_luan_tao_sua_thu_va_link_hong() {
    let _g = serial().lock().await;
    let f = setup().await;
    let ports = fanpage_deps(f.ingest.clone(), false, None, None);
    let cm = ports.comments.as_ref().unwrap();

    let rule = cm
        .create_rule(
            f.company,
            f.user,
            obj(json!({ "name": "fp44 luật giá", "keywords": ["giá"], "public_replies": ["Chào {ten}"] })),
        )
        .await
        .unwrap();
    let id = i32::try_from(rule["id"].as_i64().unwrap()).unwrap();
    assert_eq!(rule["mode"], "test"); // mặc định chế độ thử
    assert!(
        cm.list_rules(f.company)
            .await
            .unwrap()
            .iter()
            .any(|r| r["id"] == rule["id"])
    );

    let rule = cm
        .update_rule(f.company, id, obj(json!({ "name": "fp44 luật đổi tên" })))
        .await
        .unwrap();
    assert_eq!(rule["name"], "fp44 luật đổi tên");

    // Thân sai (mode ngoài test/live) ⇒ 400 thành câu cho AI; luật không tồn tại ⇒ 404 cũng thành câu.
    let bad = cm
        .create_rule(f.company, f.user, obj(json!({ "mode": "zzz" })))
        .await
        .unwrap_err();
    assert!(user_msg(bad).contains("mode must be one of"));
    assert!(matches!(
        cm.update_rule(f.company, 999_999, obj(json!({ "name": "x" })))
            .await
            .unwrap_err(),
        ToolError::User(_)
    ));

    let dry = cm
        .dry_run(f.company, json!({ "message": "giá bao nhiêu", "page_id": "fp44p" }))
        .await
        .unwrap();
    assert!(dry.get("actions").is_some() && dry.get("matched_rule").is_some());

    // Khoảng `since` ở tương lai ⇒ không còn bình luận nào.
    let q = mod_mcp::tools::CommentQuery {
        limit: 100,
        status: None,
        since: Utc::now() + chrono::Duration::days(1),
    };
    assert!(cm.list_comments(f.company, q).await.unwrap().is_empty());

    assert_eq!(
        cm.normalize_post_id("https://facebook.com/x/posts/1234567", Some("fp44p"))
            .unwrap()
            .as_deref(),
        Some("fp44p_1234567")
    );
    assert!(matches!(
        cm.normalize_post_id("linh tinh", None).unwrap_err(),
        ToolError::User(_)
    ));
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn link_chat_tao_va_liet_ke() {
    let _g = serial().lock().await;
    let f = setup().await;
    let ports = fanpage_deps(f.ingest.clone(), false, None, None);
    let cl = ports.chat_links.as_ref().unwrap();
    let made = cl
        .create(f.company, f.user, json!({ "name": "fp44 link", "page_id": "fp44p" }))
        .await
        .unwrap();
    assert_eq!(made["page_id"], "fp44p");
    let rows = cl.list(f.company).await.unwrap();
    assert!(rows.iter().any(|r| r["id"] == made["id"] && r["name"] == "fp44 link"));
    // Thiếu Page ⇒ câu nghiệp vụ, không phải lỗi hệ thống.
    let e = cl
        .create(
            f.company,
            f.user,
            json!({ "name": "fp44 hỏng", "page_id": "fp44-khong-co" }),
        )
        .await
        .unwrap_err();
    assert!(matches!(e, ToolError::User(_)), "{e:?}");
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn huong_dan_quan_tri_page_soan_theo_page_id_facebook() {
    let _g = serial().lock().await;
    let f = setup().await;
    let ports = fanpage_deps(f.ingest.clone(), false, None, None);
    let g = ports.admin_guide.as_ref().unwrap();
    let d = g
        .compose(f.company, "fp44p", Some("Chị Lan".into()), None)
        .await
        .unwrap();
    assert_eq!(
        (d["sent"].clone(), d["page_name"].clone()),
        (json!(false), json!("Quán FP44"))
    );
    assert!(d["text"].as_str().unwrap().starts_with("Chào Chị Lan,"));
    // Page lạ ⇒ câu nghiệp vụ (404 của dịch vụ), không phải lỗi hệ thống.
    let e = g.compose(f.company, "fp44-khong-co", None, None).await.unwrap_err();
    assert!(matches!(e, ToolError::User(_)), "{e:?}");
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn gui_hang_loat_kiem_tao_gui_huy() {
    let _g = serial().lock().await;
    let f = setup().await;
    let kicks = Arc::new(AtomicUsize::new(0));
    let k = kicks.clone();
    let ports = fanpage_deps(
        f.ingest.clone(),
        false,
        Some(Arc::new(move || {
            k.fetch_add(1, Ordering::SeqCst);
        })),
        None,
    );
    let bc = ports.broadcasts.as_ref().unwrap();
    let ok = json!({ "name": "fp44 lượt", "page_id": "fp44p", "text": "Chào {ten}" });

    bc.validate(f.company, &ok, false).await.unwrap();
    let empty = json!({ "name": "fp44 lượt", "page_id": "fp44p", "text": "   " });
    assert!(bc.validate(f.company, &empty, false).await.is_err());
    // Sửa một phần: trường vắng được bỏ qua.
    bc.validate(f.company, &json!({ "name": "fp44 đổi" }), true)
        .await
        .unwrap();

    bc.check_send_time(None).unwrap();
    let far = Utc::now() + chrono::Duration::days(8);
    assert!(user_msg(bc.check_send_time(Some(far)).unwrap_err()).starts_with("Hẹn tối đa 7 ngày"));

    let preview = bc.preview(f.company, "fp44p", &json!({})).await.unwrap();
    assert!(preview["eligible"].is_number() && preview["outside_window"].is_number());

    let made = bc.create(f.company, f.user, &ok, "mcp").await.unwrap();
    let id = i32::try_from(made["id"].as_i64().unwrap()).unwrap();
    assert_eq!(made["status"], "draft");
    assert_eq!(made["page_name"], "Quán FP44");

    // Lượt nháp chưa gửi ⇒ không huỷ được.
    assert!(matches!(
        bc.cancel_pending(f.company, id).await.unwrap_err(),
        ToolError::User(_)
    ));

    let patched = bc
        .update(f.company, id, obj(json!({ "name": "fp44 đã đổi" })))
        .await
        .unwrap();
    assert_eq!(patched["name"], "fp44 đã đổi");

    let hen = Utc::now() + chrono::Duration::hours(2);
    let sent = bc.send(f.company, id, Some(hen)).await.unwrap();
    assert_eq!(sent["status"], "scheduled");
    bc.kick();
    assert_eq!(kicks.load(Ordering::SeqCst), 1);

    assert!(
        bc.list(f.company, 20)
            .await
            .unwrap()
            .iter()
            .any(|b| b["id"] == made["id"])
    );
    assert!(bc.recipients(f.company, id, 200).await.unwrap().is_empty());
    assert_eq!(bc.get(f.company, id).await.unwrap()["status"], "scheduled");

    let after = bc.cancel_pending(f.company, id).await.unwrap();
    assert_eq!(after["status"], "cancelled");
    // Huỷ lần hai ⇒ đã kết thúc.
    assert!(matches!(
        bc.cancel_pending(f.company, id).await.unwrap_err(),
        ToolError::User(_)
    ));
    // Không có lượt ⇒ 404 thành câu.
    assert!(matches!(
        bc.get(f.company, 999_999).await.unwrap_err(),
        ToolError::User(_)
    ));
}
