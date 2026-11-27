//! Tin Messenger vào và Lead Ads trên Postgres thật (`public` đã migrate bằng Prisma) với máy chủ giả Graph (wiremock; ca C15).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test ingest_pg -- --ignored`
//! Dữ liệu mang tiền tố `m47b`, tự dọn. Pool chỉ 1 kết nối: nếu mã giữ kết nối khi gọi Graph hoặc xin kết nối thứ hai trong lúc
//! đang giữ một, test sẽ treo rồi hết hạn chờ.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::ingest::FacebookIngest;
use mod_facebook::webhook::EntryProcessor;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{encrypt_secret, load_secret_key};
use wiremock::matchers::{header, method, path, path_regex};
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
    exec(
        c,
        "DELETE FROM integration_events WHERE payload::text LIKE '%m47b%' OR payload->>'origin' IN ('facebook_lead', 'facebook_messenger')",
    )
    .await;
    exec(c, "DELETE FROM facebook_conversations WHERE page_id LIKE 'm47b%'").await;
    exec(c, "DELETE FROM facebook_lead_receipts WHERE page_id LIKE 'm47b%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm47b%'").await;
    exec(
        c,
        "DELETE FROM activities WHERE metadata->>'facebook_page_id' LIKE 'm47b%'",
    )
    .await;
    exec(
        c,
        "DELETE FROM contacts WHERE phone IN ('0912470001', '0912470002', '0912470003') OR full_name LIKE 'm47b%' OR full_name LIKE 'Khách Messenger %'",
    )
    .await;
    exec(
        c,
        "DELETE FROM notification_logs WHERE action_url LIKE '/inbox?kenh=facebook%'",
    )
    .await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'm47b%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm47b%@test.local'").await;
}

fn msg(page: &str, psid: &str, mid: &str, text: &str) -> Value {
    json!({ "id": page, "messaging": [{
        "sender": { "id": psid }, "recipient": { "id": page }, "timestamp": 1_800_000_000_000_i64,
        "message": { "mid": mid, "text": text }
    }] })
}

fn lead(page: &str, leadgen: &str) -> Value {
    json!({ "id": page, "changes": [{ "field": "leadgen", "value": { "leadgen_id": leadgen, "page_id": page, "form_id": "f1" } }] })
}

fn graph_error(code: i64) -> Value {
    json!({ "error": { "message": format!("Lỗi Graph giả {code}"), "type": "OAuthException", "code": code } })
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tin_nhan_vao_va_lead_ads() {
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
    let user = one_i32(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m47ba@test.local', 'x', 'M47b', 'active', now()) RETURNING id").await;
    let src = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm47b_fb', 'Facebook', now()) RETURNING id").await;
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, contact_source_id, connected_by, updated_at) \
         VALUES ('m47bp', 'Quán M47b', $1, true, 'active', true, $2, $3, $2, now())",
    )
    .bind(encrypt_secret("PTOKEN", &key))
    .bind(user)
    .bind(src)
    .execute(&mut *c)
    .await
    .unwrap();
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi mô-đun

    // Graph giả: tên khách, lead hợp lệ, lead không SĐT, lead hết hạn token, lead bị giới hạn tần suất.
    let ok = |b: Value| ResponseTemplate::new(200).set_body_json(b);
    Mock::given(method("GET"))
        .and(path("/v25.0/psid1"))
        .and(header("authorization", "Bearer PTOKEN"))
        .respond_with(ok(json!({ "name": "m47b Lan" })))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/v25\.0/psid\d$"))
        .respond_with(ResponseTemplate::new(400).set_body_json(graph_error(100)))
        .with_priority(5)
        .mount(&server)
        .await;
    let lead_body = |phone: &str| {
        json!({ "id": "x", "field_data": [
            { "name": "full_name", "values": ["m47b Khách Lead"] }, { "name": "phone_number", "values": [phone] },
            { "name": "email", "values": ["m47b@x.vn"] }, { "name": "dich_vu", "values": ["Spa"] }
        ] })
    };
    Mock::given(method("GET"))
        .and(path("/v25.0/9001"))
        .respond_with(ok(lead_body("+84912470001")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/9002"))
        .respond_with(ok(lead_body("0912470001")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/9003"))
        .respond_with(ok(
            json!({ "id": "x", "field_data": [{ "name": "dich_vu", "values": ["Spa"] }] }),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v25.0/9004"))
        .respond_with(ResponseTemplate::new(400).set_body_json(graph_error(4)))
        .mount(&server)
        .await;

    let env2 = env.clone();
    let ingest = FacebookIngest::new(
        db.clone(),
        env.clone(),
        Arc::new(move |_| GraphClient::new(env2.clone(), Arc::new(|_| {}))),
    );

    // ── Tin nhắn đầu: hội thoại + khách (tên Facebook) + sự kiện + ghi chú + chuông ──
    let entries = [msg("m47bp", "psid1", "m47b.mid1", "xin chào")];
    assert_eq!(ingest.process(company, &entries).await.unwrap(), 1);
    // Meta gửi lại cùng `mid` ⇒ KHÔNG tạo thêm tin, khách hay sự kiện.
    assert_eq!(ingest.process(company, &entries).await.unwrap(), 0);
    // Tin có SĐT: điền vào khách đang trống SĐT.
    let entries2 = [msg("m47bp", "psid1", "m47b.mid2", "gọi em 0912 470 002 nhé")];
    assert_eq!(ingest.process(company, &entries2).await.unwrap(), 1);

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(
        count(&mut c, "SELECT count(*) FROM facebook_messages WHERE mid LIKE 'm47b.%'").await,
        2
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_conversations WHERE page_id = 'm47bp' AND unread_count = 2 AND customer_name = 'm47b Lan'").await, 1);
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM contacts WHERE phone = '0912470002' AND full_name = 'm47b Lan'"
        )
        .await,
        1
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'messenger.message_received' AND payload->>'page_id' = 'm47bp'").await, 2);
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'contact.created' AND payload->>'origin' = 'facebook_messenger'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM activities WHERE metadata->>'facebook_page_id' = 'm47bp' AND metadata->>'direction' = 'in'").await, 2);
    // Chuông chỉ MỘT lần cho hai tin liên tiếp trong 3 phút.
    assert_eq!(count(&mut c, "SELECT count(*) FROM notification_logs WHERE event_type = 'messenger.message_received' AND recipient_id = (SELECT id FROM users WHERE email = 'm47ba@test.local') AND action_url LIKE '/inbox?kenh=facebook%'").await, 1);
    // Echo của Page: tin ra, không tăng chưa đọc, không báo chuông.
    drop(c);
    let echo = json!({ "id": "m47bp", "messaging": [{
        "sender": { "id": "m47bp" }, "recipient": { "id": "psid1" },
        "message": { "mid": "m47b.mid3", "text": "dạ shop chào", "is_echo": true }
    }] });
    assert_eq!(ingest.process(company, &[echo]).await.unwrap(), 1);
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM facebook_conversations WHERE page_id = 'm47bp' AND unread_count = 2"
        )
        .await,
        1
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'messenger.message_sent' AND payload->>'page_id' = 'm47bp'").await, 1);
    // Page chưa nối ⇒ bỏ qua.
    drop(c);
    assert_eq!(
        ingest
            .process(company, &[msg("m47bx", "psid1", "m47b.mid9", "x")])
            .await
            .unwrap(),
        0
    );

    // ── Lead Ads ──
    assert_eq!(ingest.process(company, &[lead("m47bp", "9001")]).await.unwrap(), 1);
    // Meta gửi lại cùng `leadgen_id` ⇒ không tạo thêm.
    assert_eq!(ingest.process(company, &[lead("m47bp", "9001")]).await.unwrap(), 0);
    // Lead khác cùng SĐT (dạng khác) ⇒ khớp khách cũ, KHÔNG tạo khách thứ hai (ca C15).
    assert_eq!(ingest.process(company, &[lead("m47bp", "9002")]).await.unwrap(), 1);
    // Không SĐT/email ⇒ biên nhận `no_contact_info`, không đếm.
    assert_eq!(ingest.process(company, &[lead("m47bp", "9003")]).await.unwrap(), 0);
    // Giới hạn tần suất ⇒ lỗi để Meta gửi lại, chưa có biên nhận.
    assert!(ingest.process(company, &[lead("m47bp", "9004")]).await.is_err());

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(
        count(&mut c, "SELECT count(*) FROM contacts WHERE phone = '0912470001'").await,
        1
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'contact.created' AND payload->>'origin' = 'facebook_lead'").await, 1);
    assert_eq!(
        count(&mut c, "SELECT count(*) FROM facebook_lead_receipts WHERE page_id = 'm47bp' AND ((leadgen_id = '9001' AND result = 'created') OR (leadgen_id = '9002' AND result = 'duplicate') OR (leadgen_id = '9003' AND result = 'no_contact_info'))").await,
        3
    );
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM facebook_lead_receipts WHERE leadgen_id = '9004'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM activities WHERE details->>'source' = 'facebook_lead'"
        )
        .await,
        2
    );
    clean(&mut c).await;
}
