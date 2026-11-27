//! Hộp thư Messenger trên Postgres thật với máy chủ giả Graph (M48): trả lời trong 24 giờ, trong 7 ngày (thẻ Human Agent), quá 7
//! ngày bị từ chối, danh sách và tin của hội thoại.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test inbox_pg -- --ignored`
//! Dữ liệu mang tiền tố `m48`, tự dọn. Pool chỉ 1 kết nối: mã giữ kết nối khi gọi Graph sẽ làm test treo rồi hết hạn chờ.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::ingest::FacebookIngest;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{encrypt_secret, load_secret_key};
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn env_for(graph_base: &str) -> Env {
    let base = graph_base.to_owned();
    let key = STANDARD.encode([7_u8; 32]);
    Arc::new(move |k| match k {
        "INTEGRATIONS_SECRET_KEY" => Some(key.clone()),
        "FACEBOOK_APP_ID" => Some("123".into()),
        "FACEBOOK_APP_SECRET" => Some("shh".into()),
        "FACEBOOK_GRAPH_BASE_URL" => Some(base.clone()),
        _ => None,
    })
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap();
}

async fn count(c: &mut PgConnection, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn one_i32(c: &mut PgConnection, sql: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn clean(c: &mut PgConnection) {
    exec(c, "DELETE FROM integration_events WHERE payload->>'page_id' LIKE 'm48%'").await;
    exec(c, "DELETE FROM facebook_conversations WHERE page_id LIKE 'm48%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm48%'").await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'm48%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm48%@test.local'").await;
}

async fn add_conv(c: &mut PgConnection, psid: &str, inbound_ago: &str) -> i32 {
    one_i32(
        c,
        &format!(
            "INSERT INTO facebook_conversations (page_id, psid, customer_name, last_message_at, last_message_preview, \
             last_inbound_at, unread_count) VALUES ('m48p', '{psid}', 'Khách {psid}', now() - interval '{inbound_ago}', \
             'xin chào', now() - interval '{inbound_ago}', 2) RETURNING id"
        ),
    )
    .await
}

fn graph_error(code: i64, subcode: i64) -> Value {
    json!({ "error": { "message": "Lỗi Graph giả", "type": "OAuthException", "code": code, "error_subcode": subcode } })
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tra_loi_theo_cua_so_24_gio_7_ngay() {
    let _g = serial().lock().await;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let company = CompanyRef::DEFAULT;
    let server = MockServer::start().await;
    let env = env_for(&server.uri());
    let key = load_secret_key(&|k: &str| env(k)).unwrap();

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user = one_i32(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m48a@test.local', 'x', 'M48', 'active', now()) RETURNING id").await;
    let src = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm48_fb', 'Facebook', now()) RETURNING id").await;
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, contact_source_id, connected_by, updated_at) \
         VALUES ('m48p', 'Quán M48', $1, true, 'active', true, $2, $3, $2, now())",
    )
    .bind(encrypt_secret("PTOKEN", &key))
    .bind(user)
    .bind(src)
    .execute(&mut *c)
    .await
    .unwrap();
    let within_24h = add_conv(&mut c, "m48a", "2 hours").await;
    let within_7d = add_conv(&mut c, "m48b", "3 days").await;
    let beyond_7d = add_conv(&mut c, "m48c", "10 days").await;
    let refused = add_conv(&mut c, "m48d", "3 days").await;
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi mô-đun

    let sent = |mid: &str| ResponseTemplate::new(200).set_body_json(json!({ "message_id": mid, "recipient_id": "x" }));
    // Trong 24 giờ: gửi thường (RESPONSE), KHÔNG có thẻ.
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_partial_json(
            json!({ "recipient": { "id": "m48a" }, "messaging_type": "RESPONSE" }),
        ))
        .respond_with(sent("m48.out1"))
        .expect(1)
        .mount(&server)
        .await;
    // Trong 7 ngày: MESSAGE_TAG + HUMAN_AGENT.
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_partial_json(
            json!({ "recipient": { "id": "m48b" }, "messaging_type": "MESSAGE_TAG", "tag": "HUMAN_AGENT" }),
        ))
        .respond_with(sent("m48.out2"))
        .expect(1)
        .mount(&server)
        .await;
    // Meta chưa duyệt Human Agent: Graph từ chối.
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_partial_json(json!({ "recipient": { "id": "m48d" } })))
        .respond_with(ResponseTemplate::new(400).set_body_json(graph_error(10, 2_018_278)))
        .expect(1)
        .mount(&server)
        .await;
    // Quá 7 ngày: không bao giờ gọi gửi (đồng bộ hội thoại vẫn hỏi Facebook, trả rỗng).
    Mock::given(method("GET"))
        .and(path("/v25.0/m48p/conversations"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "data": [] })))
        .mount(&server)
        .await;

    let env2 = env.clone();
    let ingest = FacebookIngest::new(
        db.clone(),
        env.clone(),
        Arc::new(move |_| GraphClient::new(env2.clone(), Arc::new(|_| {}))),
    );
    let now = chrono::Utc::now();

    // Trong 24 giờ.
    let r = ingest
        .reply(company, None, within_24h, "  dạ chào anh  ", user, now)
        .await
        .unwrap();
    assert_eq!(r["mid"], "m48.out1");
    assert_eq!(r["direction"], "out");
    assert_eq!(r["text"], "dạ chào anh");
    assert!(r["id"].is_string(), "id BigInt trả dạng chuỗi");
    // Trong 7 ngày (Human Agent).
    let r = ingest
        .reply(company, None, within_7d, "dạ em trả lời muộn", user, now)
        .await
        .unwrap();
    assert_eq!(r["mid"], "m48.out2");
    // Quá 7 ngày: 400, không gọi Graph gửi tin.
    let e = ingest
        .reply(company, None, beyond_7d, "alo", user, now)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("7 ngày"), "{e}");
    // Human Agent bị Meta từ chối ⇒ 400 với câu hướng dẫn, không lưu tin.
    let e = ingest
        .reply(company, None, refused, "alo", user, now)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("Human Agent"), "{e}");
    // Trống ⇒ 400; hội thoại không có ⇒ 404.
    let blank = ingest.reply(company, None, within_24h, "   ", user, now).await;
    assert!(blank.is_err());
    let missing = ingest.reply(company, None, 999_999_999, "x", user, now).await;
    assert!(missing.is_err());

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_messages WHERE mid LIKE 'm48.out%' AND direction = 'out'").await, 2);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_messages WHERE mid LIKE 'm48.out%' AND sent_by_user_id IS NOT NULL").await, 2);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_conversations WHERE page_id = 'm48p' AND last_message_preview = 'dạ chào anh'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'messenger.message_sent' AND payload->>'page_id' = 'm48p' AND payload->>'origin' = 'agent'").await, 2);
    // Hội thoại bị từ chối không có tin ra.
    assert_eq!(count(&mut c, &format!("SELECT count(*) FROM facebook_messages WHERE conversation_id IN ({refused}, {beyond_7d})")).await, 0);
    drop(c);

    // Danh sách: `reply_mode` đúng theo thời gian; `unanswered` giữ hội thoại có tin cuối của khách.
    let now_ms = now.timestamp_millis();
    let list = ingest
        .list_conversations(company, Some("50"), None, now_ms)
        .await
        .unwrap();
    let data = list["data"].as_array().unwrap();
    let find = |id: i32| data.iter().find(|v| v["id"] == id).unwrap();
    assert_eq!(find(beyond_7d)["reply_mode"], "closed");
    assert_eq!(find(beyond_7d)["can_reply"], false);
    assert_eq!(find(beyond_7d)["page_name"], "Quán M48");
    assert_eq!(find(within_7d)["reply_mode"], "human_agent");
    assert_eq!(find(within_24h)["reply_mode"], "standard");
    let only = ingest
        .list_conversations(company, None, Some("1"), now_ms)
        .await
        .unwrap();
    let only = only["data"].as_array().unwrap();
    assert!(only.iter().all(|v| v["awaiting_reply"] == true));
    assert!(only.iter().any(|v| v["id"] == beyond_7d));
    assert!(!only.iter().any(|v| v["id"] == within_24h), "đã trả lời thì không còn chờ");

    // Tin của hội thoại: có tin ra, đánh dấu đã đọc.
    let m = ingest.messages(company, within_24h, now_ms).await.unwrap();
    assert_eq!(m["conversation"]["unread_count"], 0);
    assert_eq!(m["conversation"]["reply_mode"], "standard");
    assert_eq!(m["messages"].as_array().unwrap().len(), 1);
    let missing = ingest.messages(company, 999_999_999, now_ms).await;
    assert!(missing.is_err());
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(count(&mut c, &format!("SELECT count(*) FROM facebook_conversations WHERE id = {within_24h} AND unread_count = 0")).await, 1);
    clean(&mut c).await;
}
