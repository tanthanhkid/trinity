//! Kết nối Fanpage trên Postgres thật (`public` đã migrate bằng Prisma) với máy chủ giả Graph (wiremock; kịch bản như C06b).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test pages_pg -- --ignored`
//! Dữ liệu mang tiền tố `m46`, tự dọn. Pool chỉ 1 kết nối: nếu mã giữ kết nối khi gọi Graph (HTTP) hoặc xin kết nối thứ hai trong
//! lúc đang giữ một, test sẽ treo rồi hết hạn chờ.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::pages::{self, Ctx, UpdatePage};
use mod_facebook::state::{sign_state, verify_state};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{decrypt_secret, load_secret_key};
use trinity_rbac::OwnerIds;
use wiremock::matchers::{header, method, path, path_regex, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// (page_id, tên, đã đăng ký webhook, trạng thái token, người nhận mặc định, nguồn khách, người nối, đang bật).
type PageRow = (String, String, bool, String, i32, i32, i32, bool);

const NOW: i64 = 1_800_000_000_000;

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn env_for(graph_base: &str) -> Env {
    let base = graph_base.to_owned();
    let key = STANDARD.encode([7_u8; 32]);
    Arc::new(move |k| match k {
        "JWT_SECRET" => Some("bi-mat-jwt".into()),
        "INTEGRATIONS_SECRET_KEY" => Some(key.clone()),
        "INTEGRATIONS_PUBLIC_BASE_URL" => Some("https://crm.example.test".into()),
        "FACEBOOK_APP_ID" => Some("123".into()),
        "FACEBOOK_APP_SECRET" => Some("shh".into()),
        "FACEBOOK_GRAPH_BASE_URL" => Some(base.clone()),
        _ => None,
    })
}

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

fn json_of(v: &impl serde::Serialize) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn clean(c: &mut PgConnection) {
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm46%'").await;
    exec(c, "DELETE FROM social_accounts WHERE external_id LIKE 'm46%'").await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'm46%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm46%@test.local'").await;
}

async fn one_i32(c: &mut PgConnection, sql: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

fn graph_error(code: i64) -> Value {
    json!({ "error": { "message": format!("Lỗi Graph giả {code}"), "type": "OAuthException", "code": code, "fbtrace_id": "MOCKTRACE" } })
}

async fn mount_login(server: &MockServer) {
    let ok = |b: Value| ResponseTemplate::new(200).set_body_json(b);
    Mock::given(method("GET"))
        .and(path("/v25.0/oauth/access_token"))
        .and(query_param("code", "CODE"))
        .respond_with(ok(json!({ "access_token": "SHORT" })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/oauth/access_token"))
        .and(query_param("grant_type", "fb_exchange_token"))
        .respond_with(ok(json!({ "access_token": "LONG" })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/me/accounts"))
        .and(header("authorization", "Bearer LONG"))
        .respond_with(ok(json!({ "data": [
            { "id": "m46a", "name": "Quán A", "access_token": "PTa", "tasks": ["MANAGE"], "picture": { "data": { "url": "https://img/a.png" } } },
            { "id": "m46b", "name": "Quán B", "access_token": "PTb" },
            { "id": "m46c", "name": "Quán C", "access_token": "PTc", "tasks": ["MESSAGING"] },
            { "id": "m46d", "name": "Quán D không có token" },
            "phần tử hỏng"
        ] })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/me/permissions"))
        .respond_with(ok(json!({ "data": [
            { "permission": "pages_show_list", "status": "granted" }, { "permission": "pages_read_engagement", "status": "granted" },
            { "permission": "pages_manage_posts", "status": "granted" }
        ] })))
        .mount(server)
        .await;
    // Page B không đăng ký được webhook (thiếu quyền): vẫn được nối, `subscribed = false`.
    Mock::given(method("POST"))
        .and(path("/v25.0/m46b/subscribed_apps"))
        .respond_with(ResponseTemplate::new(400).set_body_json(graph_error(10)))
        .with_priority(1)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/v25\.0/m46./subscribed_apps$"))
        .respond_with(ok(json!({ "success": true })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/me/messenger_profile"))
        .respond_with(ok(json!({ "data": [] })))
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messenger_profile"))
        .respond_with(ok(json!({ "result": "success" })))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/debug_token"))
        .respond_with(ok(json!({ "data": { "is_valid": true, "expires_at": 0 } })))
        .mount(server)
        .await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn ket_noi_fanpage_day_du() {
    let _g = serial().lock().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let platform = Platform::new(&db, None);
    let company = CompanyRef::DEFAULT;
    let server = MockServer::start().await;
    let env = env_for(&server.uri());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let graph = GraphClient::new(env.clone(), Arc::new(move |o| s2.lock().unwrap().push(o)));
    let ctx = Ctx {
        db: &db,
        env: &env,
        graph: &graph,
        platform: &platform,
        company,
    };
    let key = load_secret_key(&|k: &str| env(k)).unwrap();

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let mk_user = |tag: &'static str, active: bool| {
        format!(
            "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m46{tag}@test.local', 'x', 'M46', '{}', now()) RETURNING id",
            if active { "active" } else { "inactive" }
        )
    };
    let actor = one_i32(&mut c, &mk_user("a", true)).await;
    let other = one_i32(&mut c, &mk_user("b", true)).await;
    let gone = one_i32(&mut c, &mk_user("c", false)).await;
    let src_fb = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm46_fb', 'Facebook Ads', now()) RETURNING id").await;
    let src_other = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm46_x', 'Giới thiệu', now()) RETURNING id").await;
    let stage = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_stage', 'm46_s', 'Giai đoạn', now()) RETURNING id").await;
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi hàm của mô-đun

    // Trạng thái cấu hình và URL đăng nhập: `state` ký cho đúng người bấm, đủ quyền Messenger + đăng bài, không lộ secret.
    let st = json_of(&pages::status(&env));
    assert_eq!(
        (
            st["configured"].as_bool(),
            st["secret_key_configured"].as_bool(),
            st["verify_token_set"].as_bool()
        ),
        (Some(true), Some(true), Some(false))
    );
    assert_eq!(
        st["oauth_redirect_uri"],
        "https://crm.example.test/api/v1/facebook/oauth/callback"
    );
    assert!(!st.to_string().contains("shh"));
    let u = pages::connect_url(&ctx, actor, NOW).await.unwrap();
    let url = u["url"].as_str().unwrap();
    assert!(url.starts_with("https://www.facebook.com/v25.0/dialog/oauth?client_id=123&redirect_uri=https%3A%2F%2Fcrm.example.test%2Fapi%2Fv1%2Ffacebook%2Foauth%2Fcallback&state="), "{url}");
    assert!(
        url.contains("pages_messaging%2Cpages_manage_metadata")
            && url.contains("pages_manage_posts")
            && url.ends_with("&response_type=code")
    );
    let state = url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(verify_state("bi-mat-jwt", &state, NOW, false, None), Some(actor));
    // Chưa cấu hình ⇒ 503 với câu của bản Node.
    let bare: Env = Arc::new(|_| None);
    let bare_graph = GraphClient::new(bare.clone(), Arc::new(|_| {}));
    let bare_ctx = Ctx {
        db: &db,
        env: &bare,
        graph: &bare_graph,
        platform: &platform,
        company,
    };
    let (code, msg) = status(pages::connect_url(&bare_ctx, actor, NOW).await.unwrap_err());
    assert_eq!(code, 503);
    assert!(msg.contains("FACEBOOK_APP_ID"), "{msg}");

    // State sai/hết hạn/của người khác ⇒ 400, chưa gọi Facebook.
    mount_login(&server).await;
    let bad = pages::handle_callback(&ctx, "CODE", "khong.hop.le", NOW)
        .await
        .unwrap_err();
    assert_eq!(status(bad).0, 400);
    let expired = sign_state("bi-mat-jwt", actor, None, NOW - 11 * 60 * 1000);
    assert_eq!(
        status(pages::handle_callback(&ctx, "CODE", &expired, NOW).await.unwrap_err()).0,
        400
    );
    assert!(server.received_requests().await.unwrap().is_empty());

    // Callback: 3 Page. A (MANAGE) và B (không có task) có phần đăng bài, C (chỉ MESSAGING) thì không.
    let r = pages::handle_callback(&ctx, "CODE", &state, NOW).await.unwrap();
    assert_eq!(
        (r.connected, r.failed, r.posting),
        (3, 2, 2),
        "Page thiếu access_token và phần tử hỏng chỉ tính là Page lỗi"
    );
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let rows: Vec<PageRow> = sqlx::query_as(
        "SELECT page_id, name, subscribed, token_status, default_assignee_id, contact_source_id, connected_by, is_active FROM facebook_pages WHERE page_id LIKE 'm46%' ORDER BY page_id",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap();
    assert_eq!(
        rows[0],
        (
            "m46a".into(),
            "Quán A".into(),
            true,
            "active".into(),
            actor,
            src_fb,
            actor,
            true
        )
    );
    assert_eq!(
        (rows[1].0.as_str(), rows[1].2),
        ("m46b", false),
        "đăng ký webhook lỗi vẫn nối Page"
    );
    assert_eq!((rows[2].0.as_str(), rows[2].3.as_str()), ("m46c", "active"));
    // Token lưu mã hoá và giải mã được; không bao giờ ở dạng rõ.
    let enc: String = sqlx::query_scalar("SELECT token_enc FROM facebook_pages WHERE page_id = 'm46a'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(enc.starts_with("v1.") && !enc.contains("PTa"));
    assert_eq!(decrypt_secret(&enc, &key).unwrap(), "PTa");
    let soc: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as("SELECT external_id, scopes, status, avatar_url FROM social_accounts WHERE external_id LIKE 'm46%' ORDER BY external_id").fetch_all(&mut *c).await.unwrap();
    assert_eq!(soc.len(), 2);
    assert_eq!(
        (
            soc[0].0.as_str(),
            soc[0].1.as_str(),
            soc[0].2.as_str(),
            soc[0].3.as_deref()
        ),
        (
            "m46a",
            "pages_show_list pages_read_engagement pages_manage_posts",
            "active",
            Some("https://img/a.png")
        )
    );
    // Mỗi lời gọi Graph đã báo cho cửa sổ lỗi; có lỗi 10 (đọc/đăng ký, không phải gửi) nhưng không có lời gọi GỬI nào.
    assert!(seen.lock().unwrap().iter().any(|o| o.code == Some(10)) && seen.lock().unwrap().iter().all(|o| !o.send));

    // Danh sách: không lộ token, thứ tự khoá như bản Node, trạng thái đăng bài.
    let list = pages::list(&mut c).await.unwrap();
    let v = json_of(&list[0]);
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(&keys[..4], ["id", "page_id", "name", "token_status"]);
    assert_eq!(&keys[keys.len() - 2..], ["posting", "disconnected"]);
    assert!(!v.to_string().contains("token_enc") && !v.to_string().contains("PTa"));
    assert_eq!(
        (v["posting"].as_str(), v["disconnected"].as_bool()),
        (Some("on"), Some(false))
    );
    assert_eq!(json_of(&list[2])["posting"], Value::Null);
    let id_a = list.iter().find(|p| p.page_id == "m46a").unwrap().id;
    let id_b = list.iter().find(|p| p.page_id == "m46b").unwrap().id;
    let id_c = list.iter().find(|p| p.page_id == "m46c").unwrap().id;

    // Cập nhật: người nhận phải đang hoạt động; ngoài phạm vi contacts.transfer ⇒ 403; nguồn phải là contact_source đang bật.
    let up = |a: Option<i32>, s: Option<i32>, act: Option<bool>| UpdatePage {
        default_assignee_id: a,
        contact_source_id: s,
        is_active: act,
    };
    let nobody: Option<&OwnerIds> = None; // không có quyền contacts.transfer: chỉ tự gán cho mình
    assert_eq!(
        status(
            pages::update(&mut c, id_a, &up(Some(gone), None, None), actor, Some(&OwnerIds::All))
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    assert_eq!(
        status(
            pages::update(&mut c, id_a, &up(Some(other), None, None), actor, nobody)
                .await
                .unwrap_err()
        )
        .0,
        403
    );
    let v = json_of(
        &pages::update(
            &mut c,
            id_a,
            &up(Some(other), Some(src_other), None),
            actor,
            Some(&OwnerIds::Ids(vec![other])),
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        (v["default_assignee_id"].as_i64(), v["contact_source_id"].as_i64()),
        (Some(i64::from(other)), Some(i64::from(src_other)))
    );
    assert!(
        pages::update(&mut c, id_a, &up(Some(actor), None, None), actor, nobody)
            .await
            .is_ok(),
        "tự gán cho mình thì không cần phạm vi"
    );
    assert_eq!(
        status(
            pages::update(&mut c, id_a, &up(None, Some(stage), None), actor, nobody)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    assert_eq!(
        status(
            pages::update(&mut c, id_a, &up(None, Some(2_000_000_000), None), actor, nobody)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    assert_eq!(
        status(
            pages::update(&mut c, 2_000_000_000, &up(None, None, Some(false)), actor, nobody)
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    assert!(
        !pages::update(&mut c, id_a, &up(None, None, Some(false)), actor, nobody)
            .await
            .unwrap()
            .is_active
    );
    drop(c);

    // Kiểm token: còn sống ⇒ active (+ đăng ký lại webhook); 190 ⇒ invalid; lỗi Graph khác ⇒ 503 và giữ trạng thái.
    Mock::given(method("GET"))
        .and(path("/v25.0/debug_token"))
        .and(query_param("input_token", "PTc"))
        .respond_with(ResponseTemplate::new(400).set_body_json(graph_error(190)))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/debug_token"))
        .and(query_param("input_token", "PTb"))
        .respond_with(ResponseTemplate::new(500).set_body_json(graph_error(2)))
        .with_priority(1)
        .mount(&server)
        .await;
    let ok = json_of(&pages::check_token(&ctx, id_a, NOW).await.unwrap());
    assert_eq!(
        (ok["token_status"].as_str(), ok["subscribed"].as_bool()),
        (Some("active"), Some(true))
    );
    let inv = json_of(&pages::check_token(&ctx, id_c, NOW).await.unwrap());
    assert_eq!(inv["token_status"], "invalid");
    assert_eq!(
        status(pages::check_token(&ctx, id_b, NOW).await.unwrap_err()),
        (
            503,
            "\"Không kiểm tra được token với Facebook, thử lại sau.\"".to_owned()
        )
    );
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let b_status: String = sqlx::query_scalar("SELECT token_status FROM facebook_pages WHERE page_id = 'm46b'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(b_status, "active", "lỗi Graph tạm thời không đổi trạng thái token");
    // Page nội bộ: Page tắt ⇒ không có token; Page bật ⇒ token giải mã; đánh dấu token hỏng.
    assert!(
        pages::active_page_with_token(&mut c, &env, "m46a")
            .await
            .unwrap()
            .is_none(),
        "Page đã tắt"
    );
    let (p, tok) = pages::active_page_with_token(&mut c, &env, "m46c")
        .await
        .unwrap()
        .unwrap();
    assert_eq!((p.page_id.as_str(), tok.as_str()), ("m46c", "PTc"));
    pages::mark_token_invalid(&mut c, "m46b").await.unwrap();
    let b_status: String = sqlx::query_scalar("SELECT token_status FROM facebook_pages WHERE page_id = 'm46b'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(b_status, "invalid");
    drop(c);

    // Ngắt kết nối: huỷ đăng ký webhook, xoá token, tắt; ngắt lần nữa không gọi Graph; không bật lại khi chưa nối lại.
    Mock::given(method("POST"))
        .and(path("/v25.0/m46c/subscribed_apps"))
        .and(query_param("subscribed_fields", ""))
        .and(header("authorization", "Bearer PTc"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true })))
        .with_priority(1)
        .expect(1)
        .mount(&server)
        .await;
    pages::disconnect(&ctx, id_c).await.unwrap();
    let before = server.received_requests().await.unwrap().len();
    pages::disconnect(&ctx, id_c).await.unwrap();
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        before,
        "Page đã ngắt không còn token để gọi Graph"
    );
    assert_eq!(status(pages::disconnect(&ctx, 2_000_000_000).await.unwrap_err()).0, 404);
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let row: (bool, String, bool) =
        sqlx::query_as("SELECT is_active, token_enc, subscribed FROM facebook_pages WHERE page_id = 'm46c'")
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(row, (false, String::new(), false));
    let dv = json_of(
        pages::list(&mut c)
            .await
            .unwrap()
            .iter()
            .find(|p| p.page_id == "m46c")
            .unwrap(),
    );
    assert_eq!(dv["disconnected"], true);
    assert_eq!(
        status(
            pages::update(&mut c, id_c, &up(None, None, Some(true)), actor, nobody)
                .await
                .unwrap_err()
        )
        .0,
        400,
        "phải nối lại mới bật được"
    );
    drop(c); // pool chỉ 1 kết nối
    assert_eq!(status(pages::check_token(&ctx, id_c, NOW).await.unwrap_err()).0, 400);
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    // Phần đăng bài người dùng đã gỡ (`disabled`) giữ nguyên khi nối lại; Page đã tắt không tự bật lại.
    exec(
        &mut c,
        "UPDATE social_accounts SET status = 'disabled' WHERE external_id = 'm46a'",
    )
    .await;
    drop(c);
    let again = pages::handle_callback(&ctx, "CODE", &state, NOW).await.unwrap();
    assert_eq!(
        (again.connected, again.failed, again.posting),
        (3, 2, 1),
        "m46a bị gỡ đăng bài nên không tính"
    );
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let a: (bool, String) = sqlx::query_as("SELECT is_active, token_status FROM facebook_pages WHERE page_id = 'm46a'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        a,
        (false, "active".to_owned()),
        "Page người dùng đã tắt không tự bật lại"
    );
    let c_row: (bool, bool) =
        sqlx::query_as("SELECT is_active, token_enc <> '' FROM facebook_pages WHERE page_id = 'm46c'")
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(c_row, (false, true), "nối lại cấp token mới nhưng vẫn tắt");
    let sa: String = sqlx::query_scalar("SELECT status FROM social_accounts WHERE external_id = 'm46a'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(sa, "disabled");
    let lv = pages::list(&mut c).await.unwrap();
    assert_eq!(
        json_of(lv.iter().find(|p| p.page_id == "m46a").unwrap())["posting"],
        "removed"
    );
    // Token đã lưu không giải mã được (khoá đổi, dữ liệu hỏng) ⇒ 503 như lỗi Graph tạm thời, không 500.
    exec(
        &mut c,
        "UPDATE facebook_pages SET token_enc = 'v1.hong.hong.hong' WHERE page_id = 'm46b'",
    )
    .await;
    drop(c);
    assert_eq!(
        status(pages::check_token(&ctx, id_b, NOW).await.unwrap_err()),
        (
            503,
            "\"Không kiểm tra được token với Facebook, thử lại sau.\"".to_owned()
        )
    );
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM facebook_pages WHERE page_id = 'm46d'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(rows, 0, "Page thiếu token không được lưu");
    clean(&mut c).await;
}
