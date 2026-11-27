//! Tài khoản đăng bài trên Postgres thật (`public` đã migrate bằng Prisma) với máy chủ giả Graph (wiremock).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-social --test accounts_pg -- --ignored`
//! Dữ liệu mang tiền tố `m53a`, tự dọn. Pool chỉ 1 kết nối: nếu mã giữ kết nối khi gọi Graph (HTTP) hoặc xin kết nối thứ hai
//! trong lúc đang giữ một, test sẽ treo rồi hết hạn chờ.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::pages::Ctx;
use mod_social::accounts;
use mod_social::state::sign_social_state;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{decrypt_secret, load_secret_key};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

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

async fn one_i32(c: &mut PgConnection, sql: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn clean(c: &mut PgConnection) {
    exec(
        c,
        "DELETE FROM social_post_targets WHERE post_id IN (SELECT id FROM social_posts WHERE content LIKE 'm53a%')",
    )
    .await;
    exec(c, "DELETE FROM social_posts WHERE content LIKE 'm53a%'").await;
    exec(c, "DELETE FROM social_accounts WHERE external_id LIKE 'm53a%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm53a%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm53a%@test.local'").await;
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
            { "id": "m53aa", "name": "Quán A", "access_token": "PTa", "tasks": ["MANAGE"], "picture": { "data": { "url": "https://img/a.png" } } },
            { "id": "m53ab", "name": "Quán B", "access_token": "PTb" },
            { "id": "m53ac", "name": "Quán C", "access_token": "PTc", "tasks": ["MESSAGING"] },
            { "id": "m53ad", "name": "Quán D không có token" }
        ] })))
        .mount(server)
        .await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tai_khoan_fanpage_day_du() {
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
    mount_login(&server).await;
    let env = env_for(&server.uri());
    let graph = GraphClient::new(env.clone(), Arc::new(|_| {}));
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
    let actor = one_i32(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m53aa@test.local', 'x', 'M53a', 'active', now()) RETURNING id").await;
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi hàm của mô-đun

    // networks: cấu hình đủ ⇒ configured, URL callback để dán vào app Meta.
    let n = json_of(&accounts::networks(&env));
    assert_eq!(n[0]["network"], "facebook");
    assert_eq!(n[0]["configured"], true);
    assert_eq!(
        n[0]["redirect_uri"],
        "https://crm.example.test/api/v1/social/oauth/callback/facebook"
    );

    // connect-url: mạng đã gỡ ⇒ 400 câu "ngừng hỗ trợ"; Facebook ⇒ URL kèm state ký cho đúng người bấm.
    let (s, m) = status(accounts::connect_url(&ctx, "tiktok", actor, NOW).await.unwrap_err());
    assert_eq!(s, 400);
    assert!(m.contains("Trinity đã ngừng hỗ trợ TikTok"), "{m}");
    let u = accounts::connect_url(&ctx, "facebook", actor, NOW).await.unwrap();
    let u = u["url"].as_str().unwrap().to_owned();
    assert!(
        u.starts_with("https://www.facebook.com/v25.0/dialog/oauth?client_id=123"),
        "{u}"
    );
    assert!(
        u.contains("pages_manage_posts") && !u.contains("pages_messaging"),
        "{u}"
    );
    assert!(!u.contains("shh"), "không lộ secret");

    // callback: state sai ⇒ 400; state đúng ⇒ chỉ Page đăng được (A, B) được lưu, token mã hoá.
    let (s, _) = status(
        accounts::handle_callback(&ctx, "facebook", "CODE", "rac", NOW)
            .await
            .unwrap_err(),
    );
    assert_eq!(s, 400);
    let state = sign_social_state("bi-mat-jwt", actor, "facebook", None, None, NOW);
    assert_eq!(
        accounts::handle_callback(&ctx, "facebook", "CODE", &state, NOW)
            .await
            .unwrap(),
        2
    );
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let rows: Vec<(String, String, String, String, i32)> = sqlx::query_as(
        "SELECT external_id, name, access_token_enc, status, connected_by FROM social_accounts WHERE external_id LIKE 'm53a%' ORDER BY external_id",
    )
    .fetch_all(&mut *c)
    .await
    .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        ["m53aa", "m53ab"]
    );
    assert_eq!(decrypt_secret(&rows[0].2, &key).unwrap(), "PTa");
    assert_eq!((rows[0].3.as_str(), rows[0].4), ("active", actor));
    drop(c);

    // list: không lộ token; có `removed`, `inbox` (Page chưa nối nhận tin ⇒ null).
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let list = json_of(&accounts::list(&mut c).await.unwrap());
    let a = list
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["external_id"] == "m53aa")
        .unwrap()
        .clone();
    assert_eq!(a["removed"], false);
    assert_eq!(a["inbox"], Value::Null);
    assert!(a.get("access_token_enc").is_none() && a.get("refresh_token_enc").is_none());
    let id_a = a["id"].as_i64().unwrap() as i32;

    // enable khi đang bật ⇒ 400; id lạ ⇒ 404.
    let (s, m) = status(accounts::enable(&mut c, id_a).await.unwrap_err());
    assert_eq!((s, m.as_str()), (400, "\"Kênh này đang bật\""));
    let (s, _) = status(accounts::enable(&mut c, 2_000_000_000).await.unwrap_err());
    assert_eq!(s, 404);

    // disconnect: xoá token, huỷ bài `queued` của kênh, kênh gỡ + hết token ⇒ ẩn khỏi danh sách; gỡ lần hai ⇒ 404.
    let post = one_i32(&mut c, &format!("INSERT INTO social_posts (content, created_by, updated_at) VALUES ('m53a bài', {actor}, now()) RETURNING id")).await;
    exec(&mut c, &format!("INSERT INTO social_post_targets (post_id, account_id, network, status, updated_at) VALUES ({post}, {id_a}, 'facebook', 'queued', now())")).await;
    accounts::disconnect(&mut c, id_a).await.unwrap();
    let t: (String, Option<String>) =
        sqlx::query_as("SELECT status, last_error FROM social_post_targets WHERE post_id = $1")
            .bind(post)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!((t.0.as_str(), t.1.as_deref()), ("cancelled", Some("Kênh đã bị gỡ")));
    let tok: String = sqlx::query_scalar("SELECT access_token_enc FROM social_accounts WHERE id = $1")
        .bind(id_a)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(tok, "");
    let list = json_of(&accounts::list(&mut c).await.unwrap());
    assert!(list.as_array().unwrap().iter().all(|x| x["external_id"] != "m53aa"));
    let (s, _) = status(accounts::disconnect(&mut c, id_a).await.unwrap_err());
    assert_eq!(s, 404);
    // Hết token ⇒ không bật lại được.
    exec(
        &mut c,
        &format!("UPDATE social_accounts SET status = 'disabled' WHERE id = {id_a}"),
    )
    .await;
    let (s, m) = status(accounts::enable(&mut c, id_a).await.unwrap_err());
    assert_eq!((s, m.as_str()), (400, "\"Liên kết lại để bật kênh này\""));
    drop(c);

    // Nối lại kênh đã gỡ: làm mới token nhưng GIỮ `disabled`; sau đó có token ⇒ bật lại được.
    let state = sign_social_state("bi-mat-jwt", actor, "facebook", None, None, NOW);
    accounts::handle_callback(&ctx, "facebook", "CODE", &state, NOW)
        .await
        .unwrap();
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let v = json_of(&accounts::enable(&mut c, id_a).await.unwrap());
    assert_eq!(v["status"], "active");
    assert!(v.get("removed").is_none());

    // callback_location: huỷ, mạng đã gỡ, state sai.
    drop(c);
    let loc = accounts::callback_location(&ctx, "facebook", None, None, Some("access_denied"), NOW).await;
    assert_eq!(
        loc,
        "https://crm.example.test/social?tab=channels&social=cancelled&network=facebook"
    );
    let loc = accounts::callback_location(&ctx, "facebook", Some("CODE"), Some("rac"), None, NOW).await;
    assert!(
        loc.starts_with("https://crm.example.test/social?tab=channels&social=error&network=facebook&reason="),
        "{loc}"
    );
    let loc = accounts::callback_location(&ctx, "zzz", Some("c"), Some("s"), None, NOW).await;
    assert_eq!(loc, "https://crm.example.test/social?tab=channels&social=error");

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
}
