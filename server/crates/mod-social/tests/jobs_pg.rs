//! Job đăng bài và số liệu trên Postgres thật (`public` đã migrate bằng Prisma) với máy chủ giả Graph (wiremock).
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-social --test jobs_pg -- --ignored`
//! Dữ liệu mang tiền tố `m54b`, tự dọn. Pool chỉ 1 kết nối: nếu job giữ kết nối khi gọi Graph (HTTP) hoặc xin kết nối thứ hai
//! trong lúc đang giữ một, test sẽ treo rồi hết hạn chờ.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mod_channel_guard::ChannelGuard;
use mod_facebook::config::Env;
use mod_facebook::graph::GraphClient;
use mod_social::jobs::{JobDeps, Outcome, Runner};
use mod_social::media::MediaStore;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::webhooks::secret::{encrypt_secret, load_secret_key};
use trinity_storage::LocalDiskDriver;
use wiremock::matchers::{body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

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

async fn clean(c: &mut PgConnection) {
    exec(
        c,
        "DELETE FROM integration_events WHERE event_type LIKE 'social_post.%' \
         AND resource_id IN (SELECT t.id::text FROM social_post_targets t JOIN social_posts p ON p.id = t.post_id \
         WHERE p.content LIKE 'm54b%')",
    )
    .await;
    exec(
        c,
        "DELETE FROM social_post_targets WHERE post_id IN (SELECT id FROM social_posts WHERE content LIKE 'm54b%')",
    )
    .await;
    exec(c, "DELETE FROM social_posts WHERE content LIKE 'm54b%'").await;
    exec(c, "DELETE FROM social_accounts WHERE external_id LIKE 'm54b%'").await;
    exec(c, "DELETE FROM users WHERE email LIKE 'm54b%@test.local'").await;
}

/// `(status, attempts, external_post_id, last_error)` của một kênh.
async fn target_row(c: &mut PgConnection, id: i32) -> (String, i32, Option<String>, Option<String>) {
    sqlx::query_as("SELECT status, attempts, external_post_id, last_error FROM social_post_targets WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn events(c: &mut PgConnection, target: i32, kind: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM integration_events WHERE event_type = $1 AND resource_id = $2")
        .bind(kind)
        .bind(target.to_string())
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

async fn new_target(c: &mut PgConnection, account: i32, user: i32, content: &str, media: &Value) -> (i32, i32) {
    let post: i32 = sqlx::query_scalar(
        "INSERT INTO social_posts (content, media, status, source, created_by, updated_at) \
         VALUES ($1, $2, 'publishing', 'test', $3, now()) RETURNING id",
    )
    .bind(content)
    .bind(media)
    .bind(user)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let target: i32 = sqlx::query_scalar(
        "INSERT INTO social_post_targets (post_id, account_id, network, options, next_attempt_at, updated_at) \
         VALUES ($1, $2, 'facebook', '{}', now() - interval '1 second', now()) RETURNING id",
    )
    .bind(post)
    .bind(account)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    (post, target)
}

fn graph_error(status: u16, code: i64, subcode: Option<i64>) -> ResponseTemplate {
    let mut e = json!({ "message": "loi", "code": code });
    if let Some(s) = subcode {
        e["error_subcode"] = json!(s);
    }
    ResponseTemplate::new(status).set_body_json(json!({ "error": e }))
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn job_dang_bai_va_so_lieu() {
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
    let graph = GraphClient::new(env.clone(), Arc::new(|_| {}));
    let root = std::env::temp_dir().join(format!("m54b-{}", std::process::id()));
    let local = LocalDiskDriver::new(&root);
    local.init().await.unwrap();
    let store = Arc::new(MediaStore::Local(local));
    let runner = Runner::new(JobDeps {
        db: db.clone(),
        platform: platform.clone(),
        env: env.clone(),
        store: Arc::clone(&store),
        guard: ChannelGuard::new(db.clone(), platform.clone()),
        graph_for: Arc::new(move |_| graph.clone()),
        before_publish: None,
        owns_publish: None,
    });
    let key = load_secret_key(&|k: &str| env(k)).unwrap();

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let user = one_i32(
        &mut c,
        "INSERT INTO users (email, password_hash, full_name, status, updated_at) \
         VALUES ('m54ba@test.local', 'x', 'M54b', 'active', now()) RETURNING id",
    )
    .await;
    let account: i32 = sqlx::query_scalar(
        "INSERT INTO social_accounts (network, external_id, name, access_token_enc, scopes, connected_by, status, updated_at) \
         VALUES ('facebook', 'm54bpage', 'Quán M54b', $1, 'pages_manage_posts', $2, 'active', now()) RETURNING id",
    )
    .bind(encrypt_secret("PAGE-TOKEN", &key))
    .bind(user)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    let none = json!([]);
    drop(c); // pool chỉ 1 kết nối: trả lại trước khi gọi hàm của mô-đun

    // 1. Đăng chữ thành công đúng MỘT lần; chạy lại không đăng đôi.
    let feed = Mock::given(method("POST"))
        .and(path("/v25.0/m54bpage/feed"))
        .and(header("authorization", "Bearer PAGE-TOKEN"))
        .and(body_string_contains("m54b chu"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "m54bpage_1" })))
        .expect(1)
        .mount_as_scoped(&server)
        .await;
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let (post1, t1) = new_target(&mut c, account, user, "m54b chu", &none).await;
    drop(c);
    let stats = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((stats.published, stats.failed, stats.retry), (1, 0, 0));
    let again = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((again.published, again.failed, again.retry, again.stale), (0, 0, 0, 0));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let row = target_row(&mut c, t1).await;
    assert_eq!((row.0.as_str(), row.1, row.2.as_deref()), ("published", 1, Some("m54bpage_1")));
    let post_status: String = sqlx::query_scalar("SELECT status FROM social_posts WHERE id = $1")
        .bind(post1)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(post_status, "published");
    assert_eq!(events(&mut c, t1, "social_post.published").await, 1);
    drop(c);
    drop(feed); // kiểm đúng một lần gọi

    // 2. Nhận việc loại trừ nhau: kênh đã nhận thì lần nhận sau không thấy nữa.
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let (_p, t2) = new_target(&mut c, account, user, "m54b nhan", &none).await;
    drop(c);
    assert_eq!(runner.claim(company).await.unwrap(), Some(t2));
    assert_eq!(runner.claim(company).await.unwrap(), None);
    // Đang `publishing` còn hạn thuê ⇒ không bị dọn và không bị đăng.
    let idle = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((idle.published, idle.stale), (0, 0));
    // Hết hạn thuê ⇒ chuyển `failed` kèm câu nhắc, KHÔNG đăng lại (không có lời gọi Graph nào cho nội dung này).
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    exec(&mut c, &format!("UPDATE social_post_targets SET next_attempt_at = now() - interval '1 minute' WHERE id = {t2}")).await;
    drop(c);
    let swept = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((swept.stale, swept.published), (1, 0));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let row = target_row(&mut c, t2).await;
    assert_eq!(row.0, "failed");
    assert!(row.3.unwrap().contains("Bị gián đoạn khi đang đăng"));
    drop(c);

    // 3. Lỗi Graph 500 ⇒ thử lại sau 1 phút, `attempts` giữ nguyên, bài về hàng đợi.
    let flaky = Mock::given(method("POST"))
        .and(path("/v25.0/m54bpage/feed"))
        .and(body_string_contains("m54b tam"))
        .respond_with(graph_error(500, 2, None))
        .mount_as_scoped(&server)
        .await;
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let (_p, t3) = new_target(&mut c, account, user, "m54b tam", &none).await;
    drop(c);
    let r = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((r.published, r.retry), (0, 1));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let row = target_row(&mut c, t3).await;
    assert_eq!((row.0.as_str(), row.1), ("queued", 1));
    assert!(row.3.unwrap().contains("Sẽ tự thử lại sau 1 phút"));
    let wait: f64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM next_attempt_at - now())::float8 FROM social_post_targets WHERE id = $1",
    )
    .bind(t3)
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert!((30.0..=61.0).contains(&wait), "hẹn lại sau ~1 phút, được {wait}");
    // Lượt thứ 5 mà vẫn lỗi ⇒ hết lượt thử: `failed` + sự kiện, không hẹn nữa.
    exec(&mut c, &format!("UPDATE social_post_targets SET attempts = 4, next_attempt_at = now() - interval '1 second' WHERE id = {t3}")).await;
    drop(c);
    let r = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((r.failed, r.retry), (1, 0));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let row = target_row(&mut c, t3).await;
    assert_eq!((row.0.as_str(), row.1), ("failed", 5));
    assert!(row.3.unwrap().contains("Bấm Thử lại để đăng lại"));
    assert_eq!(events(&mut c, t3, "social_post.failed").await, 1);
    drop(c);
    drop(flaky);

    // 4. Token hết hạn (190) ⇒ kênh `reauth`, không thử lại.
    let expired = Mock::given(method("POST"))
        .and(path("/v25.0/m54bpage/feed"))
        .and(body_string_contains("m54b token"))
        .respond_with(graph_error(400, 190, None))
        .mount_as_scoped(&server)
        .await;
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let (_p, t4) = new_target(&mut c, account, user, "m54b token", &none).await;
    drop(c);
    let r = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!((r.failed, r.retry), (1, 0));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    assert_eq!(target_row(&mut c, t4).await.0, "failed");
    let acc_status: String = sqlx::query_scalar("SELECT status FROM social_accounts WHERE id = $1")
        .bind(account)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(acc_status, "reauth");
    // Kênh cần liên kết lại ⇒ bài kế tiếp báo lỗi ngay, không gọi Graph.
    let (_p, t5) = new_target(&mut c, account, user, "m54b sau reauth", &none).await;
    drop(c);
    let outcome = runner.process_one(company, t5).await.unwrap();
    assert_eq!(outcome, Outcome::Failed);
    drop(expired);
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    exec(&mut c, &format!("UPDATE social_accounts SET status = 'active' WHERE id = {account}")).await;
    drop(c);

    // 5. Video tải theo phiên, đọc từng phần từ kho (không đọc cả tệp vào RAM).
    store.put_bytes("social/u1_1_m54b01.mp4", b"abcd", "video/mp4").await.unwrap();
    let media = json!([{ "key": "social/u1_1_m54b01.mp4", "type": "video", "content_type": "video/mp4", "size": 4 }]);
    let start = Mock::given(method("POST"))
        .and(path("/v25.0/m54bpage/videos"))
        .and(body_string_contains("name=\"upload_phase\"\r\n\r\nstart"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "upload_session_id": "S1", "video_id": "V1", "start_offset": "0", "end_offset": "4"
        })))
        .expect(1)
        .mount_as_scoped(&server)
        .await;
    let transfer = Mock::given(method("POST"))
        .and(path("/v25.0/m54bpage/videos"))
        .and(body_string_contains("name=\"upload_phase\"\r\n\r\ntransfer"))
        .and(body_string_contains("abcd"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "start_offset": "4", "end_offset": "4" })))
        .expect(1)
        .mount_as_scoped(&server)
        .await;
    let finish = Mock::given(method("POST"))
        .and(path("/v25.0/m54bpage/videos"))
        .and(body_string_contains("name=\"upload_phase\"\r\n\r\nfinish"))
        .and(body_string_contains("name=\"description\"\r\n\r\nm54b video"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "success": true })))
        .expect(1)
        .mount_as_scoped(&server)
        .await;
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let (_p, t6) = new_target(&mut c, account, user, "m54b video", &media).await;
    drop(c);
    let r = runner.run_due(company, Duration::from_secs(50)).await.unwrap();
    assert_eq!(r.published, 1);
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let row = target_row(&mut c, t6).await;
    assert_eq!((row.0.as_str(), row.2.as_deref()), ("published", Some("V1")));
    let url: String = sqlx::query_scalar("SELECT url FROM social_post_targets WHERE id = $1")
        .bind(t6)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(url, "https://www.facebook.com/m54bpage/videos/V1");
    drop(c);
    drop((start, transfer, finish));

    // 6. Số liệu: bài còn thì lưu số; bài bị xoá trên mạng (100/33) hiện là đã xoá và thôi lấy số.
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    exec(
        &mut c,
        &format!(
            "UPDATE social_post_targets SET external_post_id = 'm54bpage_live', published_at = now(), metrics_at = NULL WHERE id = {t1}"
        ),
    )
    .await;
    let (_p, gone) = new_target(&mut c, account, user, "m54b da xoa", &none).await;
    exec(
        &mut c,
        &format!(
            "UPDATE social_post_targets SET status = 'published', external_post_id = 'm54bpage_gone', published_at = now() WHERE id = {gone}"
        ),
    )
    .await;
    drop(c);
    let live = Mock::given(method("GET"))
        .and(path("/v25.0/m54bpage_live"))
        .and(query_param("fields", "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "reactions": { "summary": { "total_count": 12 } },
            "comments": { "summary": { "total_count": 3 } }
        })))
        .mount_as_scoped(&server)
        .await;
    // Video (id số): lượt xem; không có `post_id` nên không có số tương tác.
    let video_views = Mock::given(method("GET"))
        .and(path("/v25.0/V1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "views": 7 })))
        .mount_as_scoped(&server)
        .await;
    let removed = Mock::given(method("GET"))
        .and(path("/v25.0/m54bpage_gone"))
        .respond_with(graph_error(400, 100, Some(33)))
        .expect(1)
        .mount_as_scoped(&server)
        .await;
    let now = chrono::Utc::now().timestamp_millis();
    let m = runner
        .refresh_metrics_due(company, Duration::from_secs(30), now)
        .await
        .unwrap();
    assert_eq!((m.updated, m.failed), (2, 1));
    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    let live_metrics: Value = sqlx::query_scalar("SELECT metrics FROM social_post_targets WHERE id = $1")
        .bind(t1)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(live_metrics, json!({ "views": null, "reactions": 12, "comments": 3, "shares": 0 }));
    let gone_metrics: Value = sqlx::query_scalar("SELECT metrics FROM social_post_targets WHERE id = $1")
        .bind(gone)
        .fetch_one(&mut *c)
        .await
        .unwrap();
    assert_eq!(gone_metrics["removed"], json!(true));
    drop(c);
    // Chạy lại cách 2 giờ: bài đã xoá không gọi mạng nữa (mock `expect(1)` giữ nguyên), hai bài còn lấy lại khi tới hạn.
    let later = runner
        .refresh_metrics_due(company, Duration::from_secs(30), now + 2 * 3_600_000)
        .await
        .unwrap();
    assert_eq!((later.updated, later.failed), (2, 0));
    drop((live, removed, video_views));

    let mut c = db.tenant(company).await.unwrap().acquire().await.unwrap();
    clean(&mut c).await;
    let _ = std::fs::remove_dir_all(&root);
}
