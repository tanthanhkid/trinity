//! Zalo OA trên Postgres thật (`public` đã migrate bằng Prisma) với máy chủ giả Zalo (wiremock; kịch bản như C06b).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-zalo --test zalo_pg -- --ignored`
//! Dữ liệu mang tiền tố `m52`, tự dọn; các test chạy nối tiếp. Pool 4 kết nối: nhiều luồng làm mới token cùng lúc phải dồn về MỘT
//! lời gọi làm mới (khoá advisory) mà không cạn pool.

#![allow(clippy::result_large_err)]

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use mod_zalo::client::ZaloClient;
use mod_zalo::config::Env;
use mod_zalo::signature::compute_zalo_mac;
use mod_zalo::token::{self, Ctx};
use mod_zalo::webhook;
use mod_zalo::{messaging, threads};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{decrypt_secret, load_secret_key};
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const NOW: i64 = 1_800_000_000_000;

fn serial() -> &'static tokio::sync::Mutex<()> {
    static S: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn env_for(base: &str) -> Env {
    let base = base.to_owned();
    let key = STANDARD.encode([9_u8; 32]);
    Arc::new(move |k| match k {
        "ZALO_OA_APP_ID" => Some("app1".into()),
        "ZALO_OA_APP_SECRET" => Some("shh".into()),
        "ZALO_WEBHOOK_SECRET" => Some("hook-secret".into()),
        "ZALO_OA_REDIRECT_URI" => Some("https://crm.example.test/api/v1/zalo-oa/oauth/callback".into()),
        "INTEGRATIONS_SECRET_KEY" => Some(key.clone()),
        "ZALO_OAUTH_BASE_URL" | "ZALO_OPENAPI_BASE_URL" | "ZALO_ZNS_BASE_URL" => Some(base.clone()),
        _ => None,
    })
}

fn status(e: trinity_kernel::error::AppError) -> (u16, String) {
    let (s, b) = e.response(true);
    (s, serde_json::to_string(&b.message).unwrap())
}

fn jv(v: &impl serde::Serialize) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
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
        "DELETE FROM integration_events WHERE event_type LIKE 'zalo_oa.%' OR payload->>'origin' = 'zalo_oa'",
    )
    .await;
    exec(c, "DELETE FROM zalo_oa_threads WHERE oa_id LIKE 'm52%'").await;
    exec(c, "DELETE FROM zalo_oa_connections WHERE oa_id LIKE 'm52%'").await;
    exec(c, "DELETE FROM zalo_oa_oauth_states").await;
    exec(
        c,
        "DELETE FROM contacts WHERE zalo_account LIKE 'm52%' OR phone IN ('0912000111', '0912000222', '0987000333', '0912000444', '0987000555')",
    )
    .await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm52%@test.local'").await;
}

struct World {
    db: Db,
    platform: Platform,
    client: ZaloClient,
    env: Env,
    server: MockServer,
    admin: i32,
}

impl World {
    async fn new() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let url = std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL");
        let mut cfg = DbConfig::new(url);
        cfg.pool_size = 4;
        cfg.acquire_timeout = Duration::from_secs(5);
        let db = Db::connect(&cfg).await.expect("nối DB");
        let platform = Platform::new(&db, None);
        let server = MockServer::start().await;
        let env = env_for(&server.uri());
        let client = ZaloClient::new(env.clone());
        let mut c = db.tenant(CompanyRef::DEFAULT).await.unwrap().acquire().await.unwrap();
        clean(&mut c).await;
        let admin: i32 = sqlx::query_scalar("INSERT INTO users (email, password_hash, full_name, updated_at) VALUES ('m52a@test.local', 'x', 'M52', now()) RETURNING id")
            .fetch_one(&mut *c)
            .await
            .unwrap();
        drop(c);
        Self {
            db,
            platform,
            client,
            env,
            server,
            admin,
        }
    }

    fn ctx(&self) -> Ctx<'_> {
        Ctx {
            db: &self.db,
            env: &self.env,
            client: &self.client,
            platform: &self.platform,
            company: CompanyRef::DEFAULT,
        }
    }

    async fn conn(&self) -> trinity_db::TenantConn {
        self.db
            .tenant(CompanyRef::DEFAULT)
            .await
            .unwrap()
            .acquire()
            .await
            .unwrap()
    }

    /// Webhook ký đúng bằng khoá của môi trường thử.
    async fn hook(&self, ev: Value) -> Result<webhook::Outcome, trinity_kernel::error::AppError> {
        let mut ev = ev;
        ev["app_id"] = json!("app1");
        ev["timestamp"] = json!(NOW);
        let raw = ev.to_string();
        let mac = compute_zalo_mac("app1", raw.as_bytes(), &NOW.to_string(), "hook-secret");
        webhook::receive(&self.ctx(), Some(raw.as_bytes()), Some(&format!("mac={mac}")), NOW).await
    }

    /// Nối OA `m52oa` bằng cách chèn thẳng token đã mã hoá (access hết hạn sau `ttl_s` giây).
    async fn connect_direct(&self, ttl_s: i64) {
        let key = load_secret_key(&|k: &str| (self.env)(k)).unwrap();
        let mut c = self.conn().await;
        sqlx::query(
            "INSERT INTO zalo_oa_connections (oa_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, status, connected_by, updated_at) \
             VALUES ('m52oa', $1, $2, $3, $4, 'active', $5, now()) ON CONFLICT (oa_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, \
             refresh_token_enc = EXCLUDED.refresh_token_enc, access_expires_at = EXCLUDED.access_expires_at, status = 'active', last_error = NULL",
        )
        .bind(trinity_integrations::webhooks::secret::encrypt_secret("AT1", &key))
        .bind(trinity_integrations::webhooks::secret::encrypt_secret("RT1", &key))
        .bind(chrono::DateTime::from_timestamp_millis(NOW + ttl_s * 1000).unwrap())
        .bind(chrono::DateTime::from_timestamp_millis(NOW + 80 * 86_400_000).unwrap())
        .bind(self.admin)
        .execute(&mut *c)
        .await
        .unwrap();
    }
}

fn ok(b: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(b)
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn oauth_pkce_state_mot_lan_va_lam_moi_mot_lan() {
    let _g = serial().lock().await;
    let w = World::new().await;
    let ctx = w.ctx();
    // URL cấp quyền: PKCE S256 + state; thiếu cấu hình ⇒ 503.
    let u = token::start_connect(&ctx, w.admin, NOW).await.unwrap();
    let url = url::Url::parse(u["authorize_url"].as_str().unwrap()).unwrap();
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        (q["app_id"].as_str(), q["code_challenge_method"].as_str()),
        ("app1", "S256")
    );
    assert_eq!(
        q["redirect_uri"],
        "https://crm.example.test/api/v1/zalo-oa/oauth/callback"
    );
    assert!(url.path().ends_with("/v4/oa/permission"));
    let bare: Env = Arc::new(|_| None);
    let bare_ctx = Ctx { env: &bare, ..ctx };
    assert_eq!(
        status(token::start_connect(&bare_ctx, w.admin, NOW).await.unwrap_err()).0,
        503
    );

    // Callback: tham số thiếu/sai ⇒ 400; state sai ⇒ 400; đúng ⇒ đổi code bằng đúng `code_verifier` của PKCE.
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .and(header("secret_key", "shh"))
        .and(body_string_contains("grant_type=authorization_code"))
        .respond_with(ok(
            json!({ "access_token": "AT1", "refresh_token": "RT1", "expires_in": 3600 }),
        ))
        .expect(1)
        .mount(&w.server)
        .await;
    for bad in [
        ("", "m52oa", q["state"].as_str()),
        ("C", "", q["state"].as_str()),
        ("C", "a b", q["state"].as_str()),
        ("C", "m52oa", ""),
    ] {
        assert_eq!(
            status(
                token::complete_connect(&ctx, bad.0, bad.1, bad.2, NOW)
                    .await
                    .unwrap_err()
            ),
            (400, "\"Thiếu tham số callback\"".to_owned()),
            "{bad:?}"
        );
    }
    assert_eq!(
        status(
            token::complete_connect(&ctx, "C", "m52oa", "khong-co", NOW)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    assert_eq!(
        token::complete_connect(&ctx, "C", "m52oa", &q["state"], NOW + 1000)
            .await
            .unwrap(),
        "m52oa"
    );
    // State dùng một lần; quá 10 phút ⇒ 400.
    assert_eq!(
        status(
            token::complete_connect(&ctx, "C", "m52oa", &q["state"], NOW + 2000)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    let old = token::start_connect(&ctx, w.admin, NOW).await.unwrap();
    let old_state = url::Url::parse(old["authorize_url"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(
        status(
            token::complete_connect(&ctx, "C", "m52oa", &old_state, NOW + 11 * 60 * 1000)
                .await
                .unwrap_err()
        )
        .0,
        400
    );
    // PKCE: `code_verifier` Zalo nhận có sha256 base64url đúng bằng `code_challenge` trong URL.
    let reqs = w.server.received_requests().await.unwrap();
    let body = String::from_utf8(
        reqs.iter()
            .find(|r| r.url.path().ends_with("/access_token"))
            .unwrap()
            .body
            .clone(),
    )
    .unwrap();
    let verifier = url::form_urlencoded::parse(body.as_bytes())
        .find(|(k, _)| k == "code_verifier")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        q["code_challenge"]
    );
    // Token lưu mã hoá; trạng thái không lộ token.
    let key = load_secret_key(&|k: &str| (w.env)(k)).unwrap();
    let mut c = w.conn().await;
    let enc: String = sqlx::query_scalar("SELECT access_token_enc FROM zalo_oa_connections WHERE oa_id = 'm52oa'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert!(enc.starts_with("v1.") && decrypt_secret(&enc, &key).unwrap() == "AT1");
    drop(c);
    let st = jv(&token::status(&ctx).await.unwrap());
    assert_eq!(
        (st["connected"].as_bool(), st["status"].as_str(), st["oa_id"].as_str()),
        (Some(true), Some("active"), Some("m52oa"))
    );
    assert!(!st.to_string().contains("AT1"));

    // Còn hạn: không gọi Zalo. Sắp hết hạn: 6 luồng đồng thời chỉ làm mới MỘT lần (refresh token dùng một lần).
    w.server.reset().await;
    w.connect_direct(3600).await;
    assert_eq!(token::get_access_token(&ctx, NOW).await.unwrap().token, "AT1");
    assert!(w.server.received_requests().await.unwrap().is_empty());
    w.connect_direct(60).await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .and(body_string_contains("refresh_token=RT1"))
        .respond_with(
            ok(json!({ "access_token": "AT2", "refresh_token": "RT2", "expires_in": 3600 }))
                .set_delay(Duration::from_millis(200)),
        )
        .expect(1)
        .mount(&w.server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .respond_with(ok(json!({ "error": -118, "message": "refresh token đã dùng" })))
        .with_priority(9)
        .mount(&w.server)
        .await;
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let (db, env, platform) = (w.db.clone(), w.env.clone(), w.platform.clone());
        let client = w.client.clone();
        tasks.push(tokio::spawn(async move {
            let c = Ctx {
                db: &db,
                env: &env,
                client: &client,
                platform: &platform,
                company: CompanyRef::DEFAULT,
            };
            token::get_access_token(&c, NOW)
                .await
                .map(|t| t.token)
                .map_err(|e| status(e).1)
        }));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap().unwrap(), "AT2");
    }
    let mut c = w.conn().await;
    let rt: String = sqlx::query_scalar("SELECT refresh_token_enc FROM zalo_oa_connections WHERE oa_id = 'm52oa'")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(decrypt_secret(&rt, &key).unwrap(), "RT2");
    drop(c);

    // Lỗi làm mới: tạm thời ⇒ 400 "thử lại sau", giữ `active`; Zalo từ chối thật ⇒ `needs_reauth`, các lần sau 400 "kết nối lại".
    w.server.reset().await;
    w.connect_direct(60).await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .respond_with(ResponseTemplate::new(503).set_body_string("down"))
        .mount(&w.server)
        .await;
    let (code, msg) = status(token::get_access_token(&ctx, NOW).await.unwrap_err());
    assert_eq!(code, 400);
    assert!(msg.contains("lỗi tạm thời"), "{msg}");
    assert_eq!(jv(&token::status(&ctx).await.unwrap())["status"], "active");
    w.server.reset().await;
    Mock::given(method("POST"))
        .and(path("/v4/oa/access_token"))
        .respond_with(ok(json!({ "error": -118, "message": "invalid" })))
        .mount(&w.server)
        .await;
    let (code, msg) = status(token::get_access_token(&ctx, NOW).await.unwrap_err());
    assert_eq!(code, 400);
    assert!(msg.contains("cần kết nối lại"), "{msg}");
    let st = jv(&token::status(&ctx).await.unwrap());
    assert_eq!(
        (st["status"].as_str(), st["connected"].as_bool()),
        (Some("needs_reauth"), Some(false))
    );
    assert!(st["last_error"].as_str().unwrap().contains("-118"));
    assert!(
        status(token::get_access_token(&ctx, NOW).await.unwrap_err())
            .1
            .contains("chưa kết nối hoặc cần kết nối lại")
    );
    // Lỗi cấu hình khi làm mới ⇒ 503 và KHÔNG đánh dấu cần kết nối lại.
    w.connect_direct(60).await;
    let base: Env = {
        let inner = w.env.clone();
        Arc::new(move |k| {
            if k == "ZALO_OAUTH_BASE_URL" {
                Some("http://oauth.example.test".into())
            } else {
                inner(k)
            }
        })
    };
    let bad_client = ZaloClient::new(base.clone());
    let bad_ctx = Ctx {
        env: &base,
        client: &bad_client,
        ..ctx
    };
    assert_eq!(status(token::get_access_token(&bad_ctx, NOW).await.unwrap_err()).0, 503);
    assert_eq!(jv(&token::status(&ctx).await.unwrap())["status"], "active");
    // Ngắt kết nối.
    token::disconnect(&ctx).await.unwrap();
    assert_eq!(jv(&token::status(&ctx).await.unwrap())["status"], "disconnected");
    let mut c = w.conn().await;
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn webhook_hoi_thoai_ghep_khach_va_khu_trung() {
    let _g = serial().lock().await;
    let w = World::new().await;
    w.connect_direct(3600).await;
    // Chữ ký sai/thiếu ⇒ 401, không phân biệt lý do.
    let raw = br#"{"app_id":"app1","event_name":"user_send_text","timestamp":1}"#;
    for sig in [None, Some("mac=zzz"), Some(&*format!("mac={}", "0".repeat(64)))] {
        assert_eq!(
            status(webhook::receive(&w.ctx(), Some(raw), sig, NOW).await.unwrap_err()).0,
            401
        );
    }
    // Hồ sơ Zalo có SĐT chia sẻ ⇒ tạo khách mới giao cho người nối OA.
    Mock::given(method("GET"))
        .and(path("/v3.0/oa/user/detail"))
        .respond_with(ok(json!({ "error": 0, "data": { "display_name": "Lan", "avatar": "https://img/l.png", "shared_info": { "phone": "84912000111" } } })))
        .mount(&w.server)
        .await;
    let inbound = |msg_id: &str, text: &str| {
        json!({
            "event_name": "user_send_text", "sender": { "id": "m52u1" }, "recipient": { "id": "m52oa" }, "message": { "msg_id": msg_id, "text": text }
        })
    };
    let r = w.hook(inbound("mm1", "xin chào")).await.unwrap();
    assert_eq!((r.ok, r.handled), (true, true));
    let mut c = w.conn().await;
    let t = threads::list(&mut c, 30, None, None)
        .await
        .unwrap()
        .data
        .into_iter()
        .find(|t| t.zalo_user_id == "m52u1")
        .unwrap();
    assert_eq!(
        (
            t.unread_count,
            t.last_message_preview.as_deref(),
            t.display_name.as_deref(),
            t.phone.as_deref()
        ),
        (1, Some("xin chào"), Some("Lan"), Some("84912000111"))
    );
    assert!(t.last_inbound_at.is_some() && t.contact_id.is_some());
    let (phone, acct, assigned): (String, Option<String>, Option<i32>) =
        sqlx::query_as("SELECT phone, zalo_account, assigned_to FROM contacts WHERE id = $1")
            .bind(t.contact_id)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(
        (phone.as_str(), acct.as_deref(), assigned),
        ("0912000111", Some("m52u1"), Some(w.admin))
    );
    // Webhook gửi lại cùng msg_id: không tin mới, không sự kiện lần hai, không tăng chưa đọc.
    drop(c);
    let r = w.hook(inbound("mm1", "xin chào")).await.unwrap();
    assert!(r.ok && !r.handled);
    let mut c = w.conn().await;
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM integration_events WHERE event_type = 'zalo_oa.message_received' AND resource_id = $1",
    )
    .bind(t.id.to_string())
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(events, 1);
    assert_eq!(threads::get(&mut c, t.id).await.unwrap().unread_count, 1);
    let created: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM integration_events WHERE event_type = 'contact.created' AND payload->>'origin' = 'zalo_oa'").fetch_one(&mut *c).await.unwrap();
    assert_eq!(created, 1, "khách mới phát contact.created trong cùng giao dịch");
    drop(c);

    // Người thứ hai cùng SĐT ⇒ ghép khách có sẵn, không tạo thêm. Tin đính kèm không có text.
    let r = w
        .hook(json!({ "event_name": "user_send_image", "sender": { "id": "m52u2" }, "recipient": { "id": "m52oa" },
                      "message": { "msg_id": "mm2", "attachments": [{ "type": "image", "payload": { "url": "https://x/i.png" } }] } }))
        .await
        .unwrap();
    assert!(r.handled);
    let mut c = w.conn().await;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM contacts WHERE phone = '0912000111' AND deleted_at IS NULL")
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let t2 = threads::list(&mut c, 30, None, None)
        .await
        .unwrap()
        .data
        .into_iter()
        .find(|t| t.zalo_user_id == "m52u2")
        .unwrap();
    assert_eq!(
        (t2.contact_id, t2.last_message_preview.as_deref()),
        (t.contact_id, Some("[Tệp đính kèm]"))
    );
    let msgs = threads::messages(&mut c, t2.id, 50, None).await.unwrap();
    assert_eq!(
        (msgs.len(), msgs[0].kind.as_str(), msgs[0].id.parse::<i64>().is_ok()),
        (1, "attachment", true)
    );
    assert_eq!(jv(&msgs[0])["payload"]["attachments"][0]["type"], "image");
    drop(c);

    // Tin do OA gửi từ app Zalo đồng bộ vào hộp thư (không tăng chưa đọc); follow tạo hội thoại; sự kiện lạ ⇒ 200 bỏ qua.
    let r = w.hook(json!({ "event_name": "oa_send_text", "sender": { "id": "m52oa" }, "recipient": { "id": "m52u1" }, "message": { "msg_id": "mm3", "text": "OA trả lời" } })).await.unwrap();
    assert!(r.handled);
    let r = w
        .hook(json!({ "event_name": "follow", "oa": { "id": "m52oa" }, "follower": { "id": "m52u3" } }))
        .await
        .unwrap();
    assert!(r.handled);
    let r = w.hook(json!({ "event_name": "user_seen_message" })).await.unwrap();
    assert_eq!((r.ok, r.handled), (true, false));
    let mut c = w.conn().await;
    let after = threads::get(&mut c, t.id).await.unwrap();
    assert_eq!(
        (after.unread_count, after.last_message_preview.as_deref()),
        (1, Some("OA trả lời"))
    );
    // Danh sách: tìm theo tên (không phân biệt hoa/thường), ký tự LIKE được thoát, phân trang theo con trỏ.
    assert_eq!(
        threads::list(&mut c, 30, None, Some("LAN")).await.unwrap().data.len(),
        1
    );
    assert!(
        threads::list(&mut c, 30, None, Some("%"))
            .await
            .unwrap()
            .data
            .is_empty(),
        "% là ký tự thường"
    );
    assert_eq!(
        threads::list(&mut c, 30, None, Some("84912000111"))
            .await
            .unwrap()
            .data
            .len(),
        2
    );
    let p1 = threads::list(&mut c, 1, None, Some("")).await.unwrap();
    assert!(p1.meta.next_cursor.is_some());
    let p2 = threads::list(&mut c, 100, p1.meta.next_cursor.map(i64::from), None)
        .await
        .unwrap();
    assert!(p2.data.iter().all(|x| x.id != p1.data[0].id));
    assert!(
        threads::list(&mut c, 30, Some(2_000_000_000), None)
            .await
            .unwrap()
            .data
            .is_empty(),
        "con trỏ không tồn tại ⇒ rỗng"
    );
    // Đã đọc, 404.
    threads::mark_read(&mut c, t.id).await.unwrap();
    assert_eq!(threads::get(&mut c, t.id).await.unwrap().unread_count, 0);
    assert_eq!(
        status(threads::mark_read(&mut c, 2_000_000_000).await.unwrap_err()).0,
        404
    );
    assert_eq!(
        status(threads::messages(&mut c, 2_000_000_000, 50, None).await.unwrap_err()).0,
        404
    );
    // Ghép tay: khách không tồn tại 404; theo SĐT tìm/tạo; SĐT sai 404.
    assert_eq!(
        status(
            threads::link(&mut c, t.id, Some(2_000_000_000), None, w.admin)
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    let linked = threads::link(&mut c, t.id, None, Some("0912 000 222"), w.admin)
        .await
        .unwrap();
    assert_ne!(linked.contact_id, t.contact_id);
    assert_eq!(linked.phone.as_deref(), Some("84912000222"));
    assert_eq!(
        status(
            threads::link(&mut c, t.id, None, Some("12"), w.admin)
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    clean(&mut c).await;
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn gui_tin_tu_van_48_gio_va_zns() {
    let _g = serial().lock().await;
    let w = World::new().await;
    w.connect_direct(3600).await;
    let ctx = w.ctx();
    let mut c = w.conn().await;
    let t = threads::upsert_thread(&mut c, "m52oa", "m52u9").await.unwrap();
    exec(
        &mut c,
        &format!(
            "UPDATE zalo_oa_threads SET phone = '84912000111', last_inbound_at = to_timestamp({}) WHERE id = {}",
            (NOW - 3_600_000) / 1000,
            t.id
        ),
    )
    .await;
    drop(c);
    // Trong 48 giờ: gửi được, ghi lịch sử, tên người gửi.
    Mock::given(method("POST"))
        .and(path("/v3.0/oa/message/cs"))
        .respond_with(ok(json!({ "error": 0, "data": { "message_id": "zm1" } })))
        .mount(&w.server)
        .await;
    assert_eq!(
        messaging::send_text(&ctx, None, t.id, "  chào bạn  ", Some(w.admin), NOW)
            .await
            .unwrap()
            .as_deref(),
        Some("zm1")
    );
    let mut c = w.conn().await;
    let m = threads::messages(&mut c, t.id, 10, None).await.unwrap();
    assert_eq!(
        (
            m[0].direction.as_str(),
            m[0].text.as_deref(),
            m[0].status.as_str(),
            m[0].sent_by
        ),
        ("out", Some("chào bạn"), "sent", Some(w.admin))
    );
    // Nội dung rỗng/quá dài ⇒ 400; quá 48 giờ ⇒ 400 gợi ý ZNS; hội thoại lạ ⇒ 404.
    for bad in ["   ".to_owned(), "x".repeat(2001)] {
        assert_eq!(
            status(
                messaging::send_text(&ctx, None, t.id, &bad, None, NOW)
                    .await
                    .unwrap_err()
            )
            .0,
            400
        );
    }
    assert_eq!(
        status(
            messaging::send_text(&ctx, None, 2_000_000_000, "x", None, NOW)
                .await
                .unwrap_err()
        )
        .0,
        404
    );
    let (code, msg) = status(
        messaging::send_text(&ctx, None, t.id, "x", None, NOW + 49 * 3_600_000)
            .await
            .unwrap_err(),
    );
    assert_eq!(code, 400);
    assert!(msg.contains("ZNS"), "{msg}");
    drop(c);
    // Zalo từ chối (đã chặn OA, -233): câu tiếng Việt, ghi tin `failed`, KHÔNG đánh dấu cần kết nối lại.
    w.server.reset().await;
    Mock::given(method("POST"))
        .and(path("/v3.0/oa/message/cs"))
        .respond_with(ok(json!({ "error": -233, "message": "blocked" })))
        .mount(&w.server)
        .await;
    let (code, msg) = status(
        messaging::send_text(&ctx, None, t.id, "x", None, NOW)
            .await
            .unwrap_err(),
    );
    assert_eq!(code, 400);
    assert!(msg.contains("chưa quan tâm OA"), "{msg}");
    let mut c = w.conn().await;
    let m = threads::messages(&mut c, t.id, 10, None).await.unwrap();
    assert_eq!((m[0].status.as_str(), m[0].error.is_some()), ("failed", true));
    assert_eq!(jv(&token::status(&ctx).await.unwrap())["status"], "active");
    // Token hỏng (-216): 400 "kết nối lại" và đánh dấu `needs_reauth`.
    drop(c);
    w.server.reset().await;
    Mock::given(method("POST"))
        .and(path("/v3.0/oa/message/cs"))
        .respond_with(ok(json!({ "error": -216, "message": "invalid token" })))
        .mount(&w.server)
        .await;
    assert!(
        status(
            messaging::send_text(&ctx, None, t.id, "x", None, NOW)
                .await
                .unwrap_err()
        )
        .1
        .contains("kết nối lại")
    );
    assert_eq!(jv(&token::status(&ctx).await.unwrap())["status"], "needs_reauth");
    w.connect_direct(3600).await;

    // ZNS: SĐT sai 400; thành công trả quota và ghi vào hội thoại có SĐT đó; mẫu chưa duyệt (-224) dịch đúng và ghi `failed`.
    w.server.reset().await;
    let data = json!({ "customer_name": "Lan" });
    let map = data.as_object().unwrap();
    let input = |phone| messaging::ZnsInput {
        phone,
        template_id: "555",
        template_data: map,
        tracking_id: Some("trk"),
        sent_by: Some(w.admin),
    };
    assert_eq!(
        status(messaging::send_zns(&ctx, None, &input("12345"), NOW).await.unwrap_err()).0,
        400
    );
    Mock::given(method("POST"))
        .and(path("/message/template"))
        .and(body_string_contains("\"phone\":\"84912000111\""))
        .respond_with(ok(
            json!({ "error": 0, "data": { "msg_id": "zz1", "quota": { "remainingQuota": "9" } } }),
        ))
        .expect(1)
        .mount(&w.server)
        .await;
    let r = messaging::send_zns(&ctx, None, &input("0912 000 111"), NOW)
        .await
        .unwrap();
    assert_eq!(
        (r["message_id"].as_str(), r["quota"]["remainingQuota"].as_str()),
        (Some("zz1"), Some("9"))
    );
    let mut c = w.conn().await;
    let m = threads::messages(&mut c, t.id, 10, None).await.unwrap();
    assert_eq!(
        (
            m[0].kind.as_str(),
            m[0].status.as_str(),
            jv(&m[0])["payload"]["template_id"].as_str().map(str::to_owned)
        ),
        ("zns", "sent", Some("555".to_owned()))
    );
    drop(c);
    w.server.reset().await;
    Mock::given(method("POST"))
        .and(path("/message/template"))
        .respond_with(ok(json!({ "error": -224, "message": "template not approved" })))
        .mount(&w.server)
        .await;
    let (code, msg) = status(
        messaging::send_zns(&ctx, None, &input("0912000111"), NOW)
            .await
            .unwrap_err(),
    );
    assert_eq!(code, 400);
    assert!(msg.contains("Mẫu ZNS"), "{msg}");
    let mut c = w.conn().await;
    let m = threads::messages(&mut c, t.id, 10, None).await.unwrap();
    assert_eq!((m[0].kind.as_str(), m[0].status.as_str()), ("zns", "failed"));
    clean(&mut c).await;
}

/// Một tin vào của khách (ghi thẳng, không qua webhook).
async fn inbound_text(c: &mut PgConnection, thread: i32, msg_id: &str, text: &str, direction: &'static str) -> i64 {
    let m = threads::record(
        c,
        &threads::RecordMessage {
            thread_id: thread,
            direction,
            kind: "text",
            msg_id: Some(msg_id),
            text: Some(text),
            payload: json!({}),
            status: if direction == "in" { "received" } else { "sent" },
            error: None,
            sent_by: None,
            at: None,
        },
    )
    .await
    .unwrap()
    .unwrap();
    m.id.0
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn luu_sdt_tu_tin_nhan_vao_ho_so() {
    let _g = serial().lock().await;
    let w = World::new().await;
    let mut c = w.conn().await;
    let t1 = threads::upsert_thread(&mut c, "m52sp", "m52usp1").await.unwrap();
    let m1 = inbound_text(&mut c, t1.id, "sp1", "Chào shop, SĐT chị 0987 000 333 nhé", "in").await;
    let m_out = inbound_text(&mut c, t1.id, "sp2", "Dạ em gọi chị theo 0987 000 333", "out").await;
    let m_none = inbound_text(&mut c, t1.id, "sp3", "báo giá 18.500.000 ₫ giúp chị", "in").await;

    // Danh sách tin: chỉ tin KHÁCH có số mới có `phones`.
    let view = threads::messages(&mut c, t1.id, 10, None).await.unwrap();
    let phones: Vec<(String, Vec<String>)> = view
        .iter()
        .map(|m| (m.msg_id.clone().unwrap(), m.phones.clone()))
        .collect();
    assert!(phones.contains(&("sp1".into(), vec!["0987000333".into()])));
    assert!(phones.contains(&("sp2".into(), vec![])) && phones.contains(&("sp3".into(), vec![])));

    // Lỗi đầu vào: tin đi, tin không có số, tin của hội thoại khác, số không có trong tin.
    for (mid, want, code) in [
        (m_out, None, 404),
        (m_none, None, 400),
        (m1 + 9999, None, 404),
        (m1, Some("0912000444"), 400),
    ] {
        let e = threads::save_phone(&mut c, t1.id, mid, want, w.admin)
            .await
            .unwrap_err();
        assert_eq!(status(e).0, code, "{mid} {want:?}");
    }
    let (cid, n): (Option<i32>, i64) = sqlx::query_as("SELECT (SELECT contact_id FROM zalo_oa_threads WHERE id = $1), (SELECT count(*) FROM contacts WHERE phone = '0987000333')")
        .bind(t1.id)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!((cid, n), (None, 0), "lỗi đầu vào không được ghi gì");

    // Hội thoại chưa ghép khách ⇒ tạo khách mới, ghép, giao cho người bấm.
    let r = threads::save_phone(&mut c, t1.id, m1, None, w.admin).await.unwrap();
    assert_eq!((r.created, r.already, r.phone.as_str()), (true, false, "0987000333"));
    assert_eq!(
        (r.thread.contact_id, r.thread.phone.as_deref()),
        (Some(r.contact_id), Some("84987000333"))
    );
    let (phone, source, assigned): (String, Option<String>, Option<i32>) =
        sqlx::query_as("SELECT c.phone, c.zalo_account, c.assigned_to FROM contacts c WHERE c.id = $1")
            .bind(r.contact_id)
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(
        (phone.as_str(), source.as_deref(), assigned),
        ("0987000333", Some("m52usp1"), Some(w.admin))
    );
    // Bấm lần hai: không tạo thêm, `already`.
    let again = threads::save_phone(&mut c, t1.id, m1, Some("+84 987 000 333"), w.admin)
        .await
        .unwrap();
    assert_eq!(
        (again.contact_id, again.created, again.already),
        (r.contact_id, false, true)
    );

    // Hội thoại khác, tin có HAI số: phải chọn; chọn số đã là khách khác ⇒ ghép vào khách đó, không tạo trùng.
    let t2 = threads::upsert_thread(&mut c, "m52sp", "m52usp2").await.unwrap();
    let m2 = inbound_text(&mut c, t2.id, "sp4", "số 0912 000 444 hoặc 0987.000.333", "in").await;
    assert_eq!(
        status(threads::save_phone(&mut c, t2.id, m2, None, w.admin).await.unwrap_err()).0,
        400
    );
    let r2 = threads::save_phone(&mut c, t2.id, m2, Some("0987000333"), w.admin)
        .await
        .unwrap();
    assert_eq!((r2.contact_id, r2.created), (r.contact_id, false));

    // Đã ghép khách mang SỐ KHÁC ⇒ 409, không ghi đè số, không đổi hội thoại.
    let t3 = threads::upsert_thread(&mut c, "m52sp", "m52usp3").await.unwrap();
    let m3 = inbound_text(&mut c, t3.id, "sp5", "số mới của chị 0987 000 555", "in").await;
    threads::update_profile(&mut c, t3.id, None, None, None, Some(r.contact_id))
        .await
        .unwrap();
    let e = threads::save_phone(&mut c, t3.id, m3, None, w.admin).await.unwrap_err();
    assert_eq!(status(e).0, 409);
    let (cp, count): (String, i64) = sqlx::query_as(
        "SELECT (SELECT phone FROM contacts WHERE id = $1), (SELECT count(*) FROM contacts WHERE phone = '0987000555')",
    )
    .bind(r.contact_id)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!((cp.as_str(), count), ("0987000333", 0));

    // Khách đã ghép bị xoá (mềm) ⇒ coi như chưa ghép: tạo khách mới mang số trong tin và ghép lại, không báo 404.
    let t4 = threads::upsert_thread(&mut c, "m52sp", "m52usp4").await.unwrap();
    let m4 = inbound_text(&mut c, t4.id, "sp6", "chị đổi sang 0987 000 666", "in").await;
    threads::update_profile(&mut c, t4.id, None, None, None, Some(r.contact_id))
        .await
        .unwrap();
    sqlx::query("UPDATE contacts SET deleted_at = now() WHERE id = $1")
        .bind(r.contact_id)
        .execute(&mut *c)
        .await
        .unwrap();
    let r4 = threads::save_phone(&mut c, t4.id, m4, None, w.admin).await.unwrap();
    assert!(r4.created && !r4.already && r4.contact_id != r.contact_id);
    assert_eq!(r4.thread.contact_id, Some(r4.contact_id));
    clean(&mut c).await;
}
