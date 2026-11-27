//! Bình luận Fanpage và luật tự động trên Postgres thật (`public` đã migrate bằng Prisma) với máy chủ giả Graph (wiremock; M49).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-facebook --test comments_pg -- --ignored`
//! Dữ liệu mang tiền tố `m49`, tự dọn. Pool chỉ 1 kết nối: nếu mã giữ kết nối khi gọi Graph hoặc xin kết nối thứ hai trong lúc
//! đang giữ một, test sẽ treo rồi hết hạn chờ.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use chrono::Utc;
use mod_facebook::comments::{self, CommentCtx, CommentReply, DryRunInput, ListQuery};
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
        "DELETE FROM integration_events WHERE payload::text LIKE '%m49%' OR payload->>'origin' = 'facebook_comment'",
    )
    .await;
    exec(c, "DELETE FROM facebook_comments WHERE page_id LIKE 'm49%'").await;
    exec(c, "DELETE FROM facebook_comment_rules WHERE name LIKE 'm49%'").await;
    exec(c, "DELETE FROM facebook_conversations WHERE page_id LIKE 'm49%'").await;
    exec(c, "DELETE FROM facebook_pages WHERE page_id LIKE 'm49%'").await;
    exec(
        c,
        "DELETE FROM activities WHERE metadata->>'facebook_page_id' LIKE 'm49%'",
    )
    .await;
    exec(
        c,
        "DELETE FROM contacts WHERE phone IN ('0912490001', '0912490002') OR full_name LIKE 'm49%'",
    )
    .await;
    exec(c, "DELETE FROM notification_logs WHERE action_url = '/inbox?kenh=tuong-tac'").await;
    exec(c, "DELETE FROM setting_options WHERE value LIKE 'm49%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm49%@test.local'").await;
}

fn comment(page: &str, cid: &str, post: &str, from: &str, text: &str) -> Value {
    json!({ "id": page, "changes": [{ "field": "feed", "value": {
        "item": "comment", "verb": "add", "comment_id": cid, "post_id": post, "parent_id": post,
        "from": { "id": from, "name": format!("m49 {from}") }, "message": text, "created_time": 1_800_000_000
    } }] })
}

fn rule_body(v: Value) -> serde_json::Map<String, Value> {
    comments::validate_rule_body(&v).unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn binh_luan_luat_tu_dong_va_tra_loi_tay() {
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
    let user = one_i32(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('m49a@test.local', 'x', 'M49', 'active', now()) RETURNING id").await;
    let src = one_i32(&mut c, "INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', 'm49_fb', 'Facebook', now()) RETURNING id").await;
    sqlx::query(
        "INSERT INTO facebook_pages (page_id, name, token_enc, subscribed, token_status, is_active, default_assignee_id, contact_source_id, connected_by, updated_at) \
         VALUES ('m49p', 'Quán M49', $1, true, 'active', true, $2, $3, $2, now())",
    )
    .bind(encrypt_secret("PTOKEN", &key))
    .bind(user)
    .bind(src)
    .execute(&mut *c)
    .await
    .unwrap();

    // Luật 1 (chạy thật): từ khoá "giá" ⇒ trả lời công khai + nhắn riêng + ẩn khi có SĐT. Luật 2 (thử): "thử".
    let r1 = comments::create_rule(
        &mut c,
        &rule_body(json!({
            "name": "m49 giá", "keywords": ["giá"], "public_replies": ["Chào {ten}!"], "private_reply": "Em gửi giá cho {ten}",
            "hide_if_phone": true, "mode": "live"
        })),
        user,
    )
    .await
    .unwrap();
    assert_eq!((r1.mode.as_str(), r1.once_per_user, r1.is_active), ("live", true, true));
    let r2 = comments::create_rule(
        &mut c,
        &rule_body(json!({ "name": "m49 thử", "keywords": ["thử"], "public_replies": ["x"] })),
        user,
    )
    .await
    .unwrap();
    assert_eq!(r2.mode, "test", "mặc định chế độ thử");
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi mô-đun

    // Graph giả: trả lời công khai, nhắn riêng (trả PSID), ẩn bình luận.
    let ok = |b: Value| ResponseTemplate::new(200).set_body_json(b);
    Mock::given(method("POST"))
        .and(path_regex(r"^/v25\.0/m49c\d+/comments$"))
        .and(header("authorization", "Bearer PTOKEN"))
        .respond_with(ok(json!({ "id": "m49reply" })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v25.0/m49p/messages"))
        .respond_with(ok(json!({ "recipient_id": "m49psid", "message_id": "m49.mid1" })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"^/v25\.0/m49c\d+$"))
        .respond_with(ok(json!({ "success": true })))
        .mount(&server)
        .await;

    let env2 = env.clone();
    let ingest = FacebookIngest::new(
        db.clone(),
        env.clone(),
        Arc::new(move |_| GraphClient::new(env2.clone(), Arc::new(|_| {}))),
    );

    // ── Bình luận khớp luật 1, có SĐT: trả lời + nhắn riêng + ẩn, khách mới có SĐT ──
    let first = comment("m49p", "m49c1", "m49p_1", "u1", "Cho em hỏi giá, sđt 0912 490 001");
    assert_eq!(ingest.process(company, &[first.clone()]).await.unwrap(), 1);
    // Meta gửi lại cùng `comment_id` ⇒ không tạo thêm, không gọi Graph lần nữa.
    assert_eq!(ingest.process(company, &[first]).await.unwrap(), 0);
    // Bình luận của chính Page ⇒ bỏ qua.
    assert_eq!(
        ingest
            .process(company, &[comment("m49p", "m49c0", "m49p_1", "m49p", "giá")])
            .await
            .unwrap(),
        0
    );
    // Cùng người, cùng bài, cùng luật ⇒ bỏ qua (mỗi người một lần mỗi bài).
    assert_eq!(
        ingest
            .process(company, &[comment("m49p", "m49c2", "m49p_1", "u1", "giá nữa nhé")])
            .await
            .unwrap(),
        1
    );
    // Luật chế độ thử: chỉ ghi lại.
    assert_eq!(
        ingest
            .process(company, &[comment("m49p", "m49c3", "m49p_1", "u2", "thử xem")])
            .await
            .unwrap(),
        1
    );
    // Không khớp luật nào ⇒ `received`, vẫn tạo khách (biết người bình luận).
    assert_eq!(
        ingest
            .process(company, &[comment("m49p", "m49c4", "m49p_1", "u3", "đẹp quá")])
            .await
            .unwrap(),
        1
    );
    // Page chưa nối ⇒ bỏ qua.
    assert_eq!(
        ingest
            .process(company, &[comment("m49x", "m49c9", "m49x_1", "u1", "giá")])
            .await
            .unwrap(),
        0
    );

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE page_id = 'm49p'").await, 4);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE comment_id = 'm49c1' AND status = 'done' AND hidden AND phone = '0912490001' AND rule_id IS NOT NULL AND contact_id IS NOT NULL AND actions->'public_reply'->>'id' = 'm49reply' AND actions->'private_reply'->>'message_id' = 'm49.mid1' AND actions->'public_reply'->>'text' = 'Chào m49 u1!'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE comment_id = 'm49c2' AND status = 'skipped'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE comment_id = 'm49c3' AND status = 'test' AND NOT hidden AND actions->'public_reply'->>'id' IS NULL").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE comment_id = 'm49c4' AND status = 'received' AND rule_id IS NULL AND contact_id IS NOT NULL").await, 1);
    // Khách có SĐT từ bình luận, hội thoại Messenger tạo sẵn gắn đúng khách + tin ra của Page.
    assert_eq!(count(&mut c, "SELECT count(*) FROM contacts WHERE phone = '0912490001' AND full_name = 'm49 u1'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_conversations v JOIN contacts k ON k.id = v.contact_id WHERE v.page_id = 'm49p' AND v.psid = 'm49psid' AND k.phone = '0912490001'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_messages WHERE mid = 'm49.mid1' AND direction = 'out'").await, 1);
    // Sự kiện: mỗi bình luận mới một `facebook.comment_received`; tin ra của nhắn riêng một `messenger.message_sent`.
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'facebook.comment_received' AND payload->>'page_id' = 'm49p'").await, 4);
    assert_eq!(count(&mut c, "SELECT count(*) FROM integration_events WHERE event_type = 'messenger.message_sent' AND payload->>'origin' = 'comment_reply'").await, 1);
    assert_eq!(count(&mut c, "SELECT count(*) FROM activities WHERE metadata->>'facebook_page_id' = 'm49p' AND details->>'source' = 'facebook_comment'").await, 4);
    // Chuông cho người nhận mặc định của Page.
    assert!(count(&mut c, "SELECT count(*) FROM notification_logs WHERE event_type = 'facebook.comment_received' AND action_url = '/inbox?kenh=tuong-tac'").await >= 4);

    // ── Danh sách: chưa trả lời = test + received (done/skipped đã tính là trả lời) ──
    let now = Utc::now();
    let all = comments::list_comments(&mut c, &ListQuery::from_params(None, None, None), now)
        .await
        .unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(all[0]["id"], json!(all[0]["id"].as_str().unwrap()), "id là chuỗi");
    let open = comments::list_comments(&mut c, &ListQuery::from_params(Some("50"), None, Some("1")), now)
        .await
        .unwrap();
    let mut ids: Vec<&str> = open.iter().map(|v| v["post_url"].as_str().unwrap()).collect();
    ids.dedup();
    assert_eq!(open.len(), 2);
    assert!(open.iter().all(|v| v["answered"] == json!(false)));
    let done = comments::list_comments(&mut c, &ListQuery::from_params(None, Some("done"), None), now)
        .await
        .unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0]["page_name"], "Quán M49");
    assert_eq!(done[0]["rule_name"], "m49 giá");
    assert_eq!(done[0]["can_private_reply"], json!(false), "đã nhắn riêng rồi");
    let m49c4 = open
        .iter()
        .find(|v| v["status"] == "received")
        .expect("bình luận received")
        .clone();
    drop(c);

    // ── Trả lời tay: công khai (đổi received ⇒ replied), rồi nhắn riêng một lần; lần hai bị từ chối ──
    let graph = GraphClient::new(env.clone(), Arc::new(|_| {}));
    let ctx = CommentCtx {
        db: &db,
        env: &env,
        graph: &graph,
        guard: None,
        company,
    };
    let id = m49c4["id"].as_str().unwrap().to_owned();
    let reply = |text: &str, mode: &str| CommentReply {
        text: text.to_owned(),
        mode: mode.to_owned(),
    };
    let r = comments::reply_manually(&ctx, &id, &reply(" Cảm ơn bạn ", "public"), Some(user), now)
        .await
        .unwrap();
    assert_eq!((r["status"].as_str(), r["answered"].as_bool()), (Some("replied"), Some(true)));
    assert_eq!(r["actions"]["manual"][0]["text"], "Cảm ơn bạn");
    assert_eq!(r["actions"]["manual"][0]["id"], "m49reply");
    let r = comments::reply_manually(&ctx, &id, &reply("Nhắn riêng nhé", "private"), Some(user), now)
        .await
        .unwrap();
    assert_eq!(r["actions"]["manual"].as_array().unwrap().len(), 2);
    let again = comments::reply_manually(&ctx, &id, &reply("lần hai", "private"), Some(user), now).await;
    assert!(again.is_err(), "Facebook chỉ cho nhắn riêng một lần mỗi bình luận");
    // Quá 7 ngày: nhắn riêng bị từ chối, công khai vẫn được.
    let late = now + chrono::Duration::days(8);
    let c3 = open.iter().find(|v| v["status"] == "test").unwrap()["id"].as_str().unwrap().to_owned();
    assert!(comments::reply_manually(&ctx, &c3, &reply("x", "private"), None, late).await.is_err());
    assert!(comments::reply_manually(&ctx, &c3, &reply("x", "public"), None, late).await.is_ok());
    // id không phải số ⇒ 404; nội dung trống ⇒ 400.
    assert!(comments::reply_manually(&ctx, "abc", &reply("x", "public"), None, now).await.is_err());
    assert!(comments::reply_manually(&ctx, &id, &reply("   ", "public"), None, now).await.is_err());

    // ── Luật: thử luật, sửa, xoá ──
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let dry = comments::dry_run(
        &mut c,
        &DryRunInput::from_json(&json!({ "message": "xin giá 0912 490 002", "page_id": "m49p", "from_name": "Lan" })).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(dry["matched_rule"]["name"], "m49 giá");
    assert_eq!(dry["phone_found"], "0912490002");
    assert_eq!(dry["actions"]["public_reply"]["text"], "Chào Lan!");
    assert_eq!(dry["actions"]["hide"], json!({}));
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE page_id = 'm49p'").await, 4, "không ghi gì");
    let upd = comments::update_rule(
        &mut c,
        r1.id,
        &rule_body(json!({ "is_active": false, "position": 5, "private_reply": null })),
    )
    .await
    .unwrap();
    assert_eq!((upd.is_active, upd.position, upd.private_reply), (false, 5, None));
    assert_eq!(upd.name, "m49 giá", "trường không gửi giữ nguyên");
    let dry = comments::dry_run(
        &mut c,
        &DryRunInput::from_json(&json!({ "message": "xin giá", "page_id": "m49p" })).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(dry["matched_rule"], Value::Null, "luật tắt không khớp");
    assert!(
        comments::update_rule(&mut c, 2_000_000_000, &rule_body(json!({ "name": "x" })))
            .await
            .is_err(),
        "không thấy luật ⇒ 404"
    );
    assert!(comments::update_rule(&mut c, r1.id, &rule_body(json!({ "name": null }))).await.is_err());
    assert_eq!(comments::list_rules(&mut c).await.unwrap().iter().filter(|r| r.name.starts_with("m49")).count(), 2);
    comments::delete_rule(&mut c, r1.id).await.unwrap();
    comments::delete_rule(&mut c, r2.id).await.unwrap();
    assert!(comments::delete_rule(&mut c, r2.id).await.is_err());
    // Bình luận đã xử lý giữ nguyên sau khi xoá luật.
    assert_eq!(count(&mut c, "SELECT count(*) FROM facebook_comments WHERE page_id = 'm49p'").await, 4);
    clean(&mut c).await;
}
