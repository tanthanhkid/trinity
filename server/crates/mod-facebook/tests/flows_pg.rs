//! Kịch bản nhắn tin (M50b) trên Postgres thật với máy chủ giả Graph: từ khoá → tin có nút → bấm nút → hết; bước chờ do job gửi;
//! quá 24 giờ thì `expired` và không gọi Graph; sửa/tắt kịch bản dừng lượt đang dở; webhook gửi lại không chạy kịch bản hai lần.
//! Tạm dừng kênh (giữ việc, không huỷ) kiểm ở test thuần `flows::pause_due`; chạy đủ cần `ChannelGuard` có `Platform`.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test flows_pg -- --ignored`
//! Dữ liệu mang tiền tố `m50`, tự dọn. Pool chỉ 1 kết nối: mã giữ kết nối khi gọi Graph sẽ làm test treo rồi hết hạn chờ.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_facebook::config::Env;
use mod_facebook::flows::FlowInput;
use mod_facebook::graph::GraphClient;
use mod_facebook::ingest::FacebookIngest;
use mod_facebook::webhook::EntryProcessor;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{encrypt_secret, load_secret_key};
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

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

async fn one_i32(c: &mut PgConnection, sql: &str) -> i32 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn one_str(c: &mut PgConnection, sql: &str) -> String {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn clean(c: &mut PgConnection) {
    exec(
        c,
        "DELETE FROM facebook_flow_runs WHERE flow_id IN (SELECT id FROM facebook_flows WHERE page_id LIKE 'm50%')",
    )
    .await;
    exec(c, "DELETE FROM facebook_flows WHERE page_id LIKE 'm50%'").await;
    exec(
        c,
        "DELETE FROM integration_events WHERE payload->>'page_id' LIKE 'm50%'",
    )
    .await;
    exec(c, "DELETE FROM facebook_conversations WHERE page_id LIKE 'm50%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm50%'").await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'm50%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm50%@test.local'").await;
}

/// Trả mỗi lần một `message_id` khác nhau (`mid` là duy nhất).
struct Mids(AtomicUsize);

impl Respond for Mids {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        ResponseTemplate::new(200).set_body_json(json!({ "message_id": format!("m50.out{n}"), "recipient_id": "x" }))
    }
}

struct Fixture {
    db: Db,
    ingest: FacebookIngest,
    company: CompanyRef,
    user: i32,
}

async fn setup(server: &MockServer) -> Fixture {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
    let mut cfg = DbConfig::new(url);
    cfg.pool_size = 1;
    cfg.acquire_timeout = Duration::from_secs(3);
    let db = Db::connect(&cfg).await.expect("nối DB");
    let company = CompanyRef::DEFAULT;
    let env = env_for(&server.uri());
    let key = load_secret_key(&|k: &str| env(k)).unwrap();
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user = one_i32(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m50a@test.local', 'x', 'M50', 'active', now()) RETURNING id").await;
    let src = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm50_fb', 'Facebook', now()) RETURNING id").await;
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, contact_source_id, connected_by, updated_at) \
         VALUES ('m50p', 'Quán M50', $1, true, 'active', true, $2, $3, $2, now())",
    )
    .bind(encrypt_secret("PTOKEN", &key))
    .bind(user)
    .bind(src)
    .execute(&mut *c)
    .await
    .unwrap();
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi mô-đun
    let env2 = env.clone();
    let ingest = FacebookIngest::new(
        db.clone(),
        env.clone(),
        Arc::new(move |_| GraphClient::new(env2.clone(), Arc::new(|_| {}))),
    );
    Fixture {
        db,
        ingest,
        company,
        user,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn text_event(psid: &str, mid: &str, text: &str) -> Value {
    json!({ "id": "m50p", "messaging": [{
        "sender": { "id": psid }, "recipient": { "id": "m50p" }, "timestamp": now_ms(),
        "message": { "mid": mid, "text": text }
    }] })
}

fn button_event(psid: &str, mid: &str, title: &str, payload: &str) -> Value {
    json!({ "id": "m50p", "messaging": [{
        "sender": { "id": psid }, "recipient": { "id": "m50p" }, "timestamp": now_ms(),
        "message": { "mid": mid, "text": title, "quick_reply": { "payload": payload } }
    }] })
}

fn flow_body(name: &str, steps: Value) -> FlowInput {
    FlowInput::from_json(&json!({
        "name": name, "page_id": "m50p", "trigger": "keyword", "keywords": ["bảng giá"],
        "steps": steps, "is_active": true,
    }))
    .unwrap()
}

async fn run_status(f: &Fixture, flow: i32) -> (String, Option<String>) {
    let mut c = f.db.tenant(f.company).await.unwrap().acquire().await.unwrap();
    let s = one_str(
        &mut c,
        &format!("SELECT status FROM facebook_flow_runs WHERE flow_id = {flow} ORDER BY id DESC LIMIT 1"),
    )
    .await;
    let step: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT step_id FROM facebook_flow_runs WHERE flow_id = {flow} ORDER BY id DESC LIMIT 1"
    )))
    .fetch_one(&mut *c)
    .await
    .unwrap();
    (s, step)
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tu_khoa_nut_bam_roi_het_va_webhook_gui_lai_khong_chay_hai_lan() {
    let _g = serial().lock().await;
    let server = MockServer::start().await;
    let f = setup(&server).await;
    let (company, ingest) = (f.company, &f.ingest);
    let mids = Arc::new(Mids(AtomicUsize::new(0)));
    // Bước 1: tin có nút (quick_replies); bước 2: tin cảm ơn. Mỗi tin đúng 1 lần.
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_partial_json(json!({
            "recipient": { "id": "m50a" },
            "message": { "text": "Bạn cần gì nhỉ?", "quick_replies": [{ "title": "Khoá học" }] },
        })))
        .respond_with(MidsRef(Arc::clone(&mids)))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_partial_json(json!({ "message": { "text": "Cảm ơn bạn!" } })))
        .respond_with(MidsRef(Arc::clone(&mids)))
        .expect(1)
        .mount(&server)
        .await;

    let steps = json!([
        { "id": "hoi", "text": "Bạn cần gì nhỉ?", "buttons": [{ "title": "Khoá học", "next": "cam_on" }] },
        { "id": "cam_on", "text": "Cảm ơn bạn!", "next": null },
    ]);
    let flow = ingest
        .create_flow(company, &flow_body("Báo giá", steps), f.user)
        .await
        .unwrap();
    let fid = flow["id"].as_i64().unwrap() as i32;
    assert_eq!(
        (flow["page_name"].as_str(), flow["running"].as_i64()),
        (Some("Quán M50"), Some(0))
    );

    // Khách nhắn "Bảng giá nhé" ⇒ kịch bản chạy, dừng ở nút.
    ingest
        .process(company, &[text_event("m50a", "m50.in1", "Bảng giá nhé")])
        .await
        .unwrap();
    assert_eq!(
        run_status(&f, fid).await,
        ("waiting_button".to_owned(), Some("hoi".to_owned()))
    );
    // Meta gửi lại đúng webhook đó ⇒ không chạy lại (mid trùng).
    ingest
        .process(company, &[text_event("m50a", "m50.in1", "Bảng giá nhé")])
        .await
        .unwrap();

    // Khách bấm nút: payload `FLOW:<lượt>:<bước>:<thứ tự>`.
    let run_id: i32 = {
        let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
        one_i32(
            &mut c,
            &format!("SELECT id FROM facebook_flow_runs WHERE flow_id = {fid}"),
        )
        .await
    };
    let payload = format!("FLOW:{run_id}:hoi:0");
    ingest
        .process(company, &[button_event("m50a", "m50.in2", "Khoá học", &payload)])
        .await
        .unwrap();
    assert_eq!(run_status(&f, fid).await.0, "done");
    // Bấm lại nút cũ khi lượt đã xong ⇒ bỏ qua.
    ingest
        .process(company, &[button_event("m50a", "m50.in3", "Khoá học", &payload)])
        .await
        .unwrap();
    let after = ingest.get_flow(company, fid).await.unwrap();
    assert_eq!(
        (after["starts"].as_i64(), after["completes"].as_i64()),
        (Some(1), Some(1))
    );
    let runs = ingest.flow_runs(company, fid, Some("5")).await.unwrap();
    assert_eq!(runs.len(), 1);
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn buoc_cho_do_job_gui_va_sua_kich_ban_dung_luot_dang_do() {
    let _g = serial().lock().await;
    let server = MockServer::start().await;
    let f = setup(&server).await;
    let (company, ingest) = (f.company, &f.ingest);
    let mids = Arc::new(Mids(AtomicUsize::new(0)));
    // Chỉ tin sau bước chờ được gửi, đúng 1 lần dù job chạy hai lượt.
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .and(body_partial_json(json!({ "message": { "text": "Nhắc lại sau chờ" } })))
        .respond_with(MidsRef(Arc::clone(&mids)))
        .expect(1)
        .mount(&server)
        .await;

    let steps = json!([{ "id": "nhac", "text": "Nhắc lại sau chờ", "wait_minutes": 30 }]);
    let flow = ingest
        .create_flow(company, &flow_body("Nhắc", steps.clone()), f.user)
        .await
        .unwrap();
    let fid = flow["id"].as_i64().unwrap() as i32;
    ingest
        .process(company, &[text_event("m50b", "m50.in10", "bảng giá")])
        .await
        .unwrap();
    assert_eq!(
        run_status(&f, fid).await,
        ("scheduled".to_owned(), Some("nhac".to_owned()))
    );
    // Chưa tới giờ ⇒ job không gửi.
    let n = ingest
        .flows_run_due(company, Duration::from_secs(10), chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(n, 0);
    // Tới giờ ⇒ gửi, lượt xong; chạy lại không gửi thêm.
    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    exec(
        &mut c,
        &format!("UPDATE facebook_flow_runs SET due_at = now() - interval '1 minute' WHERE flow_id = {fid}"),
    )
    .await;
    drop(c);
    for expect in [1, 0] {
        let n = ingest
            .flows_run_due(company, Duration::from_secs(10), chrono::Utc::now())
            .await
            .unwrap();
        assert_eq!(n, expect);
    }
    assert_eq!(run_status(&f, fid).await.0, "done");

    // Lượt đang chờ + sửa bước ⇒ dừng; tắt kịch bản ⇒ job không gửi.
    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    exec(
        &mut c,
        &format!(
            "INSERT INTO facebook_flow_runs (flow_id, conversation_id, step_id, status, due_at, updated_at) \
             SELECT {fid}, id, 'nhac', 'scheduled', now() - interval '1 minute', now() FROM facebook_conversations \
             WHERE page_id = 'm50p' AND psid = 'm50b'"
        ),
    )
    .await;
    drop(c);
    let off = FlowInput::from_json(&json!({ "is_active": false })).unwrap();
    let v = ingest.update_flow(company, fid, &off).await.unwrap();
    assert_eq!(v["is_active"], false);
    assert_eq!(run_status(&f, fid).await.0, "stopped");
    assert_eq!(
        ingest
            .flows_run_due(company, Duration::from_secs(10), chrono::Utc::now())
            .await
            .unwrap(),
        0
    );
    // Xoá kịch bản xoá cả lượt chạy.
    ingest.delete_flow(company, fid).await.unwrap();
    assert!(ingest.get_flow(company, fid).await.is_err());
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn qua_24_gio_thi_het_han_khong_goi_graph() {
    let _g = serial().lock().await;
    let server = MockServer::start().await;
    let f = setup(&server).await; // không mount Mock nào: nếu gọi Graph sẽ nhận 404 ⇒ lượt `failed`, test bắt được
    let (company, ingest) = (f.company, &f.ingest);
    let flow = ingest
        .create_flow(
            company,
            &flow_body("Hết hạn", json!([{ "id": "a", "text": "Xin chào" }])),
            f.user,
        )
        .await
        .unwrap();
    let fid = flow["id"].as_i64().unwrap() as i32;
    // Tin của khách mang giờ 30 giờ trước ⇒ cửa sổ 24 giờ đã đóng khi kịch bản định gửi.
    let old = now_ms() - 30 * 3_600_000;
    let ev = json!({ "id": "m50p", "messaging": [{
        "sender": { "id": "m50c" }, "recipient": { "id": "m50p" }, "timestamp": old,
        "message": { "mid": "m50.in20", "text": "bảng giá" }
    }] });
    ingest.process(company, &[ev]).await.unwrap();
    assert_eq!(run_status(&f, fid).await.0, "expired");
    assert_eq!(server.received_requests().await.unwrap_or_default().len(), 0);
}

/// Bọc `Arc<Mids>` để dùng chung giữa nhiều Mock.
struct MidsRef(Arc<Mids>);

impl Respond for MidsRef {
    fn respond(&self, r: &Request) -> ResponseTemplate {
        self.0.respond(r)
    }
}
