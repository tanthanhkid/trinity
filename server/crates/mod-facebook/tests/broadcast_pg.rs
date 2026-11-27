//! Gửi hàng loạt (M51) trên Postgres thật với máy chủ giả Graph: chốt người nhận trong cửa sổ 24 giờ, job bị cắt giữa chừng rồi chạy
//! lại KHÔNG gửi trùng (người nhận kẹt `sending` bị đánh `failed`, không gửi lại), lỗi token dừng cả lượt, huỷ/xoá/sửa.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test broadcast_pg -- --ignored`
//! Dữ liệu mang tiền tố `m51`, tự dọn. Pool chỉ 1 kết nối: mã giữ kết nối khi gọi Graph sẽ làm test treo rồi hết hạn chờ.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_facebook::broadcast::{Audience, BroadcastInput};
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_facebook::ingest::FacebookIngest;
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
        "DELETE FROM facebook_broadcast_recipients WHERE broadcast_id IN \
         (SELECT id FROM facebook_broadcasts WHERE page_id LIKE 'm51%')",
    )
    .await;
    exec(c, "DELETE FROM facebook_broadcasts WHERE page_id LIKE 'm51%'").await;
    exec(
        c,
        "DELETE FROM integration_events WHERE payload->>'page_id' LIKE 'm51%'",
    )
    .await;
    exec(c, "DELETE FROM facebook_conversations WHERE page_id LIKE 'm51%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm51%'").await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'm51%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm51%@test.local'").await;
}

async fn add_conv(c: &mut PgConnection, psid: &str, inbound_ago: &str) -> i32 {
    one_i32(
        c,
        &format!(
            "INSERT INTO facebook_conversations (page_id, psid, customer_name, last_message_at, last_message_preview, \
             last_inbound_at, unread_count) VALUES ('m51p', '{psid}', 'Khách {psid}', now() - interval '{inbound_ago}', \
             'xin chào', now() - interval '{inbound_ago}', 0) RETURNING id"
        ),
    )
    .await
}

/// Trả mỗi lần một `message_id` khác nhau (`mid` là duy nhất).
struct Mids(AtomicUsize);

impl Respond for Mids {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        ResponseTemplate::new(200).set_body_json(json!({ "message_id": format!("m51.out{n}"), "recipient_id": "x" }))
    }
}

struct Fixture {
    db: Db,
    ingest: FacebookIngest,
    company: CompanyRef,
    user: i32,
}

/// Page `m51p` đang kết nối, một người dùng; mỗi test dựng hội thoại riêng. Pool 1 kết nối.
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
    let user = one_i32(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m51a@test.local', 'x', 'M51', 'active', now()) RETURNING id").await;
    let src = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm51_fb', 'Facebook', now()) RETURNING id").await;
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, contact_source_id, connected_by, updated_at) \
         VALUES ('m51p', 'Quán M51', $1, true, 'active', true, $2, $3, $2, now())",
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

fn input(name: &str, text: &str) -> BroadcastInput {
    BroadcastInput {
        name: Some(name.to_owned()),
        page_id: Some("m51p".to_owned()),
        text: Some(text.to_owned()),
        audience: None,
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn cat_giua_chung_chay_lai_khong_gui_trung() {
    let _g = serial().lock().await;
    let server = MockServer::start().await;
    let f = setup(&server).await;
    let (company, ingest) = (f.company, &f.ingest);
    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    let c1 = add_conv(&mut c, "m51a", "2 hours").await;
    let c2 = add_conv(&mut c, "m51b", "3 hours").await;
    let _c3 = add_conv(&mut c, "m51c", "30 hours").await; // quá 24 giờ: không được chọn
    let c4 = add_conv(&mut c, "m51d", "1 hour").await;
    drop(c);

    // a và d nhận đúng 1 lần (nội dung đã điền tên); b kẹt `sending` nên KHÔNG bao giờ được gửi; c ngoài cửa sổ.
    let mids = Arc::new(Mids(AtomicUsize::new(0)));
    for (psid, expect) in [("m51a", 1), ("m51b", 0), ("m51c", 0), ("m51d", 1)] {
        Mock::given(method("POST"))
            .and(path("/v25.0/me/messages"))
            .and(body_partial_json(json!({
                "recipient": { "id": psid },
                "messaging_type": "RESPONSE",
                "message": { "text": format!("Chào Khách {psid}!") },
            })))
            .respond_with(MidsRef(Arc::clone(&mids)))
            .expect(expect)
            .mount(&server)
            .await;
    }

    let preview = ingest
        .preview_broadcast(company, "m51p", &Audience::default(), chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(preview["eligible"], 3);
    assert_eq!(preview["outside_window"], 1);

    let b = ingest
        .create_broadcast(company, &input("Báo lịch", "Chào {ten}!"), f.user, "web")
        .await
        .unwrap();
    let id = b["id"].as_i64().unwrap() as i32;
    assert_eq!(b["status"], "draft");
    assert_eq!(b["page_name"], "Quán M51");
    let sent = ingest
        .send_broadcast(company, None, id, None, chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(sent["status"], "scheduled");

    // Lượt 1 bị cắt ngay sau khi chốt người nhận (budget 0 ⇒ không gửi gì).
    let run = ingest
        .broadcasts_run_due(company, None, Duration::ZERO, chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!((run.started, run.sent), (1, 0));
    let b = ingest.get_broadcast(company, id).await.unwrap();
    assert_eq!((b["status"].as_str(), b["total"].as_i64()), (Some("sending"), Some(3)));

    // Tiến trình "chết" sau khi giành người nhận b (đã claim 20 phút trước, không rõ đã gửi chưa).
    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    exec(
        &mut c,
        &format!(
            "UPDATE facebook_broadcast_recipients SET status = 'sending', claimed_at = now() - interval '20 minutes' \
             WHERE broadcast_id = {id} AND conversation_id = {c2}"
        ),
    )
    .await;
    drop(c);

    // Chạy lại: gửi nốt a, d; b bị đánh `failed` (không gửi lại); lượt xong.
    let run = ingest
        .broadcasts_run_due(company, None, Duration::from_secs(20), chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!((run.sent, run.started), (2, 0));
    let b = ingest.get_broadcast(company, id).await.unwrap();
    assert_eq!(b["status"], "done");
    assert_eq!(
        (b["sent"].as_i64(), b["failed"].as_i64(), b["skipped"].as_i64()),
        (Some(2), Some(1), Some(0))
    );

    // Chạy lần nữa: không còn gì để gửi, không gọi Graph thêm (kiểm bằng `.expect` của máy chủ giả khi hết test).
    let run = ingest
        .broadcasts_run_due(company, None, Duration::from_secs(20), chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!((run.started, run.sent, run.failed, run.skipped), (0, 0, 0, 0));
    assert!(
        ingest
            .send_broadcast(company, None, id, None, chrono::Utc::now())
            .await
            .is_err(),
        "lượt đã xong không gửi lại"
    );

    let rec = ingest.broadcast_recipients(company, id).await.unwrap();
    let rec = rec["data"].as_array().unwrap();
    assert_eq!(rec.len(), 3);
    let by = |conv: i32| rec.iter().find(|r| r["conversation_id"] == conv).unwrap();
    assert_eq!(by(c1)["status"], "sent");
    assert_eq!(by(c4)["status"], "sent");
    assert_eq!(by(c2)["status"], "failed");
    assert!(by(c2)["note"].as_str().unwrap().contains("không rõ khách đã nhận chưa"));
    assert_eq!(by(c1)["customer_name"], "Khách m51a");

    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM facebook_messages WHERE mid LIKE 'm51.out%' AND direction = 'out'"
        )
        .await,
        2
    );
    assert_eq!(
        count(&mut c, "SELECT count(*) FROM facebook_broadcast_recipients r JOIN facebook_broadcasts b ON b.id = r.broadcast_id WHERE b.page_id = 'm51p' AND r.status IN ('queued', 'sending')").await,
        0
    );
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'messenger.broadcast_finished' AND payload->>'page_id' = 'm51p'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'messenger.message_sent' AND payload->>'page_id' = 'm51p' AND payload->>'origin' = 'broadcast'").await, 2);
    drop(c);
    clean_after(&f).await;
}

async fn clean_after(f: &Fixture) {
    let mut c = f.db.tenant(f.company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
}

/// Mượn `Mids` chung giữa nhiều mock (mỗi mock cần một `Respond` sở hữu riêng).
struct MidsRef(Arc<Mids>);

impl Respond for MidsRef {
    fn respond(&self, r: &Request) -> ResponseTemplate {
        self.0.respond(r)
    }
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn token_het_han_dung_ca_luot() {
    let _g = serial().lock().await;
    let server = MockServer::start().await;
    let f = setup(&server).await;
    let (company, ingest) = (f.company, &f.ingest);
    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    add_conv(&mut c, "m51a", "1 hour").await;
    add_conv(&mut c, "m51b", "2 hours").await;
    add_conv(&mut c, "m51c", "3 hours").await;
    drop(c);

    // Graph báo token hết hạn (190): chỉ MỘT lời gọi, phần còn lại bị đánh `failed` luôn.
    Mock::given(method("POST"))
        .and(path("/v25.0/me/messages"))
        .respond_with(
            ResponseTemplate::new(400)
                .set_body_json(json!({ "error": { "message": "token chết", "type": "OAuthException", "code": 190 } })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let b = ingest
        .create_broadcast(company, &input("Thử token", "Alo"), f.user, "web")
        .await
        .unwrap();
    let id = b["id"].as_i64().unwrap() as i32;
    ingest
        .send_broadcast(company, None, id, None, chrono::Utc::now())
        .await
        .unwrap();
    ingest
        .broadcasts_run_due(company, None, Duration::from_secs(20), chrono::Utc::now())
        .await
        .unwrap();
    let b = ingest.get_broadcast(company, id).await.unwrap();
    assert_eq!(b["status"], "done");
    assert_eq!((b["sent"].as_i64(), b["failed"].as_i64()), (Some(0), Some(3)));
    let mut c = f.db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(
        count(
            &mut c,
            "SELECT count(*) FROM facebook_pages WHERE page_id = 'm51p' AND token_status = 'invalid'"
        )
        .await,
        1
    );
    assert_eq!(
        count(&mut c, "SELECT count(*) FROM facebook_messages WHERE mid LIKE 'm51.%'").await,
        0
    );
    drop(c);
    clean_after(&f).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn tao_sua_hen_gio_huy_xoa() {
    let _g = serial().lock().await;
    let server = MockServer::start().await;
    let f = setup(&server).await;
    let (company, ingest) = (f.company, &f.ingest);

    // Thiếu tên / Page sai / nội dung trống ⇒ 400.
    for bad in [
        BroadcastInput {
            name: Some("  ".into()),
            ..input("x", "y")
        },
        BroadcastInput {
            page_id: Some("khong-co".into()),
            ..input("x", "y")
        },
        BroadcastInput {
            text: Some("   ".into()),
            ..input("x", "y")
        },
        BroadcastInput {
            name: None,
            ..input("x", "y")
        },
    ] {
        let e = ingest.create_broadcast(company, &bad, f.user, "web").await.unwrap_err();
        assert!(e.to_string().len() > 5, "{e}");
    }
    let b = ingest
        .create_broadcast(
            company,
            &BroadcastInput {
                audience: Some(json!({ "source_ids": [1, 1, "2"], "x": 9 })),
                ..input("  Khai giảng  ", "  Chào {ten}  ")
            },
            f.user,
            "web",
        )
        .await
        .unwrap();
    let id = b["id"].as_i64().unwrap() as i32;
    assert_eq!(b["name"], "Khai giảng");
    assert_eq!(b["text"], "Chào {ten}");
    assert_eq!(b["audience"], json!({ "source_ids": [1, 2] }));

    // Sửa một phần: tên mới, giữ nguyên phần còn lại; `name: null` ⇒ 400 (không ghi NULL).
    let u = ingest
        .update_broadcast(
            company,
            id,
            &BroadcastInput {
                name: Some("Tên mới".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (u["name"].as_str(), u["text"].as_str()),
        (Some("Tên mới"), Some("Chào {ten}"))
    );
    let e = ingest
        .update_broadcast(
            company,
            id,
            &BroadcastInput {
                name: Some(String::new()),
                ..Default::default()
            },
        )
        .await;
    assert!(e.is_err());

    // Hẹn giờ 2 giờ nữa: `scheduled`; job chưa chốt (chưa tới giờ); không xoá được khi đang chờ; huỷ ⇒ `cancelled`.
    let at = (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
    let s = ingest
        .send_broadcast(company, None, id, Some(&at), chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(s["status"], "scheduled");
    let run = ingest
        .broadcasts_run_due(company, None, Duration::from_secs(5), chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(run.started, 0);
    assert!(ingest.delete_broadcast(company, id).await.is_err());
    let far = (chrono::Utc::now() + chrono::Duration::days(9)).to_rfc3339();
    assert!(
        ingest
            .send_broadcast(company, None, id, Some(&far), chrono::Utc::now())
            .await
            .is_err(),
        "quá 7 ngày"
    );
    let x = ingest.cancel_broadcast(company, id).await.unwrap();
    assert_eq!(x["status"], "cancelled");
    assert!(ingest.cancel_broadcast(company, id).await.is_err(), "đã kết thúc");
    assert!(
        ingest
            .update_broadcast(
                company,
                id,
                &BroadcastInput {
                    name: Some("sau huỷ".into()),
                    ..Default::default()
                }
            )
            .await
            .is_err()
    );
    ingest.delete_broadcast(company, id).await.unwrap();
    assert!(ingest.get_broadcast(company, id).await.is_err(), "404 sau khi xoá");
    let list = ingest.list_broadcasts(company).await.unwrap();
    assert!(!list["data"].as_array().unwrap().iter().any(|v| v["id"] == id));
    let _: Value = list;
    clean_after(&f).await;
}
