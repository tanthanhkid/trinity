//! M37 qua HTTP (router K14 thật, quyền thật, Postgres thật): chuyển 28 ca của C13a (`tests/contract/cases/*/40-oauth*.test.ts`).
//! `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-oauth --test oauth_http -- --ignored --test-threads=1`
//! Test xoá sạch `oauth_*`, `integration_audit_logs` và tạo/xoá user/vai trò 9701..9799.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode};
use mod_oauth::{OauthConfig, OauthCtx, api_router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::edge::client_ip::{ClientIpResolver, NetProbe};
use trinity_http::outbound::safe_get::{SAFE_GET_MAX_BYTES, SAFE_GET_TIMEOUT, SafeGetOptions};
use trinity_http::outbound::ssrf::SystemResolver;
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache};

const JWT: &str = "m37-jwt-secret-0123456789abcdef0123456789abcdef";
const BASE: &str = "http://127.0.0.1:4390";
const ISS: &str = "http://127.0.0.1:4390/api/v1/oauth";
const MCP: &str = "http://127.0.0.1:4390/api/v1/mcp";
const REDIRECT: &str = "https://client.example.com/cb";

const AIA: i32 = 9701; // integrations.ai_connect
const AIB: i32 = 9702; // integrations.ai_connect
const ADM: i32 = 9703; // integrations.ai_admin
const NOAI: i32 = 9704; // chỉ contacts.view

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn exec(sql: &str) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut c)
        .await
        .expect(sql);
}

async fn scalar<T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin>(
    sql: &str,
) -> T {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut c)
        .await
        .expect(sql)
}

struct App {
    router: Router,
    ctx: Arc<OauthCtx>,
    cache: Arc<RbacCache>,
}

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let m: BTreeMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    move |k| m.get(k).cloned()
}

fn default_env() -> Vec<(&'static str, &'static str)> {
    vec![
        ("NODE_ENV", "test"),
        ("JWT_SECRET", JWT),
        ("INTEGRATIONS_MCP_ENABLED", "true"),
        ("INTEGRATIONS_PUBLIC_BASE_URL", BASE),
    ]
}

async fn app_with(env: &[(&str, &str)]) -> App {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let config = OauthConfig::from_lookup(env_of(env));
    let safe_get = SafeGetOptions::new(
        config.policy,
        Arc::new(SystemResolver),
        SAFE_GET_TIMEOUT,
        SAFE_GET_MAX_BYTES,
    )
    .ok();
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
    let ctx = Arc::new(OauthCtx {
        db: db.clone(),
        platform,
        perms: perms.clone(),
        config,
        ip,
        safe_get,
        limits: mod_oauth::Limiters::new(),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 9);
    App {
        router: router.with_state(ctx.clone()),
        ctx,
        cache,
    }
}

async fn app() -> App {
    app_with(&default_env()).await
}

fn user_token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m37.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

static IP_SEQ: AtomicU32 = AtomicU32::new(1);
fn fresh_ip() -> String {
    let n = IP_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("198.51.{}.{}", (n / 250) % 250, n % 250 + 1)
}

enum Payload {
    None,
    Json(Value),
    Form(Vec<(String, String)>),
}

struct Res {
    status: StatusCode,
    body: Value,
    headers: axum::http::HeaderMap,
}

async fn send(a: &App, method: Method, path: &str, user: Option<i32>, payload: Payload, ip: Option<String>) -> Res {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("x-real-ip", ip.unwrap_or_else(fresh_ip));
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", user_token(u)));
    }
    let mut req = match payload {
        Payload::None => b.body(Body::empty()).unwrap(),
        Payload::Json(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        Payload::Form(f) => {
            let s = form_urlencoded::Serializer::new(String::new()).extend_pairs(f).finish();
            b.header("content-type", "application/x-www-form-urlencoded")
                .body(Body::from(s))
                .unwrap()
        }
    };
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5555))));
    let resp = a.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
        headers,
    }
}

async fn post_json(a: &App, path: &str, body: Value) -> Res {
    send(a, Method::POST, path, None, Payload::Json(body), None).await
}

async fn form(a: &App, path: &str, pairs: &[(&str, &str)]) -> Res {
    let f = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    send(a, Method::POST, path, None, Payload::Form(f), None).await
}

fn b64u(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn pkce() -> (String, String) {
    let mut raw = [0u8; 48];
    getrandom::fill(&mut raw).unwrap();
    let verifier = b64u(&raw);
    let challenge = b64u(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn sha256(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn register(a: &App, extra: Value) -> Value {
    let mut body = json!({ "client_name": "ChatGPT test", "redirect_uris": [REDIRECT] });
    if let (Some(o), Some(e)) = (body.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    let r = post_json(a, "/api/v1/oauth/register", body).await;
    assert_eq!(r.status, 201, "{:?}", r.body);
    r.body
}

fn params(client_id: &str, challenge: &str, over: Value) -> Value {
    let mut p = json!({
        "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "scope": "crm.read",
        "state": "st-123", "code_challenge": challenge, "code_challenge_method": "S256", "resource": MCP,
    });
    if let (Some(o), Some(e)) = (p.as_object_mut(), over.as_object()) {
        for (k, v) in e {
            if v.is_null() {
                o.remove(k);
            } else {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    p
}

async fn auth_context(a: &App, user: i32, p: &Value) -> Res {
    send(
        a,
        Method::POST,
        "/api/v1/oauth/authorize/context",
        Some(user),
        Payload::Json(json!({ "params": p })),
        None,
    )
    .await
}

async fn auth_decision(a: &App, user: i32, body: Value) -> Res {
    send(
        a,
        Method::POST,
        "/api/v1/oauth/authorize/decision",
        Some(user),
        Payload::Json(body),
        None,
    )
    .await
}

/// Đồng ý như trình duyệt: context rồi decision ⇒ code.
async fn authorize_code(a: &App, user: i32, p: &Value) -> String {
    let ctx = auth_context(a, user, p).await;
    assert_eq!(ctx.status, 200, "{:?}", ctx.body);
    assert_eq!(ctx.body["ok"], true, "{:?}", ctx.body);
    let dec = auth_decision(
        a,
        user,
        json!({ "params": p, "approve": true, "consent_token": ctx.body["consent_token"] }),
    )
    .await;
    assert_eq!(dec.status, 200, "{:?}", dec.body);
    let u = url::Url::parse(dec.body["redirect_to"].as_str().unwrap()).unwrap();
    u.query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .unwrap()
}

async fn full_tokens(a: &App, user: i32, client_id: &str, secret: Option<&str>) -> Value {
    let (verifier, challenge) = pkce();
    let code = authorize_code(a, user, &params(client_id, &challenge, json!({}))).await;
    let mut f = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", REDIRECT),
        ("code_verifier", verifier.as_str()),
        ("client_id", client_id),
    ];
    if let Some(s) = secret {
        f.push(("client_secret", s));
    }
    let t = form(a, "/api/v1/oauth/token", &f).await;
    assert_eq!(t.status, 200, "{:?}", t.body);
    t.body
}

fn err(r: &Res) -> &str {
    r.body["error"].as_str().unwrap_or("")
}

async fn teardown() {
    exec("TRUNCATE TABLE oauth_clients, oauth_authorization_codes, oauth_tokens, integration_audit_logs RESTART IDENTITY;
          DELETE FROM token_blacklist WHERE user_id BETWEEN 9701 AND 9799;
          DELETE FROM user_roles WHERE user_id BETWEEN 9701 AND 9799;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9701 AND 9799;
          DELETE FROM roles WHERE id BETWEEN 9701 AND 9799;
          DELETE FROM users WHERE id BETWEEN 9701 AND 9799").await;
}

async fn setup() {
    teardown().await;
    for (id, name) in [(AIA, "A"), (AIB, "B"), (ADM, "Admin AI"), (NOAI, "Không AI")] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, updated_at)
             VALUES ({id}, 'u{id}@m37.test', 'x', 'Người {name}', 'active', now())"
        ))
        .await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES
            (9701, 'm37-ai', false, now()), (9702, 'm37-ai-admin', false, now()), (9703, 'm37-khong-ai', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9701, 'integrations.ai_connect', NULL), (9702, 'integrations.ai_admin', NULL), (9703, 'contacts.view', 'own');
          INSERT INTO user_roles (user_id, role_id) VALUES (9701, 9701), (9702, 9701), (9703, 9702), (9704, 9703)").await;
}

// ================================================================= metadata, DCR

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn metadata_rfc8414_va_rfc9728() {
    setup().await;
    let a = app().await;
    let r = send(
        &a,
        Method::GET,
        "/api/v1/oauth/.well-known/oauth-authorization-server",
        None,
        Payload::None,
        None,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.headers["access-control-allow-origin"], "*");
    assert_eq!(r.headers["cache-control"], "public, max-age=300");
    let b = &r.body;
    assert_eq!(b["issuer"], ISS);
    assert_eq!(b["authorization_endpoint"], format!("{BASE}/oauth/authorize"));
    assert_eq!(b["token_endpoint"], format!("{ISS}/token"));
    assert_eq!(b["registration_endpoint"], format!("{ISS}/register"));
    assert_eq!(b["revocation_endpoint"], format!("{ISS}/revoke"));
    assert_eq!(b["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(b["client_id_metadata_document_supported"], true);
    assert_eq!(b["authorization_response_iss_parameter_supported"], true);
    assert!(
        b["token_endpoint_auth_methods_supported"]
            .as_array()
            .unwrap()
            .contains(&json!("none"))
    );
    for g in ["implicit", "password"] {
        assert!(!b["grant_types_supported"].as_array().unwrap().contains(&json!(g)));
    }
    let r = send(
        &a,
        Method::GET,
        "/api/v1/oauth/protected-resource",
        None,
        Payload::None,
        None,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["resource"], MCP);
    assert_eq!(r.body["authorization_servers"], json!([ISS]));
    assert_eq!(r.body["bearer_methods_supported"], json!(["header"]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn dcr_dang_ky_va_tu_choi_uri_nguy_hiem() {
    setup().await;
    let a = app().await;
    let ok = register(&a, json!({})).await;
    assert!(ok["client_id"].as_str().unwrap().starts_with("trn_c_"));
    for bad in [
        "javascript:alert(1)",
        "http://evil.example.com/cb",
        "https://client.example.com/cb#frag",
        "https://user:pw@client.example.com/cb",
        "data:text/html,x",
        "chatgpt://cb",
        "https://x.example.com/a b",
    ] {
        let r = post_json(
            &a,
            "/api/v1/oauth/register",
            json!({ "client_name": "bad", "redirect_uris": [bad] }),
        )
        .await;
        assert_eq!(r.status, 400, "{bad}");
        assert_eq!(err(&r), "invalid_redirect_uri", "{bad}");
    }
    let r = post_json(
        &a,
        "/api/v1/oauth/register",
        json!({ "client_name": "cc", "redirect_uris": ["http://localhost/callback", "http://127.0.0.1/callback"] }),
    )
    .await;
    assert_eq!(r.status, 201);
    // Tham số lạ.
    for body in [
        json!({ "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "private_key_jwt" }),
        json!({ "redirect_uris": [REDIRECT], "grant_types": ["password"] }),
        json!({ "redirect_uris": [REDIRECT], "response_types": ["token"] }),
    ] {
        let r = post_json(&a, "/api/v1/oauth/register", body).await;
        assert_eq!((r.status.as_u16(), err(&r)), (400, "invalid_client_metadata"));
    }
    assert_eq!(
        post_json(&a, "/api/v1/oauth/register", json!({})).await.body["error"],
        "invalid_redirect_uri"
    );
    assert_eq!(r.headers["cache-control"], "no-store");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn dcr_chan_spam_theo_ip() {
    setup().await;
    let a = app().await;
    let ip = fresh_ip();
    for _ in 0..10 {
        let r = send(
            &a,
            Method::POST,
            "/api/v1/oauth/register",
            None,
            Payload::Json(json!({ "redirect_uris": [REDIRECT] })),
            Some(ip.clone()),
        )
        .await;
        assert_eq!(r.status, 201);
    }
    let r = send(
        &a,
        Method::POST,
        "/api/v1/oauth/register",
        None,
        Payload::Json(json!({ "redirect_uris": [REDIRECT] })),
        Some(ip),
    )
    .await;
    assert_eq!(r.status, 429);
    assert!(r.headers.get("retry-after").is_some());
    assert_eq!(r.body["error"], "temporarily_unavailable");
    // IP khác không bị ảnh hưởng.
    assert_eq!(
        post_json(&a, "/api/v1/oauth/register", json!({ "redirect_uris": [REDIRECT] }))
            .await
            .status,
        201
    );
}

// ================================================================= authorize

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn authorize_thieu_quyen_ai_connect_la_403() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    assert_eq!(
        auth_context(&a, NOAI, &params(cid, &pkce().1, json!({}))).await.status,
        403
    );
    assert_eq!(
        auth_decision(&a, NOAI, json!({ "params": {}, "approve": true, "consent_token": "x" }))
            .await
            .status,
        403
    );
    // Không đăng nhập ⇒ 401.
    let r = send(
        &a,
        Method::POST,
        "/api/v1/oauth/authorize/context",
        None,
        Payload::Json(json!({})),
        None,
    )
    .await;
    assert_eq!(r.status, 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn client_la_va_redirect_uri_sai_khong_redirect() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    let challenge = pkce().1;
    let r = auth_context(&a, AIA, &params("trn_c_nope", &challenge, json!({}))).await;
    assert_eq!((r.status.as_u16(), err(&r)), (400, "invalid_client"));
    for uri in [
        "https://evil.example.com/cb",
        "https://client.example.com/cb/../x",
        "https://client.example.com/cb?a=1",
        "http://client.example.com/cb",
    ] {
        let r = auth_context(&a, AIA, &params(cid, &challenge, json!({ "redirect_uri": uri }))).await;
        assert_eq!(r.status, 400, "{uri}");
        assert_eq!(err(&r), "invalid_request", "{uri}");
        assert!(r.body.get("redirect_to").is_none(), "{uri}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn pkce_response_type_scope_resource_loi_redirect_ve_client() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    let challenge = pkce().1;
    let cases = [
        (json!({ "code_challenge_method": "plain" }), "invalid_request"),
        (json!({ "code_challenge": null }), "invalid_request"),
        (json!({ "code_challenge": "short" }), "invalid_request"),
        (json!({ "response_type": "token" }), "unsupported_response_type"),
        (json!({ "scope": "crm.read admin.root" }), "invalid_scope"),
        (json!({ "resource": "https://evil.example.com/mcp" }), "invalid_target"),
    ];
    for (over, want) in cases {
        let r = auth_context(&a, AIA, &params(cid, &challenge, over.clone())).await;
        assert_eq!(r.status, 200, "{over}");
        assert_eq!(r.body["ok"], false, "{over}");
        let u = url::Url::parse(r.body["redirect_to"].as_str().unwrap()).unwrap();
        assert_eq!(format!("{}{}", u.origin().ascii_serialization(), u.path()), REDIRECT);
        let q: BTreeMap<String, String> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(q["error"], want, "{over}");
        assert_eq!(q["state"], "st-123");
        assert_eq!(q["iss"], ISS);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn context_tra_thong_tin_hien_thi() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({ "client_name": "Trợ lý X" })).await;
    let r = auth_context(
        &a,
        AIA,
        &params(
            c["client_id"].as_str().unwrap(),
            &pkce().1,
            json!({ "scope": "crm.read crm.write" }),
        ),
    )
    .await;
    assert_eq!(r.status, 200);
    let b = &r.body;
    assert_eq!(b["client"]["name"], "Trợ lý X");
    assert_eq!(b["client"]["redirect_host"], "client.example.com");
    assert_eq!(b["client"]["loopback"], false);
    assert_eq!(b["client"]["known_as"], Value::Null);
    let scopes: Vec<&str> = b["scopes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["scope"].as_str().unwrap())
        .collect();
    assert_eq!(scopes, ["crm.read", "crm.write"]);
    assert_eq!(
        (b["scopes"][1]["available"].clone(), b["scopes"][1]["optional"].clone()),
        (json!(true), json!(true))
    );
    assert_eq!(b["expires_in"], 600);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn decision_consent_token_sai_va_tu_choi() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let p = params(c["client_id"].as_str().unwrap(), &pkce().1, json!({}));
    let ctx = auth_context(&a, AIA, &p).await;
    let tok = ctx.body["consent_token"].as_str().unwrap().to_owned();
    let st = |r: Res| r.status.as_u16();
    // Người khác dùng token của A; đổi scope; đổi challenge; token giả; thiếu consent_token.
    assert_eq!(
        st(auth_decision(&a, AIB, json!({ "params": p, "approve": true, "consent_token": tok })).await),
        400
    );
    let mut p2 = p.clone();
    p2["scope"] = json!("crm.read crm.write");
    assert_eq!(
        st(auth_decision(&a, AIA, json!({ "params": p2, "approve": true, "consent_token": tok })).await),
        400
    );
    let mut p3 = p.clone();
    p3["code_challenge"] = json!(pkce().1);
    assert_eq!(
        st(auth_decision(&a, AIA, json!({ "params": p3, "approve": true, "consent_token": tok })).await),
        400
    );
    assert_eq!(
        st(auth_decision(
            &a,
            AIA,
            json!({ "params": p, "approve": true, "consent_token": format!("{tok}x") })
        )
        .await),
        400
    );
    assert_eq!(
        st(auth_decision(&a, AIA, json!({ "params": p, "approve": true })).await),
        400
    );
    assert_eq!(scalar::<i64>("SELECT count(*) FROM oauth_authorization_codes").await, 0);
    // granted_scopes sai kiểu hoặc rộng hơn đã hiển thị.
    for g in [json!("crm.read"), json!(["crm.write"]), json!([])] {
        let r = auth_decision(
            &a,
            AIA,
            json!({ "params": p, "approve": true, "consent_token": tok, "granted_scopes": g }),
        )
        .await;
        assert_eq!(r.status, 400, "{g}");
    }
    let deny = auth_decision(&a, AIA, json!({ "params": p, "approve": false, "consent_token": tok })).await;
    assert_eq!(deny.status, 200);
    let u = url::Url::parse(deny.body["redirect_to"].as_str().unwrap()).unwrap();
    let q: BTreeMap<String, String> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    assert_eq!(q["error"], "access_denied");
    assert!(!q.contains_key("code"));
    assert_eq!(q["state"], "st-123");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn nguoi_dung_bo_scope_tuy_chon_crm_write() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    let (verifier, challenge) = pkce();
    let p = params(cid, &challenge, json!({ "scope": "crm.read crm.write" }));
    let ctx = auth_context(&a, AIA, &p).await;
    // Bỏ crm.write ⇒ chỉ cấp crm.read; bỏ crm.read (bắt buộc) ⇒ từ chối.
    let bad = auth_decision(&a, AIA, json!({ "params": p, "approve": true, "consent_token": ctx.body["consent_token"], "granted_scopes": ["crm.write"] })).await;
    assert_eq!(bad.status, 400);
    let dec = auth_decision(&a, AIA, json!({ "params": p, "approve": true, "consent_token": ctx.body["consent_token"], "granted_scopes": ["crm.read"] })).await;
    assert_eq!(dec.status, 200, "{:?}", dec.body);
    let u = url::Url::parse(dec.body["redirect_to"].as_str().unwrap()).unwrap();
    let code = u.query_pairs().find(|(k, _)| k == "code").unwrap().1.into_owned();
    let t = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", REDIRECT),
            ("code_verifier", &verifier),
            ("client_id", cid),
        ],
    )
    .await;
    assert_eq!(t.body["scope"], "crm.read");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn loopback_claude_code_nhan_moi_cong() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({ "redirect_uris": ["http://localhost/callback"] })).await;
    let cid = c["client_id"].as_str().unwrap();
    let challenge = pkce().1;
    let ok = auth_context(
        &a,
        AIA,
        &params(
            cid,
            &challenge,
            json!({ "redirect_uri": "http://localhost:3118/callback" }),
        ),
    )
    .await;
    assert_eq!(ok.body["ok"], true, "{:?}", ok.body);
    assert_eq!(ok.body["client"]["loopback"], true);
    let bad = auth_context(
        &a,
        AIA,
        &params(
            cid,
            &challenge,
            json!({ "redirect_uri": "http://localhost:3118/other" }),
        ),
    )
    .await;
    assert_eq!(bad.status, 400);
}

// ================================================================= token

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn luong_day_du_va_dung_lai_ma_thu_hoi_chuoi() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let (verifier, challenge) = pkce();
    let err_of = |over: Vec<(&'static str, String)>| {
        let a = &a;
        let (cid, verifier) = (cid.clone(), verifier.clone());
        async move {
            let mut f: BTreeMap<&str, String> = BTreeMap::from([
                ("grant_type", "authorization_code".to_owned()),
                ("redirect_uri", REDIRECT.to_owned()),
                ("client_id", cid),
                ("code_verifier", verifier),
            ]);
            for (k, v) in over {
                f.insert(k, v);
            }
            let pairs: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
            form(a, "/api/v1/oauth/token", &pairs).await
        }
    };

    // PKCE sai ⇒ đốt mã.
    let a1 = authorize_code(&a, AIA, &params(&cid, &challenge, json!({}))).await;
    let wrong = err_of(vec![("code", a1.clone()), ("code_verifier", pkce().0)]).await;
    assert_eq!((wrong.status.as_u16(), err(&wrong)), (400, "invalid_grant"));
    assert_eq!(err(&err_of(vec![("code", a1)]).await), "invalid_grant");
    // redirect_uri khác lúc xin mã.
    let a2 = authorize_code(&a, AIA, &params(&cid, &challenge, json!({}))).await;
    assert_eq!(
        err(&err_of(vec![
            ("redirect_uri", "https://client.example.com/other".to_owned()),
            ("code", a2)
        ])
        .await),
        "invalid_grant"
    );
    // Client khác dùng mã.
    let other = register(&a, json!({})).await;
    let a3 = authorize_code(&a, AIA, &params(&cid, &challenge, json!({}))).await;
    assert_eq!(
        err(&err_of(vec![
            ("client_id", other["client_id"].as_str().unwrap().to_owned()),
            ("code", a3)
        ])
        .await),
        "invalid_grant"
    );
    // Thành công.
    let a4 = authorize_code(&a, AIA, &params(&cid, &challenge, json!({}))).await;
    let ok = err_of(vec![("code", a4.clone())]).await;
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    assert_eq!(ok.headers["cache-control"], "no-store");
    assert_eq!(ok.headers["pragma"], "no-cache");
    let t = &ok.body;
    assert_eq!(
        (t["token_type"].clone(), t["expires_in"].clone(), t["scope"].clone()),
        (json!("Bearer"), json!(3600), json!("crm.read"))
    );
    let (at, rt) = (
        t["access_token"].as_str().unwrap(),
        t["refresh_token"].as_str().unwrap(),
    );
    assert!(at.starts_with("trn_at_") && rt.starts_with("trn_rt_"));
    // DB chỉ có băm SHA-256, không có giá trị gốc.
    assert_eq!(
        scalar::<String>("SELECT access_hash FROM oauth_tokens ORDER BY id LIMIT 1").await,
        sha256(at)
    );
    let dump = scalar::<String>("SELECT row_to_json(t)::text FROM oauth_tokens t ORDER BY id LIMIT 1").await;
    assert!(!dump.contains(at) && !dump.contains(rt));
    assert_eq!(
        scalar::<i64>(
            "SELECT length(code_hash)::bigint FROM oauth_authorization_codes WHERE used_at IS NOT NULL ORDER BY id DESC LIMIT 1"
        )
        .await,
        64
    );
    // Client KHÁC dùng lại mã đã đổi ⇒ invalid_grant nhưng KHÔNG thu hồi phiên của nạn nhân.
    let oid = other["client_id"].as_str().unwrap().to_owned();
    assert_eq!(
        err(&err_of(vec![("client_id", oid), ("code", a4.clone())]).await),
        "invalid_grant"
    );
    assert!(
        scalar::<Option<chrono::DateTime<chrono::Utc>>>("SELECT revoked_at FROM oauth_tokens LIMIT 1")
            .await
            .is_none()
    );
    // Đúng client dùng lại ⇒ thu hồi chuỗi sinh từ mã.
    assert_eq!(err(&err_of(vec![("code", a4)]).await), "invalid_grant");
    assert!(
        scalar::<Option<chrono::DateTime<chrono::Utc>>>("SELECT revoked_at FROM oauth_tokens LIMIT 1")
            .await
            .is_some()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ma_het_han_60_giay_bi_tu_choi() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    let (verifier, challenge) = pkce();
    let code = authorize_code(&a, AIA, &params(cid, &challenge, json!({}))).await;
    // Mã sống 60 giây (±2 giây so với giờ DB).
    let ttl =
        scalar::<i64>("SELECT extract(epoch FROM expires_at - created_at)::bigint FROM oauth_authorization_codes")
            .await;
    assert!((58..=62).contains(&ttl), "{ttl}");
    exec("UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 second'").await;
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("redirect_uri", REDIRECT),
            ("client_id", cid),
            ("code", &code),
            ("code_verifier", &verifier),
        ],
    )
    .await;
    assert_eq!(err(&r), "invalid_grant");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn refresh_xoay_vong_va_dung_lai_thu_hoi_ca_chuoi() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t1 = full_tokens(&a, AIA, &cid, None).await;
    let refresh = |rt: String| {
        let (a, cid) = (&a, cid.clone());
        async move {
            form(
                a,
                "/api/v1/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &rt),
                    ("client_id", &cid),
                ],
            )
            .await
        }
    };
    let r1 = refresh(t1["refresh_token"].as_str().unwrap().to_owned()).await;
    assert_eq!(r1.status, 200, "{:?}", r1.body);
    let n1 = r1.body.clone();
    assert_ne!(n1["refresh_token"], t1["refresh_token"]);
    assert_ne!(n1["access_token"], t1["access_token"]);
    let works = |tok: &Value| {
        let ctx = a.ctx.clone();
        let tok = tok.as_str().unwrap().to_owned();
        async move { ctx.verify_access_token(&tok).await.is_some() }
    };
    assert!(works(&n1["access_token"]).await);
    // Refresh song song cùng token trong cửa sổ 10 giây ⇒ lành tính, cấp cặp mới cùng chuỗi.
    let parallel = refresh(t1["refresh_token"].as_str().unwrap().to_owned()).await;
    assert_eq!(parallel.status, 200, "{:?}", parallel.body);
    assert!(works(&n1["access_token"]).await);
    // Ăn cắp: dùng lại refresh cũ QUÁ cửa sổ.
    exec("UPDATE oauth_tokens SET refresh_used_at = now() - interval '1 minute' WHERE refresh_used_at IS NOT NULL")
        .await;
    let reuse = refresh(t1["refresh_token"].as_str().unwrap().to_owned()).await;
    assert_eq!((reuse.status.as_u16(), err(&reuse)), (400, "invalid_grant"));
    assert!(!works(&n1["access_token"]).await);
    assert!(!works(&parallel.body["access_token"]).await);
    assert_eq!(
        err(&refresh(n1["refresh_token"].as_str().unwrap().to_owned()).await),
        "invalid_grant"
    );
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM integration_audit_logs WHERE action = 'oauth.refresh_reuse'").await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn refresh_client_khac_scope_rong_hon_va_het_han() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let other = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t = full_tokens(&a, AIA, &cid, None).await;
    let rt = t["refresh_token"].as_str().unwrap().to_owned();
    let call = |over: Vec<(&'static str, String)>| {
        let (a, cid, rt) = (&a, cid.clone(), rt.clone());
        async move {
            let mut f: BTreeMap<&str, String> = BTreeMap::from([
                ("grant_type", "refresh_token".to_owned()),
                ("refresh_token", rt),
                ("client_id", cid),
            ]);
            for (k, v) in over {
                f.insert(k, v);
            }
            let pairs: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
            form(a, "/api/v1/oauth/token", &pairs).await
        }
    };
    assert_eq!(
        err(&call(vec![("client_id", other["client_id"].as_str().unwrap().to_owned())]).await),
        "invalid_grant"
    );
    assert_eq!(
        err(&call(vec![("scope", "crm.read crm.write".to_owned())]).await),
        "invalid_scope"
    );
    // Gửi lại đúng scope đã cấp (kèm offline_access) ⇒ không invalid_scope oan.
    let ok = call(vec![("scope", "crm.read offline_access".to_owned())]).await;
    assert_eq!(ok.status, 200, "{:?}", ok.body);
    exec("UPDATE oauth_tokens SET refresh_expires_at = now() - interval '1 second', refresh_used_at = NULL, revoked_at = NULL").await;
    assert_eq!(err(&call(vec![]).await), "invalid_grant");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn user_bi_khoa_hoac_mat_quyen_thi_token_chet() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t = full_tokens(&a, AIA, &cid, None).await;
    let at = t["access_token"].as_str().unwrap().to_owned();
    assert!(a.ctx.verify_access_token(&at).await.is_some());
    exec("UPDATE users SET status = 'locked' WHERE id = 9701").await;
    assert!(a.ctx.verify_access_token(&at).await.is_none());
    exec("UPDATE users SET status = 'active' WHERE id = 9701").await;
    assert!(a.ctx.verify_access_token(&at).await.is_some());
    // Gỡ quyền ai_connect (+ xoá cache RBAC) ⇒ refresh bị từ chối.
    exec("DELETE FROM role_permissions WHERE permission = 'integrations.ai_connect' AND role_id = 9701").await;
    a.cache.invalidate_users(1, trinity_rbac::cache::Users::All).await;
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", t["refresh_token"].as_str().unwrap()),
            ("client_id", &cid),
        ],
    )
    .await;
    assert_eq!((r.status.as_u16(), err(&r)), (400, "invalid_grant"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn revoke_rfc7009_luon_200() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t = full_tokens(&a, AIA, &cid, None).await;
    let (at, rt) = (
        t["access_token"].as_str().unwrap(),
        t["refresh_token"].as_str().unwrap(),
    );
    assert_eq!(
        form(
            &a,
            "/api/v1/oauth/revoke",
            &[("token", "khong-ton-tai"), ("client_id", &cid)]
        )
        .await
        .status,
        200
    );
    let other = register(&a, json!({})).await;
    let oid = other["client_id"].as_str().unwrap();
    assert_eq!(
        form(&a, "/api/v1/oauth/revoke", &[("token", at), ("client_id", oid)])
            .await
            .status,
        200
    ); // client khác: vô tác dụng
    assert!(a.ctx.verify_access_token(at).await.is_some());
    let r = form(&a, "/api/v1/oauth/revoke", &[("token", rt), ("client_id", &cid)]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, json!({}));
    assert!(a.ctx.verify_access_token(at).await.is_none());
    // Thiếu client_id ⇒ invalid_client 401 kèm WWW-Authenticate.
    let r = form(&a, "/api/v1/oauth/revoke", &[("token", at)]).await;
    assert_eq!(r.status, 401);
    assert_eq!(r.headers["www-authenticate"], "Basic realm=\"oauth\"");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn token_het_han_hoac_audience_sai_khong_dung_duoc() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let t = full_tokens(&a, AIA, c["client_id"].as_str().unwrap(), None).await;
    let at = t["access_token"].as_str().unwrap();
    exec("UPDATE oauth_tokens SET resource = 'https://evil.example.com/mcp'").await;
    assert!(a.ctx.verify_access_token(at).await.is_none());
    exec(&format!(
        "UPDATE oauth_tokens SET resource = '{MCP}', access_expires_at = now() - interval '1 second'"
    ))
    .await;
    assert!(a.ctx.verify_access_token(at).await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn client_secret_post_sai_hoac_thieu_la_401() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({ "token_endpoint_auth_method": "client_secret_post" })).await;
    let cid = c["client_id"].as_str().unwrap();
    let secret = c["client_secret"].as_str().unwrap();
    assert!(secret.starts_with("trn_s_"));
    let (verifier, challenge) = pkce();
    let code = authorize_code(&a, AIA, &params(cid, &challenge, json!({}))).await;
    let base = [
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT),
        ("client_id", cid),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    let no = form(&a, "/api/v1/oauth/token", &base).await;
    assert_eq!((no.status.as_u16(), err(&no)), (401, "invalid_client"));
    let mut wrong = base.to_vec();
    wrong.push(("client_secret", "sai"));
    assert_eq!(form(&a, "/api/v1/oauth/token", &wrong).await.status, 401);
    assert_eq!(
        scalar::<String>("SELECT client_secret_hash FROM oauth_clients LIMIT 1").await,
        sha256(secret)
    );
    let mut good = base.to_vec();
    good.push(("client_secret", secret));
    assert_eq!(form(&a, "/api/v1/oauth/token", &good).await.status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn grant_la_va_thieu_tham_so() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    for g in ["password", "client_credentials", "implicit"] {
        let r = form(&a, "/api/v1/oauth/token", &[("grant_type", g), ("client_id", cid)]).await;
        assert_eq!((r.status.as_u16(), err(&r)), (400, "unsupported_grant_type"), "{g}");
    }
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[("grant_type", "authorization_code"), ("client_id", cid)],
    )
    .await;
    assert_eq!(err(&r), "invalid_request");
    // JSON cũng được nhận (Nest nhận cả hai).
    let r = post_json(
        &a,
        "/api/v1/oauth/token",
        json!({ "grant_type": "refresh_token", "client_id": cid }),
    )
    .await;
    assert_eq!(err(&r), "invalid_request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn nhat_ky_khong_chua_token_hay_ma() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let t = full_tokens(&a, AIA, c["client_id"].as_str().unwrap(), None).await;
    let actions: Vec<String> = sqlx::query_scalar::<_, String>(
        "SELECT action FROM integration_audit_logs WHERE channel = 'mcp' ORDER BY action",
    )
    .fetch_all(&mut PgConnection::connect(&url()).await.unwrap())
    .await
    .unwrap();
    assert_eq!(actions, ["oauth.authorize", "oauth.register", "oauth.token_issued"]);
    let dump =
        scalar::<String>("SELECT coalesce(string_agg(row_to_json(l)::text, ''), '') FROM integration_audit_logs l")
            .await;
    assert!(
        !dump.contains(t["access_token"].as_str().unwrap()) && !dump.contains(t["refresh_token"].as_str().unwrap())
    );
}

// ================================================================= kết nối AI

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn danh_sach_va_thu_hoi_ket_noi_ai() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({ "client_name": "Claude test" })).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let ta = full_tokens(&a, AIA, &cid, None).await;
    full_tokens(&a, AIB, &cid, None).await;
    // Refresh vẫn là một chuỗi.
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", ta["refresh_token"].as_str().unwrap()),
            ("client_id", &cid),
        ],
    )
    .await;
    assert_eq!(r.status, 200);

    let list = |u: i32, qs: &'static str| {
        let a = &a;
        async move {
            send(
                a,
                Method::GET,
                &format!("/api/v1/integrations/ai-connections{qs}"),
                Some(u),
                Payload::None,
                None,
            )
            .await
        }
    };
    let mine = list(AIA, "").await;
    assert_eq!(mine.status, 200, "{:?}", mine.body);
    let md = mine.body["data"].as_array().unwrap().clone();
    assert_eq!(md.len(), 1);
    assert_eq!(md[0]["client_name"], "Claude test");
    assert_eq!(md[0]["scopes"], json!(["crm.read"]));
    assert_eq!(md[0]["user"]["id"], AIA);
    assert!(md[0]["connected_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(list(AIA, "?scope=all").await.status, 404); // không phải ai_admin
    let all = list(ADM, "?scope=all").await;
    assert_eq!(all.status, 200);
    assert_eq!(all.body["data"].as_array().unwrap().len(), 2);

    let remove = |u: i32, id: String| {
        let a = &a;
        async move {
            send(
                a,
                Method::DELETE,
                &format!("/api/v1/integrations/ai-connections/{id}"),
                Some(u),
                Payload::None,
                None,
            )
            .await
        }
    };
    let fam_a = md[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(remove(AIB, fam_a.clone()).await.status, 404);
    assert_eq!(remove(AIA, fam_a).await.status, 204);
    assert_eq!(list(AIA, "").await.body["data"].as_array().unwrap().len(), 0);
    let fam_b = all.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["user"]["id"] == AIB)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(remove(ADM, fam_b).await.status, 204);
    assert_eq!(remove(ADM, "khong-phai-uuid".to_owned()).await.status, 404);
    // Nhật ký thu hồi ghi chủ sở hữu hay quản trị.
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM integration_audit_logs WHERE action = 'oauth.revoke'").await,
        2
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ket_noi_ai_khong_quyen_la_403() {
    setup().await;
    let a = app().await;
    let g = send(
        &a,
        Method::GET,
        "/api/v1/integrations/ai-connections",
        Some(NOAI),
        Payload::None,
        None,
    )
    .await;
    assert_eq!(g.status, 403);
    let d = send(
        &a,
        Method::DELETE,
        "/api/v1/integrations/ai-connections/x",
        Some(NOAI),
        Payload::None,
        None,
    )
    .await;
    assert_eq!(d.status, 403);
}

// ================================================================= CIMD

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cimd_ssrf_client_id_noi_bo_bi_chan() {
    setup().await;
    let a = app().await; // cờ private TẮT
    for id in [
        "https://127.0.0.1/c.json",
        "https://localhost/c.json",
        "https://169.254.169.254/latest/meta.json",
        "https://10.0.0.5/c.json",
        "https://[::1]/c.json",
        "https://0x7f000001/c.json",
    ] {
        let r = auth_context(&a, AIA, &params(id, &pkce().1, json!({}))).await;
        assert_eq!(r.status, 400, "{id}");
        assert_eq!(err(&r), "invalid_client", "{id}");
    }
    for id in [
        "https://example.com/",
        "https://example.com",
        "https://example.com/a/../b.json",
        "https://u:p@example.com/c.json",
        "https://example.com/c.json#x",
    ] {
        assert_eq!(
            auth_context(&a, AIA, &params(id, &pkce().1, json!({}))).await.status,
            400,
            "{id}"
        );
    }
    // http không phải CIMD khi cờ private tắt ⇒ tra như client thường ⇒ không tồn tại.
    assert_eq!(
        auth_context(&a, AIA, &params("http://127.0.0.1:9/x.json", &pkce().1, json!({})))
            .await
            .status,
        400
    );
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM oauth_clients WHERE kind = 'cimd'").await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cimd_host_ngoai_danh_sach_bi_tu_choi() {
    setup().await;
    let mut env = default_env();
    env.push(("INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS", "allowed.example"));
    let a = app_with(&env).await;
    let r = auth_context(
        &a,
        AIA,
        &params("https://chatgpt.com/client.json", &pkce().1, json!({})),
    )
    .await;
    assert_eq!((r.status.as_u16(), err(&r)), (400, "invalid_client"));
}

/// Máy chủ metadata tối giản trên 127.0.0.1: `/<đường dẫn>` ⇒ JSON trong `docs`.
async fn metadata_server(docs: Arc<std::sync::Mutex<BTreeMap<String, Value>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let docs = docs.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let doc = docs.lock().unwrap().get(&path).cloned();
                let resp = match doc {
                    Some(d) => {
                        let body = d.to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: max-age=600\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    }
                    None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned(),
                };
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    format!("http://127.0.0.1:{}", addr.port())
}

fn private_env() -> Vec<(&'static str, &'static str)> {
    let mut e = default_env();
    e.push(("INTEGRATIONS_ALLOW_PRIVATE_TARGETS", "true"));
    e
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cimd_tai_metadata_cache_va_tu_choi() {
    setup().await;
    let a = app_with(&private_env()).await;
    let docs = Arc::new(std::sync::Mutex::new(BTreeMap::new()));
    let origin = metadata_server(docs.clone()).await;
    let id = format!("{origin}/client.json");
    docs.lock().unwrap().insert(
        "/client.json".into(),
        json!({
            "client_id": id, "client_name": "CIMD App", "redirect_uris": [REDIRECT],
            "token_endpoint_auth_method": "none", "logo_uri": "https://client.example.com/logo.png",
        }),
    );
    let p = params(&id, &pkce().1, json!({}));
    let ctx = auth_context(&a, AIA, &p).await;
    assert_eq!(ctx.status, 200, "{:?}", ctx.body);
    assert_eq!(ctx.body["client"]["name"], "CIMD App");
    assert_eq!(ctx.body["client"]["kind"], "cimd");
    assert_eq!(ctx.body["client"]["logo_uri"], "https://client.example.com/logo.png");
    assert!(
        scalar::<Option<chrono::DateTime<chrono::Utc>>>(&format!(
            "SELECT metadata_expires_at FROM oauth_clients WHERE client_id = '{id}'"
        ))
        .await
        .is_some()
    );
    // Cache: sửa tài liệu rồi hỏi lại trong hạn ⇒ vẫn bản cũ.
    docs.lock().unwrap().insert(
        "/client.json".into(),
        json!({ "client_id": id, "client_name": "Đổi tên", "redirect_uris": [REDIRECT] }),
    );
    assert_eq!(auth_context(&a, AIA, &p).await.body["client"]["name"], "CIMD App");

    // client_id trong tài liệu khác URL.
    let id2 = format!("{origin}/mismatch.json");
    docs.lock().unwrap().insert(
        "/mismatch.json".into(),
        json!({ "client_id": format!("{origin}/other.json"), "client_name": "x", "redirect_uris": [REDIRECT] }),
    );
    let bad = auth_context(&a, AIA, &params(&id2, &pkce().1, json!({}))).await;
    assert_eq!((bad.status.as_u16(), err(&bad)), (400, "invalid_client"));
    // redirect_uri không có trong tài liệu.
    let r = auth_context(
        &a,
        AIA,
        &params(&id, &pkce().1, json!({ "redirect_uri": "https://evil.example.com/cb" })),
    )
    .await;
    assert_eq!((r.status.as_u16(), err(&r)), (400, "invalid_request"));
    // CIMD không được có shared secret.
    let id3 = format!("{origin}/secret.json");
    docs.lock().unwrap().insert("/secret.json".into(), json!({ "client_id": id3, "client_name": "x", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_post" }));
    assert_eq!(
        err(&auth_context(&a, AIA, &params(&id3, &pkce().1, json!({}))).await),
        "invalid_client"
    );
    // Endpoint token KHÔNG tải URL ngoài: CIMD chưa từng qua màn đồng ý ⇒ invalid_client.
    let t = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", "x"),
            ("client_id", &format!("{origin}/never-seen.json")),
        ],
    )
    .await;
    assert_eq!(t.status, 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cimd_luong_day_du() {
    setup().await;
    let a = app_with(&private_env()).await;
    let docs = Arc::new(std::sync::Mutex::new(BTreeMap::new()));
    let origin = metadata_server(docs.clone()).await;
    let id = format!("{origin}/full.json");
    docs.lock().unwrap().insert(
        "/full.json".into(),
        json!({ "client_id": id, "client_name": "Full", "redirect_uris": [REDIRECT] }),
    );
    let t = full_tokens(&a, AIA, &id, None).await;
    assert!(t["access_token"].as_str().unwrap().starts_with("trn_at_"));
    assert!(
        a.ctx
            .verify_access_token(t["access_token"].as_str().unwrap())
            .await
            .is_some()
    );
}

// ================================================================= INERT

async fn assert_inert(a: &App) {
    let st = |r: Res| r.status.as_u16();
    assert_eq!(
        st(send(
            a,
            Method::GET,
            "/api/v1/oauth/.well-known/oauth-authorization-server",
            None,
            Payload::None,
            None
        )
        .await),
        404
    );
    assert_eq!(
        st(send(
            a,
            Method::GET,
            "/api/v1/oauth/protected-resource",
            None,
            Payload::None,
            None
        )
        .await),
        404
    );
    assert_eq!(
        st(post_json(a, "/api/v1/oauth/register", json!({ "redirect_uris": [REDIRECT] })).await),
        404
    );
    assert_eq!(
        st(post_json(a, "/api/v1/oauth/token", json!({ "grant_type": "refresh_token" })).await),
        404
    );
    assert_eq!(
        st(post_json(a, "/api/v1/oauth/revoke", json!({ "token": "x" })).await),
        404
    );
    assert_eq!(st(auth_context(a, AIA, &json!({})).await), 404);
    assert_eq!(st(auth_decision(a, AIA, json!({})).await), 404);
    assert_eq!(
        st(send(
            a,
            Method::GET,
            "/api/v1/integrations/ai-connections",
            Some(AIA),
            Payload::None,
            None
        )
        .await),
        404
    );
    let r = send(
        a,
        Method::GET,
        "/api/v1/integrations/ai-connections/00000000-0000-0000-0000-000000000000",
        None,
        Payload::None,
        None,
    )
    .await;
    assert_ne!(r.status, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn co_tat_thi_inert_integrations_off() {
    setup().await;
    let a = app_with(&[
        ("NODE_ENV", "test"),
        ("JWT_SECRET", JWT),
        ("INTEGRATIONS_MCP_ENABLED", "false"),
        ("INTEGRATIONS_PUBLIC_BASE_URL", BASE),
    ])
    .await;
    assert_inert(&a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn thieu_dia_chi_goc_thi_inert() {
    setup().await;
    let a = app_with(&[
        ("NODE_ENV", "test"),
        ("JWT_SECRET", JWT),
        ("INTEGRATIONS_MCP_ENABLED", "true"),
    ])
    .await;
    assert_inert(&a).await;
    // Địa chỉ gốc không hợp lệ (http ngoài loopback, có path) cũng tắt.
    for bad in [
        "http://crm.example.com",
        "https://crm.example.com/app",
        "https://u:p@crm.example.com",
    ] {
        let a = app_with(&[
            ("NODE_ENV", "test"),
            ("JWT_SECRET", JWT),
            ("INTEGRATIONS_MCP_ENABLED", "true"),
            ("INTEGRATIONS_PUBLIC_BASE_URL", bad),
        ])
        .await;
        assert_eq!(
            post_json(&a, "/api/v1/oauth/register", json!({ "redirect_uris": [REDIRECT] }))
                .await
                .status,
            404,
            "{bad}"
        );
    }
}

// ================================================================= nhiều công ty

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ma_va_token_cong_ty_la_khong_dung_duoc() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap();
    // Bản một công ty: tiền tố công ty khác 1 ⇒ không có công ty đó ⇒ invalid_grant, không tra nhầm schema công ty 1.
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("code", "c7.abc"),
            ("code_verifier", &"a".repeat(43)),
            ("redirect_uri", REDIRECT),
            ("client_id", cid),
        ],
    )
    .await;
    assert_eq!((r.status.as_u16(), err(&r)), (400, "invalid_grant"));
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", "c7.abc"),
            ("client_id", cid),
        ],
    )
    .await;
    assert_eq!(err(&r), "invalid_grant");
    assert!(a.ctx.verify_access_token("c7.trn_at_x").await.is_none());
    assert!(a.ctx.verify_access_token(&"x".repeat(300)).await.is_none());
}

// ================================================================= theo review #392

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn hai_dau_refresh_chi_mot_dau_song_va_danh_sach_khong_trung() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t1 = full_tokens(&a, AIA, &cid, None).await;
    let refresh = |rt: String| {
        let (a, cid) = (&a, cid.clone());
        async move {
            form(
                a,
                "/api/v1/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", &rt),
                    ("client_id", &cid),
                ],
            )
            .await
        }
    };
    let r0 = t1["refresh_token"].as_str().unwrap().to_owned();
    let h1 = refresh(r0.clone()).await; // thắng
    let h2 = refresh(r0).await; // trùng lặp trong cửa sổ ⇒ đầu thứ hai
    assert_eq!((h1.status.as_u16(), h2.status.as_u16()), (200, 200));
    // Danh sách kết nối chỉ một dòng dù chuỗi có hai đầu.
    let l = send(
        &a,
        Method::GET,
        "/api/v1/integrations/ai-connections",
        Some(AIA),
        Payload::None,
        None,
    )
    .await;
    assert_eq!(l.body["data"].as_array().unwrap().len(), 1, "{:?}", l.body);
    // Một đầu xoay ⇒ đầu kia bị đánh dấu đã dùng; dùng nó SAU cửa sổ ⇒ coi là dùng lại ⇒ thu hồi cả chuỗi.
    let h3 = refresh(h1.body["refresh_token"].as_str().unwrap().to_owned()).await;
    assert_eq!(h3.status, 200, "{:?}", h3.body);
    exec("UPDATE oauth_tokens SET refresh_used_at = refresh_used_at - interval '1 minute' WHERE refresh_used_at IS NOT NULL").await;
    let stale = refresh(h2.body["refresh_token"].as_str().unwrap().to_owned()).await;
    assert_eq!((stale.status.as_u16(), err(&stale)), (400, "invalid_grant"));
    assert!(
        a.ctx
            .verify_access_token(h3.body["access_token"].as_str().unwrap())
            .await
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn refresh_bi_thu_hoi_khong_ghi_nhat_ky_dung_lai() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t = full_tokens(&a, AIA, &cid, None).await;
    let rt = t["refresh_token"].as_str().unwrap().to_owned();
    // Đã dùng + đã thu hồi (người dùng bấm Thu hồi giữa chừng) ⇒ invalid_grant, KHÔNG phải tấn công dùng lại.
    exec("UPDATE oauth_tokens SET refresh_used_at = now() - interval '1 minute', revoked_at = now()").await;
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &rt),
            ("client_id", &cid),
        ],
    )
    .await;
    assert_eq!(err(&r), "invalid_grant");
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM integration_audit_logs WHERE action = 'oauth.refresh_reuse'").await,
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn refresh_scope_trung_lap_duoc_gop() {
    setup().await;
    let a = app().await;
    let c = register(&a, json!({})).await;
    let cid = c["client_id"].as_str().unwrap().to_owned();
    let t = full_tokens(&a, AIA, &cid, None).await;
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", t["refresh_token"].as_str().unwrap()),
            ("client_id", &cid),
            ("scope", "crm.read crm.read"),
        ],
    )
    .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["scope"], "crm.read");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn dcr_tran_5000_client_la_tran_cung_khi_dang_ky_dong_thoi() {
    setup().await;
    let a = app().await;
    exec("INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_endpoint_auth_method, metadata)
          SELECT 'trn_c_fill' || g, 'dcr', 'fill', ARRAY['https://client.example.com/cb'], 'none', '{}'::jsonb FROM generate_series(1, 4999) g").await;
    let body = |n: u32| json!({ "client_name": format!("c{n}"), "redirect_uris": [REDIRECT] });
    let (x, y) = tokio::join!(
        send(
            &a,
            Method::POST,
            "/api/v1/oauth/register",
            None,
            Payload::Json(body(1)),
            None
        ),
        send(
            &a,
            Method::POST,
            "/api/v1/oauth/register",
            None,
            Payload::Json(body(2)),
            None
        ),
    );
    let mut st = [x.status.as_u16(), y.status.as_u16()];
    st.sort_unstable();
    assert_eq!(st, [201, 503]);
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM oauth_clients WHERE kind = 'dcr'").await,
        5000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cimd_da_luu_nhung_host_ngoai_danh_sach_bi_chan_o_token() {
    setup().await;
    let mut env = default_env();
    env.push(("INTEGRATIONS_OAUTH_CIMD_ALLOWED_HOSTS", "allowed.example"));
    let a = app_with(&env).await;
    exec("INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_endpoint_auth_method, metadata)
          VALUES ('https://chatgpt.com/client.json', 'cimd', 'cũ', ARRAY['https://client.example.com/cb'], 'none', '{}'::jsonb)").await;
    let r = form(
        &a,
        "/api/v1/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", "x"),
            ("client_id", "https://chatgpt.com/client.json"),
        ],
    )
    .await;
    assert_eq!((r.status.as_u16(), err(&r)), (401, "invalid_client"));
    assert!(
        r.body["error_description"]
            .as_str()
            .unwrap()
            .contains("danh sách cho phép")
    );
}
