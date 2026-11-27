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
    env_with(|r| {
        r.register(ToolSpec {
            name: "get_setup_guide",
            scope: None,
            permissions: &[],
            runner: Arc::new(Probe),
        });
    })
    .await
}

async fn env_with(register: fn(&mut ToolRegistry)) -> Env {
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
    let perms = PermissionService::new(db.clone(), cache.clone());
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
    register(&mut registry);
    let scopes = trinity_rbac::ScopeService::new(db.clone(), cache.clone());
    let tool_deps = Arc::new(mod_mcp::deps::ToolDeps {
        db: db.clone(),
        scopes: scopes.clone(),
        reports: Arc::new(mod_reports::Ctx {
            db: db.clone(),
            scopes,
            cache: mod_reports::cache::ReadCache::new(true),
        }),
        social: None,
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
            deps: tool_deps,
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

    // tools/list nhận cả 110 tool; ping.
    let (s, _, v) = e
        .call(
            Method::POST,
            Some(&good),
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await;
    assert_eq!((s, v["result"]["tools"].as_array().map(Vec::len)), (200, Some(110)));

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

fn tool(name: &str, args: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": name, "arguments": args } })
}

/// Kết quả một lần gọi tool: `(isError, text, structuredContent)`.
async fn run(e: &Env, token: &str, name: &str, args: &Value) -> (bool, String, Value) {
    let (status, _, v) = e.call(Method::POST, Some(token), &tool(name, args)).await;
    assert_eq!(status, 200, "{name}: {v}");
    let r = &v["result"];
    (
        r["isError"] == true,
        r["content"][0]["text"].as_str().unwrap_or("").to_owned(),
        r["structuredContent"].clone(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_doc_nhom_1_theo_pham_vi_va_che_sdt() {
    let e = env_with(mod_mcp::register_group1).await;
    let mut c = e.conn().await;
    // Vai trò nhân viên: chỉ xem của mình, nhưng CÓ `contacts.phone_full` (AI vẫn không được thấy SĐT thật).
    exec(
        &mut c,
        "INSERT INTO roles (name, is_system, updated_at) VALUES ('nv-m40', false, now());
         INSERT INTO role_permissions (role_id, permission, scope)
           SELECT r.id, p.permission, p.scope FROM roles r, (VALUES
             ('integrations.ai_connect', NULL), ('contacts.view', 'own'), ('contacts.phone_full', 'all'),
             ('deals.view', 'own'), ('kanban.view', 'own')) AS p(permission, scope) WHERE r.name = 'nv-m40';
         INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = 'staff@m39.test' AND r.name = 'nv-m40';",
    )
    .await;
    let (admin, staff) = (e.admin, e.staff);
    exec(
        &mut c,
        &format!(
            "INSERT INTO contacts (phone, full_name, assigned_to, updated_at) VALUES
               ('0912345001', 'Nguyễn Văn An', {staff}, now()), ('0912345002', 'Trần Thị Bình', {admin}, now()), ('0912345003', 'An Khang', {admin}, now());
             INSERT INTO deals (title, assigned_to, created_by, contact_id, updated_at)
               SELECT 'Deal của nhân viên', {staff}, {admin}, id, now() FROM contacts WHERE full_name = 'Nguyễn Văn An';
             INSERT INTO deals (title, assigned_to, created_by, contact_id, updated_at)
               SELECT 'Deal của quản trị', {admin}, {admin}, id, now() FROM contacts WHERE full_name = 'Trần Thị Bình';
             INSERT INTO activities (contact_id, action, details, created_by)
               SELECT id, 'note', '{{\"description\": \"Gọi 0987 654 321 chốt đơn\"}}'::jsonb, {admin} FROM contacts WHERE full_name = 'Nguyễn Văn An';
             INSERT INTO kanban_boards (name, updated_at) VALUES ('Việc', now());
             INSERT INTO kanban_columns (board_id, name, position, updated_at) SELECT id, 'Cần làm', 1, now() FROM kanban_boards WHERE name = 'Việc';"
        ),
    )
    .await;
    exec(
        &mut c,
        &format!(
            "INSERT INTO kanban_cards (board_id, column_id, title, position, created_by, assignee_id, due_at, updated_at)
               SELECT b.id, k.id, t.title, t.pos, {admin}, t.assignee, now() + interval '1 day', now()
               FROM kanban_boards b JOIN kanban_columns k ON k.board_id = b.id AND b.name = 'Việc',
                    (VALUES ('Gọi lại khách An', 1, {staff}), ('Việc của quản trị', 2, {admin})) AS t(title, pos, assignee);
             INSERT INTO kanban_cards (board_id, column_id, title, position, created_by, assignee_id, completed_at, updated_at)
               SELECT b.id, k.id, 'Việc đã xong', 3, {admin}, {staff}, now(), now() FROM kanban_boards b JOIN kanban_columns k ON k.board_id = b.id AND b.name = 'Việc';"
        ),
    )
    .await;
    let adm = e
        .token("quantri", e.admin, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    let stf = e
        .token("nhanvien", e.staff, "{crm.read}", RESOURCE, "1 hour", false)
        .await;

    // ── Quản trị: thấy cả 3 khách, SĐT luôn che dù có quyền; phân trang bằng con trỏ.
    let (err, _, v) = run(&e, &adm, "list_contacts", &json!({})).await;
    assert!(!err);
    assert_eq!(v["data"]["contacts"].as_array().unwrap().len(), 3);
    assert!(
        v["data"]["contacts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["phone"].as_str().unwrap().starts_with("***")),
        "{v}"
    );
    assert!(v["notice"].as_str().unwrap().contains("SĐT luôn bị che"));
    let (_, _, p1) = run(&e, &adm, "list_contacts", &json!({ "limit": 2 })).await;
    assert_eq!(p1["data"]["contacts"].as_array().unwrap().len(), 2);
    let cur = p1["data"]["next_cursor"].as_i64().unwrap();
    let (_, _, p2) = run(&e, &adm, "list_contacts", &json!({ "limit": 2, "cursor": cur })).await;
    assert_eq!(p2["data"]["contacts"].as_array().unwrap().len(), 1);
    assert!(p2["data"]["next_cursor"].is_null());
    // Lọc theo tên (không phân biệt hoa/thường); `%` được thoát nên không khớp mọi thứ.
    let (_, _, v) = run(&e, &adm, "list_contacts", &json!({ "name": "AN" })).await;
    assert_eq!(v["data"]["contacts"].as_array().unwrap().len(), 2);
    let (_, _, v) = run(&e, &adm, "list_contacts", &json!({ "name": "%" })).await;
    assert_eq!(v["data"]["contacts"].as_array().unwrap().len(), 0);
    // Chống dò chữ số: tìm theo tên có ≥ 4 chữ số bị từ chối.
    let (err, text, _) = run(&e, &adm, "list_contacts", &json!({ "name": "0912" })).await;
    assert!(
        err && text.starts_with("Không hỗ trợ tìm theo chuỗi có nhiều chữ số"),
        "{text}"
    );
    let (err, text, _) = run(&e, &adm, "search", &json!({ "query": "09 12" })).await;
    assert!(err && text.contains("Không hỗ trợ"), "{text}");

    // ── Chi tiết, hoạt động (SĐT trong nội dung bị che), deal, fetch, search.
    let an: i64 = e
        .scalar("SELECT id::bigint FROM contacts WHERE full_name = 'Nguyễn Văn An'")
        .await;
    let (err, _, v) = run(&e, &adm, "get_contact", &json!({ "id": an })).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["phone"], "***001");
    assert_eq!(v["data"]["deals"].as_array().unwrap().len(), 1);
    assert!(v["data"].get("current_address").is_none());
    let (_, _, v) = run(&e, &adm, "list_contact_activities", &json!({ "contact_id": an })).await;
    let acts = v["data"]["activities"].as_array().unwrap();
    assert_eq!(acts.len(), 1);
    assert!(
        acts[0]["details"].to_string().contains("***321") && !acts[0]["details"].to_string().contains("0987"),
        "{v}"
    );
    let (_, _, v) = run(&e, &adm, "list_deals", &json!({ "status": "open" })).await;
    assert_eq!(v["data"]["deals"].as_array().unwrap().len(), 2);
    // outputSchema đóng băng có additionalProperties:false cho từng deal; khoá thừa (vd `code`) làm client SDK từ chối kết quả (X04).
    for d in v["data"]["deals"].as_array().unwrap() {
        for k in d.as_object().unwrap().keys() {
            assert!(
                [
                    "id",
                    "title",
                    "status",
                    "value",
                    "contact_id",
                    "assignee",
                    "assigned_to",
                    "created_at"
                ]
                .contains(&k.as_str()),
                "khoá thừa trong list_deals: {k}"
            );
        }
    }
    let (_, _, v) = run(&e, &adm, "search", &json!({ "query": "an" })).await;
    let ids: Vec<String> = v["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        ids.contains(&format!("contact:{an}")) && ids.iter().any(|i| i.starts_with("card:")),
        "{ids:?}"
    );
    assert!(v["results"][0]["url"].as_str().unwrap().starts_with(BASE));
    let (err, _, v) = run(&e, &adm, "fetch", &json!({ "id": format!("contact:{an}") })).await;
    assert!(!err, "{v}");
    let text = v["text"].as_str().unwrap();
    assert!(
        text.contains("SĐT: ***001") && text.contains("Nguyễn Văn An") && text.contains("Deal:\n  - deal:"),
        "{text}"
    );
    assert!(text.starts_with('[') && !text.contains("0912345001") && v["metadata"]["notice"].is_string());
    let (err, text, _) = run(&e, &adm, "fetch", &json!({ "id": "contact:abc" })).await;
    assert!(err);
    assert!(
        text.is_empty() || text.contains("Input validation") || text.starts_with("id phải"),
        "{text}"
    );

    // ── Nhân viên (chỉ xem của mình, có `contacts.phone_full` nhưng AI vẫn bị che).
    let (_, _, v) = run(&e, &stf, "list_contacts", &json!({})).await;
    let cs = v["data"]["contacts"].as_array().unwrap();
    assert_eq!(cs.len(), 1, "{v}");
    assert_eq!(cs[0]["phone"], "***001");
    let other: i64 = e
        .scalar("SELECT id::bigint FROM contacts WHERE full_name = 'Trần Thị Bình'")
        .await;
    let (err, text, _) = run(&e, &stf, "get_contact", &json!({ "id": other })).await;
    assert!(
        err && text.starts_with("Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn"),
        "{text}"
    );
    let (err, text, _) = run(&e, &stf, "fetch", &json!({ "id": format!("contact:{other}") })).await;
    assert!(err && text.starts_with("Không tìm thấy"), "{text}");
    let (_, _, v) = run(&e, &stf, "list_deals", &json!({})).await;
    assert_eq!(v["data"]["deals"].as_array().unwrap().len(), 1);
    let (_, _, v) = run(&e, &stf, "search", &json!({ "query": "an" })).await;
    assert!(
        v["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| !r["id"].as_str().unwrap().starts_with("deal:")
                || r["title"].as_str().unwrap().contains("nhân viên")),
        "{v}"
    );
    // Việc của tôi: chỉ thẻ của mình và chưa xong.
    let (_, _, v) = run(&e, &stf, "list_my_tasks", &json!({})).await;
    let tasks = v["data"]["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "{v}");
    assert_eq!(tasks[0]["title"], "Gọi lại khách An");
    // Thiếu quyền của tool ⇒ câu từ chối, có nhật ký `denied`.
    let (err, text, _) = run(&e, &stf, "get_dashboard_overview", &json!({})).await;
    assert!(err && text.contains("cần quyền reports.overview"), "{text}");
    // Danh mục: nhân viên có contacts.view và kanban.view nhưng không có contacts.transfer.
    let (_, _, v) = run(&e, &stf, "list_crm_options", &json!({})).await;
    let d = &v["data"];
    assert!(
        d["sources"].as_array().is_some_and(|a| !a.is_empty()) && d["stages"].is_array() && d["statuses"].is_array(),
        "{v}"
    );
    let board = d["kanban_boards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["name"] == "Việc")
        .expect("bảng Việc");
    assert_eq!(board["columns"][0]["name"], "Cần làm");
    assert!(d.get("assignable_users").is_none());
    let (_, _, v) = run(&e, &adm, "list_crm_options", &json!({ "user_name": "Quản" })).await;
    assert!(v["data"]["assignable_users"].is_array(), "{v}");
    // Tổng quan của quản trị chạy được.
    let (err, _, v) = run(&e, &adm, "get_dashboard_overview", &json!({})).await;
    assert!(!err && v["data"].is_object(), "{v}");

    // Nhật ký: mỗi lời gọi một dòng, thành công và bị từ chối.
    assert!(e.scalar("SELECT count(*) FROM integration_audit_logs WHERE channel = 'mcp' AND action = 'list_contacts' AND status = 'ok'").await >= 5);
    assert_eq!(
        e.scalar("SELECT count(*) FROM integration_audit_logs WHERE channel = 'mcp' AND action = 'get_dashboard_overview' AND status = 'denied'").await,
        1
    );
    assert!(
        e.scalar("SELECT count(*) FROM integration_audit_logs WHERE metadata::text LIKE '%0912345%'")
            .await
            == 0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_doc_nhom_2_schema_ma_chung_va_tinh_nang() {
    let e = env_with(mod_mcp::register_group2).await;
    let mut c = e.conn().await;
    exec(
        &mut c,
        "INSERT INTO roles (name, is_system, updated_at) VALUES ('nv-m41', false, now());
         INSERT INTO role_permissions (role_id, permission, scope)
           SELECT r.id, p.permission, p.scope FROM roles r, (VALUES
             ('integrations.ai_connect', NULL), ('contacts.view', 'own')) AS p(permission, scope) WHERE r.name = 'nv-m41';
         INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = 'staff@m39.test' AND r.name = 'nv-m41';",
    )
    .await;
    let adm = e
        .token("quantri", e.admin, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    let stf = e
        .token("nhanvien", e.staff, "{crm.read}", RESOURCE, "1 hour", false)
        .await;

    // describe_schema: nhân viên chỉ thấy bảng lõi họ có quyền xem; không sửa được cấu trúc.
    let (err, _, v) = run(&e, &stf, "describe_schema", &json!({})).await;
    assert!(!err, "{v}");
    let tables = v["data"]["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 1, "{v}");
    assert_eq!(tables[0]["key"], "contacts");
    assert_eq!(tables[0]["data_scope"], "own");
    assert_eq!(v["data"]["structure"]["can_edit"], false);
    let (err, _, v) = run(&e, &adm, "describe_schema", &json!({ "object": "deals" })).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["structure"]["can_edit"], true);
    assert!(
        v["data"]["other_tables"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["key"] != "deals")
    );
    let (err, text, _) = run(&e, &adm, "describe_schema", &json!({ "object": "khong_co" })).await;
    assert!(err && text.starts_with("Không có bảng “khong_co”"), "{text}");

    // list_records / get_record: khoá bảng sai dạng và bảng không có đều là lỗi AI sửa được.
    let (err, text, _) = run(&e, &adm, "list_records", &json!({ "object": "Sai Khoa" })).await;
    assert!(err && text.starts_with("object phải là khoá bảng"), "{text}");
    let (err, text, _) = run(&e, &adm, "list_records", &json!({ "object": "khong_co" })).await;
    assert!(err && text.contains("describe_schema"), "{text}");
    let (err, text, _) = run(&e, &adm, "get_record", &json!({ "object": "contacts" })).await;
    assert!(err && text.starts_with("Cần id"), "{text}");
    let (err, text, _) = run(
        &e,
        &adm,
        "list_records",
        &json!({ "object": "deals", "filter": { "x": 1 } }),
    )
    .await;
    assert!(err && text.contains("chỉ lọc được theo"), "{text}");

    // find_by_code: mã không thấy nằm ở not_found; mã sai dạng bị từ chối.
    let (err, _, v) = run(
        &e,
        &adm,
        "find_by_code",
        &json!({ "codes": ["kh999", "@KH999", "ZZ1"] }),
    )
    .await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["not_found"], json!(["KH999", "ZZ1"]));
    let (err, text, _) = run(&e, &adm, "find_by_code", &json!({ "codes": ["###"] })).await;
    assert!(err && text.contains("không phải mã bản ghi"), "{text}");

    // Tool cấu trúc: chỉ người có custom_objects.manage.
    let (err, _, v) = run(&e, &stf, "list_structure_versions", &json!({})).await;
    assert!(err, "{v}");
    let (err, _, v) = run(&e, &adm, "list_structure_versions", &json!({})).await;
    assert!(!err && v["data"]["versions"].is_array(), "{v}");
    let (err, _, v) = run(&e, &adm, "list_object_templates", &json!({})).await;
    assert!(!err && v["data"]["templates"].is_array(), "{v}");
    let (err, _, v) = run(&e, &stf, "list_screen_types", &json!({})).await;
    assert!(!err && v["data"]["can_create"] == false, "{v}");
    assert_eq!(v["data"]["screen_types"].as_array().unwrap().len(), 4);

    // list_features: đủ 5 nhóm, 19 tính năng; get_setup_guide: nhân viên không thấy vai trò.
    let (err, _, v) = run(&e, &stf, "list_features", &json!({})).await;
    assert!(!err, "{v}");
    let groups = v["data"]["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 5);
    assert_eq!(
        groups
            .iter()
            .map(|g| g["features"].as_array().unwrap().len())
            .sum::<usize>(),
        19
    );
    let (err, _, v) = run(&e, &stf, "get_setup_guide", &json!({})).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["can_build"], false);
    assert_eq!(v["data"]["current"]["roles"], json!([]));
    let (_, _, v) = run(&e, &adm, "get_setup_guide", &json!({})).await;
    assert_eq!(v["data"]["can_build"], true);
    assert!(!v["data"]["current"]["roles"].as_array().unwrap().is_empty(), "{v}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_ghi_chay_ngay_va_tao_de_xuat_khi_bat_che_do_duyet() {
    let e = env_with(mod_mcp::register_group3).await;
    let mut c = e.conn().await;
    exec(
        &mut c,
        "INSERT INTO setting_options (group_key, value, label, sort_order, is_active, is_system, updated_at) VALUES
           ('contact_source', 'web', 'Website', 1, true, false, now()),
           ('contact_stage', 'new', 'Mới', 1, true, false, now()),
           ('contact_stage', 'won', 'Đã chốt', 2, true, false, now());
         INSERT INTO roles (name, is_system, updated_at) VALUES ('nv-m42', false, now());
         INSERT INTO role_permissions (role_id, permission, scope)
           SELECT r.id, p.permission, p.scope FROM roles r, (VALUES
             ('integrations.ai_connect', NULL), ('contacts.view', 'own')) AS p(permission, scope) WHERE r.name = 'nv-m42';
         INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = 'staff@m39.test' AND r.name = 'nv-m42';",
    )
    .await;
    let source: i64 = e
        .scalar("SELECT id::bigint FROM setting_options WHERE group_key = 'contact_source'")
        .await;
    let won: i64 = e
        .scalar("SELECT id::bigint FROM setting_options WHERE group_key = 'contact_stage' AND value = 'won'")
        .await;
    let write = e
        .token(
            "quantri-ghi",
            e.admin,
            "{crm.read,crm.write}",
            RESOURCE,
            "1 hour",
            false,
        )
        .await;
    let read_only = e
        .token("quantri-doc", e.admin, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    let stf = e
        .token(
            "nhanvien-ghi",
            e.staff,
            "{crm.read,crm.write}",
            RESOURCE,
            "1 hour",
            false,
        )
        .await;

    // Thiếu scope crm.write ⇒ từ chối; nhân viên thiếu quyền contacts.create ⇒ từ chối.
    let args = json!({ "full_name": "Khách Ghi", "phone": "0900001234", "source_id": source });
    let (err, text, _) = run(&e, &read_only, "create_contact", &args).await;
    assert!(err && text.starts_with("insufficient_scope"), "{text}");
    let (err, text, _) = run(&e, &stf, "create_contact", &args).await;
    assert!(err && text.contains("cần quyền contacts.create"), "{text}");

    // Mặc định chạy ngay: ghi khách, ghi lịch sử `executed`, SĐT đầy đủ không lọt vào kết quả.
    let (err, _, v) = run(&e, &write, "create_contact", &args).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "executed");
    assert!(!v.to_string().contains("0900001234"), "{v}");
    let cid = v["data"]["result"]["contact_id"].as_i64().unwrap();
    let aid = v["data"]["action_id"].as_i64().unwrap();
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM contacts WHERE id = {cid} AND full_name = 'Khách Ghi'"
        ))
        .await,
        1
    );
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM ai_action_drafts WHERE id = {aid} AND status = 'executed' AND result IS NOT NULL"
        ))
        .await,
        1
    );
    // Dữ liệu sai theo DTO ⇒ 400 nêu đúng thông điệp, không ghi gì.
    let (err, text, _) = run(
        &e,
        &write,
        "create_contact",
        &json!({ "full_name": "X", "phone": "123456789012", "source_id": source }),
    )
    .await;
    assert!(err && text.contains("SĐT không hợp lệ"), "{text}");

    // Ghi chú và đổi giai đoạn; đổi sang đúng giai đoạn hiện tại bị từ chối.
    let note = json!({ "contact_id": cid, "note": "Gọi lại chiều nay" });
    let (err, _, v) = run(&e, &write, "add_contact_note", &note).await;
    assert!(!err, "{v}");
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM activities WHERE contact_id = {cid} AND action = 'note'"
        ))
        .await,
        1
    );
    let stage = json!({ "contact_id": cid, "stage_id": won });
    let (err, _, v) = run(&e, &write, "update_contact_stage", &stage).await;
    assert!(!err, "{v}");
    let (err, text, _) = run(&e, &write, "update_contact_stage", &stage).await;
    assert!(err && text.contains("Khách đã ở giai đoạn"), "{text}");

    // get_action_status: chỉ thấy thao tác của chính kết nối này; thiếu id là lỗi đối số.
    let (err, _, v) = run(&e, &write, "get_action_status", &json!({ "action_id": aid })).await;
    assert!(!err && v["data"]["status"] == "executed", "{v}");
    let (err, text, _) = run(&e, &write, "get_action_status", &json!({ "action_id": 999_999 })).await;
    assert!(err && text.starts_with("Không tìm thấy"), "{text}");
    let (err, text, _) = run(&e, &write, "get_action_status", &json!({})).await;
    assert!(err && text.starts_with("Cần action_id"), "{text}");

    // Bật "Yêu cầu duyệt thay đổi do AI": chỉ tạo đề xuất, chưa ghi khách; gọi lại y hệt ⇒ cùng đề xuất (duplicate).
    exec(
        &mut c,
        "INSERT INTO settings (key, value, updated_at) VALUES ('ai_require_approval', 'true', now())",
    )
    .await;
    let args2 = json!({ "full_name": "Khách Chờ", "phone": "0900005678", "source_id": source });
    let (err, _, v) = run(&e, &write, "create_contact", &args2).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "pending");
    assert_eq!(v["data"]["duplicate"], false);
    assert!(v["data"]["review_url"].as_str().unwrap().starts_with(BASE), "{v}");
    let pid = v["data"]["action_id"].as_i64().unwrap();
    assert_eq!(
        e.scalar("SELECT count(*) FROM contacts WHERE full_name = 'Khách Chờ'")
            .await,
        0
    );
    let (_, _, again) = run(&e, &write, "create_contact", &args2).await;
    assert_eq!(again["data"]["duplicate"], true);
    assert_eq!(again["data"]["action_id"].as_i64(), Some(pid));
    let (_, _, v) = run(&e, &write, "get_action_status", &json!({ "action_id": pid })).await;
    assert_eq!(v["data"]["status"], "pending");
    assert_eq!(
        e.scalar("SELECT count(*) FROM ai_action_drafts WHERE status = 'pending'")
            .await,
        1
    );
    assert_eq!(
        e.scalar("SELECT count(*) FROM notification_logs WHERE event_type = 'ai_action.created'")
            .await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_cau_truc_chay_ngay_roi_thanh_de_xuat_khi_bat_che_do_duyet() {
    let e = env_with(mod_mcp::register_group3).await;
    let mut c = e.conn().await;
    let adm = e
        .token("quantri-ct", e.admin, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;
    let args = |label: &str| json!({ "label": label, "fields": [{ "label": "Mã", "type": "text" }], "confirmed_by_user": "ok tạo đi" });

    // Chưa có lời đồng ý ⇒ không tạo gì, không có đề xuất.
    let (err, text, _) = run(&e, &adm, "create_object", &json!({ "label": "Hợp đồng", "fields": [] })).await;
    assert!(err && text.contains("Chưa tạo gì"), "{text}");
    assert_eq!(e.scalar("SELECT count(*) FROM custom_objects").await, 0);

    // Mặc định chạy ngay: bảng được tạo, đề xuất `executed`, phiên bản cấu trúc chụp TRƯỚC khi đổi gắn với đề xuất đó.
    let (err, _, v) = run(&e, &adm, "create_object", &args("Hợp đồng")).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "executed");
    let aid = v["data"]["action_id"].as_i64().unwrap();
    assert_eq!(
        e.scalar("SELECT count(*) FROM custom_objects WHERE key = 'hop_dong' AND deleted_at IS NULL")
            .await,
        1
    );
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM ai_action_drafts WHERE id = {aid} AND status = 'executed' AND tool = 'create_object'"
        ))
        .await,
        1
    );
    assert_eq!(
        e.scalar(&format!(
            "SELECT count(*) FROM custom_schema_versions WHERE draft_id = {aid} AND tool = 'create_object'"
        ))
        .await,
        1
    );

    // Sửa tên bảng cũng chạy ngay.
    let (err, _, v) = run(
        &e,
        &adm,
        "update_object",
        &json!({ "object": "hop_dong", "patch": { "label": "Hợp đồng bán" } }),
    )
    .await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "executed");
    assert_eq!(
        e.scalar("SELECT count(*) FROM custom_objects WHERE key = 'hop_dong' AND label = 'Hợp đồng bán'")
            .await,
        1
    );

    // Bật "Yêu cầu duyệt thay đổi do AI": chỉ tạo đề xuất, KHÔNG tạo bảng, KHÔNG chụp phiên bản; gọi lại y hệt ⇒ cùng đề xuất.
    exec(
        &mut c,
        "INSERT INTO settings (key, value, updated_at) VALUES ('ai_require_approval', 'true', now())",
    )
    .await;
    let versions_before = e.scalar("SELECT count(*) FROM custom_schema_versions").await;
    let (err, _, v) = run(&e, &adm, "create_object", &args("Báo giá")).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "pending");
    assert_eq!(v["data"]["duplicate"], false);
    let pid = v["data"]["action_id"].as_i64().unwrap();
    assert_eq!(
        e.scalar("SELECT count(*) FROM custom_objects WHERE key = 'bao_gia'")
            .await,
        0
    );
    assert_eq!(
        e.scalar("SELECT count(*) FROM custom_schema_versions").await,
        versions_before
    );
    let (_, _, again) = run(&e, &adm, "create_object", &args("Báo giá")).await;
    assert_eq!(again["data"]["duplicate"], true);
    assert_eq!(again["data"]["action_id"].as_i64(), Some(pid));

    // Đổi cấu trúc khác (menu, màn xem) cũng chỉ thành đề xuất khi bật chế độ duyệt.
    let (err, _, v) = run(&e, &adm, "set_menu", &json!({ "menu": [{ "object": "hop_dong" }] })).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "pending");
    assert_eq!(
        e.scalar("SELECT count(*) FROM ai_action_drafts WHERE status = 'pending'")
            .await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_complete_setup_doi_co_dung_va_chan_quyen() {
    async fn status(c: &mut PgConnection) -> Option<String> {
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'setup_status'")
            .fetch_optional(&mut *c)
            .await
            .unwrap()
    }
    let e = env_with(mod_mcp::register_group3).await;
    let mut c = e.conn().await;
    let adm = e
        .token("quantri-ct", e.admin, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;
    // Chưa dựng ⇒ từ chối, cờ không đổi.
    exec(&mut c, "INSERT INTO settings (key, value, updated_at) VALUES ('setup_status', 'chua_dung', now()) ON CONFLICT (key) DO UPDATE SET value = 'chua_dung'").await;
    let (err, text, _) = run(&e, &adm, "complete_setup", &json!({})).await;
    assert!(err && text.contains("Chưa dựng"), "{text}");
    assert_eq!(status(&mut c).await.as_deref(), Some("chua_dung"));
    // Đang dựng ⇒ đã dùng.
    exec(
        &mut c,
        "UPDATE settings SET value = 'dang_dung' WHERE key = 'setup_status'",
    )
    .await;
    let (err, _, v) = run(&e, &adm, "complete_setup", &json!({})).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["status"], "da_dung");
    assert_eq!(status(&mut c).await.as_deref(), Some("da_dung"));
    // Token chỉ đọc ⇒ thiếu scope ghi, không đổi gì.
    exec(
        &mut c,
        "UPDATE settings SET value = 'dang_dung' WHERE key = 'setup_status'",
    )
    .await;
    let ro = e
        .token("doc-ct", e.admin, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    let (err, text, _) = run(&e, &ro, "complete_setup", &json!({})).await;
    assert!(err && text.contains("insufficient_scope"), "{text}");
    assert_eq!(status(&mut c).await.as_deref(), Some("dang_dung"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_dang_bai_kenh_va_thu_vien_media() {
    let e = env_with(|r| {
        let root = std::env::temp_dir().join(format!("m44a_media_{}", std::process::id()));
        mod_mcp::register_social(
            r,
            Arc::new(mod_mcp::SocialDeps::new(
                mod_social::media::MediaStore::Local(trinity_storage::LocalDiskDriver::new(root)),
                Arc::new(|_: &str| -> Option<String> { None }),
            )),
        );
    })
    .await;
    let mut c = e.conn().await;
    // Nhân viên chỉ xem kênh (social.post), không bật lại kênh (social.manage).
    exec(
        &mut c,
        "INSERT INTO roles (name, is_system, updated_at) VALUES ('nv-m44a', false, now());
         INSERT INTO role_permissions (role_id, permission, scope)
           SELECT r.id, p.permission, p.scope FROM roles r, (VALUES
             ('integrations.ai_connect', NULL), ('social.post', NULL)) AS p(permission, scope) WHERE r.name = 'nv-m44a';
         INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = 'staff@m39.test' AND r.name = 'nv-m44a';
         INSERT INTO settings (key, value) VALUES ('org_features', '{\"social_posting\":true}')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
         INSERT INTO social_accounts (network, external_id, name, access_token_enc, status, connected_by)
           VALUES ('facebook', 'm44a-1', 'Trang A', 'tok', 'active', (SELECT min(id) FROM users)),
                  ('facebook', 'm44a-2', 'Trang B', 'tok', 'disabled', (SELECT min(id) FROM users));",
    )
    .await;
    let adm = e
        .token("quantri", e.admin, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;
    let stf = e
        .token("nhanvien", e.staff, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;
    let ro = e
        .token("chidoc", e.admin, "{crm.read}", RESOURCE, "1 hour", false)
        .await;

    // list_social_accounts: có `removed`, `inbox` (chỉ Fanpage), danh sách mạng.
    let (err, _, v) = run(&e, &stf, "list_social_accounts", &json!({})).await;
    assert!(!err, "{v}");
    let accs = v["data"]["accounts"].as_array().unwrap();
    assert_eq!(accs.len(), 2, "{v}");
    assert_eq!(accs[0]["name"], "Trang A");
    assert_eq!(accs[0]["removed"], false);
    assert!(accs[0]["inbox"].is_null() && accs[0].get("inbox").is_some(), "{v}");
    assert_eq!(accs[1]["removed"], true);
    assert_eq!(v["data"]["networks"][0]["network"], "facebook");
    assert!(
        v["data"]["manage_url"]
            .as_str()
            .unwrap()
            .ends_with("/social?tab=channels")
    );

    // Ghi cần scope crm.write; bật lại kênh cần social.manage.
    let (err, _, _) = run(&e, &ro, "enable_social_account", &json!({ "account_id": 1 })).await;
    assert!(err);
    let (err, _, _) = run(&e, &stf, "enable_social_account", &json!({ "account_id": 1 })).await;
    assert!(err, "nhân viên thiếu social.manage");
    let id: i32 = sqlx::query_scalar("SELECT id FROM social_accounts WHERE external_id = 'm44a-2'")
        .fetch_one(&mut e.conn().await)
        .await
        .unwrap();
    let (err, text, _) = run(&e, &adm, "enable_social_account", &json!({ "account_id": id + 1000 })).await;
    assert!(err && text.contains("Không tìm thấy kênh"), "{text}");
    let (err, _, v) = run(&e, &adm, "enable_social_account", &json!({ "account_id": id })).await;
    assert!(!err && v["data"]["status"] == "active", "{v}");
    let (err, text, _) = run(&e, &adm, "enable_social_account", &json!({ "account_id": id })).await;
    assert!(err && text.contains("đang bật"), "{text}");

    // upload_social_media: đúng một trong url/data_base64; base64 hợp lệ vào thư viện (không đăng gì), rồi list_social_media thấy.
    let (err, text, _) = run(&e, &adm, "upload_social_media", &json!({})).await;
    assert!(err && text.contains("đúng một trong hai"), "{text}");
    let (err, text, _) = run(&e, &adm, "upload_social_media", &json!({ "data_base64": "QUJD" })).await;
    assert!(err && text.contains("file_name"), "{text}");
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let (err, text, v) = run(
        &e,
        &adm,
        "upload_social_media",
        &json!({ "data_base64": png, "file_name": "m44a.png", "name": "Ảnh thử" }),
    )
    .await;
    assert!(!err, "{text}");
    assert_eq!(v["data"]["type"], "image");
    assert_eq!(v["data"]["name"], "Ảnh thử");
    let key = v["data"]["media_key"].as_str().unwrap().to_owned();
    assert_eq!(
        e.scalar("SELECT count(*) FROM social_media_assets WHERE source = 'mcp'")
            .await,
        1
    );
    let (err, _, v) = run(&e, &stf, "list_social_media", &json!({ "type": "image", "q": "Ảnh%" })).await;
    assert!(!err, "{v}");
    assert!(
        v["data"]["files"].as_array().unwrap().is_empty(),
        "% phải được thoát: {v}"
    );
    let (err, _, v) = run(&e, &stf, "list_social_media", &json!({ "type": "image", "q": "Ảnh" })).await;
    assert!(!err && v["data"]["files"][0]["media_key"] == key.as_str(), "{v}");
    assert!(v["data"]["next_cursor"].is_null());

    // Tắt tính năng "Đăng đa kênh" ⇒ cả bốn tool báo tắt.
    exec(
        &mut e.conn().await,
        "UPDATE settings SET value = '{\"social_posting\":false}' WHERE key = 'org_features'",
    )
    .await;
    let (err, text, _) = run(&e, &stf, "list_social_accounts", &json!({})).await;
    assert!(err && text.contains("đang tắt"), "{text}");
    let (err, text, _) = run(&e, &adm, "list_social_media", &json!({})).await;
    assert!(err && text.contains("đang tắt"), "{text}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn tool_cham_y_dinh_lead_hoat_dong_ai_va_tuong_tac() {
    let e = env_with(mod_mcp::register_group1).await;
    let mut c = e.conn().await;
    exec(
        &mut c,
        "INSERT INTO roles (name, is_system, updated_at) VALUES ('nv-lead', false, now());
         INSERT INTO role_permissions (role_id, permission, scope)
           SELECT r.id, p.permission, p.scope FROM roles r, (VALUES
             ('integrations.ai_connect', NULL), ('contacts.view', 'own')) AS p(permission, scope) WHERE r.name = 'nv-lead';
         INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = 'staff@m39.test' AND r.name = 'nv-lead';",
    )
    .await;
    let (admin, staff) = (e.admin, e.staff);
    exec(
        &mut c,
        &format!(
            "INSERT INTO contacts (phone, full_name, assigned_to, updated_at) VALUES
               ('0912345011', 'Khách Của Quản Trị', {admin}, now()), ('0912345012', 'Khách Của Nhân Viên', {staff}, now());
             INSERT INTO activities (contact_id, action, details, created_by)
               SELECT id, 'note', '{{\"description\": \"Hỏi giá, gọi 0987 654 321 chốt đơn\"}}'::jsonb, {admin}
               FROM contacts WHERE full_name = 'Khách Của Quản Trị';"
        ),
    )
    .await;
    let mine: i64 = e
        .scalar("SELECT id::bigint FROM contacts WHERE full_name = 'Khách Của Quản Trị'")
        .await;
    let theirs: i64 = e
        .scalar("SELECT id::bigint FROM contacts WHERE full_name = 'Khách Của Nhân Viên'")
        .await;
    let write = e
        .token("lead-ghi", admin, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;
    let read_only = e
        .token("lead-doc", admin, "{crm.read}", RESOURCE, "1 hour", false)
        .await;
    let stf = e
        .token("lead-nv", staff, "{crm.read,crm.write}", RESOURCE, "1 hour", false)
        .await;

    // Chưa chấm: cả hai khách có mặt, ghi chú có SĐT bị che.
    let (err, _, v) = run(&e, &write, "list_leads_to_score", &json!({})).await;
    assert!(!err, "{v}");
    let leads = v["data"]["leads"].as_array().unwrap();
    assert_eq!(leads.len(), 2, "{v}");
    let a = leads.iter().find(|l| l["id"] == mine).unwrap();
    assert!(a["intent"].is_null());
    let notes = a["notes"].as_str().unwrap();
    assert!(notes.contains("Hỏi giá") && !notes.contains("0987 654 321"), "{notes}");

    // Ghi ý định: khách trong phạm vi ok + có điểm; id lạ báo lỗi từng dòng; thiếu scope ghi bị từ chối.
    let items = json!({ "items": [
        { "contact_id": mine, "intent": 0.9, "reason": "hỏi giá, muốn chốt" },
        { "contact_id": 2_000_000_000, "intent": 0.5 },
    ] });
    let (err, _, v) = run(&e, &write, "set_lead_intent", &items).await;
    assert!(!err, "{v}");
    let res = v["data"]["results"].as_array().unwrap();
    assert_eq!(res[0]["ok"], true, "{v}");
    assert!(res[0]["lead_score"].is_number(), "{v}");
    assert_eq!(res[1]["ok"], false);
    let (err, _, _) = run(&e, &read_only, "set_lead_intent", &items).await;
    assert!(err);
    let (err, text, _) = run(&e, &write, "set_lead_intent", &json!({ "items": [] })).await;
    assert!(err, "{text}");
    // Nhân viên chỉ chấm được khách của mình.
    let (_, _, v) = run(
        &e,
        &stf,
        "set_lead_intent",
        &json!({ "items": [{ "contact_id": mine, "intent": 1 }, { "contact_id": theirs, "intent": 0.1 }] }),
    )
    .await;
    assert_eq!(v["data"]["results"][0]["ok"], false, "{v}");
    assert_eq!(v["data"]["results"][1]["ok"], true, "{v}");
    assert_eq!(
        e.scalar(&format!(
            "SELECT (intent * 100)::bigint FROM lead_ai_intents WHERE contact_id = {mine}"
        ))
        .await,
        90
    );

    // Đã chấm thì không còn trong danh sách mặc định; only_missing=false vẫn thấy, kèm intent.
    let (_, _, v) = run(&e, &write, "list_leads_to_score", &json!({})).await;
    assert!(v["data"]["leads"].as_array().unwrap().is_empty(), "{v}");
    let (_, _, v) = run(&e, &write, "list_leads_to_score", &json!({ "only_missing": false })).await;
    let all = v["data"]["leads"].as_array().unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all.iter().find(|l| l["id"] == mine).unwrap()["intent"], 0.9);

    // Hoạt động AI: của mình mặc định; cả công ty cần integrations.ai_admin; ngày sai bị từ chối.
    let (err, _, v) = run(&e, &write, "list_ai_activity", &json!({})).await;
    assert!(!err, "{v}");
    assert_eq!(v["data"]["who"], "chính bạn");
    assert_eq!(v["data"]["timezone"], "Asia/Ho_Chi_Minh");
    assert!(v["data"]["items"].is_array());
    let (err, _, _) = run(&e, &stf, "list_ai_activity", &json!({ "all_users": true })).await;
    assert!(err);
    let (err, _, _) = run(&e, &write, "list_ai_activity", &json!({ "from": "27/11/2026" })).await;
    assert!(err);

    // Tương tác: khung thống kê luôn có; ngày sai và chuỗi nhiều chữ số bị từ chối.
    let (err, _, v) = run(&e, &write, "list_interactions", &json!({ "limit": 5 })).await;
    assert!(!err, "{v}");
    assert!(v["data"]["items"].is_array());
    assert!(v["data"]["stats_today"]["messages"].is_number());
    assert_eq!(v["data"]["manage_url"], "/inbox?kenh=tuong-tac");
    let (err, _, _) = run(&e, &write, "list_interactions", &json!({ "from": "hôm qua" })).await;
    assert!(err);
    let (err, _, _) = run(&e, &write, "list_interactions", &json!({ "q": "0912 345" })).await;
    assert!(err);
}
