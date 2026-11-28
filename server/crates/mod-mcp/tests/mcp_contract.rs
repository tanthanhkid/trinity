//! Hợp đồng MCP đóng băng (C03) chạy trên lõi Rust, không cần DB: `tools/list` khớp từng byte `tools.json`, `instructions` khớp từng
//! byte `instructions.txt`, 16 ca vận chuyển `transport/*.json` (phản hồi thật của Node), cộng các luật của controller (Origin, 401/403 +
//! `WWW-Authenticate`, 405, giới hạn, batch) và của `execute` (scope, quyền, ánh xạ lỗi, cắt 40.000, nhật ký).

use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use mod_mcp::auth::{AuthError, AuthFailure, Identity, Principal, Who};
use mod_mcp::deps::ToolDeps;
use mod_mcp::endpoint::{HttpIn, McpConfig, McpEndpoint};
use mod_mcp::exec::{AuditSink, Executor, ToolCtx, ToolError, ToolOutput, ToolRegistry, ToolRunner, ToolSpec};
use mod_mcp::frozen::{Frozen, INSTRUCTIONS, TOOLS_JSON, minify};
use mod_mcp::limits::McpLimits;
use mod_mcp::protocol::BoxFuture;
use serde_json::{Value, json};
use trinity_auth::Security;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_http::edge::client_ip::{ClientIp, Source};
use trinity_integrations::audit::{AuditEntry, AuditStatus};
use trinity_rbac::{Grant, Grants, Scope};
use trinity_rbac::{RbacCache, ScopeService};

const DIR: &str = "../../contracts/mcp";
const OK_TOOL: &str = "get_setup_guide";
const BASE: &str = "https://crm.example.test";

fn dir() -> String {
    let m = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_owned());
    format!("{m}/{DIR}")
}

// ------------------------------------------------------------------ dựng endpoint giả

struct VecAudit(Mutex<Vec<(i32, AuditEntry)>>);

impl AuditSink for VecAudit {
    fn log<'a>(&'a self, company: CompanyRef, entry: AuditEntry) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.0.lock().unwrap().push((company.id(), entry)) })
    }
}

struct Stub(Result<Principal, AuthError>);

impl Identity for Stub {
    fn authenticate<'a>(&'a self, _a: Option<&'a str>) -> BoxFuture<'a, Result<Principal, AuthError>> {
        Box::pin(async move { self.0.clone() })
    }
}

fn principal(scopes: &[&str], grants: &[(&str, Grant)]) -> Principal {
    Principal {
        company: CompanyRef::DEFAULT,
        user_id: 1,
        email: "a@x.vn".into(),
        client_id: "c".into(),
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        token_id: 1,
        grants: grants.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect::<Grants>(),
    }
}

type Run = dyn Fn(&Value) -> Result<ToolOutput, ToolError> + Send + Sync;

struct FnRunner(Arc<Run>);

impl ToolRunner for FnRunner {
    fn run<'a>(&'a self, args: &'a Value, _c: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move { (self.0)(args) })
    }
}

fn ok_output() -> ToolOutput {
    ToolOutput {
        text: Some("ok".into()),
        structured: json!({ "notice": "", "data": {} }),
    }
}

/// Đăng ký `run` cho MỌI tool của hợp đồng (như harness C03 chặn `execute`).
fn registry_all(run: Arc<Run>) -> ToolRegistry {
    let mut r = ToolRegistry::new();
    for n in Frozen::embedded().names() {
        let name: &'static str = Box::leak(n.clone().into_boxed_str());
        r.register(ToolSpec {
            name,
            scope: None,
            permissions: &[],
            runner: Arc::new(FnRunner(run.clone())),
        });
    }
    r
}

/// Phụ thuộc tool giả: DB lười (không bao giờ nối vì các tool giả không đụng DB).
fn lazy_deps() -> Arc<ToolDeps> {
    let db = Db::connect_lazy(&DbConfig::new("postgresql://u@127.0.0.1:1/x")).unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let scopes = ScopeService::new(db.clone(), RbacCache::new(security));
    let reports = Arc::new(mod_reports::Ctx {
        db: db.clone(),
        scopes: scopes.clone(),
        cache: mod_reports::cache::ReadCache::new(true),
    });
    Arc::new(ToolDeps {
        db,
        scopes,
        reports,
        social: None,
    })
}

struct Rig {
    ep: McpEndpoint,
    audit: Arc<VecAudit>,
}

fn rig(identity: Result<Principal, AuthError>, registry: ToolRegistry, enabled: bool) -> Rig {
    let audit = Arc::new(VecAudit(Mutex::new(Vec::new())));
    let limits = Arc::new(McpLimits::new());
    let ep = McpEndpoint {
        config: McpConfig {
            enabled,
            base: Some(BASE.into()),
            allowed_origins: BTreeSet::from([BASE.to_owned(), "https://claude.ai".to_owned()]),
        },
        frozen: Arc::new(Frozen::embedded()),
        identity: Arc::new(Stub(identity)),
        limits: limits.clone(),
        exec: Executor {
            registry,
            limits,
            audit: audit.clone(),
            deps: lazy_deps(),
            base_url: BASE.into(),
        },
        audit: audit.clone(),
    };
    Rig { ep, audit }
}

fn default_rig() -> Rig {
    rig(
        Ok(principal(&["crm.read", "crm.write"], &[])),
        registry_all(Arc::new(|_| Ok(ok_output()))),
        true,
    )
}

fn client() -> ClientIp {
    ClientIp {
        ip: Some("203.0.113.9".parse::<IpAddr>().unwrap()),
        rate_key: "203.0.113.9".into(),
        untrusted_reason: None,
        source: Source::Edge,
    }
}

#[derive(Debug, Clone)]
struct Reply {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }

    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(h, _)| *h == k).map(|(_, v)| v.as_str())
    }
}

async fn send(r: &Rig, method: &str, body: &[u8], extra: &[(&str, &str)]) -> Reply {
    let mut req = HttpIn {
        method: method.to_owned(),
        origin: None,
        authorization: Some("Bearer t".into()),
        accept: Some("application/json, text/event-stream".into()),
        content_type: Some("application/json".into()),
        protocol_version: None,
        body: body.to_vec(),
        client: client(),
    };
    for (k, v) in extra {
        let v = Some((*v).to_owned());
        match *k {
            "origin" => req.origin = v,
            "authorization" => req.authorization = v,
            "accept" => req.accept = v,
            "content-type" => req.content_type = v,
            "mcp-protocol-version" => req.protocol_version = v,
            other => panic!("header lạ {other}"),
        }
    }
    let out = r.ep.handle(req).await;
    Reply {
        status: out.status,
        headers: out.headers,
        body: String::from_utf8(out.body).unwrap(),
    }
}

async fn post(r: &Rig, body: &Value, extra: &[(&str, &str)]) -> Reply {
    send(r, "POST", body.to_string().as_bytes(), extra).await
}

fn rpc(method: &str, params: Option<Value>) -> Value {
    let mut v = json!({ "jsonrpc": "2.0", "id": 2, "method": method });
    if let Some(p) = params {
        v["params"] = p;
    }
    v
}

fn init(version: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "contract", "version": "0" } } })
}

// ------------------------------------------------------------------ in đẹp như JSON.stringify(v, null, 2)

/// In lại JSON gọn theo `JSON.stringify(v, null, 2)` mà KHÔNG đổi thứ tự khoá.
fn pretty(compact: &str) -> String {
    let mut out = String::new();
    let (mut depth, mut in_str, mut esc) = (0usize, false, false);
    let chars: Vec<char> = compact.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
        } else {
            match c {
                '"' => {
                    in_str = true;
                    out.push(c);
                }
                '{' | '[' => {
                    let close = if c == '{' { '}' } else { ']' };
                    if chars.get(i + 1) == Some(&close) {
                        out.push(c);
                        out.push(close);
                        i += 1;
                    } else {
                        depth += 1;
                        out.push(c);
                        out.push('\n');
                        out.push_str(&"  ".repeat(depth));
                    }
                }
                '}' | ']' => {
                    depth -= 1;
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                    out.push(c);
                }
                ',' => {
                    out.push(',');
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
                ':' => out.push_str(": "),
                c => out.push(c),
            }
        }
        i += 1;
    }
    out
}

/// Dạng tệp `transport/*.json` do spec TS ghi: `{ status, headers: {content-type, allow}, body }`.
fn as_golden(r: &Reply) -> String {
    let keep: Vec<String> = ["content-type", "allow"]
        .iter()
        .filter_map(|k| {
            r.header(k).map(|v| {
                format!(
                    "{}:{}",
                    serde_json::to_string(k).unwrap(),
                    serde_json::to_string(v).unwrap()
                )
            })
        })
        .collect();
    let body = if r.body.is_empty() {
        "\"\"".to_owned()
    } else {
        r.body.clone()
    };
    pretty(&format!(
        "{{\"status\":{},\"headers\":{{{}}},\"body\":{}}}",
        r.status,
        keep.join(","),
        body
    )) + "\n"
}

// ------------------------------------------------------------------ tests

#[tokio::test]
async fn tools_list_khop_tung_byte() {
    let r = default_rig();
    let rep = post(&r, &rpc("tools/list", None), &[]).await;
    assert_eq!(rep.status, 200);
    let tools = &rep.json()["result"]["tools"];
    assert_eq!(tools.as_array().unwrap().len(), 115);
    // `tools.json` ghi `{ tool_count, tools }` bằng JSON.stringify(…, null, 2): in đẹp mảng nhận về phải ra đúng tệp.
    let array = rep
        .body
        .strip_prefix("{\"result\":{\"tools\":")
        .and_then(|b| b.strip_suffix("},\"jsonrpc\":\"2.0\",\"id\":2}"))
        .expect("khung tools/list");
    let rebuilt = pretty(&format!("{{\"tool_count\":115,\"tools\":{array}}}")) + "\n";
    assert_eq!(rebuilt, TOOLS_JSON);
    assert_eq!(minify(TOOLS_JSON).matches("\"inputSchema\"").count(), 115);
}

#[tokio::test]
async fn instructions_khop_tung_byte() {
    let r = default_rig();
    let rep = post(&r, &init("2025-06-18"), &[]).await;
    assert_eq!(rep.json()["result"]["instructions"].as_str(), Some(INSTRUCTIONS));
    let file = std::fs::read_to_string(format!("{}/instructions.txt", dir())).unwrap();
    assert_eq!(file, INSTRUCTIONS);
}

#[tokio::test]
async fn ca_van_chuyen_dong_bang_khop_tung_byte() {
    let r = default_rig();
    let tool_call = |name: &str, args: Value| rpc("tools/call", Some(json!({ "name": name, "arguments": args })));
    let cases: Vec<(&str, Reply)> = vec![
        ("initialize-2025-06-18", post(&r, &init("2025-06-18"), &[]).await),
        ("initialize-2025-03-26", post(&r, &init("2025-03-26"), &[]).await),
        ("initialize-2024-11-05", post(&r, &init("2024-11-05"), &[]).await),
        ("initialize-version-la", post(&r, &init("1999-01-01"), &[]).await),
        (
            "header-protocol-version-hop-le",
            post(&r, &rpc("tools/list", None), &[("mcp-protocol-version", "2025-06-18")]).await,
        ),
        (
            "header-protocol-version-la",
            post(&r, &rpc("tools/list", None), &[("mcp-protocol-version", "1999-01-01")]).await,
        ),
        (
            "accept-thieu-406",
            post(&r, &rpc("tools/list", None), &[("accept", "application/json")]).await,
        ),
        (
            "content-type-sai-415",
            post(&r, &rpc("tools/list", None), &[("content-type", "text/plain")]).await,
        ),
        ("json-hong", send(&r, "POST", b"{khong-phai-json", &[]).await),
        ("resources-list", post(&r, &rpc("resources/list", None), &[]).await),
        ("prompts-list", post(&r, &rpc("prompts/list", None), &[]).await),
        ("phuong-thuc-la", post(&r, &rpc("khong/ton-tai", None), &[]).await),
        ("tool-la", post(&r, &tool_call("khong_co_tool", json!({})), &[]).await),
        (
            "doi-so-sai-kieu",
            post(&r, &tool_call("get_record", json!({ "id": 123 })), &[]).await,
        ),
        ("doi-so-thieu", post(&r, &tool_call("get_record", json!({})), &[]).await),
        (
            "tool-khoa-thua",
            post(&r, &tool_call(OK_TOOL, json!({ "khoa_la": "x", "khac": 1 })), &[]).await,
        ),
    ];
    assert_eq!(cases.len(), 16);
    for (name, rep) in &cases {
        let file = std::fs::read_to_string(format!("{}/transport/{name}.json", dir())).unwrap();
        let got = as_golden(rep);
        if name.starts_with("initialize-") || *name == "header-protocol-version-hop-le" {
            // Thân có `instructions` rất dài và `tools`: so cấu trúc (thứ tự khoá `result`, `jsonrpc`, `id` đã kiểm ở dưới).
            assert_eq!(
                serde_json::from_str::<Value>(&got).unwrap(),
                serde_json::from_str::<Value>(&file).unwrap(),
                "{name}"
            );
        }
        assert_eq!(got, file, "{name}");
    }
}

#[tokio::test]
async fn tool_bo_khoa_la_khong_tu_choi() {
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let s = seen.clone();
    let r = rig(
        Ok(principal(&["crm.read"], &[])),
        registry_all(Arc::new(move |a| {
            s.lock().unwrap().push(a.clone());
            Ok(ok_output())
        })),
        true,
    );
    let rep = post(
        &r,
        &rpc(
            "tools/call",
            Some(json!({ "name": OK_TOOL, "arguments": { "khoa_la": "x" } })),
        ),
        &[],
    )
    .await;
    assert!(rep.json()["result"].get("isError").is_none(), "{}", rep.body);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].get("khoa_la").is_none());
}

#[tokio::test]
async fn doi_so_sai_schema_va_ket_qua_sai_output_schema_la_iserror() {
    let r = default_rig();
    let bad = post(
        &r,
        &rpc(
            "tools/call",
            Some(json!({ "name": OK_TOOL, "arguments": { "agent": "khong-co" } })),
        ),
        &[],
    )
    .await;
    let text = bad.json()["result"]["content"][0]["text"].as_str().unwrap().to_owned();
    assert!(
        text.starts_with("MCP error -32602: Input validation error: Invalid arguments for tool get_setup_guide"),
        "{text}"
    );
    assert_eq!(bad.json()["result"]["isError"], true);
    // Tool trả `structuredContent` sai outputSchema.
    let r = rig(
        Ok(principal(&["crm.read"], &[])),
        registry_all(Arc::new(|_| {
            Ok(ToolOutput {
                text: None,
                structured: json!({ "sai": 1 }),
            })
        })),
        true,
    );
    let rep = post(
        &r,
        &rpc("tools/call", Some(json!({ "name": OK_TOOL, "arguments": {} }))),
        &[],
    )
    .await;
    let text = rep.json()["result"]["content"][0]["text"].as_str().unwrap().to_owned();
    assert!(
        text.starts_with("MCP error -32602: Structured content does not match the tool's output schema"),
        "{text}"
    );
}

#[tokio::test]
async fn thong_bao_tra_202_khong_than_va_ping() {
    let r = default_rig();
    let n = send(
        &r,
        "POST",
        br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        &[],
    )
    .await;
    assert_eq!((n.status, n.body.as_str()), (202, ""));
    assert!(n.headers.is_empty());
    let p = post(&r, &rpc("ping", None), &[]).await;
    assert_eq!(p.body, "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":2}");
    // id chuỗi được giữ nguyên.
    let s = post(&r, &json!({ "jsonrpc": "2.0", "id": "abc", "method": "ping" }), &[]).await;
    assert_eq!(s.body, "{\"result\":{},\"jsonrpc\":\"2.0\",\"id\":\"abc\"}");
}

#[tokio::test]
async fn origin_batch_co_va_405() {
    let r = default_rig();
    // Origin lạ ⇒ 403; origin trong danh sách (kể cả `/` cuối) và không có Origin ⇒ qua.
    let bad = post(&r, &rpc("ping", None), &[("origin", "https://evil.example")]).await;
    assert_eq!(bad.status, 403);
    assert_eq!(
        bad.body,
        "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"Origin không được phép\"},\"id\":null}"
    );
    assert_eq!(
        post(&r, &rpc("ping", None), &[("origin", "https://claude.ai/")])
            .await
            .status,
        200
    );
    // Batch, thân rỗng, null, chuỗi ⇒ 400 -32600; JSON hỏng ⇒ -32700 của vận chuyển.
    for body in [
        "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]",
        "",
        "  ",
        "null",
        "\"x\"",
        "5",
    ] {
        let rep = send(&r, "POST", body.as_bytes(), &[]).await;
        assert_eq!(rep.status, 400, "{body}");
        assert!(
            rep.body.contains("-32600") && rep.body.contains("không hỗ trợ batch"),
            "{}",
            rep.body
        );
    }
    assert!(send(&r, "POST", b"{x", &[]).await.body.contains("-32700"));
    // GET/DELETE ⇒ 405 kèm Allow; cờ tắt ⇒ 404.
    for m in ["GET", "DELETE"] {
        let rep = send(&r, m, b"", &[]).await;
        assert_eq!(rep.status, 405);
        assert_eq!(rep.header("allow"), Some("POST"));
        assert!(rep.body.contains("Method not allowed"));
    }
    let off = rig(
        Ok(principal(&["crm.read"], &[])),
        registry_all(Arc::new(|_| Ok(ok_output()))),
        false,
    );
    let rep = send(&off, "POST", b"{}", &[]).await;
    assert_eq!(rep.status, 404);
    assert_eq!(rep.body, "{\"statusCode\":404,\"message\":\"Not Found\"}");
    // GET/DELETE khi tắt: 404 nhưng vẫn là thân JSON-RPC (như bản TS) kèm Allow.
    for m in ["GET", "DELETE"] {
        let rep = send(&off, m, b"", &[]).await;
        assert_eq!(rep.status, 404, "{m}");
        assert_eq!(rep.header("allow"), Some("POST"));
        assert_eq!(
            rep.body,
            "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"Method not allowed\"},\"id\":null}"
        );
    }
}

#[tokio::test]
async fn loi_he_thong_khi_xac_thuc_la_500_khong_challenge_khong_dem_khong_audit() {
    let who = Some(Who {
        company: CompanyRef::DEFAULT,
        user_id: 7,
        client_id: "c".into(),
    });
    let r = rig(
        Err(AuthError {
            kind: AuthFailure::Internal,
            description: "db".into(),
            who,
        }),
        registry_all(Arc::new(|_| Ok(ok_output()))),
        true,
    );
    // 40 lần (> 30 lần xác thực sai/phút) vẫn 500, không bao giờ 429, không có WWW-Authenticate, không có nhật ký.
    for _ in 0..40 {
        let rep = post(&r, &rpc("ping", None), &[]).await;
        assert_eq!(rep.status, 500);
        assert!(rep.header("www-authenticate").is_none());
        assert_eq!(rep.body, "{\"statusCode\":500,\"message\":\"Internal server error\"}");
    }
    assert!(r.audit.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn kiem_hinh_dang_chi_khi_content_type_json() {
    let r = default_rig();
    // Content-Type sai + thân mảng ⇒ 415 của vận chuyển, không phải 400 -32600.
    let rep = send(&r, "POST", b"[1]", &[("content-type", "text/plain")]).await;
    assert_eq!(rep.status, 415);
    // Content-Type JSON + thân mảng ⇒ 400 -32600.
    assert_eq!(send(&r, "POST", b"[1]", &[]).await.status, 400);
}

#[tokio::test]
async fn xac_thuc_that_bai_co_challenge_va_nhat_ky() {
    let who = Some(Who {
        company: CompanyRef::DEFAULT,
        user_id: 7,
        client_id: "client-x".into(),
    });
    for (kind, desc, who, status, error) in [
        (AuthFailure::Missing, "Thiếu Bearer token", None, 401, "unauthorized"),
        (
            AuthFailure::InvalidToken,
            "Token không hợp lệ, đã hết hạn hoặc đã bị thu hồi",
            None,
            401,
            "invalid_token",
        ),
        (
            AuthFailure::InsufficientScope,
            "Token thiếu scope crm.read",
            who.clone(),
            403,
            "insufficient_scope",
        ),
    ] {
        let r = rig(
            Err(AuthError {
                kind,
                description: desc.into(),
                who: who.clone(),
            }),
            registry_all(Arc::new(|_| Ok(ok_output()))),
            true,
        );
        let rep = post(&r, &rpc("ping", None), &[]).await;
        assert_eq!(rep.status, status);
        assert_eq!(rep.json()["error"], error);
        assert_eq!(rep.header("cache-control"), Some("no-store"));
        let h = rep.header("www-authenticate").unwrap();
        assert!(h.starts_with("Bearer "), "{h}");
        assert!(
            h.contains(&format!("resource_metadata=\"{BASE}/api/v1/oauth/protected-resource\"")),
            "{h}"
        );
        assert!(h.contains("scope=\"crm.read crm.write\""), "{h}");
        assert_eq!(h.contains("error=\""), kind != AuthFailure::Missing, "{h}");
        assert!(h.is_ascii(), "{h}");
        // Nhật ký `denied` chỉ khi đã nhận diện được người dùng.
        let log = r.audit.0.lock().unwrap();
        assert_eq!(log.len(), usize::from(who.is_some()), "{kind:?}");
        if let Some((_, e)) = log.first() {
            assert_eq!(
                (e.action.as_str(), e.status, e.user_id, e.client_id.as_deref()),
                ("auth", AuditStatus::Denied, Some(7), Some("client-x"))
            );
        }
    }
}

#[tokio::test]
async fn gioi_han_xac_thuc_sai_240_request_va_60_loi_goi() {
    // 30 lần xác thực sai/phút/IP, lần 31 ⇒ 429 Retry-After 60.
    let r = rig(
        Err(AuthError {
            kind: AuthFailure::InvalidToken,
            description: "x".into(),
            who: None,
        }),
        registry_all(Arc::new(|_| Ok(ok_output()))),
        true,
    );
    for i in 0..30 {
        assert_eq!(post(&r, &rpc("ping", None), &[]).await.status, 401, "{i}");
    }
    let rep = post(&r, &rpc("ping", None), &[]).await;
    assert_eq!((rep.status, rep.header("retry-after")), (429, Some("60")));
    assert_eq!(rep.json()["error"], "rate_limited");

    // 240 request/phút/người ⇒ request 241 bị 429 -32000.
    let r = default_rig();
    for _ in 0..240 {
        assert_eq!(post(&r, &rpc("ping", None), &[]).await.status, 200);
    }
    let rep = post(&r, &rpc("ping", None), &[]).await;
    assert_eq!(rep.status, 429);
    assert!(rep.body.contains("Quá giới hạn yêu cầu") && rep.header("retry-after").is_some());

    // 60 lời gọi tool/phút/người: lời gọi 61 là kết quả isError (không phải 429), có nhật ký `denied`.
    let r = default_rig();
    let call = rpc("tools/call", Some(json!({ "name": OK_TOOL, "arguments": {} })));
    for _ in 0..60 {
        assert!(post(&r, &call, &[]).await.json()["result"].get("isError").is_none());
    }
    let rep = post(&r, &call, &[]).await;
    let text = rep.json()["result"]["content"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.starts_with("Quá giới hạn 60 lời gọi/phút. Thử lại sau"), "{text}");
    let log = r.audit.0.lock().unwrap();
    assert_eq!(
        log.iter()
            .filter(|(_, e)| e.status == AuditStatus::Denied && e.error.as_deref() == Some("rate_limited"))
            .count(),
        1
    );
    assert_eq!(log.iter().filter(|(_, e)| e.status == AuditStatus::Ok).count(), 60);
}

fn call_with(registry: ToolRegistry, p: Principal) -> (Rig, Value) {
    (
        rig(Ok(p), registry, true),
        rpc(
            "tools/call",
            Some(json!({ "name": OK_TOOL, "arguments": { "agent": "claude" } })),
        ),
    )
}

fn one(spec: ToolSpec) -> ToolRegistry {
    let mut r = ToolRegistry::new();
    r.register(spec);
    r
}

fn spec(scope: Option<&'static str>, permissions: &'static [&'static str], run: Arc<Run>) -> ToolSpec {
    ToolSpec {
        name: OK_TOOL,
        scope,
        permissions,
        runner: Arc::new(FnRunner(run)),
    }
}

async fn text_of(r: &Rig, call: &Value) -> (String, bool) {
    let v = post(r, call, &[]).await.json();
    (
        v["result"]["content"][0]["text"].as_str().unwrap_or("").to_owned(),
        v["result"]["isError"] == true,
    )
}

#[tokio::test]
async fn scope_quyen_va_anh_xa_loi() {
    // Thiếu scope ghi.
    let (r, call) = call_with(
        one(spec(Some("crm.write"), &[], Arc::new(|_| Ok(ok_output())))),
        principal(&["crm.read"], &[]),
    );
    let (t, e) = text_of(&r, &call).await;
    assert!(
        e && t.starts_with("insufficient_scope: kết nối này chưa được cấp quyền ghi (crm.write)"),
        "{t}"
    );
    assert_eq!(
        r.audit.0.lock().unwrap()[0].1.error.as_deref(),
        Some("insufficient_scope:crm.write")
    );
    // Thiếu quyền của tool.
    let (r, call) = call_with(
        one(spec(None, &["deals.view"], Arc::new(|_| Ok(ok_output())))),
        principal(&["crm.read"], &[("contacts.view", Grant::Scope(Scope::All))]),
    );
    let (t, _) = text_of(&r, &call).await;
    assert!(
        t.starts_with("Bạn không có quyền thực hiện thao tác này (cần quyền deals.view)"),
        "{t}"
    );
    // Có quyền ⇒ chạy.
    let (r, call) = call_with(
        one(spec(None, &["deals.view"], Arc::new(|_| Ok(ok_output())))),
        principal(&["crm.read"], &[("deals.view", Grant::Scope(Scope::Own))]),
    );
    assert!(!text_of(&r, &call).await.1);
    // Tool trong hợp đồng chưa đăng ký ⇒ báo chưa sẵn sàng.
    let (r, call) = call_with(ToolRegistry::new(), principal(&["crm.read"], &[]));
    let (t, e) = text_of(&r, &call).await;
    assert!(e && t.contains("chưa sẵn sàng"), "{t}");
    // Ánh xạ lỗi.
    let cases: Vec<(ToolError, &str, AuditStatus, &str)> = vec![
        (
            ToolError::User("query phải từ 2 ký tự".into()),
            "query phải từ 2 ký tự",
            AuditStatus::Error,
            "invalid_arguments",
        ),
        (
            ToolError::NotFound,
            "Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn. / Not found or outside your permission scope.",
            AuditStatus::Denied,
            "not_found_or_out_of_scope",
        ),
        (
            ToolError::Forbidden("Cần confirmed_by_user".into()),
            "Cần confirmed_by_user",
            AuditStatus::Denied,
            "forbidden",
        ),
        (
            ToolError::Http {
                status: 403,
                message: "x".into(),
            },
            "Bạn không có quyền thực hiện thao tác này. / Permission denied.",
            AuditStatus::Denied,
            "forbidden",
        ),
        (
            ToolError::Http {
                status: 403,
                message: "Bạn không có quyền thực hiện thao tác này (cần quyền custom_records.manage).".into(),
            },
            "Bạn không có quyền thực hiện thao tác này (cần quyền custom_records.manage).",
            AuditStatus::Denied,
            "forbidden",
        ),
        (
            ToolError::Http {
                status: 409,
                message: "trùng".into(),
            },
            "Yêu cầu không hợp lệ: trùng",
            AuditStatus::Error,
            "http_409",
        ),
        (
            ToolError::Plain("id không hợp lệ".into()),
            "id không hợp lệ",
            AuditStatus::Error,
            "invalid_arguments",
        ),
        (
            ToolError::Plain("lỗi lạ có SĐT".into()),
            "lỗi lạ có SĐT",
            AuditStatus::Error,
            "invalid_arguments",
        ),
        (
            ToolError::Plain("db sập".into()),
            "Lỗi hệ thống khi thực hiện yêu cầu. Vui lòng thử lại sau. / Internal error.",
            AuditStatus::Error,
            "internal_error",
        ),
        (
            ToolError::Http {
                status: 500,
                message: "boom".into(),
            },
            "Lỗi hệ thống khi thực hiện yêu cầu. Vui lòng thử lại sau. / Internal error.",
            AuditStatus::Error,
            "internal_error",
        ),
        (
            ToolError::Internal("boom".into()),
            "Lỗi hệ thống khi thực hiện yêu cầu. Vui lòng thử lại sau. / Internal error.",
            AuditStatus::Error,
            "internal_error",
        ),
    ];
    for (err, text, status, code) in cases {
        let cell = Arc::new(Mutex::new(Some(err)));
        let c = cell.clone();
        let (r, call) = call_with(
            one(spec(
                None,
                &[],
                Arc::new(move |_| Err(c.lock().unwrap().take().unwrap())),
            )),
            principal(&["crm.read"], &[]),
        );
        let (t, e) = text_of(&r, &call).await;
        assert!(e);
        assert_eq!(t, text);
        let log = r.audit.0.lock().unwrap();
        assert_eq!(
            (log[0].1.status, log[0].1.error.as_deref()),
            (status, Some(code)),
            "{text}"
        );
    }
}

#[tokio::test]
async fn cat_40000_utf16_va_ghi_nhat_ky_da_che_sdt() {
    // Chữ ngoài BMP (2 đơn vị UTF-16): cắt theo UTF-16 như `.slice()`, không theo byte hay ký tự.
    let long = "😀".repeat(30_000);
    let l = long.clone();
    let (r, call) = call_with(
        one(spec(
            None,
            &[],
            Arc::new(move |_| {
                Ok(ToolOutput {
                    text: Some(l.clone()),
                    structured: json!({ "notice": "", "data": {} }),
                })
            }),
        )),
        principal(&["crm.read"], &[]),
    );
    let v = post(&r, &call, &[]).await.json();
    let text = v["result"]["content"][0]["text"].as_str().unwrap().to_owned();
    assert_eq!(text.encode_utf16().count(), 40_000);
    assert_eq!(text.chars().count(), 20_000);
    // Văn bản vắng ⇒ JSON của structured.
    let (r, call) = call_with(
        one(spec(
            None,
            &[],
            Arc::new(|_| {
                Ok(ToolOutput {
                    text: None,
                    structured: json!({ "notice": "n", "data": { "a": 1 } }),
                })
            }),
        )),
        principal(&["crm.read"], &[]),
    );
    let v = post(&r, &call, &[]).await.json();
    assert_eq!(
        v["result"]["content"][0]["text"],
        "{\"notice\":\"n\",\"data\":{\"a\":1}}"
    );
    // Nhật ký: có người, client, thời lượng; `args` che SĐT.
    let (r, _) = call_with(
        one(spec(None, &[], Arc::new(|_| Ok(ok_output())))),
        principal(&["crm.read"], &[]),
    );
    let call = rpc(
        "tools/call",
        Some(json!({ "name": OK_TOOL, "arguments": { "agent": "claude" } })),
    );
    post(&r, &call, &[]).await;
    let log = r.audit.0.lock().unwrap();
    let e = &log[0].1;
    assert_eq!(
        (e.action.as_str(), e.status, e.user_id, e.client_id.as_deref()),
        (OK_TOOL, AuditStatus::Ok, Some(1), Some("c"))
    );
    assert!(e.duration_ms.is_some());
    assert_eq!(e.metadata.as_ref().unwrap()["args"]["agent"], "claude");
}

#[test]
fn tool_ghi_khop_hop_dong_va_khong_co_tool_xoa() {
    let mut r = ToolRegistry::new();
    mod_mcp::register_group3(&mut r);
    let names = r.names();
    assert_eq!(
        names,
        [
            "add_contact_note",
            "add_field",
            "archive_field",
            "archive_record",
            "assign_contact",
            "complete_setup",
            "create_contact",
            "create_object",
            "create_objects",
            "create_record",
            "create_task",
            "create_view",
            "get_action_status",
            "import_records",
            "install_object_template",
            "link_records",
            "propose_workspace",
            "restore_structure_version",
            "set_menu",
            "setup_build",
            "update_contact_stage",
            "update_field",
            "update_object",
            "update_record",
            "update_view",
        ]
    );
    let frozen = Frozen::embedded();
    for n in &names {
        assert!(frozen.tool(n).is_some(), "{n}");
        for w in ["delete", "remove", "destroy", "purge", "drop"] {
            assert!(!n.contains(w), "{n}");
        }
        let expected = if *n == "get_action_status" {
            None
        } else {
            Some("crm.write")
        };
        assert_eq!(r.get(n).unwrap().scope, expected, "{n}");
    }
    // Cả hợp đồng đóng băng cũng không có tool xoá.
    assert!(
        frozen
            .names()
            .iter()
            .all(|n| !n.contains("delete") && !n.contains("remove"))
    );
}

/// Ghi thương vụ qua `create_record`/`update_record` (issue #600): đăng ký thật nhóm ghi, DB lười (lỗi đọc cài đặt duyệt ⇒ chế độ
/// đề xuất, `prepare` chạy trước mọi truy vấn khác). Vai không có `deals.manage` bị từ chối; vai có quyền đi qua kiểm DTO web.
#[tokio::test]
async fn ghi_thuong_vu_theo_vai_va_kiem_dto() {
    let call = |name: &str, args: Value| rpc("tools/call", Some(json!({ "name": name, "arguments": args })));
    let run = |grants: &[(&str, Grant)], name: &str, args: Value| {
        let mut reg = ToolRegistry::new();
        mod_mcp::register_group3(&mut reg);
        let r = rig(Ok(principal(&["crm.read", "crm.write"], grants)), reg, true);
        let c = call(name, args);
        async move { text_of(&r, &c).await }
    };
    let create = json!({ "object": "deals", "values": { "title": "Gói niềng", "value": 45_000_000 } });
    let update = json!({ "object": "deals", "id": 1, "values": { "value": 1 } });

    // Bị từ chối: chỉ có deals.view / contacts.view, không có deals.manage.
    let viewer = [
        ("deals.view", Grant::Scope(Scope::Own)),
        ("contacts.view", Grant::Scope(Scope::Own)),
    ];
    for (name, args) in [("create_record", &create), ("update_record", &update)] {
        let (t, e) = run(&viewer, name, args.clone()).await;
        assert!(e && t.contains("cần quyền deals.manage"), "{name}: {t}");
    }

    // Được phép (có deals.manage) nhưng dữ liệu sai ⇒ lỗi DTO/trường, không đụng DB.
    let manager = [
        ("deals.view", Grant::Scope(Scope::Own)),
        ("deals.manage", Grant::Scope(Scope::Own)),
    ];
    let bad_status = json!({ "object": "deals", "values": { "title": "A", "status": "pending" } });
    let (t, e) = run(&manager, "create_record", bad_status).await;
    assert!(e && t.contains("status") && !t.contains("deals.manage"), "{t}");
    let no_title = json!({ "object": "deals", "values": { "value": 5 } });
    let (t, e) = run(&manager, "create_record", no_title).await;
    assert!(e && t.contains("title"), "{t}");
    let stranger = json!({ "object": "deals", "values": { "title": "A", "la": 1 } });
    let (t, e) = run(&manager, "create_record", stranger).await;
    assert!(e && t.contains("la"), "{t}");
    let not_editable = json!({ "object": "deals", "id": 1, "values": { "assigned_to": 2 } });
    let (t, e) = run(&manager, "update_record", not_editable).await;
    assert!(e && t.contains("Bảng thương vụ chỉ sửa được"), "{t}");
    let neg = json!({ "object": "deals", "id": 1, "values": { "value": -5 } });
    let (t, e) = run(&manager, "update_record", neg).await;
    assert!(e && t.contains("value"), "{t}");
    let null_title = json!({ "object": "deals", "id": 1, "values": { "title": null } });
    let (t, e) = run(&manager, "update_record", null_title).await;
    assert!(e && t.contains("title"), "{t}");
}
