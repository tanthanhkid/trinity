//! Lõi MCP trên Postgres thật, đa công ty (schema thật do `provision_company` migrate) và token OAuth thật của M37: xác thực
//! (thiếu/sai/hết hạn/thu hồi/sai audience/công ty lạ/thiếu quyền/thiếu scope), nhật ký `integration_audit_logs`, gỡ `*.phone_full`
//! khỏi quyền của AI, và router axum (`POST` JSON-RPC, `GET`/`DELETE` ⇒ 405).
//!
//! Test tự tạo một DB trống (`<DB của TEST_DATABASE_URL>_m39_<pid>`), tạo một công ty (c_2) rồi xoá DB:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-mcp --test mcp_pg -- --ignored`

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request};
use mod_mcp::auth::OauthIdentity;
use mod_mcp::endpoint::{McpConfig, McpEndpoint};
use mod_mcp::exec::{DbAudit, Executor, ToolCtx, ToolError, ToolOutput, ToolRegistry, ToolRunner, ToolSpec};
use mod_mcp::frozen::Frozen;
use mod_mcp::limits::McpLimits;
use mod_mcp::protocol::BoxFuture;
use mod_mcp::routes::{McpState, api_router};
use mod_oauth::{OauthConfig, OauthCtx};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::provision::{ProvisionInput, provision_company};
use trinity_db::{Db, DbConfig, migrate};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache};

const BASE: &str = "http://127.0.0.1:4391";
const SETUP: &str = "
CREATE TABLE public.users (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.facebook_pages (id serial PRIMARY KEY, page_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.zalo_oa_connections (id serial PRIMARY KEY, oa_id varchar(255) NOT NULL UNIQUE);
CREATE TABLE public.settings (key varchar(255) PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.connector_accounts (id serial PRIMARY KEY, provider varchar(32) NOT NULL, status varchar(32) NOT NULL, settings jsonb NOT NULL DEFAULT '{}');
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

/// Tool giả báo lại phần quyền AI nhìn thấy.
struct Probe;

impl ToolRunner for Probe {
    fn run<'a>(&'a self, _a: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let p = ctx.principal;
            Ok(ToolOutput {
                text: Some("ok".into()),
                structured: json!({
                    "notice": "",
                    "data": {
                        "user": p.user_id, "company": p.company.id(), "client": p.client_id,
                        "has_phone_full": p.grants.keys().any(|k| k.ends_with(".phone_full")),
                        "has_contacts_view": p.grants.contains_key("contacts.view"),
                    }
                }),
            })
        })
    }
}

struct Env {
    t: TestDb,
    router: axum::Router,
    admin: i32,
    staff: i32,
}

impl Env {
    async fn conn(&self) -> PgConnection {
        let mut c = PgConnection::connect(&self.t.url).await.unwrap();
        exec(&mut c, "SET search_path TO c_2, public").await;
        c
    }

    async fn scalar(&self, sql: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
            .fetch_one(&mut self.conn().await)
            .await
            .unwrap()
    }

    /// Chèn một access token cho công ty 2 (`c2.` + bí mật), trả chuỗi token.
    async fn token(
        &self,
        secret: &str,
        user: i32,
        scopes: &str,
        resource: &str,
        expires: &str,
        revoked: bool,
    ) -> String {
        let raw = format!("c2.{secret}");
        exec(
            &mut self.conn().await,
            &format!(
                "INSERT INTO oauth_tokens (access_hash, refresh_hash, client_id, user_id, scopes, resource, family_id, access_expires_at, refresh_expires_at, revoked_at)
                 VALUES (encode(sha256('{raw}'::bytea), 'hex'), encode(sha256('r-{raw}'::bytea), 'hex'), 'client-x', {user}, '{scopes}'::text[], '{resource}',
                         '00000000-0000-0000-0000-000000000001', now() + interval '{expires}', now() + interval '1 day', {})",
                if revoked { "now()" } else { "NULL" }
            ),
        )
        .await;
        raw
    }

    async fn call(&self, method: Method, token: Option<&str>, body: &Value) -> (u16, axum::http::HeaderMap, Value) {
        let mut rq = Request::builder()
            .method(method.clone())
            .uri("/api/v1/mcp")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(t) = token {
            rq = rq.header("authorization", format!("Bearer {t}"));
        }
        let req = rq
            .body(if method == Method::POST {
                Body::from(body.to_string())
            } else {
                Body::empty()
            })
            .unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let (status, headers) = (resp.status().as_u16(), resp.headers().clone());
        let raw = axum::body::to_bytes(resp.into_body(), 1 << 22).await.unwrap();
        (status, headers, serde_json::from_slice(&raw).unwrap_or(Value::Null))
    }
}

async fn env() -> Env {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let base = base_url();
    let dbname = base
        .split_once('?')
        .map_or(base.as_str(), |(h, _)| h)
        .rsplit_once('/')
        .map(|(_, d)| d.to_owned())
        .unwrap();
    let name = format!(
        "{dbname}_m39_{}_{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let mut admin_conn = PgConnection::connect(&base).await.unwrap();
    exec(
        &mut admin_conn,
        &format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"),
    )
    .await;
    exec(&mut admin_conn, &format!("CREATE DATABASE \"{name}\"")).await;
    let url = url_for(&name);
    let t = TestDb { name, url: url.clone() };
    exec(&mut PgConnection::connect(&url).await.unwrap(), SETUP).await;
    let mut cfg = DbConfig::new(url);
    cfg.multi_tenant = true;
    cfg.pool_size = 16;
    cfg.acquire_timeout = Duration::from_secs(30);
    cfg.statement_timeout = Duration::ZERO;
    let db = Db::connect_lazy(&cfg).unwrap();
    let platform = Platform::new(&db, None);
    let res = provision_company(
        &db,
        &platform,
        &migrate::embedded_migrations(),
        migrate::latest_embedded(),
        &ProvisionInput {
            company_name: "Công ty M39".into(),
            admin_email: "admin@m39.test".into(),
            admin_password: "mat-khau-thu-123".into(),
            admin_name: "Quản trị".into(),
        },
    )
    .await
    .unwrap();
    let mut c = PgConnection::connect(&t.url).await.unwrap();
    exec(&mut c, "SET search_path TO c_2, public").await;
    exec(&mut c, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('staff@m39.test', 'x', 'NV', 'active', now())").await;
    let staff: i32 = sqlx::query_scalar("SELECT id FROM users WHERE email = 'staff@m39.test'")
        .fetch_one(&mut c)
        .await
        .unwrap();
    let admin = res.admin_user_id;

    let get = |k: &str| match k {
        "INTEGRATIONS_MCP_ENABLED" => Some("true".to_owned()),
        "INTEGRATIONS_PUBLIC_BASE_URL" => Some(BASE.to_owned()),
        "NODE_ENV" => Some("development".to_owned()),
        _ => None,
    };
    let security = Security::new(db.clone(), platform.clone(), true);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache);
    let mut ip_env = BTreeMap::new();
    ip_env.insert(
        "TRUSTED_PROXY".to_owned(),
        "cidr:127.0.0.1/32;header=x-real-ip".to_owned(),
    );
    let ip = Arc::new(
        ClientIpResolver::from_env(
            &ip_env,
            NetProbe::Fixed {
                route_table: None,
                in_container: false,
            },
        )
        .unwrap(),
    );
    let oauth = Arc::new(OauthCtx {
        db: db.clone(),
        platform,
        perms: perms.clone(),
        config: OauthConfig::from_lookup(get),
        ip: ip.clone(),
        safe_get: None,
        limits: mod_oauth::Limiters::new(),
    });
    let limits = Arc::new(McpLimits::with_untrusted_peer(oauth.limits.untrusted_peer.clone()));
    let audit = Arc::new(DbAudit { db: db.clone() });
    let mut registry = ToolRegistry::new();
    registry.register(ToolSpec {
        name: "get_setup_guide",
        scope: None,
        permissions: &[],
        runner: Arc::new(Probe),
    });
    let endpoint = McpEndpoint {
        config: McpConfig::from_lookup(get),
        frozen: Arc::new(Frozen::embedded()),
        identity: Arc::new(OauthIdentity { oauth }),
        limits: limits.clone(),
        exec: Executor {
            registry,
            limits,
            audit: audit.clone(),
            base_url: BASE.into(),
        },
        audit,
    };
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(
            security,
            "m39-jwt-secret-0123456789abcdef0123456789abcdef",
            &[],
        )),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 3);
    Env {
        t,
        router: router.with_state(Arc::new(McpState { endpoint, ip })),
        admin,
        staff,
    }
}

const RESOURCE: &str = "http://127.0.0.1:4391/api/v1/mcp";

fn call_tool() -> Value {
    json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "get_setup_guide", "arguments": {} } })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn xac_thuc_oauth_that_nhat_ky_va_gui_quyen() {
    let e = env().await;

    // Token hợp lệ của quản trị: gọi tool được; AI KHÔNG có `*.phone_full` dù là quản trị; nhật ký ghi đủ.
    let good = e
        .token("tot", e.admin, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;
    let (status, headers, v) = e.call(Method::POST, Some(&good), &call_tool()).await;
    assert_eq!(status, 200, "{v}");
    assert_eq!(headers.get("content-type").unwrap(), "application/json");
    let d = &v["result"]["structuredContent"]["data"];
    assert_eq!(
        (d["user"].as_i64(), d["company"].as_i64(), d["client"].as_str()),
        (Some(i64::from(e.admin)), Some(2), Some("client-x"))
    );
    assert_eq!(
        (d["has_phone_full"].as_bool(), d["has_contacts_view"].as_bool()),
        (Some(false), Some(true))
    );
    let row: (String, String, Option<i32>, Option<String>, Value) = sqlx::query_as(
        "SELECT channel, action, user_id, client_id, metadata FROM integration_audit_logs WHERE channel = 'mcp' AND action = 'get_setup_guide'",
    )
    .fetch_one(&mut e.conn().await)
    .await
    .unwrap();
    assert_eq!(
        (row.0.as_str(), row.1.as_str(), row.2, row.3.as_deref()),
        ("mcp", "get_setup_guide", Some(e.admin), Some("client-x"))
    );
    assert!(row.4["args"].is_object());

    // tools/list nhận cả 104 tool; ping.
    let (s, _, v) = e
        .call(
            Method::POST,
            Some(&good),
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await;
    assert_eq!((s, v["result"]["tools"].as_array().map(Vec::len)), (200, Some(104)));

    // Thiếu token, token rác, công ty lạ ⇒ 401 kèm `WWW-Authenticate`.
    for (tok, header_has_error) in [(None, false), (Some("rac"), true), (Some("c999.khong-co"), true)] {
        let (s, h, v) = e
            .call(
                Method::POST,
                tok,
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }),
            )
            .await;
        assert_eq!(s, 401, "{tok:?}");
        let www = h.get("www-authenticate").unwrap().to_str().unwrap();
        assert!(
            www.contains(&format!("resource_metadata=\"{BASE}/api/v1/oauth/protected-resource\"")),
            "{www}"
        );
        assert_eq!(www.contains("error=\"invalid_token\""), header_has_error, "{www}");
        assert_eq!(
            v["error"],
            if header_has_error {
                "invalid_token"
            } else {
                "unauthorized"
            }
        );
    }
    // Hết hạn, thu hồi, sai audience ⇒ 401.
    let expired = e
        .token("hethan", e.admin, "{crm.read}", RESOURCE, "-1 hour", false)
        .await;
    let revoked = e.token("thuhoi", e.admin, "{crm.read}", RESOURCE, "1 hour", true).await;
    let wrong = e
        .token(
            "saiaud",
            e.admin,
            "{crm.read}",
            "http://127.0.0.1:4391/khac",
            "1 hour",
            false,
        )
        .await;
    for t in [&expired, &revoked, &wrong] {
        let (s, _, v) = e.call(Method::POST, Some(t), &call_tool()).await;
        assert_eq!((s, v["error"].as_str()), (401, Some("invalid_token")), "{t}");
    }
    // Thiếu scope crm.read ⇒ 403 + nhật ký `denied` có người và client.
    let noscope = e
        .token("khongscope", e.admin, "{crm.write}", RESOURCE, "1 hour", false)
        .await;
    let (s, h, v) = e.call(Method::POST, Some(&noscope), &call_tool()).await;
    assert_eq!((s, v["error"].as_str()), (403, Some("insufficient_scope")));
    assert!(
        h.get("www-authenticate")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("error=\"insufficient_scope\"")
    );
    assert_eq!(
        e.scalar(&format!("SELECT count(*) FROM integration_audit_logs WHERE channel = 'mcp' AND action = 'auth' AND status = 'denied' AND user_id = {} AND error = 'insufficient_scope'", e.admin)).await,
        1
    );
    // Lỗi DB khi đọc quyền ⇒ 500 (không phải 401): không challenge, không nhật ký `denied`.
    exec(
        &mut e.conn().await,
        "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('hong@m39.test', 'x', 'H', 'active', now())",
    )
    .await;
    let broken_user: i32 = sqlx::query_scalar("SELECT id FROM users WHERE email = 'hong@m39.test'")
        .fetch_one(&mut e.conn().await)
        .await
        .unwrap();
    let broken = e
        .token("hong", broken_user, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    exec(&mut e.conn().await, "ALTER TABLE user_roles RENAME TO user_roles_tam").await;
    let (s, h, v) = e.call(Method::POST, Some(&broken), &call_tool()).await;
    exec(&mut e.conn().await, "ALTER TABLE user_roles_tam RENAME TO user_roles").await;
    assert_eq!(s, 500, "{v}");
    assert!(h.get("www-authenticate").is_none());
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM integration_audit_logs WHERE channel = 'mcp' AND user_id = {broken_user}"
        ))
        .await,
        0
    );
    // Người dùng không còn quyền kết nối AI (không vai trò nào) ⇒ 401, có nhật ký.
    let staff = e
        .token("nhanvien", e.staff, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    let (s, _, v) = e.call(Method::POST, Some(&staff), &call_tool()).await;
    assert_eq!((s, v["error"].as_str()), (401, Some("invalid_token")));
    assert_eq!(
        e.scalar(&format!("SELECT count(*) FROM integration_audit_logs WHERE channel = 'mcp' AND action = 'auth' AND user_id = {} AND error = 'invalid_token'", e.staff)).await,
        1
    );
    // Người dùng bị khoá ⇒ token vô hiệu.
    exec(
        &mut e.conn().await,
        &format!("UPDATE users SET status = 'locked' WHERE id = {}", e.staff),
    )
    .await;
    let (s, _, _) = e.call(Method::POST, Some(&staff), &call_tool()).await;
    assert_eq!(s, 401);

    // GET/DELETE ⇒ 405 kèm Allow; Origin lạ ⇒ 403.
    for m in [Method::GET, Method::DELETE] {
        let (s, h, v) = e.call(m, Some(&good), &json!({})).await;
        assert_eq!((s, h.get("allow").unwrap().to_str().unwrap()), (405, "POST"));
        assert_eq!(v["error"]["message"], "Method not allowed");
    }
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/mcp")
        .header("origin", "https://evil.example")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("authorization", format!("Bearer {good}"))
        .body(Body::from(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(),
        ))
        .unwrap();
    assert_eq!(e.router.clone().oneshot(req).await.unwrap().status().as_u16(), 403);
}
