//! Thành viên (vai trò cố định) xem phiếu lương của CHÍNH MÌNH qua HTTP (router thật, quyền đọc từ `role_permissions` thật,
//! Postgres thật): `payroll.view` phạm vi `own` từ `MEMBER_GRANTS` và migration `0031_thanh_vien_xem_phieu_luong`.
//! Quản lý (`payroll.view` team) và kế toán (`payroll.view` all + `payroll.manage`) giữ nguyên phạm vi cũ.
//!
//! Chạy: `TEST_DATABASE_URL=postgresql://$USER@localhost:5432/trinity_<tên> cargo test -p mod-payroll --test thanh_vien_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9961..9969 (phiếu tháng `2098-07`).

use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_payroll::api::{Ctx, api_router};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_http::router::AccessDeps;
use trinity_rbac::fixed_roles::{self, MEMBER_ROLE_MARK};
use trinity_rbac::{PermissionService, RbacCache, ScopeService};

const JWT: &str = "ax2-luong-jwt-secret-0123456789abcdef0123456789abcdef";
const MIGRATION: &str = include_str!("../../../prisma/migrations/0031_thanh_vien_xem_phieu_luong/migration.sql");
const MONTH: &str = "2098-07";

const NV1: i32 = 9961; // Thành viên, quản lý trực tiếp là QL
const NV2: i32 = 9962; // Thành viên khác
const QL: i32 = 9963; // vai trò quản lý: payroll.view team
const KT: i32 = 9964; // vai trò kế toán: payroll.view all + payroll.manage + payroll.export all

/// Hai test cùng sửa vai trò Thành viên dùng chung (migration xoá rồi thêm lại `payroll.view`) ⇒ chạy tuần tự.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

async fn app() -> Router {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let ctx = Arc::new(Ctx {
        db: db.clone(),
        scopes: ScopeService::new(db, cache),
        socket: Arc::new(OnceLock::new()),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    api_router(deps).into_parts().0.with_state(ctx)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@ax2.test"), None, None, now),
        JWT,
    )
    .unwrap()
}

async fn call(app: &Router, method: Method, path: &str, user: i32, body: Option<Value>) -> (StatusCode, Value) {
    let b = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {}", token(user)));
    let req = match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap();
    (status, serde_json::from_slice(&raw).unwrap_or(Value::Null))
}

/// Chủ các phiếu trong danh sách (`user_id` của nhân viên), đã sắp.
fn owners(v: &Value) -> Vec<i64> {
    let mut out: Vec<i64> = v
        .as_array()
        .unwrap_or_else(|| panic!("cần mảng, được {v}"))
        .iter()
        .map(|p| {
            p["employee"]["user_id"]
                .as_i64()
                .unwrap_or_else(|| panic!("phiếu thiếu employee.user_id: {p}"))
        })
        .collect();
    out.sort_unstable();
    out
}

async fn teardown() {
    exec(&format!(
        "DELETE FROM payslips WHERE month = '{MONTH}' OR employee_id IN (SELECT id FROM employees WHERE user_id BETWEEN 9961 AND 9969);
         DELETE FROM employees WHERE user_id BETWEEN 9961 AND 9969;
         DELETE FROM audit_logs WHERE user_id BETWEEN 9961 AND 9969;
         DELETE FROM user_roles WHERE user_id BETWEEN 9961 AND 9969;
         DELETE FROM role_permissions WHERE role_id BETWEEN 9961 AND 9969;
         DELETE FROM roles WHERE id BETWEEN 9961 AND 9969;
         UPDATE users SET manager_id = NULL WHERE id BETWEEN 9961 AND 9969;
         DELETE FROM users WHERE id BETWEEN 9961 AND 9969;"
    ))
    .await;
}

/// Thành viên lấy từ đường tạo lười thật (`ensure_member_role`), không tự chép quyền vào test.
async fn member_role() -> i32 {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let mut tx = c.begin().await.unwrap();
    let id = fixed_roles::ensure_member_role(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    id
}

/// Trả id phiếu của NV1, NV2, QL, KT.
async fn setup() -> [i64; 4] {
    teardown().await;
    let member = member_role().await;
    for (id, mgr) in [(QL, "NULL"), (KT, "NULL"), (NV1, "9963"), (NV2, "NULL")] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, manager_id, updated_at)
             VALUES ({id}, 'u{id}@ax2.test', 'x', 'AX2 {id}', {mgr}, now())"
        ))
        .await;
    }
    exec(&format!(
        "INSERT INTO roles (id, name, is_system, updated_at) VALUES (9961, 'ax2-quan-ly', false, now()), (9962, 'ax2-ke-toan', false, now());
         INSERT INTO role_permissions (role_id, permission, scope) VALUES
           (9961, 'payroll.view', 'team'),
           (9962, 'payroll.view', 'all'), (9962, 'payroll.manage', NULL), (9962, 'payroll.export', 'all');
         INSERT INTO user_roles (user_id, role_id) VALUES ({NV1}, {member}), ({NV2}, {member}), ({QL}, 9961), ({KT}, 9962);"
    ))
    .await;
    let mut ids = [0i64; 4];
    for (i, u) in [NV1, NV2, QL, KT].into_iter().enumerate() {
        let e: i32 = scalar(&format!(
            "INSERT INTO employees (user_id, position, status) VALUES ({u}, 'ax2', 'active') RETURNING id"
        ))
        .await;
        let p: i32 = scalar(&format!(
            "INSERT INTO payslips (employee_id, month, updated_at) VALUES ({e}, '{MONTH}', now()) RETURNING id"
        ))
        .await;
        ids[i] = i64::from(p);
    }
    ids
}

#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn thanh_vien_chi_xem_phieu_cua_minh_quan_ly_ke_toan_khong_doi() {
    let _serial = SERIAL.lock().await;
    let [p1, p2, pq, pk] = setup().await;
    // Thành viên mặc định có payroll.view phạm vi own (seed `MEMBER_GRANTS`).
    let scope: Option<String> = scalar(&format!(
        "SELECT rp.scope FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
         WHERE r.description = '{MEMBER_ROLE_MARK}' AND rp.permission = 'payroll.view' ORDER BY r.id LIMIT 1"
    ))
    .await;
    assert_eq!(scope.as_deref(), Some("own"));

    let app = app().await;
    let list = format!("/api/v1/payslips?month={MONTH}");

    // NV1: danh sách chỉ có phiếu của mình; mở phiếu người khác ⇒ 404 (không lộ là có).
    let (s, v) = call(&app, Method::GET, &list, NV1, None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(owners(&v), [i64::from(NV1)]);
    let (s, v) = call(&app, Method::GET, &format!("/api/v1/payslips/{p1}"), NV1, None).await;
    assert_eq!(
        (s, v["employee"]["user_id"].as_i64()),
        (StatusCode::OK, Some(i64::from(NV1))),
        "{v}"
    );
    for other in [p2, pq, pk] {
        let (s, v) = call(&app, Method::GET, &format!("/api/v1/payslips/{other}"), NV1, None).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "NV1 mở phiếu #{other}: {v}");
    }
    let (s, v) = call(
        &app,
        Method::GET,
        &format!("/api/v1/payslips/me?month={MONTH}"),
        NV1,
        None,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(owners(&v), [i64::from(NV1)]);

    // NV2 tương tự, không thấy phiếu NV1.
    let (s, v) = call(&app, Method::GET, &list, NV2, None).await;
    assert_eq!((s, owners(&v)), (StatusCode::OK, vec![i64::from(NV2)]));
    let (s, _) = call(&app, Method::GET, &format!("/api/v1/payslips/{p1}"), NV2, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Thành viên không lập/sửa/xoá/duyệt/xuất phiếu, không xem cấu hình và báo cáo lương.
    let forbidden: [(Method, String, Option<Value>); 12] = [
        (Method::GET, format!("/api/v1/payslips/addable?month={MONTH}"), None),
        (
            Method::POST,
            "/api/v1/payslips/generate".into(),
            Some(json!({"month": MONTH})),
        ),
        (
            Method::PATCH,
            format!("/api/v1/payslips/{p1}"),
            Some(json!({"advances": "1"})),
        ),
        (Method::DELETE, format!("/api/v1/payslips/{p1}"), None),
        (
            Method::PATCH,
            format!("/api/v1/payslips/{p1}/approve"),
            Some(json!({"action": "approve"})),
        ),
        (Method::GET, format!("/api/v1/payslips/{p1}/pdf"), None),
        (Method::GET, format!("/api/v1/payslips/{p1}/excel"), None),
        (Method::GET, format!("/api/v1/payslips/excel-bulk?month={MONTH}"), None),
        (Method::GET, "/api/v1/salary-components".into(), None),
        (Method::GET, "/api/v1/insurance-settings".into(), None),
        (Method::GET, "/api/v1/tax-config".into(), None),
        (Method::GET, "/api/v1/reports/summary".into(), None),
    ];
    for (m, path, body) in forbidden {
        let (s, v) = call(&app, m.clone(), &path, NV1, body).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{m} {path}: {v}");
    }
    // Phiếu của NV1 không bị đổi.
    let left: i64 = scalar(&format!(
        "SELECT count(*) FROM payslips WHERE id = {p1} AND deleted_at IS NULL"
    ))
    .await;
    assert_eq!(left, 1);

    // Quản lý (team): mình + cấp dưới trực tiếp NV1, không thấy NV2/KT.
    let (s, v) = call(&app, Method::GET, &list, QL, None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(owners(&v), [i64::from(NV1), i64::from(QL)]);
    let (s, _) = call(&app, Method::GET, &format!("/api/v1/payslips/{p1}"), QL, None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = call(&app, Method::GET, &format!("/api/v1/payslips/{p2}"), QL, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Kế toán (all + manage): thấy cả bốn phiếu, mở được phiếu bất kỳ, vẫn quản lý được cấu hình.
    let (s, v) = call(&app, Method::GET, &list, KT, None).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let all = owners(&v);
    for u in [NV1, NV2, QL, KT] {
        assert!(all.contains(&i64::from(u)), "kế toán thiếu phiếu của {u}: {all:?}");
    }
    for p in [p1, p2, pq, pk] {
        let (s, v) = call(&app, Method::GET, &format!("/api/v1/payslips/{p}"), KT, None).await;
        assert_eq!(s, StatusCode::OK, "kế toán mở #{p}: {v}");
    }
    let (s, v) = call(&app, Method::GET, "/api/v1/salary-components", KT, None).await;
    assert_eq!(s, StatusCode::OK, "{v}");

    teardown().await;
}

/// Migration 0031 cho công ty đã có vai trò Thành viên từ trước: bổ sung đúng một dòng `own`, chạy lại không đổi gì, không có
/// vai trò Thành viên thì không làm gì, đã có phạm vi rộng hơn thì giữ nguyên.
#[tokio::test]
#[ignore = "cần Postgres: đặt TEST_DATABASE_URL rồi chạy với --ignored"]
async fn migration_bo_sung_payroll_view_own_cho_thanh_vien_cu() {
    let _serial = SERIAL.lock().await;
    let member = member_role().await;
    let grant = |role: i32| {
        format!(
            "SELECT coalesce(string_agg(coalesce(scope, 'NULL'), ','), '') FROM role_permissions WHERE role_id = {role} AND permission = 'payroll.view'"
        )
    };

    // Công ty cũ: vai trò Thành viên chưa có payroll.view ⇒ migration thêm `own`; chạy lại vẫn một dòng.
    exec(&format!(
        "DELETE FROM role_permissions WHERE role_id = {member} AND permission = 'payroll.view'"
    ))
    .await;
    assert_eq!(scalar::<String>(&grant(member)).await, "");
    exec(MIGRATION).await;
    exec(MIGRATION).await;
    assert_eq!(scalar::<String>(&grant(member)).await, "own");

    let mut c = PgConnection::connect(&url()).await.unwrap();
    // Đã có phạm vi rộng hơn (vd. dữ liệu sửa tay) ⇒ giữ nguyên.
    let mut tx = c.begin().await.unwrap();
    sqlx::query("UPDATE role_permissions SET scope = 'all' WHERE role_id = $1 AND permission = 'payroll.view'")
        .bind(member)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql(AssertSqlSafe(MIGRATION)).execute(&mut *tx).await.unwrap();
    let s: String = sqlx::query_scalar(AssertSqlSafe(grant(member)))
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(s, "all");
    tx.rollback().await.unwrap();

    // Công ty chưa có vai trò Thành viên ⇒ không thêm dòng nào.
    let mut tx = c.begin().await.unwrap();
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'payroll.view'")
        .bind(member)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE roles SET description = 'ax2-khong-phai-thanh-vien' WHERE id = $1")
        .bind(member)
        .execute(&mut *tx)
        .await
        .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM role_permissions")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql(AssertSqlSafe(MIGRATION)).execute(&mut *tx).await.unwrap();
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM role_permissions")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(before, after);
    tx.rollback().await.unwrap();

    assert_eq!(scalar::<String>(&grant(member)).await, "own");
}
