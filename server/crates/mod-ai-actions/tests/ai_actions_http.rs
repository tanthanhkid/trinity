//! M38 qua HTTP (router K14 thật, quyền thật, Postgres thật), DB RIÊNG (bảng bị TRUNCATE):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-ai-actions --test ai_actions_http -- --ignored --test-threads=1`

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_ai_actions::{ActionExecutor, ActionUser, AiActionsCtx, BoxFut, ToolInfo, api_router, expiry_job};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_kernel::error::{AppError, HttpError};
use trinity_rbac::{PermissionService, RbacCache};

const JWT: &str = "m38-jwt-secret-0123456789abcdef0123456789abcdef";
const A: i32 = 9901; // contacts.create
const B: i32 = 9902; // không quyền
const ADM: i32 = 9903; // integrations.ai_admin

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

/// Bộ chạy giả: `ok_tool` (cần `contacts.create`), `structure_tool` (đổi cấu trúc), `boom` (lỗi 500), `refuse` (lỗi 400 có SĐT).
struct Mock {
    runs: AtomicUsize,
    versions: AtomicUsize,
}

impl ActionExecutor for Mock {
    fn info(&self, tool: &str) -> Option<ToolInfo> {
        let (label, perms, structure) = match tool {
            "ok_tool" => ("Tạo khách", vec!["contacts.create".to_owned()], false),
            "structure_tool" => ("Đổi cấu trúc", vec![], true),
            "boom" | "refuse" | "slow" => ("Hỏng", vec![], false),
            _ => return None,
        };
        Some(ToolInfo {
            label: label.to_owned(),
            permissions: perms,
            structure,
        })
    }
    fn save_version<'a>(
        &'a self,
        _d: i32,
        _t: &'a str,
        _s: &'a str,
        _u: &'a ActionUser,
    ) -> BoxFut<'a, Result<(), AppError>> {
        self.versions.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
    fn execute<'a>(
        &'a self,
        tool: &'a str,
        params: &'a Value,
        user: &'a ActionUser,
        draft_id: i32,
    ) -> BoxFut<'a, Result<Value, AppError>> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match tool {
                "boom" => Err(AppError::internal("lỗi nội bộ có bí mật")),
                "slow" => {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    Ok(json!({}))
                }
                "refuse" => Err(HttpError::bad_request("SĐT 0901234567 đã tồn tại").into()),
                _ => {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    Ok(json!({ "draft": draft_id, "by": user.user_id, "echo": params }))
                }
            }
        })
    }
}

struct App {
    router: Router,
    mock: Arc<Mock>,
    db: Db,
}

async fn app(enabled: bool) -> App {
    app_t(enabled, std::time::Duration::from_secs(30)).await
}

async fn app_t(enabled: bool, exec_timeout: std::time::Duration) -> App {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform, false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache);
    let mock = Arc::new(Mock {
        runs: AtomicUsize::new(0),
        versions: AtomicUsize::new(0),
    });
    let ctx = Arc::new(AiActionsCtx {
        db: db.clone(),
        enabled,
        executor: mock.clone(),
        exec_timeout,
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = api_router(deps).into_parts();
    assert_eq!(table.len(), 7);
    App {
        router: router.with_state(ctx),
        mock,
        db,
    }
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m38.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
}

async fn call(a: &App, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = a.router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    Res {
        status,
        body: serde_json::from_slice(&raw).unwrap_or(Value::Null),
    }
}

const P: &str = "/api/v1/integrations/ai-actions";

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

/// Các test dùng chung một DB (TRUNCATE + id cố định 9901..) nên phải chạy tuần tự: giữ guard tới hết test.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn setup() -> tokio::sync::MutexGuard<'static, ()> {
    let guard = SERIAL.lock().await;
    exec("TRUNCATE ai_action_drafts, oauth_clients, integration_audit_logs RESTART IDENTITY;
          DELETE FROM settings WHERE key = 'ai_require_approval';
          DELETE FROM user_roles WHERE user_id BETWEEN 9901 AND 9999; DELETE FROM role_permissions WHERE role_id BETWEEN 9901 AND 9999;
          DELETE FROM roles WHERE id BETWEEN 9901 AND 9999; DELETE FROM users WHERE id BETWEEN 9901 AND 9999").await;
    for id in [A, B, ADM] {
        exec(&format!("INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES ({id}, 'u{id}@m38.test', 'x', 'U{id}', 'active', now())")).await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9901, 'm38-a', false, now()), (9902, 'm38-b', false, now()), (9903, 'm38-adm', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES (9901, 'contacts.create', NULL), (9903, 'integrations.ai_admin', NULL);
          INSERT INTO user_roles (user_id, role_id) VALUES (9901, 9901), (9902, 9902), (9903, 9903)").await;
    exec(
        "INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, token_endpoint_auth_method, metadata)
          VALUES ('trn_c_m38', 'dcr', 'Trợ lý M38', ARRAY['https://client.example.com/cb'], 'none', '{}'::jsonb)",
    )
    .await;
    guard
}

/// Thêm một đề xuất; trả id.
async fn draft(user: i32, tool: &str, status: &str, extra: &str) -> i32 {
    scalar::<i32>(&format!(
        "INSERT INTO ai_action_drafts (user_id, client_id, tool, params, summary, details, status, expires_at {cols})
         VALUES ({user}, 'trn_c_m38', '{tool}', '{{\"a\":1}}'::jsonb, 'Tạo khách Nguyễn Văn A', '[{{\"label\":\"Tên\",\"value\":\"A\"}},{{\"x\":1}}]'::jsonb, '{status}', now() + interval '1 day' {vals}) RETURNING id",
        cols = extra.split('|').next().unwrap_or(""),
        vals = extra.split('|').nth(1).unwrap_or(""),
    ))
    .await
}

// ================================================================= đọc

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn co_tat_thi_moi_route_404() {
    let _s = setup().await;
    let a = app(false).await;
    for (m, p) in [
        (Method::GET, P.to_owned()),
        (Method::GET, format!("{P}/settings")),
        (Method::GET, format!("{P}/pending-count")),
        (Method::GET, format!("{P}/1")),
        (Method::POST, format!("{P}/1/approve")),
        (Method::POST, format!("{P}/1/reject")),
    ] {
        let r = call(&a, m.clone(), &p, Some(A), None).await;
        assert_eq!(r.status, 404, "{m} {p}");
    }
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{P}/settings"),
            Some(ADM),
            Some(json!({ "require_approval": true }))
        )
        .await
        .status,
        404
    );
    // Chưa đăng nhập vẫn 401 trước cổng cờ.
    assert_eq!(call(&a, Method::GET, P, None, None).await.status, 401);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn danh_sach_chi_cua_minh_loc_trang_thai_va_phan_trang() {
    let _s = setup().await;
    let a = app(true).await;
    let p1 = draft(A, "ok_tool", "pending", "").await;
    let p2 = draft(A, "ok_tool", "pending", "").await;
    let late = draft(A, "ok_tool", "pending", "").await;
    exec(&format!(
        "UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute' WHERE id = {late}"
    ))
    .await;
    let done = draft(A, "unknown_tool", "executed", "").await;
    draft(B, "ok_tool", "pending", "").await; // của người khác
    let r = call(&a, Method::GET, P, Some(A), None).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    let ids: Vec<i64> = r.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [i64::from(done), i64::from(late), i64::from(p2), i64::from(p1)]);
    assert_eq!(r.body["next_cursor"], Value::Null);
    let d0 = &r.body["data"][3];
    assert_eq!(
        (
            d0["tool_label"].as_str(),
            d0["client_name"].as_str(),
            d0["status"].as_str()
        ),
        (Some("Tạo khách"), Some("Trợ lý M38"), Some("pending"))
    );
    assert_eq!(d0["details"], json!([{ "label": "Tên", "value": "A" }])); // dòng sai hình dạng bị bỏ
    assert!(d0.get("params").is_none(), "không trả params thô");
    assert_eq!(r.body["data"][0]["tool_label"], "unknown_tool"); // tool lạ: nhãn là tên
    // `pending` loại đề xuất quá hạn; `expired` gồm cả pending quá hạn; trạng thái khác lọc theo cột.
    let st = |s: &str| {
        let a = &a;
        let s = s.to_owned();
        async move {
            let r = call(a, Method::GET, &format!("{P}?status={s}"), Some(A), None).await;
            r.body["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d["id"].as_i64().unwrap())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(st("pending").await, [i64::from(p2), i64::from(p1)]);
    assert_eq!(st("expired").await, [i64::from(late)]);
    assert_eq!(st("executed").await, [i64::from(done)]);
    // Phân trang: limit 2 ⇒ next_cursor = id cuối trang; cursor ⇒ chỉ id nhỏ hơn.
    let r = call(&a, Method::GET, &format!("{P}?limit=2"), Some(A), None).await;
    assert_eq!(r.body["data"].as_array().unwrap().len(), 2);
    assert_eq!(r.body["next_cursor"].as_i64(), Some(i64::from(late)));
    let r = call(&a, Method::GET, &format!("{P}?limit=2&cursor={late}"), Some(A), None).await;
    let ids: Vec<i64> = r.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [i64::from(p2), i64::from(p1)]);
    assert_eq!(r.body["next_cursor"], Value::Null);
    // `limit` hỏng/0 ⇒ 20; lớn ⇒ kẹp 50 (không lỗi).
    for l in ["abc", "0", "9999", "-5"] {
        assert_eq!(
            call(&a, Method::GET, &format!("{P}?limit={l}"), Some(A), None)
                .await
                .status,
            200,
            "{l}"
        );
    }
    // Đầu vào sai.
    for q in [
        "status=khac",
        "cursor=abc",
        "cursor=0",
        "cursor=1.5",
        "cursor=2147483648",
    ] {
        let r = call(&a, Method::GET, &format!("{P}?{q}"), Some(A), None).await;
        assert_eq!(r.status, 400, "{q}: {:?}", r.body);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn chi_tiet_dem_cho_duyet_va_ranh_gioi_id() {
    let _s = setup().await;
    let a = app(true).await;
    let id = draft(A, "ok_tool", "pending", "").await;
    draft(A, "ok_tool", "pending", "").await;
    exec("UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute' WHERE id = 2").await;
    let r = call(&a, Method::GET, &format!("{P}/{id}"), Some(A), None).await;
    assert_eq!((r.status.as_u16(), r.body["id"].as_i64()), (200, Some(i64::from(id))));
    assert!(r.body["created_at"].as_str().unwrap().ends_with('Z'));
    // Của người khác, không có, ngoài INT32, 0, âm ⇒ 404; không phải số ⇒ 400 (ParseIntPipe).
    for p in [
        id.to_string(),
        "999".to_owned(),
        "2147483648".to_owned(),
        "0".to_owned(),
        "-1".to_owned(),
    ] {
        let who = if p == id.to_string() { B } else { A };
        assert_eq!(
            call(&a, Method::GET, &format!("{P}/{p}"), Some(who), None).await.status,
            404,
            "{p}"
        );
    }
    assert_eq!(
        call(&a, Method::GET, &format!("{P}/abc"), Some(A), None).await.status,
        400
    );
    // Đếm chỉ đề xuất còn hạn của mình.
    let r = call(&a, Method::GET, &format!("{P}/pending-count"), Some(A), None).await;
    assert_eq!(r.body, json!({ "pending": 1 }));
    assert_eq!(
        call(&a, Method::GET, &format!("{P}/pending-count"), Some(B), None)
            .await
            .body,
        json!({ "pending": 0 })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn cai_dat_yeu_cau_duyet() {
    let _s = setup().await;
    let a = app(true).await;
    let sp = format!("{P}/settings");
    let get = || call(&a, Method::GET, &sp, Some(B), None);
    assert_eq!(get().await.body, json!({ "require_approval": false }));
    let patch = |u: i32, b: Value| call(&a, Method::PATCH, &sp, Some(u), Some(b));
    assert_eq!(patch(B, json!({ "require_approval": true })).await.status, 403);
    for bad in [
        json!({}),
        json!({ "require_approval": "true" }),
        json!({ "require_approval": true, "x": 1 }),
    ] {
        assert_eq!(patch(ADM, bad.clone()).await.status, 400, "{bad}");
    }
    let r = patch(ADM, json!({ "require_approval": true })).await;
    assert_eq!((r.status.as_u16(), r.body), (200, json!({ "require_approval": true })));
    assert_eq!(get().await.body, json!({ "require_approval": true }));
    assert_eq!(
        patch(ADM, json!({ "require_approval": false })).await.body,
        json!({ "require_approval": false })
    );
    assert_eq!(get().await.body, json!({ "require_approval": false }));
    assert_eq!(
        scalar::<i64>(
            "SELECT count(*) FROM integration_audit_logs WHERE action = 'ai_action.setting' AND channel = 'mcp'"
        )
        .await,
        2
    );
}

// ================================================================= từ chối, duyệt

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tu_choi() {
    let _s = setup().await;
    let a = app(true).await;
    let id = draft(A, "ok_tool", "pending", "").await;
    assert_eq!(
        call(&a, Method::POST, &format!("{P}/{id}/reject"), Some(B), None)
            .await
            .status,
        404
    );
    let r = call(&a, Method::POST, &format!("{P}/{id}/reject"), Some(A), None).await;
    assert_eq!((r.status.as_u16(), r.body["status"].as_str()), (200, Some("rejected")));
    assert!(r.body["decided_at"].is_string());
    let r = call(&a, Method::POST, &format!("{P}/{id}/reject"), Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (409, "Đề xuất này đã bị từ chối")
    );
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (409, "Đề xuất này đã bị từ chối")
    );
    assert_eq!(a.mock.runs.load(Ordering::SeqCst), 0);
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM integration_audit_logs WHERE action = 'ai_action.reject'").await,
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn duyet_chay_dung_mot_lan_ngay_ca_khi_duyet_song_song() {
    let _s = setup().await;
    let a = app(true).await;
    let id = draft(A, "ok_tool", "pending", "").await;
    let path = format!("{P}/{id}/approve");
    let (x, y) = tokio::join!(
        call(&a, Method::POST, &path, Some(A), None),
        call(&a, Method::POST, &path, Some(A), None)
    );
    let mut st = [x.status.as_u16(), y.status.as_u16()];
    st.sort_unstable();
    assert_eq!(st, [200, 409]);
    assert_eq!(a.mock.runs.load(Ordering::SeqCst), 1);
    let ok = if x.status == 200 { &x } else { &y };
    assert_eq!(ok.body["status"], "approved");
    assert_eq!(ok.body["result"]["by"], A);
    assert_eq!(ok.body["result"]["echo"], json!({ "a": 1 }));
    assert_eq!(
        scalar::<i64>(
            "SELECT count(*) FROM integration_audit_logs WHERE action = 'ai_action.approve' AND status = 'ok'"
        )
        .await,
        1
    );
    // Duyệt lại ⇒ 409 "đã được duyệt".
    let r = call(&a, Method::POST, &path, Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (409, "Đề xuất này đã được duyệt trước đó")
    );
    // Người khác ⇒ 404.
    assert_eq!(call(&a, Method::POST, &path, Some(B), None).await.status, 404);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn duyet_kiem_lai_quyen_loi_chuyen_failed_va_che_sdt() {
    let _s = setup().await;
    let a = app(true).await;
    // Mất quyền nghiệp vụ lúc duyệt ⇒ 403 + failed kèm lý do.
    let id = draft(B, "ok_tool", "pending", "").await; // B không có contacts.create
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(B), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (
            403,
            "Bạn không còn quyền thực hiện thao tác này (cần quyền contacts.create)"
        )
    );
    let v = call(&a, Method::GET, &format!("{P}/{id}"), Some(B), None).await;
    assert_eq!(v.body["status"], "failed");
    assert!(v.body["error"].as_str().unwrap().contains("contacts.create"));
    // Loại đề xuất không còn hỗ trợ ⇒ 400 + failed.
    let id = draft(A, "da_go_tool", "pending", "").await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (400, "Loại đề xuất không còn được hỗ trợ")
    );
    // Lỗi < 500 của dịch vụ ⇒ trả nguyên, đề xuất failed, SĐT trong lý do bị che.
    let id = draft(A, "refuse", "pending", "").await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(r.status, 400);
    let v = call(&a, Method::GET, &format!("{P}/{id}"), Some(A), None).await;
    assert_eq!(v.body["status"], "failed");
    assert_eq!(v.body["error"], "SĐT ***567 đã tồn tại");
    // Lỗi hệ thống ⇒ 500 chung, không lộ nội dung; đề xuất failed.
    let id = draft(A, "boom", "pending", "").await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(r.status, 500);
    assert!(msg(&r).contains("đã được đánh dấu thất bại"), "{}", msg(&r));
    assert!(!r.body.to_string().contains("bí mật"));
    assert_eq!(
        call(&a, Method::GET, &format!("{P}/{id}"), Some(A), None).await.body["status"],
        "failed"
    );
    assert!(scalar::<i64>("SELECT count(*) FROM integration_audit_logs WHERE action = 'ai_action.approve' AND status IN ('denied','error')").await >= 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn duyet_het_han_va_xac_nhan_ten_bang() {
    let _s = setup().await;
    let a = app(true).await;
    // Quá hạn ⇒ 409 và được đánh dấu expired; không chạy.
    let id = draft(A, "ok_tool", "pending", "").await;
    exec(&format!(
        "UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute' WHERE id = {id}"
    ))
    .await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (409, "Đề xuất đã hết hạn (quá 24 giờ) — hãy nhờ AI tạo lại")
    );
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM ai_action_drafts WHERE id = {id}")).await,
        "expired"
    );
    assert_eq!(a.mock.runs.load(Ordering::SeqCst), 0);
    // Đổi cấu trúc ảnh hưởng dữ liệu ⇒ phải gõ đúng tên bảng; sai ⇒ 400 và vẫn chờ duyệt; đúng (khác hoa/thường, khoảng trắng) ⇒ chạy + lưu phiên bản.
    let id = draft(
        A,
        "structure_tool",
        "pending",
        ", impact|, '{\"confirm_label\":\"Học sinh\"}'::jsonb",
    )
    .await;
    let path = format!("{P}/{id}/approve");
    let r = call(
        &a,
        Method::POST,
        &path,
        Some(A),
        Some(json!({ "confirm_text": "Giáo viên" })),
    )
    .await;
    assert_eq!(r.status, 400);
    assert!(msg(&r).contains("Học sinh"));
    assert_eq!(call(&a, Method::POST, &path, Some(A), None).await.status, 400);
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM ai_action_drafts WHERE id = {id}")).await,
        "pending"
    );
    assert_eq!(
        call(
            &a,
            Method::POST,
            &path,
            Some(A),
            Some(json!({ "confirm_text": "x".repeat(201) }))
        )
        .await
        .status,
        400
    );
    let r = call(
        &a,
        Method::POST,
        &path,
        Some(A),
        Some(json!({ "confirm_text": "  học   SINH " })),
    )
    .await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(a.mock.versions.load(Ordering::SeqCst), 1);
    assert_eq!(a.mock.runs.load(Ordering::SeqCst), 1);
    // Thân có khoá lạ ⇒ 400.
    let id = draft(A, "ok_tool", "pending", "").await;
    assert_eq!(
        call(
            &a,
            Method::POST,
            &format!("{P}/{id}/approve"),
            Some(A),
            Some(json!({ "khoa_la": 1 }))
        )
        .await
        .status,
        400
    );
}

// ================================================================= job

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn job_het_han_ket_qua_khong_ro_va_don() {
    let _s = setup().await;
    let a = app(true).await;
    let overdue = draft(A, "ok_tool", "pending", "").await;
    exec(&format!(
        "UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute' WHERE id = {overdue}"
    ))
    .await;
    let fresh = draft(A, "ok_tool", "pending", "").await;
    // Đã nhận duyệt mà không có kết quả: quá 5 phút ⇒ failed (kết quả không rõ); mới đây ⇒ đang chạy.
    let stale = draft(A, "ok_tool", "approved", ", decided_at|, now() - interval '6 minutes'").await;
    let running = draft(A, "ok_tool", "approved", ", decided_at|, now() - interval '1 minute'").await;
    let old = draft(A, "ok_tool", "executed", "").await;
    exec(&format!(
        "UPDATE ai_action_drafts SET created_at = now() - interval '91 days' WHERE id = {old}"
    ))
    .await;
    let view = call(&a, Method::GET, &format!("{P}/{stale}"), Some(A), None).await;
    assert_eq!(view.body["status"], "failed"); // trạng thái hiệu lực không đợi job
    assert!(view.body["error"].as_str().unwrap().starts_with("Không rõ kết quả"));
    assert_eq!(
        call(&a, Method::GET, &format!("{P}/{running}"), Some(A), None)
            .await
            .body["status"],
        "executing"
    );

    let mut c = PgConnection::connect(&url()).await.unwrap();
    let r = mod_ai_actions::service::expire_overdue(&mut c, chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!((r.expired, r.stale, r.purged), (1, 1, 1));
    let status = |id: i32| {
        scalar::<String>(Box::leak(
            format!("SELECT status FROM ai_action_drafts WHERE id = {id}").into_boxed_str(),
        ))
    };
    assert_eq!(status(overdue).await, "expired");
    assert_eq!(status(fresh).await, "pending");
    assert_eq!(status(stale).await, "failed");
    assert_eq!(status(running).await, "approved");
    assert_eq!(
        scalar::<i64>(&format!("SELECT count(*) FROM ai_action_drafts WHERE id = {old}")).await,
        0
    );
    // Lần hai không còn gì để làm.
    let r = mod_ai_actions::service::expire_overdue(&mut c, chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!((r.expired, r.stale, r.purged), (0, 0, 0));
    // Job chỉ đăng ký khi OAuth/MCP bật.
    assert!(expiry_job(&a.db, false).unwrap().is_none());
    assert!(expiry_job(&a.db, true).unwrap().is_some());
}

// ================================================================= theo review #416

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tu_choi_het_han_la_409_va_danh_dau_expired() {
    let _s = setup().await;
    let a = app(true).await;
    let id = draft(A, "ok_tool", "pending", "").await;
    exec(&format!(
        "UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute' WHERE id = {id}"
    ))
    .await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/reject"), Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (409, "Đề xuất đã hết hạn (quá 24 giờ) — hãy nhờ AI tạo lại")
    );
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM ai_action_drafts WHERE id = {id}")).await,
        "expired"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn duyet_kiem_trang_thai_truoc_xac_nhan_ten_bang() {
    let _s = setup().await;
    let a = app(true).await;
    // Đã từ chối + có confirm_label: duyệt không đòi gõ tên bảng mà báo ngay 409.
    let id = draft(
        A,
        "structure_tool",
        "rejected",
        ", impact|, '{\"confirm_label\":\"Học sinh\"}'::jsonb",
    )
    .await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(
        (r.status.as_u16(), msg(&r).as_str()),
        (409, "Đề xuất này đã bị từ chối")
    );
    // Hết hạn + confirm_label: 409 hết hạn và đánh expired (không 400 tên bảng).
    let id = draft(
        A,
        "structure_tool",
        "pending",
        ", impact|, '{\"confirm_label\":\"Học sinh\"}'::jsonb",
    )
    .await;
    exec(&format!(
        "UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute' WHERE id = {id}"
    ))
    .await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(r.status, 409);
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM ai_action_drafts WHERE id = {id}")).await,
        "expired"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn thuc_thi_qua_han_bi_dung_va_ghi_failed_con_job_khong_dung_vao_dang_chay() {
    let _s = setup().await;
    // Hạn thực thi 300 ms (ngắn hơn ngưỡng 5 phút của job): tool chậm bị dừng chờ, đề xuất failed kèm lý do "không rõ kết quả".
    let a = app_t(true, std::time::Duration::from_millis(300)).await;
    let id = draft(A, "slow", "pending", "").await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(r.status, 500);
    let v = call(&a, Method::GET, &format!("{P}/{id}"), Some(A), None).await;
    assert_eq!(v.body["status"], "failed");
    assert!(
        v.body["error"].as_str().unwrap().contains("kết quả không rõ"),
        "{:?}",
        v.body
    );
    // Đang chạy (approved, chưa có kết quả, dưới 5 phút): job bỏ qua; kết quả ghi muộn sau khi đã failed không đè.
    let running = draft(A, "ok_tool", "approved", ", decided_at|, now() - interval '4 minutes'").await;
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let r = mod_ai_actions::service::expire_overdue(&mut c, chrono::Utc::now())
        .await
        .unwrap();
    assert_eq!(r.stale, 0);
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM ai_action_drafts WHERE id = {running}")).await,
        "approved"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn duyet_tra_ket_qua_va_ghi_result_dung_mot_lan() {
    let _s = setup().await;
    let a = app(true).await;
    let id = draft(A, "ok_tool", "pending", "").await;
    let r = call(&a, Method::POST, &format!("{P}/{id}/approve"), Some(A), None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["result"]["draft"], id);
    assert_eq!(
        scalar::<String>(&format!("SELECT result->>'by' FROM ai_action_drafts WHERE id = {id}")).await,
        A.to_string()
    );
    assert_eq!(r.body["client_name"], "Trợ lý M38");
    // Thứ tự cổng: cờ tắt ⇒ 404 trước cả kiểm thân (thân hỏng).
    let off = app(false).await;
    let bad = Request::builder()
        .method(Method::PATCH)
        .uri(format!("{P}/settings"))
        .header("authorization", format!("Bearer {}", token(ADM)))
        .header("content-type", "application/json")
        .body(Body::from("{không phải json"))
        .unwrap();
    assert_eq!(off.router.clone().oneshot(bad).await.unwrap().status(), 404);
}
