//! M34 với Postgres thật và một máy chủ nhận giả: endpoint, outbox → delivery → gửi có chữ ký, thử lại, tự tắt, lease, nhận
//! trùng, chống SSRF.
//!
//! Mỗi test tạo một DB trống riêng (`<DB của TEST_DATABASE_URL>_m34_<ca>_<pid>`) rồi xoá:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_m34 cargo test -p trinity-integrations --test webhooks_pg -- --ignored`

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection, Row};
use trinity_db::outbox::publish_integration_event;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_http::outbound::ssrf::{HostResolver, LookupFuture, SsrfPolicy, SystemResolver};
use trinity_integrations::webhooks::actors::{ActorFuture, ActorProvider};
use trinity_integrations::webhooks::deliveries::{self, DeliveryQuery};
use trinity_integrations::webhooks::dispatcher::{Dispatcher, housekeeping_once};
use trinity_integrations::webhooks::endpoints::{self, CreateEndpoint, EndpointError, UpdateEndpoint};
use trinity_integrations::webhooks::payload::{ActorScopes, Scope};
use trinity_integrations::webhooks::secret::{KeySource, decrypt_secret};
use trinity_integrations::webhooks::sender::Sender;
use trinity_integrations::webhooks::signature::verify_signature_header;
use trinity_integrations::webhooks::worker::{claim, sweep_exhausted};
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const KEY: [u8; 32] = [7; 32];

/// Cột và kiểu như `packages/prisma/prisma/schema.prisma` (chỉ phần M34 dùng).
const SETUP: &str = "
CREATE TABLE integration_audit_logs (
  id bigserial PRIMARY KEY, created_at timestamptz(3) NOT NULL DEFAULT now(), channel varchar(16) NOT NULL,
  client_id varchar(255), user_id int, action varchar(128) NOT NULL, resource varchar(64), resource_id varchar(64),
  status varchar(16) NOT NULL, http_status int, duration_ms int, error varchar(500), metadata jsonb NOT NULL DEFAULT '{}');
CREATE TABLE integration_events (
  id bigserial PRIMARY KEY, event_type varchar(64) NOT NULL, resource varchar(32) NOT NULL, resource_id varchar(64) NOT NULL,
  payload jsonb NOT NULL, actor_user_id int, created_at timestamptz(3) NOT NULL DEFAULT now(), dispatched_at timestamptz(3));
CREATE TABLE webhook_endpoints (
  id serial PRIMARY KEY, name varchar(100) NOT NULL, url varchar(2048) NOT NULL, secret_enc text NOT NULL, events text[] NOT NULL,
  is_active boolean NOT NULL DEFAULT true, disabled_reason varchar(64), created_by int NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),
  last_success_at timestamptz(3), last_failure_at timestamptz(3), consecutive_failures int NOT NULL DEFAULT 0);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint_id int NOT NULL, event_id bigint, event_type varchar(64) NOT NULL,
  payload jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(3) NOT NULL DEFAULT now(), last_status_code int, last_error varchar(255),
  created_at timestamptz(3) NOT NULL DEFAULT now(), delivered_at timestamptz(3));
CREATE UNIQUE INDEX webhook_deliveries_endpoint_event_uniq ON webhook_deliveries (endpoint_id, event_id);
CREATE TABLE webhook_inbound_receipts (id bigserial PRIMARY KEY, source_id int NOT NULL, external_id varchar(128) NOT NULL, contact_id int, created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE notification_logs (
  id serial PRIMARY KEY, recipient_id int NOT NULL, event_type varchar(64) NOT NULL, channel varchar(32) NOT NULL, title text NOT NULL,
  body text NOT NULL, status varchar(16) NOT NULL, sent_at timestamptz, action_url text);
CREATE TABLE _prisma_migrations (id serial PRIMARY KEY, migration_name varchar(255) NOT NULL, finished_at timestamptz, rolled_back_at timestamptz);
INSERT INTO _prisma_migrations (migration_name, finished_at) VALUES ('9998_gia', now());
";

fn base_url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

fn url_for(db: &str) -> String {
    let base = base_url();
    let (head, query) = base
        .split_once('?')
        .map_or((base.as_str(), None), |(h, q)| (h, Some(q)));
    let (server, _) = head.rsplit_once('/').expect("URL có tên DB");
    query.map_or_else(|| format!("{server}/{db}"), |q| format!("{server}/{db}?{q}"))
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

struct TestDb {
    name: String,
    url: String,
    db: Db,
}

impl TestDb {
    async fn new(case: &str) -> Self {
        let base = base_url();
        let dbname = base
            .split_once('?')
            .map_or(base.as_str(), |(h, _)| h)
            .rsplit_once('/')
            .map(|(_, d)| d.to_owned())
            .unwrap();
        let name = format!("{dbname}_m34_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        exec(&mut PgConnection::connect(&url).await.unwrap(), SETUP).await;
        let mut cfg = DbConfig::new(url.clone());
        cfg.pool_size = 8;
        cfg.acquire_timeout = Duration::from_secs(10);
        cfg.required_migration = "9998_gia".to_owned();
        Self {
            name,
            url,
            db: Db::connect_lazy(&cfg).unwrap(),
        }
    }
    async fn conn(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.unwrap()
    }
    async fn tenant(&self) -> TenantDb {
        self.db.tenant(CompanyRef::new(1).unwrap()).await.unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let name = self.name.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(mut admin) = PgConnection::connect(&base_url()).await {
                    let _ = sqlx::raw_sql(AssertSqlSafe(format!(
                        "DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"
                    )))
                    .execute(&mut admin)
                    .await;
                }
            });
        })
        .join();
    }
}

fn key_source() -> KeySource {
    Arc::new(|| Ok(KEY))
}

fn sender(allow_private: bool) -> Sender {
    Sender::new(SsrfPolicy { allow_private }, Arc::new(SystemResolver), key_source()).unwrap()
}

#[derive(Default)]
struct Actors(HashMap<i32, Option<ActorScopes>>);

impl ActorProvider for Actors {
    fn scopes_for<'a>(&'a self, _t: &'a TenantDb, user: i32) -> ActorFuture<'a> {
        let v = self.0.get(&user).cloned().flatten();
        Box::pin(async move { Ok(v) })
    }
}

fn admin_scopes() -> ActorScopes {
    ActorScopes {
        contacts_view: Scope::All,
        deals_view: Scope::All,
        pos_sell: Scope::All,
        phone_full: Scope::None,
        custom_view: Scope::All,
        custom_phone_full: Scope::None,
        ..ActorScopes::default()
    }
}

fn actors(users: &[i32]) -> Box<dyn ActorProvider> {
    Box::new(Actors(users.iter().map(|u| (*u, Some(admin_scopes()))).collect()))
}

async fn mock(status: u16) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(status))
        .mount(&s)
        .await;
    s
}

async fn make_endpoint(c: &mut PgConnection, s: &Sender, url: &str, events: &[&str], user: i32) -> (i32, String) {
    let dto = CreateEndpoint {
        name: "ep".into(),
        url: url.into(),
        events: events.iter().map(|e| (*e).to_owned()).collect(),
    };
    let v = endpoints::create(c, s, &dto, user).await.unwrap();
    (
        i32::try_from(v["id"].as_i64().unwrap()).unwrap(),
        v["secret"].as_str().unwrap().to_owned(),
    )
}

async fn publish(c: &mut PgConnection, ty: &str, payload: &Value, id: i32) {
    publish_integration_event(c, ty, payload, id, Some(1)).await.unwrap();
}

fn contact_payload() -> Value {
    json!({"contact": {"id": 1, "full_name": "Lan", "phone": "0912345678", "assigned_to": 7, "created_by_id": 7}})
}

async fn scalar_i64(c: &mut PgConnection, sql: &str) -> i64 {
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn vong_doi_endpoint_va_chong_ssrf() {
    let t = TestDb::new("ep").await;
    let mut c = t.conn().await;
    let s = sender(false);
    // Production: http và IP nội bộ bị chặn ngay lúc tạo.
    for url in [
        "http://example.com/hook",
        "https://127.0.0.1/hook",
        "https://10.0.0.5/hook",
        "https://169.254.169.254/x",
        "https://a.example.com:8080/x",
    ] {
        let dto = CreateEndpoint {
            name: "x".into(),
            url: url.into(),
            events: vec!["contact.created".into()],
        };
        let r = endpoints::create(&mut c, &s, &dto, 1).await;
        assert!(matches!(r, Err(EndpointError::BadRequest(_))), "{url}: {r:?}");
    }
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM webhook_endpoints").await, 0);
    // Sự kiện sai / rỗng.
    let bad = CreateEndpoint {
        name: "x".into(),
        url: "https://example.com".into(),
        events: vec!["khong.co".into()],
    };
    assert!(matches!(
        endpoints::create(&mut c, &sender(true), &bad, 1).await,
        Err(EndpointError::BadRequest(_))
    ));

    let s = sender(true);
    let m = mock(200).await;
    let url = format!("{}/hook", m.uri());
    let (id, secret) = make_endpoint(&mut c, &s, &url, &["contact.created", "deal.won"], 1).await;
    assert!(secret.starts_with("whsec_"));
    // Secret chỉ trong phản hồi tạo; đọc lại thì không có `secret`/`secret_enc`.
    let v = endpoints::get(&mut c, id).await.unwrap();
    assert!(v.get("secret").is_none() && v.get("secret_enc").is_none());
    assert_eq!(v["secret_set"], true);
    assert_eq!(v["events"], json!(["contact.created", "deal.won"]));
    let enc: String = sqlx::query_scalar("SELECT secret_enc FROM webhook_endpoints WHERE id = $1")
        .bind(id)
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(decrypt_secret(&enc, &KEY).unwrap(), secret);
    assert_eq!(audit_actions(&mut c).await, ["endpoint.created"]);

    // Tối đa 20 endpoint.
    for _ in 1..20 {
        make_endpoint(&mut c, &s, &url, &["deal.won"], 1).await;
    }
    let over = CreateEndpoint {
        name: "x".into(),
        url: url.clone(),
        events: vec!["deal.won".into()],
    };
    assert!(
        matches!(endpoints::create(&mut c, &s, &over, 1).await, Err(EndpointError::BadRequest(m)) if m.contains("20"))
    );
    assert_eq!(endpoints::list(&mut c).await.unwrap().len(), 20);

    // Đổi sự kiện / tên KHÔNG chuyển chủ thể; đổi URL bởi người khác thì chuyển và huỷ việc chờ.
    exec(&mut c, &format!("INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload) VALUES ({id}, 1, 'deal.won', '{{}}')")).await;
    let r = endpoints::update(
        &mut c,
        &s,
        id,
        &UpdateEndpoint {
            name: Some("moi".into()),
            events: Some(vec!["deal.won".into()]),
            ..Default::default()
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!((r["created_by"].clone(), r["name"].clone()), (json!(1), json!("moi")));
    assert_eq!(
        scalar_i64(
            &mut c,
            &format!("SELECT count(*) FROM webhook_deliveries WHERE endpoint_id = {id} AND status = 'pending'")
        )
        .await,
        1
    );
    let m2 = mock(200).await;
    let new_url = format!("{}/khac", m2.uri());
    let r = endpoints::update(
        &mut c,
        &s,
        id,
        &UpdateEndpoint {
            url: Some(new_url.clone()),
            ..Default::default()
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!((r["created_by"].clone(), r["url"].clone()), (json!(2), json!(new_url)));
    let st: (String, Option<String>) =
        sqlx::query_as("SELECT status, last_error FROM webhook_deliveries WHERE endpoint_id = $1")
            .bind(id)
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(st, ("dead".to_owned(), Some("endpoint_changed".to_owned())));
    // Cùng URL (đã chuẩn hoá) bởi người khác: không chuyển chủ.
    let r = endpoints::update(
        &mut c,
        &s,
        id,
        &UpdateEndpoint {
            url: Some(new_url),
            ..Default::default()
        },
        3,
    )
    .await
    .unwrap();
    assert_eq!(r["created_by"], 2);
    // Tắt tay rồi bật lại xoá lý do và bộ đếm.
    let r = endpoints::update(
        &mut c,
        &s,
        id,
        &UpdateEndpoint {
            is_active: Some(false),
            ..Default::default()
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!(
        (r["is_active"].clone(), r["disabled_reason"].clone()),
        (json!(false), json!("manual"))
    );
    exec(
        &mut c,
        &format!("UPDATE webhook_endpoints SET consecutive_failures = 5 WHERE id = {id}"),
    )
    .await;
    let r = endpoints::update(
        &mut c,
        &s,
        id,
        &UpdateEndpoint {
            is_active: Some(true),
            ..Default::default()
        },
        2,
    )
    .await
    .unwrap();
    assert_eq!(
        (r["disabled_reason"].clone(), r["consecutive_failures"].clone()),
        (Value::Null, json!(0))
    );

    // Xoay secret: secret mới giải mã được, khác cũ.
    let r = endpoints::rotate_secret(&mut c, &s, id, 2).await.unwrap();
    let new_secret = r["secret"].as_str().unwrap().to_owned();
    assert_ne!(new_secret, secret);
    let enc: String = sqlx::query_scalar("SELECT secret_enc FROM webhook_endpoints WHERE id = $1")
        .bind(id)
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(decrypt_secret(&enc, &KEY).unwrap(), new_secret);

    // 404 và xoá kèm delivery.
    assert!(matches!(
        endpoints::get(&mut c, 999_999).await,
        Err(EndpointError::NotFound(_))
    ));
    endpoints::remove(&mut c, id, 2).await.unwrap();
    assert_eq!(
        scalar_i64(
            &mut c,
            &format!("SELECT count(*) FROM webhook_deliveries WHERE endpoint_id = {id}")
        )
        .await,
        0
    );
    assert!(matches!(
        endpoints::remove(&mut c, id, 2).await,
        Err(EndpointError::NotFound(_))
    ));
    let _ = (m, m2);
}

async fn audit_actions(c: &mut PgConnection) -> Vec<String> {
    sqlx::query("SELECT action FROM integration_audit_logs ORDER BY id")
        .fetch_all(&mut *c)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get("action"))
        .collect()
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn khoa_thieu_thi_503_khong_tao() {
    let t = TestDb::new("key").await;
    let mut c = t.conn().await;
    let no_key: KeySource = Arc::new(|| {
        Err(trinity_integrations::webhooks::secret::KeyError(
            "INTEGRATIONS_SECRET_KEY chưa được cấu hình (cần 32 byte base64)".into(),
        ))
    });
    let s = Sender::new(SsrfPolicy { allow_private: true }, Arc::new(SystemResolver), no_key).unwrap();
    let dto = CreateEndpoint {
        name: "x".into(),
        url: "https://example.com".into(),
        events: vec!["deal.won".into()],
    };
    let e = endpoints::create(&mut c, &s, &dto, 1).await.unwrap_err();
    assert_eq!(e.http_status(), 503);
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM webhook_endpoints").await, 0);
    // Dispatcher tạm dừng, không đụng outbox.
    publish(&mut c, "contact.created", &contact_payload(), 1).await;
    let d = Dispatcher::new(s, actors(&[1]));
    d.tick(&t.tenant().await, true).await.unwrap();
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM integration_events WHERE dispatched_at IS NULL"
        )
        .await,
        1
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn outbox_den_delivery_gui_co_chu_ky_va_che_sdt() {
    let t = TestDb::new("e2e").await;
    let mut c = t.conn().await;
    let s = sender(true);
    let m = mock(200).await;
    let (id, secret) = make_endpoint(&mut c, &s, &format!("{}/hook", m.uri()), &["contact.created"], 1).await;
    let (id_other, _) = make_endpoint(&mut c, &s, &format!("{}/hook2", m.uri()), &["deal.won"], 1).await;
    publish(&mut c, "contact.created", &contact_payload(), 1).await;
    publish(
        &mut c,
        "deal.won",
        &json!({"deal": {"id": 1, "title": "t", "assigned_to": 7, "created_by": 7}}),
        1,
    )
    .await;
    // Sự kiện có trước khi endpoint tồn tại bị bỏ qua.
    exec(&mut c, "INSERT INTO integration_events (event_type, resource, resource_id, payload, created_at) VALUES ('contact.created','contact','9','{}', now() - interval '1 hour')").await;

    let d = Dispatcher::new(s, actors(&[1]));
    let tenant = t.tenant().await;
    d.tick(&tenant, true).await.unwrap();
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM integration_events WHERE dispatched_at IS NULL"
        )
        .await,
        0
    );
    let rows = sqlx::query(
        "SELECT endpoint_id, status, attempts, last_status_code FROM webhook_deliveries ORDER BY endpoint_id",
    )
    .fetch_all(&mut c)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    for r in &rows {
        assert_eq!(
            (
                r.get::<String, _>("status"),
                r.get::<i32, _>("attempts"),
                r.get::<Option<i32>, _>("last_status_code")
            ),
            ("success".to_owned(), 1, Some(200))
        );
    }
    assert_eq!(
        scalar_i64(
            &mut c,
            &format!("SELECT consecutive_failures::bigint FROM webhook_endpoints WHERE id = {id}")
        )
        .await,
        0
    );
    assert!(
        sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
            "SELECT last_success_at FROM webhook_endpoints WHERE id = $1"
        )
        .bind(id)
        .fetch_one(&mut c)
        .await
        .unwrap()
        .is_some()
    );

    // Máy nhận thấy đúng header, thân ký đúng, SĐT bị che (chủ thể không có phone_full).
    let reqs = m.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 2);
    let r = reqs.iter().find(|r| r.url.path() == "/hook").unwrap();
    let h = |n: &str| {
        r.headers
            .get(n)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default()
    };
    assert_eq!(
        (h("content-type"), h("user-agent"), h("x-trinity-event")),
        (
            "application/json".to_owned(),
            "Trinity-Webhooks/1.0".to_owned(),
            "contact.created".to_owned()
        )
    );
    let body: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(h("x-trinity-delivery"), body["id"].as_str().unwrap());
    assert_eq!(body["type"], "contact.created");
    assert_eq!(body["data"]["contact"]["phone"], "***678");
    assert!(body["created_at"].as_str().unwrap().ends_with('Z'));
    assert!(
        String::from_utf8_lossy(&r.body).starts_with("{\"id\":"),
        "thứ tự khoá như Node"
    );
    let now_ms = chrono::Utc::now().timestamp_millis();
    assert!(verify_signature_header(
        &secret,
        &r.body,
        Some(&h("x-trinity-signature")),
        300,
        now_ms
    ));
    assert!(!verify_signature_header(
        "whsec_sai",
        &r.body,
        Some(&h("x-trinity-signature")),
        300,
        now_ms
    ));
    // Nhật ký gửi: không có URL, không có thân.
    let a = sqlx::query("SELECT action, status, user_id, resource, resource_id, http_status, metadata FROM integration_audit_logs WHERE action = 'contact.created'").fetch_one(&mut c).await.unwrap();
    assert_eq!(
        (
            a.get::<String, _>("status"),
            a.get::<Option<i32>, _>("user_id"),
            a.get::<Option<i32>, _>("http_status")
        ),
        ("ok".to_owned(), Some(1), Some(200))
    );
    assert_eq!(a.get::<Option<String>, _>("resource_id"), Some(id.to_string()));
    assert!(!a.get::<Value, _>("metadata").to_string().contains("http://"));
    let _ = id_other;

    // Chạy lại: không tạo thêm, không gửi lại.
    d.tick(&tenant, true).await.unwrap();
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM webhook_deliveries").await, 2);
    assert_eq!(m.received_requests().await.unwrap().len(), 2);

    // Danh sách: không có payload; trang 2 với con trỏ.
    let (page1, next) = deliveries::list(
        &mut c,
        &DeliveryQuery {
            limit: Some(1),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(page1.len(), 1);
    assert!(page1[0].get("payload").is_none());
    let (page2, next2) = deliveries::list(
        &mut c,
        &DeliveryQuery {
            limit: Some(1),
            cursor: next,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!((page2.len(), next2), (1, None));
    assert_ne!(page1[0]["id"], page2[0]["id"]);
    let (only, _) = deliveries::list(
        &mut c,
        &DeliveryQuery {
            endpoint_id: Some(id),
            status: Some("success".into()),
            event_type: Some("contact.created".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(only.len(), 1);
    assert!(matches!(
        deliveries::list(
            &mut c,
            &DeliveryQuery {
                cursor: Some("rac".into()),
                ..Default::default()
            }
        )
        .await,
        Err(deliveries::DeliveryError::InvalidCursor)
    ));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn loi_thu_lai_het_luot_chet_va_tu_tat() {
    let t = TestDb::new("retry").await;
    let mut c = t.conn().await;
    let s = sender(true);
    let m = mock(500).await;
    let (id, _) = make_endpoint(&mut c, &s, &format!("{}/hook", m.uri()), &["contact.created"], 1).await;
    publish(&mut c, "contact.created", &contact_payload(), 1).await;
    let d = Dispatcher::new(s, actors(&[1]));
    let tenant = t.tenant().await;
    let expected_delay_min = [1, 5, 30, 120, 360, 720];
    for (i, mins) in expected_delay_min.iter().enumerate() {
        d.tick(&tenant, true).await.unwrap();
        let r = sqlx::query("SELECT status, attempts, last_error, last_status_code, extract(epoch FROM next_attempt_at - now())::float8 AS wait FROM webhook_deliveries").fetch_one(&mut c).await.unwrap();
        assert_eq!(
            (r.get::<String, _>("status"), r.get::<i32, _>("attempts")),
            ("failed".to_owned(), i32::try_from(i + 1).unwrap()),
            "lượt {}",
            i + 1
        );
        assert_eq!(
            (
                r.get::<Option<String>, _>("last_error"),
                r.get::<Option<i32>, _>("last_status_code")
            ),
            (Some("http_500".to_owned()), Some(500))
        );
        let wait = r.get::<f64, _>("wait");
        let want = f64::from(*mins) * 60.0;
        assert!((want - 5.0..=want + 1.0).contains(&wait), "chờ {wait}s, cần ~{want}s");
        // Chưa đến hạn thì không gửi lại.
        d.tick(&tenant, true).await.unwrap();
        assert_eq!(m.received_requests().await.unwrap().len(), i + 1);
        exec(&mut c, "UPDATE webhook_deliveries SET next_attempt_at = now()").await;
    }
    d.tick(&tenant, true).await.unwrap();
    let r = sqlx::query("SELECT status, attempts FROM webhook_deliveries")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(
        (r.get::<String, _>("status"), r.get::<i32, _>("attempts")),
        ("dead".to_owned(), 7)
    );
    assert_eq!(m.received_requests().await.unwrap().len(), 7, "tối đa 7 lần gửi");
    assert_eq!(
        scalar_i64(
            &mut c,
            &format!("SELECT consecutive_failures::bigint FROM webhook_endpoints WHERE id = {id}")
        )
        .await,
        7
    );

    // Tự tắt khi lỗi liên tiếp 20 lần: thông báo cho người tạo, việc chờ chuyển dead.
    exec(
        &mut c,
        &format!("UPDATE webhook_endpoints SET consecutive_failures = 19 WHERE id = {id}"),
    )
    .await;
    publish(&mut c, "contact.created", &contact_payload(), 2).await;
    exec(&mut c, "INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload) VALUES (%ID%, 777, 'contact.created', '{}')".replace("%ID%", &id.to_string()).as_str()).await;
    d.tick(&tenant, true).await.unwrap();
    let ep =
        sqlx::query("SELECT is_active, disabled_reason, consecutive_failures FROM webhook_endpoints WHERE id = $1")
            .bind(id)
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(
        (
            ep.get::<bool, _>("is_active"),
            ep.get::<Option<String>, _>("disabled_reason")
        ),
        (false, Some("consecutive_failures".to_owned()))
    );
    assert_eq!(
        scalar_i64(
            &mut c,
            "SELECT count(*) FROM webhook_deliveries WHERE status IN ('pending', 'failed')"
        )
        .await,
        0
    );
    let n = sqlx::query("SELECT recipient_id, event_type, channel, status, action_url, body FROM notification_logs")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(
        (
            n.get::<i32, _>("recipient_id"),
            n.get::<String, _>("event_type"),
            n.get::<String, _>("channel")
        ),
        (1, "webhook_endpoint_disabled".to_owned(), "in_app".to_owned())
    );
    assert_eq!(
        n.get::<Option<String>, _>("action_url").as_deref(),
        Some("/connections?muc=webhook-out")
    );
    assert!(n.get::<String, _>("body").contains("lỗi liên tiếp 20 lần"));
    // Tắt rồi: tick tiếp không gửi gì và không thông báo lần hai.
    let before = m.received_requests().await.unwrap().len();
    d.tick(&tenant, true).await.unwrap();
    assert_eq!(m.received_requests().await.unwrap().len(), before);
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM notification_logs").await, 1);
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn chu_the_mat_quyen_thi_tat_endpoint_va_khong_gui() {
    let t = TestDb::new("actor").await;
    let mut c = t.conn().await;
    let s = sender(true);
    let m = mock(200).await;
    let (id, _) = make_endpoint(&mut c, &s, &format!("{}/hook", m.uri()), &["contact.created"], 5).await;
    publish(&mut c, "contact.created", &contact_payload(), 1).await;
    // Chủ thể 5 không còn đủ điều kiện.
    let d = Dispatcher::new(s, Box::new(Actors(HashMap::from([(5, None)]))));
    d.tick(&t.tenant().await, true).await.unwrap();
    assert!(m.received_requests().await.unwrap().is_empty());
    let r = sqlx::query("SELECT is_active, disabled_reason FROM webhook_endpoints WHERE id = $1")
        .bind(id)
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(
        (
            r.get::<bool, _>("is_active"),
            r.get::<Option<String>, _>("disabled_reason")
        ),
        (false, Some("creator_unauthorized".to_owned()))
    );
    assert_eq!(scalar_i64(&mut c, "SELECT count(*) FROM webhook_deliveries").await, 0);
    let n = sqlx::query("SELECT recipient_id, body FROM notification_logs")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(n.get::<i32, _>("recipient_id"), 5);
    assert!(n.get::<String, _>("body").contains("không còn quyền"));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn quyen_doi_giua_chung_viec_cho_chet_no_longer_visible() {
    let t = TestDb::new("vis").await;
    let mut c = t.conn().await;
    let s = sender(true);
    let m = mock(200).await;
    let (id, _) = make_endpoint(&mut c, &s, &format!("{}/hook", m.uri()), &["contact.created"], 1).await;
    // Delivery đã dựng, nhưng giờ chủ thể chỉ xem được khách của người 99.
    exec(&mut c, &format!("INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload) VALUES ({id}, 1, 'contact.created', '{}')", contact_payload())).await;
    let narrow = ActorScopes {
        contacts_view: Scope::Owners(vec![99]),
        ..admin_scopes()
    };
    let d = Dispatcher::new(s, Box::new(Actors(HashMap::from([(1, Some(narrow))]))));
    d.tick(&t.tenant().await, true).await.unwrap();
    assert!(m.received_requests().await.unwrap().is_empty());
    let r = sqlx::query("SELECT status, last_error FROM webhook_deliveries")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(
        (r.get::<String, _>("status"), r.get::<Option<String>, _>("last_error")),
        ("dead".to_owned(), Some("no_longer_visible".to_owned()))
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn nhan_viec_khong_trung_lease_va_tran_tuyet_doi() {
    let t = TestDb::new("claim").await;
    let mut c = t.conn().await;
    let s = sender(true);
    let (id, _) = make_endpoint(&mut c, &s, "http://127.0.0.1:9/x", &["contact.created"], 1).await;
    exec(&mut c, &format!("INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload) SELECT {id}, g, 'contact.created', '{{}}' FROM generate_series(1, 100) g")).await;
    // 4 tiến trình nhận cùng lúc: mỗi việc đúng một lần.
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let url = t.url.clone();
        tasks.push(tokio::spawn(async move {
            let mut conn = PgConnection::connect(&url).await.unwrap();
            let mut got = Vec::new();
            loop {
                let rows = claim(&mut conn, 7).await.unwrap();
                if rows.is_empty() {
                    break;
                }
                got.extend(rows.into_iter().map(|r| r.id));
            }
            got
        }));
    }
    let mut all = Vec::new();
    for h in tasks {
        all.extend(h.await.unwrap());
    }
    assert_eq!(all.len(), 100);
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 100, "không việc nào được nhận hai lần");
    assert!(claim(&mut c, 10).await.unwrap().is_empty(), "đang trong lease");
    // Lease hết (crash trước khi ghi kết quả) ⇒ nhận lại, attempts tăng.
    exec(
        &mut c,
        "UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'",
    )
    .await;
    let again = claim(&mut c, 200).await.unwrap();
    assert_eq!(again.len(), 100);
    assert!(again.iter().all(|r| r.attempts == 2));
    // Tới lượt thứ 7 mà vẫn không ghi kết quả: không nhận nữa, quét sang dead.
    exec(
        &mut c,
        "UPDATE webhook_deliveries SET attempts = 7, next_attempt_at = now() - interval '1 second'",
    )
    .await;
    assert!(claim(&mut c, 10).await.unwrap().is_empty());
    assert_eq!(sweep_exhausted(&mut c).await.unwrap(), 100);
    let r = sqlx::query("SELECT status, last_error FROM webhook_deliveries LIMIT 1")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(
        (r.get::<String, _>("status"), r.get::<Option<String>, _>("last_error")),
        ("dead".to_owned(), Some("attempts_exhausted".to_owned()))
    );
    // Endpoint tắt thì không nhận việc của nó.
    exec(&mut c, &format!("INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload) VALUES ({id}, 500, 'contact.created', '{{}}'); UPDATE webhook_endpoints SET is_active = false")).await;
    assert!(claim(&mut c, 10).await.unwrap().is_empty());
}

struct Rebind;
impl HostResolver for Rebind {
    fn lookup<'a>(&'a self, host: &'a str) -> LookupFuture<'a> {
        let _ = host;
        Box::pin(async { Ok(vec!["127.0.0.1".parse().unwrap()]) })
    }
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn chan_ssrf_luc_gui_ke_ca_dns_tro_ve_noi_bo() {
    let t = TestDb::new("ssrf").await;
    let mut c = t.conn().await;
    // Endpoint đã lưu (qua đường cấu hình thoáng), nhưng lúc gửi chính sách production.
    let s_open = sender(true);
    let m = mock(200).await;
    let (id, _) = make_endpoint(&mut c, &s_open, &format!("{}/hook", m.uri()), &["contact.created"], 1).await;
    exec(
        &mut c,
        &format!("UPDATE webhook_endpoints SET url = 'https://evil.example.com/x' WHERE id = {id}"),
    )
    .await;
    publish(&mut c, "contact.created", &contact_payload(), 1).await;
    // Tên miền công khai giả nhưng DNS trả 127.0.0.1 (rebinding): bị chặn trước khi nối.
    let s = Sender::new(SsrfPolicy { allow_private: false }, Arc::new(Rebind), key_source()).unwrap();
    let d = Dispatcher::new(s, actors(&[1]));
    d.tick(&t.tenant().await, true).await.unwrap();
    assert!(m.received_requests().await.unwrap().is_empty());
    let r = sqlx::query("SELECT status, last_error, last_status_code FROM webhook_deliveries")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(
        (
            r.get::<String, _>("status"),
            r.get::<Option<String>, _>("last_error"),
            r.get::<Option<i32>, _>("last_status_code")
        ),
        ("failed".to_owned(), Some("blocked_target".to_owned()), None)
    );
    // Lỗi trả về không lộ URL hay IP.
    let a: Option<String> = sqlx::query_scalar("SELECT error FROM integration_audit_logs ORDER BY id DESC LIMIT 1")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert_eq!(a.as_deref(), Some("blocked_target"));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn gui_thu_ping_dong_bo_va_gui_lai() {
    let t = TestDb::new("ping").await;
    let mut c = t.conn().await;
    let s = sender(true);
    let ok = mock(200).await;
    let (id, secret) = make_endpoint(&mut c, &s, &format!("{}/hook", ok.uri()), &["contact.created"], 1).await;
    let r = endpoints::test(&mut c, &s, id, 1).await.unwrap();
    assert_eq!(
        (r["ok"].clone(), r["status_code"].clone(), r["error"].clone()),
        (json!(true), json!(200), Value::Null)
    );
    let req = &ok.received_requests().await.unwrap()[0];
    let body: Value = serde_json::from_slice(&req.body).unwrap();
    assert_eq!(
        (body["type"].clone(), body["data"].clone()),
        (json!("ping"), json!({"message": "Trinity webhook test"}))
    );
    assert!(verify_signature_header(
        &secret,
        &req.body,
        req.headers.get("x-trinity-signature").map(|v| v.to_str().unwrap()),
        300,
        chrono::Utc::now().timestamp_millis()
    ));
    let ping: (String, i32) =
        sqlx::query_as("SELECT status, attempts FROM webhook_deliveries WHERE event_type = 'ping'")
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(ping, ("success".to_owned(), 1));
    // Ping không tính vào bộ đếm lỗi liên tiếp và worker không nhận.
    assert!(claim(&mut c, 10).await.unwrap().is_empty());
    let ping_id: String = sqlx::query_scalar("SELECT id::text FROM webhook_deliveries WHERE event_type = 'ping'")
        .fetch_one(&mut c)
        .await
        .unwrap();
    assert!(matches!(
        endpoints::retry_delivery(&mut c, &ping_id, 1).await,
        Err(EndpointError::BadRequest(_))
    ));

    // Lỗi phía nhận: ping thất bại ghi dead, KHÔNG tăng consecutive_failures.
    let bad = mock(503).await;
    let (id2, _) = make_endpoint(&mut c, &s, &format!("{}/hook", bad.uri()), &["contact.created"], 1).await;
    let r = endpoints::test(&mut c, &s, id2, 1).await.unwrap();
    assert_eq!((r["ok"].clone(), r["error"].clone()), (json!(false), json!("http_503")));
    assert_eq!(
        scalar_i64(
            &mut c,
            &format!("SELECT consecutive_failures::bigint FROM webhook_endpoints WHERE id = {id2}")
        )
        .await,
        0
    );

    // Gửi lại: chỉ lượt failed/dead, endpoint phải bật.
    exec(&mut c, &format!("INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload, status, attempts, last_error) VALUES ({id2}, 1, 'contact.created', '{{}}', 'dead', 7, 'http_500'), ({id2}, 2, 'contact.created', '{{}}', 'success', 1, NULL)")).await;
    let dead_id: String = sqlx::query_scalar(
        "SELECT id::text FROM webhook_deliveries WHERE status = 'dead' AND event_type = 'contact.created'",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    let ok_id: String = sqlx::query_scalar(
        "SELECT id::text FROM webhook_deliveries WHERE status = 'success' AND event_type = 'contact.created'",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    assert!(matches!(
        endpoints::retry_delivery(&mut c, &ok_id, 1).await,
        Err(EndpointError::Conflict(_))
    ));
    assert!(matches!(
        endpoints::retry_delivery(&mut c, "00000000-0000-4000-8000-000000000000", 1).await,
        Err(EndpointError::NotFound(_))
    ));
    assert!(matches!(
        endpoints::retry_delivery(&mut c, "khong-phai-uuid", 1).await,
        Err(EndpointError::BadRequest(_))
    ));
    exec(
        &mut c,
        &format!("UPDATE webhook_endpoints SET is_active = false WHERE id = {id2}"),
    )
    .await;
    assert!(matches!(
        endpoints::retry_delivery(&mut c, &dead_id, 1).await,
        Err(EndpointError::Conflict(_))
    ));
    exec(
        &mut c,
        &format!("UPDATE webhook_endpoints SET is_active = true WHERE id = {id2}"),
    )
    .await;
    let r = endpoints::retry_delivery(&mut c, &dead_id, 1).await.unwrap();
    assert_eq!(r, json!({"id": dead_id, "status": "pending"}));
    let st: (String, i32, Option<String>) =
        sqlx::query_as("SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = $1::uuid")
            .bind(&dead_id)
            .fetch_one(&mut c)
            .await
            .unwrap();
    assert_eq!(st, ("pending".to_owned(), 0, None));
    let _ = bad;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn don_delivery_cu_va_receipt() {
    let t = TestDb::new("hk").await;
    let mut c = t.conn().await;
    exec(&mut c, "
      INSERT INTO webhook_deliveries (endpoint_id, event_id, event_type, payload, status, created_at) VALUES
        (1, 1, 'x', '{}', 'success', now() - interval '31 days'), (1, 2, 'x', '{}', 'dead', now() - interval '31 days'),
        (1, 3, 'x', '{}', 'success', now() - interval '29 days'), (1, 4, 'x', '{}', 'failed', now() - interval '40 days'),
        (1, 5, 'x', '{}', 'pending', now() - interval '40 days');
      INSERT INTO webhook_inbound_receipts (source_id, external_id, created_at) VALUES (1, 'a', now() - interval '181 days'), (1, 'b', now() - interval '179 days');").await;
    housekeeping_once(&mut c, chrono::Utc::now()).await.unwrap();
    let left: Vec<i64> = sqlx::query("SELECT event_id FROM webhook_deliveries ORDER BY event_id")
        .fetch_all(&mut c)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get("event_id"))
        .collect();
    assert_eq!(left, [3, 4, 5]);
    assert_eq!(
        scalar_i64(&mut c, "SELECT count(*) FROM webhook_inbound_receipts").await,
        1
    );
}
