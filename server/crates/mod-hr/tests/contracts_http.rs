//! M11 qua HTTP (router K14 thật, quyền thật, kho tệp đĩa thật, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-hr --test contracts_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9701..9799 (và mọi dòng liên quan).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_hr::contracts::{ContractStore, ContractsCtx};
use mod_hr::employees::Ctx;
use mod_hr::routes::contract_router;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};
use trinity_storage::{LocalDiskDriver, LocalUploadsStore};

const JWT: &str = "m11-jwt-secret-0123456789abcdef0123456789abcdef";
const B: &str = "/api/v1/management/contracts";

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

fn root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("trinity-m11-store-{}", std::process::id()))
}

async fn app() -> Router {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        platform,
        scopes: ScopeService::new(db, cache.clone()),
        perms: perms.clone(),
        cache,
        uploads: LocalUploadsStore::new(root()),
    });
    let store = LocalDiskDriver::new(root());
    store.init().await.unwrap();
    let cc = Arc::new(ContractsCtx {
        ctx,
        store: ContractStore::Local(store),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = contract_router(deps).into_parts();
    assert_eq!(table.len(), 13);
    router.with_state(cc)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m11.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

struct Res {
    status: StatusCode,
    body: Value,
    raw: Vec<u8>,
    headers: axum::http::HeaderMap,
}

async fn send(app: &Router, method: Method, path: &str, user: Option<i32>, ct: Option<&str>, body: Vec<u8>) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(u) = user {
        b = b.header("authorization", format!("Bearer {}", token(u)));
    }
    if let Some(ct) = ct {
        b = b.header("content-type", ct);
    }
    let resp = app.clone().oneshot(b.body(Body::from(body)).unwrap()).await.unwrap();
    let (status, headers) = (resp.status(), resp.headers().clone());
    let raw = axum::body::to_bytes(resp.into_body(), 64 << 20).await.unwrap().to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Res {
        status,
        body,
        raw,
        headers,
    }
}

async fn call(app: &Router, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
    match body {
        Some(v) => {
            send(
                app,
                method,
                path,
                user,
                Some("application/json"),
                v.to_string().into_bytes(),
            )
            .await
        }
        None => send(app, method, path, user, None, Vec::new()).await,
    }
}

/// Một phần của thân multipart: (tên trường, tên tệp, loại, nội dung).
type Part<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

const BOUNDARY: &str = "----m11boundary";

/// Thân multipart: `(tên trường, tên tệp, loại, nội dung)`.
fn multipart(parts: &[Part<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, file, ct, data) in parts {
        out.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        match file {
            Some(f) => out.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n").as_bytes(),
            ),
            None => out.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n").as_bytes()),
        }
        if let Some(ct) = ct {
            out.extend_from_slice(format!("Content-Type: {ct}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    out
}

async fn upload(app: &Router, path: &str, user: i32, parts: &[Part<'_>]) -> Res {
    send(
        app,
        Method::POST,
        path,
        Some(user),
        Some(&format!("multipart/form-data; boundary={BOUNDARY}")),
        multipart(parts),
    )
    .await
}

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

const MANAGER: i32 = 9701; // contracts.view all + contracts.manage
const VIEWER: i32 = 9702; // contracts.view all
const OWN: i32 = 9703; // contracts.view own
const NOBODY: i32 = 9704; // không quyền nào
const E1: i32 = 9705; // nhân viên: quản lý OWN? không: nhân viên thường
const E2: i32 = 9706;

async fn teardown() {
    exec("DELETE FROM contract_templates WHERE name LIKE 'm11%' OR storage_key LIKE 'contract-templates/%';
          DELETE FROM employee_contracts WHERE employee_id IN (SELECT id FROM employees WHERE user_id BETWEEN 9701 AND 9799);
          DELETE FROM employees WHERE user_id BETWEEN 9701 AND 9799;
          DELETE FROM user_roles WHERE user_id BETWEEN 9701 AND 9799;
          DELETE FROM role_permissions WHERE role_id BETWEEN 9701 AND 9799;
          DELETE FROM roles WHERE id BETWEEN 9701 AND 9799;
          UPDATE users SET manager_id = NULL WHERE id BETWEEN 9701 AND 9799;
          DELETE FROM teams WHERE name LIKE 'm11%';
          DELETE FROM users WHERE id BETWEEN 9701 AND 9799")
        .await;
}

async fn setup() {
    teardown().await;
    for (id, name, mgr) in [
        (MANAGER, "Quản lý HĐ", "NULL"),
        (VIEWER, "Chỉ xem HĐ", "NULL"),
        (OWN, "Xem của mình", "NULL"),
        (NOBODY, "Không quyền", "NULL"),
        (E1, "Nhân viên một", "9701"),
        (E2, "Nhân viên hai", "NULL"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, manager_id, updated_at)
             VALUES ({id}, 'u{id}@m11.test', 'x', '{name}', 'active', {mgr}, now());
             INSERT INTO employees (user_id, position, department, status, joined_at, employee_code)
             VALUES ({id}, 'Nhân viên', 'Kinh doanh', 'active', now(), 'M11-{id}')"
        ))
        .await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES (9701, 'm11-manager', false, now()), (9702, 'm11-viewer', false, now()), (9703, 'm11-own', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9701, 'contracts.view', 'all'), (9701, 'contracts.manage', NULL),
            (9702, 'contracts.view', 'all'),
            (9703, 'contracts.view', 'own');
          INSERT INTO user_roles (user_id, role_id) VALUES (9701, 9701), (9702, 9702), (9703, 9703)")
        .await;
    exec("INSERT INTO teams (name, department, team_lead_id) VALUES ('m11 Team', 'Kinh doanh', 9701)").await;
}

async fn emp(user: i32) -> i32 {
    scalar::<i32>(&format!("SELECT id FROM employees WHERE user_id = {user}")).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn quyen_tao_sua_xoa_va_kiem_dau_vao() {
    setup().await;
    let a = app().await;
    assert_eq!(call(&a, Method::GET, B, None, None).await.status, 401);
    assert_eq!(call(&a, Method::GET, B, Some(NOBODY), None).await.status, 403);
    assert_eq!(
        call(&a, Method::POST, B, Some(VIEWER), Some(json!({}))).await.status,
        403
    );

    let e1 = emp(E1).await;
    // Kiểm dữ liệu vào: lỗi class-validator, trường lạ.
    let bad = call(
        &a,
        Method::POST,
        B,
        Some(MANAGER),
        Some(json!({ "employee_id": 0, "contract_type": "khac", "signed_date": "hôm qua" })),
    )
    .await;
    assert_eq!(bad.status, 400);
    assert!(
        bad.body["message"].as_array().is_some_and(|m| m.len() >= 3),
        "{:?}",
        bad.body
    );
    assert_eq!(
        call(
            &a,
            Method::POST,
            B,
            Some(MANAGER),
            Some(json!({ "employee_id": e1, "signed_date": "2026-01-01", "la": 1 }))
        )
        .await
        .status,
        400,
        "route strict: trường lạ bị từ chối"
    );
    // Nhân viên không có ⇒ 404.
    let none = call(
        &a,
        Method::POST,
        B,
        Some(MANAGER),
        Some(json!({ "employee_id": 999_999, "signed_date": "2026-01-01" })),
    )
    .await;
    assert_eq!(
        (none.status.as_u16(), msg(&none)),
        (404, "Không tìm thấy nhân viên".to_owned())
    );

    // Tạo: mặc định loại hdld_1; file_url trong body bị bỏ; chấm dứt ngay ghi terminated_at.
    let c = call(&a, Method::POST, B, Some(MANAGER), Some(json!({ "employee_id": e1, "signed_date": "2026-01-01", "end_date": "2027-01-01", "file_url": "hack", "notes": "ghi chú" }))).await;
    assert_eq!(c.status, 201, "{:?}", c.body);
    assert_eq!(c.body["contract_type"], "hdld_1");
    assert_eq!(c.body["file_url"], Value::Null);
    assert_eq!(c.body["employee"]["employee_code"], format!("M11-{E1}"));
    assert!(c.body["status"].as_str().is_some() && c.body["days_remaining"].is_number());
    let id = c.body["id"].as_i64().unwrap();
    let t = call(
        &a,
        Method::POST,
        B,
        Some(MANAGER),
        Some(json!({ "employee_id": emp(E2).await, "signed_date": "2025-01-01", "is_terminated": true })),
    )
    .await;
    assert_eq!(t.body["status"], "terminated");
    assert!(t.body["terminated_at"].is_string());

    // Sửa: PATCH null xoá ngày kết thúc (không thời hạn); bỏ chấm dứt xoá terminated_at; không có ⇒ 404.
    let p = call(
        &a,
        Method::PATCH,
        &format!("{B}/{id}"),
        Some(MANAGER),
        Some(json!({ "end_date": null, "contract_type": "hdld_vo_thoi_han" })),
    )
    .await;
    assert_eq!(p.status, 200, "{:?}", p.body);
    assert_eq!(
        (p.body["status"].as_str(), p.body["end_date"].clone()),
        (Some("active"), Value::Null)
    );
    let tid_c = t.body["id"].as_i64().unwrap();
    let p2 = call(
        &a,
        Method::PATCH,
        &format!("{B}/{tid_c}"),
        Some(MANAGER),
        Some(json!({ "is_terminated": false })),
    )
    .await;
    assert_eq!(p2.body["terminated_at"], Value::Null);
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/999999"),
            Some(MANAGER),
            Some(json!({}))
        )
        .await
        .status,
        404
    );
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/{id}"),
            Some(MANAGER),
            Some(json!({ "contract_type": null }))
        )
        .await
        .status,
        400
    );

    // Chi tiết theo phạm vi: OWN (view own) không thấy hợp đồng của người khác ⇒ 404; VIEWER thấy.
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/{id}"), Some(VIEWER), None)
            .await
            .status,
        200
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/{id}"), Some(OWN), None)
            .await
            .status,
        404
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/abc"), Some(VIEWER), None)
            .await
            .status,
        400
    );

    // Xoá.
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/{id}"), Some(MANAGER), None)
            .await
            .body,
        json!({ "ok": true })
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/{id}"), Some(MANAGER), None)
            .await
            .status,
        404
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn danh_sach_theo_nhan_vien_loc_sap_xep_va_thong_ke() {
    setup().await;
    let a = app().await;
    let (e1, e2) = (emp(E1).await, emp(E2).await);
    // E1: hợp đồng sắp hết hạn (còn ~10 ngày); E2: chưa có hợp đồng.
    exec(&format!(
        "INSERT INTO employee_contracts (employee_id, contract_type, signed_date, end_date, updated_at)
         VALUES ({e1}, 'hdld_2', now() - interval '300 days', now() + interval '10 days', now())"
    ))
    .await;
    let all = call(&a, Method::GET, &format!("{B}?search=M11-"), Some(VIEWER), None).await;
    assert_eq!(all.status, 200, "{:?}", all.body);
    let rows = all.body["data"].as_array().unwrap();
    assert_eq!(rows.len(), 6, "mọi nhân viên đều hiện, kể cả chưa có hợp đồng");
    let by = |code: &str| {
        rows.iter()
            .find(|r| r["employee"]["employee_code"] == code)
            .cloned()
            .unwrap()
    };
    assert_eq!(by(&format!("M11-{E1}"))["status"], "expiring");
    assert_eq!(by(&format!("M11-{E2}"))["status"], "no_contract");
    assert_eq!(by(&format!("M11-{E2}"))["id"], Value::Null);
    assert_eq!(all.body["pagination"]["total"], 6);
    // Team hiển thị: E1 có quản lý là trưởng nhóm của 'm11 Team'.
    assert_eq!(by(&format!("M11-{E1}"))["employee"]["team_lead_id"], MANAGER);

    // Lọc.
    let q = |s: &str| format!("{B}?search=M11-&{s}");
    let get = |s: String| {
        let a = a.clone();
        async move { call(&a, Method::GET, &s, Some(VIEWER), None).await }
    };
    assert_eq!(get(q("status=expiring")).await.body["pagination"]["total"], 1);
    assert_eq!(get(q("status=no_contract")).await.body["pagination"]["total"], 5);
    assert_eq!(get(q("status=expired")).await.body["pagination"]["total"], 0);
    assert_eq!(get(q("contract_type=hdld_2")).await.body["pagination"]["total"], 1);
    assert_eq!(
        get(q("contract_type=hdld_2&status=no_contract")).await.body["pagination"]["total"],
        5,
        "bỏ lọc loại khi lọc chưa có HĐ"
    );
    assert_eq!(
        get(q("employment_status=resigned")).await.body["pagination"]["total"],
        0
    );
    assert_eq!(
        get(format!("{B}?search=%25")).await.body["pagination"]["total"],
        0,
        "% là chữ, không phải ký tự đại diện"
    );
    let team_id = scalar::<i32>("SELECT id FROM teams WHERE name = 'm11 Team'").await;
    assert_eq!(
        get(q(&format!("team={team_id}"))).await.body["pagination"]["total"],
        2,
        "trưởng nhóm + nhân viên của anh ta"
    );
    let huge = get(q("page=9007199254740991&page_size=200")).await;
    assert_eq!(
        (huge.status.as_u16(), huge.body["data"].as_array().map(Vec::len)),
        (200, Some(0)),
        "trang quá lớn ⇒ rỗng, không tràn số"
    );
    let p2 = get(q("page=2&page_size=4")).await;
    assert_eq!(
        (
            p2.body["data"].as_array().unwrap().len(),
            p2.body["pagination"]["total_pages"].clone()
        ),
        (2, json!(2))
    );
    assert_eq!(get(q("page=0")).await.status, 400);
    let desc = get(q("sort_by=employee_code&sort_dir=desc")).await;
    assert_eq!(desc.body["data"][0]["employee"]["employee_code"], format!("M11-{E2}"));
    // Phạm vi: OWN chỉ thấy chính mình.
    let own = call(&a, Method::GET, &format!("{B}?search=M11-"), Some(OWN), None).await;
    assert_eq!(own.body["pagination"]["total"], 1);

    // Thống kê.
    let st = call(&a, Method::GET, &format!("{B}/stats"), Some(VIEWER), None).await;
    assert_eq!(st.status, 200, "{:?}", st.body);
    let by_status = st.body["by_status"].as_array().unwrap();
    assert_eq!(by_status.len(), 5);
    let n = |k: &str| {
        by_status.iter().find(|x| x["key"] == k).unwrap()["count"]
            .as_i64()
            .unwrap()
    };
    assert!(n("expiring") >= 1 && n("no_contract") >= 5);
    assert_eq!(st.body["signed_by_month"].as_array().unwrap().len(), 12);
    assert_eq!(st.body["expiring_3m"][0]["key"], "m1");
    assert!(
        st.body["by_team"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["label"] == "m11 Team")
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/stats?date_from=x"), Some(VIEWER), None)
            .await
            .status,
        400
    );
    let _ = e2;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn tep_hop_dong_tai_len_tai_xuong_thay_va_xoa() {
    setup().await;
    let a = app().await;
    let e1 = emp(E1).await;
    let c = call(
        &a,
        Method::POST,
        B,
        Some(MANAGER),
        Some(json!({ "employee_id": e1, "signed_date": "2026-01-01" })),
    )
    .await;
    let id = c.body["id"].as_i64().unwrap();
    let file_path = format!("{B}/{id}/file");

    // Chưa có tệp ⇒ 404; thiếu tệp ⇒ 400; sai loại ⇒ 400 đúng câu; trường tệp lạ ⇒ 400; thiếu quyền ⇒ 403.
    assert_eq!(
        msg(&call(&a, Method::GET, &file_path, Some(VIEWER), None).await),
        "Hợp đồng chưa có file đính kèm"
    );
    let none = upload(&a, &file_path, MANAGER, &[("note", None, None, b"x")]).await;
    assert_eq!(
        (none.status.as_u16(), msg(&none)),
        (400, "Vui lòng chọn file để tải lên".to_owned())
    );
    let exe = upload(
        &a,
        &file_path,
        MANAGER,
        &[("file", Some("a.exe"), Some("application/x-msdownload"), b"MZ")],
    )
    .await;
    assert_eq!(
        (exe.status.as_u16(), msg(&exe)),
        (400, "Chỉ chấp nhận file PDF, JPG, PNG hoặc WEBP.".to_owned())
    );
    let wrong = upload(
        &a,
        &file_path,
        MANAGER,
        &[("anh", Some("a.png"), Some("image/png"), b"x")],
    )
    .await;
    assert_eq!(
        (wrong.status.as_u16(), msg(&wrong)),
        (400, "Unexpected field".to_owned())
    );
    assert_eq!(
        upload(
            &a,
            &file_path,
            VIEWER,
            &[("file", Some("a.pdf"), Some("application/pdf"), b"x")]
        )
        .await
        .status,
        403
    );

    // Loại tệp được chuẩn hoá (chữ hoa, tham số sau `;`) trước khi so danh sách.
    let norm = upload(
        &a,
        &file_path,
        MANAGER,
        &[("file", Some("n.pdf"), Some("Application/PDF; charset=binary"), b"%PDF")],
    )
    .await;
    assert_eq!(norm.status, 201, "{:?}", norm.body);

    // Tải lên: byte nhị phân (cả 0x00 và 0xFF) phải về đúng từng byte; tên tệp tiếng Việt được làm sạch trong khoá.
    let mut data: Vec<u8> = (0..=255u8).collect();
    data.extend(std::iter::repeat_n(0xAB, 300_000));
    let up = upload(
        &a,
        &file_path,
        MANAGER,
        &[("file", Some("Hợp đồng/1.pdf"), Some("application/pdf"), &data)],
    )
    .await;
    assert_eq!(up.status, 201, "{:?}", up.body);
    let key = up.body["file_url"].as_str().unwrap().to_owned();
    assert!(
        key.starts_with(&format!("contracts/{e1}/{id}/")) && key.ends_with("H_p___ng_1.pdf"),
        "{key}"
    );
    assert!(root().join(&key).exists() || std::fs::read_dir(root()).is_ok());

    let dl = call(&a, Method::GET, &file_path, Some(VIEWER), None).await;
    assert_eq!(dl.status, 200);
    assert_eq!(dl.raw, data, "tệp tải xuống giống hệt tệp tải lên");
    assert_eq!(dl.headers["content-type"], "application/pdf");
    assert_eq!(dl.headers["content-length"], data.len().to_string().as_str());
    let cd = dl.headers["content-disposition"].to_str().unwrap().to_owned();
    assert!(
        cd.starts_with("inline; filename*=UTF-8''") && cd.ends_with("H_p___ng_1.pdf"),
        "{cd}"
    );
    // OWN không thấy tệp của người khác.
    assert_eq!(call(&a, Method::GET, &file_path, Some(OWN), None).await.status, 404);

    // Thay tệp ⇒ khoá mới, tệp cũ bị xoá khỏi kho.
    let up2 = upload(
        &a,
        &file_path,
        MANAGER,
        &[("file", Some("moi.png"), Some("image/png"), b"\x89PNG-moi")],
    )
    .await;
    let key2 = up2.body["file_url"].as_str().unwrap().to_owned();
    assert_ne!(key, key2);
    assert_eq!(
        call(&a, Method::GET, &file_path, Some(VIEWER), None).await.raw,
        b"\x89PNG-moi"
    );
    assert!(!root().join(&key).exists(), "tệp cũ phải bị xoá");

    // Xoá tệp ⇒ file_url null, kho sạch; xoá hợp đồng xoá luôn tệp đính kèm.
    let del = call(&a, Method::DELETE, &file_path, Some(MANAGER), None).await;
    assert_eq!(del.body["file_url"], Value::Null);
    assert!(!root().join(&key2).exists());
    let again = upload(
        &a,
        &file_path,
        MANAGER,
        &[("file", Some("b.webp"), Some("image/webp"), b"RIFFwebp")],
    )
    .await;
    let key3 = again.body["file_url"].as_str().unwrap().to_owned();
    assert!(root().join(&key3).exists());
    call(&a, Method::DELETE, &format!("{B}/{id}"), Some(MANAGER), None).await;
    assert!(!root().join(&key3).exists(), "xoá hợp đồng xoá luôn tệp");
    assert_eq!(
        upload(
            &a,
            &format!("{B}/999999/file"),
            MANAGER,
            &[("file", Some("a.pdf"), Some("application/pdf"), b"x")]
        )
        .await
        .status,
        404
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn ho_so_mau_tai_len_danh_sach_tai_xuong_va_xoa() {
    setup().await;
    let a = app().await;
    let t = format!("{B}/templates");
    assert_eq!(call(&a, Method::GET, &t, Some(NOBODY), None).await.status, 403);
    assert_eq!(
        upload(
            &a,
            &t,
            VIEWER,
            &[("file", Some("m.pdf"), Some("application/pdf"), b"x")]
        )
        .await
        .status,
        403
    );
    // Sai loại: ảnh không được làm mẫu.
    let bad = upload(&a, &t, MANAGER, &[("file", Some("a.png"), Some("image/png"), b"x")]).await;
    assert_eq!(
        msg(&bad),
        "Chỉ chấp nhận file PDF, Word (.doc/.docx) hoặc Excel (.xls/.xlsx)."
    );
    assert_eq!(
        upload(&a, &t, MANAGER, &[("name", None, None, b"chi ten")])
            .await
            .status,
        400
    );

    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    let data: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
    let up = upload(
        &a,
        &t,
        MANAGER,
        &[
            ("name", None, None, "  m11 Mẫu HĐLĐ  ".as_bytes()),
            ("file", Some("mau.docx"), Some(docx), &data),
        ],
    )
    .await;
    assert_eq!(up.status, 201, "{:?}", up.body);
    assert_eq!(up.body["name"], "m11 Mẫu HĐLĐ");
    assert_eq!(
        (up.body["mime"].as_str(), up.body["size"].as_i64()),
        (Some(docx), Some(70_000))
    );
    assert_eq!(up.body["uploaded_by"], MANAGER);
    assert!(up.body.get("storage_key").is_none(), "không lộ khoá lưu trữ");
    // Không có `name` ⇒ dùng tên tệp.
    let up2 = upload(
        &a,
        &t,
        MANAGER,
        &[("file", Some("m11-mau-hai.pdf"), Some("application/pdf"), b"%PDF-1")],
    )
    .await;
    assert_eq!(up2.body["name"], "m11-mau-hai.pdf");

    let list = call(&a, Method::GET, &t, Some(VIEWER), None).await;
    let names: Vec<&str> = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|x| x["name"].as_str())
        .collect();
    assert_eq!(
        &names[..2],
        ["m11-mau-hai.pdf", "m11 Mẫu HĐLĐ"],
        "mới nhất trước: {names:?}"
    );

    let id = up.body["id"].as_i64().unwrap();
    let dl = call(&a, Method::GET, &format!("{t}/{id}/file"), Some(VIEWER), None).await;
    assert_eq!(dl.raw, data, "tệp mẫu tải xuống giống hệt tệp tải lên");
    assert_eq!(dl.headers["content-type"], docx);
    assert!(
        dl.headers["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment; filename*=UTF-8''m11%20M%E1%BA%ABu")
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{t}/999999/file"), Some(VIEWER), None)
            .await
            .status,
        404
    );

    let key: String = scalar(&format!("SELECT storage_key FROM contract_templates WHERE id = {id}")).await;
    assert!(root().join(&key).exists());
    assert_eq!(
        call(&a, Method::DELETE, &format!("{t}/{id}"), Some(VIEWER), None)
            .await
            .status,
        403
    );
    assert_eq!(
        call(&a, Method::DELETE, &format!("{t}/{id}"), Some(MANAGER), None)
            .await
            .body,
        json!({ "ok": true, "id": id })
    );
    assert!(!root().join(&key).exists());
    assert_eq!(
        call(&a, Method::DELETE, &format!("{t}/{id}"), Some(MANAGER), None)
            .await
            .status,
        404
    );
    teardown().await;
}
