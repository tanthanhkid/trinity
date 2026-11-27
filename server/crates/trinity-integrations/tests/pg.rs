//! M33 với Postgres thật: nhật ký (ghi, lọc, trang 2 với khoá trùng, cursor chéo), job dọn outbox và OAuth.
//!
//! Mỗi test tạo một DB trống riêng (`<DB của TEST_DATABASE_URL>_m33_<ca>_<pid>`) rồi xoá:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_m33 cargo test -p trinity-integrations --test pg -- --ignored`

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection, Row};
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_integrations::audit::{self, AuditEntry, AuditQuery, AuditStatus, Channel};
use trinity_integrations::purge::{self, JOB_OAUTH_PURGE, JOB_OUTBOX_PURGE};

/// Cột và kiểu như `server/prisma/schema.prisma` (chỉ phần M33 dùng).
const SETUP: &str = "
CREATE TABLE integration_audit_logs (
  id bigserial PRIMARY KEY, created_at timestamptz(3) NOT NULL DEFAULT now(), channel varchar(16) NOT NULL,
  client_id varchar(255), user_id int, action varchar(128) NOT NULL, resource varchar(64), resource_id varchar(64),
  status varchar(16) NOT NULL, http_status int, duration_ms int, error varchar(500), metadata jsonb NOT NULL DEFAULT '{}');
CREATE INDEX integration_audit_logs_created_idx ON integration_audit_logs (created_at DESC);
CREATE TABLE integration_events (
  id bigserial PRIMARY KEY, event_type varchar(64) NOT NULL, resource varchar(32) NOT NULL, resource_id varchar(64) NOT NULL,
  payload jsonb NOT NULL, actor_user_id int, created_at timestamptz(3) NOT NULL DEFAULT now(), dispatched_at timestamptz(3));
CREATE TABLE oauth_clients (id serial PRIMARY KEY, kind varchar(8) NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(), last_used_at timestamptz(3));
CREATE TABLE oauth_authorization_codes (id serial PRIMARY KEY, expires_at timestamptz(3) NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now());
CREATE TABLE _prisma_migrations (id serial PRIMARY KEY, migration_name varchar(255) NOT NULL, finished_at timestamptz, rolled_back_at timestamptz);
INSERT INTO _prisma_migrations (migration_name, finished_at) VALUES ('9998_gia', now());
CREATE TABLE oauth_tokens (id serial PRIMARY KEY, refresh_expires_at timestamptz(3) NOT NULL, revoked_at timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT now());
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
        let name = format!("{dbname}_m33_{case}_{}", std::process::id());
        let mut admin = PgConnection::connect(&base).await.unwrap();
        exec(&mut admin, &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)")).await;
        exec(&mut admin, &format!("CREATE DATABASE \"{name}\"")).await;
        let url = url_for(&name);
        exec(&mut PgConnection::connect(&url).await.unwrap(), SETUP).await;
        Self { name, url }
    }
    async fn conn(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.unwrap()
    }
    fn db(&self) -> Db {
        let mut cfg = DbConfig::new(self.url.clone());
        cfg.pool_size = 2;
        cfg.required_migration = "9998_gia".to_owned();
        cfg.acquire_timeout = Duration::from_secs(10);
        Db::connect_lazy(&cfg).unwrap()
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

async fn count(c: &mut PgConnection, table: &str) -> i64 {
    sqlx::query(AssertSqlSafe(format!("SELECT count(*) AS n FROM {table}")))
        .fetch_one(&mut *c)
        .await
        .unwrap()
        .get("n")
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn ghi_nhat_ky_co_loc_va_khong_nem_loi() {
    let t = TestDb::new("log").await;
    let mut c = t.conn().await;
    let mut e = AuditEntry::new(Channel::Mcp, &"x".repeat(200), AuditStatus::Error);
    e.client_id = Some("client-1".into());
    e.user_id = Some(7);
    e.http_status = Some(-5);
    e.duration_ms = Some(9_999_999_999);
    e.resource = Some(String::new());
    e.resource_id = Some(String::new());
    e.error = Some("lỗi gọi 0912345678 với Bearer abc.def".into());
    e.metadata = Some(json!({"phone": "0912345678", "token": "t", "note": "ok"}));
    audit::log(&mut c, &e).await;
    let r = sqlx::query(
        "SELECT action, resource, resource_id, http_status, duration_ms, error, metadata FROM integration_audit_logs",
    )
    .fetch_one(&mut c)
    .await
    .unwrap();
    assert_eq!(r.get::<String, _>("action").len(), 128);
    assert_eq!(
        r.get::<Option<String>, _>("resource"),
        None,
        "resource rỗng ⇒ NULL (cut của Node)"
    );
    assert_eq!(
        r.get::<Option<String>, _>("resource_id").as_deref(),
        Some(""),
        "resource_id rỗng giữ '' như Node"
    );
    assert_eq!(r.get::<Option<i32>, _>("http_status"), Some(0));
    assert_eq!(r.get::<Option<i32>, _>("duration_ms"), Some(i32::MAX));
    assert_eq!(r.get::<String, _>("error"), "lỗi gọi ***678 với Bearer [redacted]");
    assert_eq!(
        r.get::<Value, _>("metadata"),
        json!({"phone": "***678", "token": "[redacted]", "note": "ok"})
    );
    // Bảng không tồn tại: log nuốt lỗi, không panic, không ném.
    exec(&mut c, "DROP TABLE integration_audit_logs").await;
    audit::log(&mut c, &e).await;
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn danh_sach_loc_va_trang_2_voi_khoa_trung() {
    let t = TestDb::new("list").await;
    let mut c = t.conn().await;
    // 7 dòng chỉ có 3 giá trị created_at (khoá sắp trùng), xen lẫn kênh/trạng thái/user.
    exec(&mut c, "INSERT INTO integration_audit_logs (created_at, channel, action, status, user_id)
        SELECT '2026-11-01 10:00:00.123+00'::timestamptz + ((g / 3) || ' seconds')::interval,
               CASE WHEN g % 2 = 0 THEN 'mcp' ELSE 'webhook_in' END, 'a' || g, CASE WHEN g % 3 = 0 THEN 'denied' ELSE 'ok' END, g % 2
        FROM generate_series(0, 6) g").await;
    let mut seen = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let q = AuditQuery {
            limit: Some(2),
            cursor: cursor.clone(),
            ..AuditQuery::default()
        };
        let r = audit::list(&mut c, &q).await.unwrap();
        pages += 1;
        for row in r["data"].as_array().unwrap() {
            seen.push(row["id"].as_str().unwrap().parse::<i64>().unwrap());
        }
        match r["meta"]["next_cursor"].as_str() {
            Some(n) => cursor = Some(n.to_owned()),
            None => break,
        }
    }
    assert_eq!(pages, 4);
    assert_eq!(seen.len(), 7, "không sót, không lặp: {seen:?}");
    let mut sorted = seen.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), 7);
    // Mới → cũ: created_at giảm dần, trong cùng created_at thì id giảm dần.
    let all = audit::list(
        &mut c,
        &AuditQuery {
            limit: Some(100),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    let ids: Vec<i64> = all["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().parse().unwrap())
        .collect();
    assert_eq!(ids, seen);
    assert_eq!(all["meta"]["next_cursor"], Value::Null);
    assert!(all["data"][0]["created_at"].as_str().unwrap().ends_with("Z"));
    assert_eq!(
        all["data"][0]["created_at"].as_str().unwrap(),
        "2026-11-01T10:00:02.123Z"
    );
    // Cursor do Node phát (`<epochMs>.<id>`) được Rust nhận: dựng tay đúng định dạng đó.
    let at: DateTime<Utc> = "2026-11-01T10:00:01.123Z".parse().unwrap();
    let node_cursor = format!("{}.{}", at.timestamp_millis(), 5);
    let after = audit::list(
        &mut c,
        &AuditQuery {
            cursor: Some(node_cursor),
            limit: Some(100),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    let rest: Vec<i64> = after["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().parse().unwrap())
        .collect();
    let pos = seen.iter().position(|id| *id == 5).unwrap();
    assert_eq!(
        rest,
        seen[pos + 1..],
        "cursor kiểu Node ⇒ trang tiếp đúng ngay sau dòng 5"
    );
    // Cursor Rust phát đúng định dạng Node đọc được: `^\d{1,15}\.\d{1,19}$`.
    let first = audit::list(
        &mut c,
        &AuditQuery {
            limit: Some(2),
            ..AuditQuery::default()
        },
    )
    .await
    .unwrap();
    let nc = first["meta"]["next_cursor"].as_str().unwrap();
    let (ms, id) = nc.split_once('.').unwrap();
    assert!(ms.bytes().all(|b| b.is_ascii_digit()) && id.bytes().all(|b| b.is_ascii_digit()));
    // Bộ lọc
    let q = AuditQuery {
        channel: Some(Channel::Mcp),
        status: Some(AuditStatus::Denied),
        ..AuditQuery::default()
    };
    let f = audit::list(&mut c, &q).await.unwrap();
    assert_eq!(
        f["data"].as_array().unwrap().len(),
        2,
        "g=0 và g=6 là mcp+denied; g=3 là webhook_in"
    );
    let q = AuditQuery {
        user_id: Some(1),
        ..AuditQuery::default()
    };
    assert_eq!(
        audit::list(&mut c, &q).await.unwrap()["data"].as_array().unwrap().len(),
        3
    );
    let q = AuditQuery {
        from: Some("2026-11-01T10:00:01Z".parse().unwrap()),
        to: Some("2026-11-01T10:00:01.5Z".parse().unwrap()),
        ..AuditQuery::default()
    };
    assert_eq!(
        audit::list(&mut c, &q).await.unwrap()["data"].as_array().unwrap().len(),
        3
    );
    assert!(matches!(
        audit::list(
            &mut c,
            &AuditQuery {
                cursor: Some("rac".into()),
                ..AuditQuery::default()
            }
        )
        .await,
        Err(audit::AuditError::InvalidCursor)
    ));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn don_outbox_theo_moc_va_theo_lo() {
    let t = TestDb::new("outbox").await;
    let mut c = t.conn().await;
    exec(
        &mut c,
        "INSERT INTO integration_events (event_type, resource, resource_id, payload, created_at, dispatched_at) VALUES
        ('contact.created','contact','1','{}', now() - interval '100 days', now() - interval '31 days'),
        ('contact.created','contact','2','{}', now() - interval '100 days', now() - interval '29 days'),
        ('contact.created','contact','3','{}', now() - interval '91 days', NULL),
        ('contact.created','contact','4','{}', now() - interval '89 days', NULL)",
    )
    .await;
    // Hơn một lô (2000): 2500 dòng đã dispatch quá hạn.
    exec(
        &mut c,
        "INSERT INTO integration_events (event_type, resource, resource_id, payload, dispatched_at)
        SELECT 'contact.created','contact', g::text, '{}', now() - interval '40 days' FROM generate_series(1, 2500) g",
    )
    .await;
    let r = purge::purge_outbox(&mut c, Utc::now()).await.unwrap();
    assert_eq!((r.dispatched, r.stale), (2501, 1));
    let left: Vec<String> = sqlx::query("SELECT resource_id FROM integration_events ORDER BY id")
        .fetch_all(&mut c)
        .await
        .unwrap()
        .iter()
        .map(|r| r.get("resource_id"))
        .collect();
    assert_eq!(left, ["2", "4"]);
    // Chạy lại: không còn gì để xoá.
    let again = purge::purge_outbox(&mut c, Utc::now()).await.unwrap();
    assert_eq!((again.dispatched, again.stale), (0, 0));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn don_oauth_theo_tung_luat() {
    let t = TestDb::new("oauth").await;
    let mut c = t.conn().await;
    exec(&mut c, "
      INSERT INTO oauth_authorization_codes (expires_at) VALUES (now() - interval '25 hours'), (now() - interval '23 hours'), (now() + interval '1 minute');
      INSERT INTO oauth_tokens (refresh_expires_at, revoked_at) VALUES
        (now() - interval '8 days', NULL), (now() - interval '6 days', NULL),
        (now() + interval '1 day', now() - interval '31 days'), (now() + interval '1 day', now() - interval '29 days'), (now() + interval '1 day', NULL);
      INSERT INTO oauth_clients (kind, created_at, last_used_at) VALUES
        ('dcr', now() - interval '8 days', NULL), ('dcr', now() - interval '6 days', NULL), ('dcr', now() - interval '80 days', now() - interval '70 days'),
        ('cimd', now() - interval '80 days', now() - interval '61 days'), ('cimd', now() - interval '80 days', now() - interval '59 days'),
        ('cimd', now() - interval '61 days', NULL), ('cimd', now() - interval '59 days', NULL);").await;
    let r = purge::purge_oauth(&mut c, Utc::now()).await.unwrap();
    assert_eq!((r.codes, r.tokens, r.clients), (1, 2, 3));
    assert_eq!(count(&mut c, "oauth_authorization_codes").await, 2);
    assert_eq!(count(&mut c, "oauth_tokens").await, 3);
    assert_eq!(count(&mut c, "oauth_clients").await, 4);
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn job_chi_co_khi_co_bat_va_chay_duoc_tren_cong_ty() {
    let t = TestDb::new("job").await;
    let db = t.db();
    assert!(purge::outbox_purge_job(&db, false).unwrap().is_none());
    assert!(purge::oauth_purge_job(&db, false).unwrap().is_none());
    let outbox = purge::outbox_purge_job(&db, true).unwrap().unwrap();
    let oauth = purge::oauth_purge_job(&db, true).unwrap().unwrap();
    assert_eq!(
        (outbox.name.as_str(), oauth.name.as_str()),
        (JOB_OUTBOX_PURGE, JOB_OAUTH_PURGE)
    );
    assert_eq!(
        (outbox.first_delay, oauth.first_delay),
        (Duration::from_secs(300), Duration::from_secs(420))
    );
    let mut c = t.conn().await;
    exec(&mut c, "INSERT INTO integration_events (event_type, resource, resource_id, payload, dispatched_at) VALUES ('contact.created','contact','1','{}', now() - interval '40 days');
                  INSERT INTO oauth_authorization_codes (expires_at) VALUES (now() - interval '2 days')").await;
    let co = CompanyRef::new(1).unwrap();
    (outbox.run)(co).await.unwrap();
    (oauth.run)(co).await.unwrap();
    assert_eq!(count(&mut c, "integration_events").await, 0);
    assert_eq!(count(&mut c, "oauth_authorization_codes").await, 0);
    db.close().await;
}
