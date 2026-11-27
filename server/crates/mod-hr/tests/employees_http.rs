//! M10 qua HTTP (router K14 thật, quyền thật, Postgres thật). `public` đã migrate bằng Prisma:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-hr --test employees_http -- --ignored --test-threads=1`
//! Test tự tạo và xoá user/vai trò 9501..9599 (và mọi dòng liên quan).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use mod_hr::employees::Ctx;
use mod_hr::routes::employee_router;
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use tower::ServiceExt;
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};
use trinity_docgen::xlsx::read_first_sheet;
use trinity_http::router::AccessDeps;
use trinity_rbac::{PermissionService, RbacCache, ScopeService};
use trinity_storage::LocalUploadsStore;

const JWT: &str = "m10-jwt-secret-0123456789abcdef0123456789abcdef";

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

fn uploads_root() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("trinity-m10-uploads-{}", std::process::id()))
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
        uploads: LocalUploadsStore::new(uploads_root()),
    });
    let deps = Arc::new(AccessDeps {
        auth: Arc::new(Authenticator::new(security, JWT, &[])),
        permissions: perms,
        features: None,
        guards: Default::default(),
    });
    let (router, table) = employee_router(deps).into_parts();
    assert_eq!(table.len(), 12);
    router.with_state(ctx)
}

fn token(user: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    jwt::sign(
        &Claims::access(i64::from(user), &format!("u{user}@m10.test"), None, None, now),
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

async fn call(app: &Router, method: Method, path: &str, user: Option<i32>, body: Option<Value>) -> Res {
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
    let resp = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (resp.status(), resp.headers().clone());
    let raw = axum::body::to_bytes(resp.into_body(), 16 << 20).await.unwrap().to_vec();
    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    Res {
        status,
        body,
        raw,
        headers,
    }
}

fn msg(r: &Res) -> String {
    match &r.body["message"] {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

const ADMIN: i32 = 9501; // vai trò hệ thống
const HR: i32 = 9502; // employees.view/export all, employees.manage, users.manage all
const S1: i32 = 9503; // nhân viên của team T, quản lý HR
const S2: i32 = 9504;
const LOW: i32 = 9505; // chỉ employees.view own
const HI: i32 = 9506; // quyền cao hơn HR

async fn teardown() {
    exec("DELETE FROM user_invitations WHERE created_by BETWEEN 9501 AND 9599;
          DELETE FROM employment_periods WHERE employee_id IN (SELECT id FROM employees WHERE user_id BETWEEN 9501 AND 9599 OR user_id IN (SELECT id FROM users WHERE email LIKE '%@m10.test'));
          DELETE FROM employees WHERE user_id IN (SELECT id FROM users WHERE id BETWEEN 9501 AND 9599 OR email LIKE '%@m10.test');
          DELETE FROM audit_logs WHERE resource_id BETWEEN 9501 AND 9599 OR user_id BETWEEN 9501 AND 9599;
          DELETE FROM token_blacklist WHERE user_id BETWEEN 9501 AND 9599;
          DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE id BETWEEN 9501 AND 9599 OR email LIKE '%@m10.test');
          DELETE FROM role_permissions WHERE role_id BETWEEN 9501 AND 9599;
          DELETE FROM roles WHERE id BETWEEN 9501 AND 9599;
          UPDATE users SET manager_id = NULL, team_id = NULL WHERE id BETWEEN 9501 AND 9599 OR email LIKE '%@m10.test';
          DELETE FROM teams WHERE name LIKE 'm10%';
          DELETE FROM job_titles WHERE name LIKE 'm10%';
          DELETE FROM users WHERE id BETWEEN 9501 AND 9599 OR email LIKE '%@m10.test'").await;
}

async fn setup() {
    teardown().await;
    for (id, name, mgr, phone, status) in [
        (ADMIN, "Admin", "NULL", "'0910000001'", "active"),
        (HR, "Nhân sự", "NULL", "'0910000002'", "active"),
        (S1, "Nhân viên một", "9502", "'0910000003'", "active"),
        (S2, "Nhân viên hai", "9502", "'0910000004'", "active"),
        (LOW, "Chỉ xem mình", "NULL", "'0910000005'", "active"),
        (HI, "Quyền cao", "NULL", "'0910000006'", "active"),
    ] {
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, phone, status, manager_id, updated_at)
             VALUES ({id}, 'u{id}@m10.test', 'x', '{name}', {phone}, '{status}', {mgr}, now());
             INSERT INTO employees (user_id, position, status, joined_at, birth_date)
             VALUES ({id}, 'Nhân viên', 'active', now(), {})",
            // Sinh nhật ngày 17/05 giờ VN (nửa đêm VN = 17:00 UTC hôm trước).
            if id == S1 { "'1990-05-16T17:00:00Z'" } else { "NULL" }
        ))
        .await;
    }
    exec("INSERT INTO roles (id, name, is_system, updated_at) VALUES
            (9501, 'm10-admin', true, now()), (9502, 'm10-hr', false, now()), (9503, 'm10-nhan-vien', false, now()), (9504, 'm10-cao', false, now());
          INSERT INTO role_permissions (role_id, permission, scope) VALUES
            (9502, 'employees.view', 'all'), (9502, 'employees.manage', NULL), (9502, 'employees.export', 'all'), (9502, 'users.manage', 'all'), (9502, 'users.view', 'all'),
            (9503, 'employees.view', 'own'),
            (9504, 'employees.view', 'all'), (9504, 'employees.manage', NULL), (9504, 'users.manage', 'all'), (9504, 'payroll.view', 'all'), (9504, 'contacts.create', NULL), (9504, 'users.view', 'all'), (9504, 'employees.export', 'all');
          INSERT INTO user_roles (user_id, role_id) VALUES (9501, 9501), (9502, 9502), (9503, 9503), (9504, 9503), (9505, 9503), (9506, 9504)").await;
    exec(
        "INSERT INTO teams (name, department, team_lead_id, color) VALUES ('m10 Team', 'Kinh doanh', 9502, '#112233')",
    )
    .await;
}

const B: &str = "/api/v1/management/employees";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn danh_sach_chi_tiet_theo_pham_vi_dto_va_thong_ke() {
    setup().await;
    let a = app().await;
    assert_eq!(call(&a, Method::GET, B, None, None).await.status, 401);
    assert_eq!(
        call(&a, Method::GET, B, Some(LOW), None).await.status,
        200,
        "LOW có employees.view own"
    );
    assert_eq!(call(&a, Method::POST, B, Some(LOW), Some(json!({}))).await.status, 403);
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/abc"), Some(HR), None).await.status,
        400
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/export"), Some(LOW), None)
            .await
            .status,
        403
    );

    // DTO kiểm bằng metadata thật: tham số sai ⇒ 400 đúng câu class-validator.
    let bad = call(
        &a,
        Method::GET,
        &format!("{B}?page=0&page_size=101&sort_by=email&employment_state=x"),
        Some(HR),
        None,
    )
    .await;
    assert_eq!(bad.status, 400);
    assert!(
        bad.body["message"].as_array().is_some_and(|m| m.len() >= 3),
        "{:?}",
        bad.body
    );
    let unknown = call(&a, Method::GET, &format!("{B}?bua=1"), Some(HR), None).await;
    assert_eq!(unknown.status, 400, "chế độ strict: tham số lạ bị từ chối");

    // Phạm vi: LOW chỉ thấy chính mình; HR thấy tất cả; mặc định sắp theo team → trưởng nhóm → thâm niên → tên.
    let own = call(&a, Method::GET, &format!("{B}?page_size=100"), Some(LOW), None).await;
    let ids: Vec<i64> = own.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["user_id"].as_i64())
        .filter(|u| (9501..9600).contains(u))
        .collect();
    assert_eq!(ids, [i64::from(LOW)]);
    let all = call(
        &a,
        Method::GET,
        &format!("{B}?page_size=100&search=m10.test"),
        Some(HR),
        None,
    )
    .await;
    assert_eq!(all.status, 200, "{:?}", all.body);
    let first = &all.body["data"][0];
    assert_eq!(first["user_id"], HR, "trưởng nhóm của team đứng đầu");
    assert_eq!(first["team_name"], "m10 Team");
    assert_eq!(all.body["pagination"]["total"], 6);
    // S1/S2 có quản lý là trưởng nhóm ⇒ cùng team; chi tiết ngoài phạm vi ⇒ 404.
    let emp_s1: i64 = scalar(&format!("SELECT id::bigint FROM employees WHERE user_id = {S1}")).await;
    let one = call(&a, Method::GET, &format!("{B}/{emp_s1}"), Some(HR), None).await;
    assert_eq!(one.status, 200);
    assert_eq!(
        (
            one.body["team_id"].is_i64(),
            one.body["employee_code"].as_str().is_some_and(|c| c.starts_with("NV"))
        ),
        (true, true)
    );
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/{emp_s1}"), Some(LOW), None)
            .await
            .status,
        404
    );

    // Thống kê: đếm trong phạm vi; hr-stats gom team + sinh nhật theo tháng giờ VN; danh sách sinh nhật ngày 17.
    let st = call(&a, Method::GET, &format!("{B}/stats"), Some(HR), None).await;
    assert_eq!(st.status, 200);
    assert!(
        st.body["by_status"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["label"] == "active")
    );
    let hs = call(&a, Method::GET, &format!("{B}/hr-stats"), Some(HR), None).await;
    assert_eq!(hs.status, 200, "{:?}", hs.body);
    assert_eq!(
        hs.body["birthdays_by_month"][4]["count"], 1,
        "tháng 5: S1 sinh 17/05 giờ VN"
    );
    assert_eq!(
        hs.body["by_team"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["team_name"] == "m10 Team")
            .map(|t| t["count"].clone()),
        Some(json!(3))
    );
    let bd = call(&a, Method::GET, &format!("{B}/birthdays?month=5"), Some(HR), None).await;
    let day = bd.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["full_name"] == "Nhân viên một")
        .map(|i| i["day"].clone());
    assert_eq!(day, Some(json!(17)));
    assert_eq!(
        call(&a, Method::GET, &format!("{B}/birthdays?month=13"), Some(HR), None)
            .await
            .status,
        400
    );

    // Xuất xlsx: đúng loại, tên file, cột; scope export own chỉ ra đúng người đó.
    let ex = call(&a, Method::GET, &format!("{B}/export?search=m10.test"), Some(HR), None).await;
    assert_eq!(ex.status, 200);
    assert!(
        ex.headers["content-disposition"]
            .to_str()
            .unwrap()
            .contains("danh-sach-nhan-vien.xlsx")
    );
    let sheet = read_first_sheet(&ex.raw).unwrap();
    assert_eq!(
        sheet.cell(2, 2).as_trimmed_text().as_deref(),
        Some("Họ tên"),
        "tiêu đề, dòng trống rồi tiêu đề cột (bộ ghi chung K29)"
    );
    let names: Vec<String> = (3..10).filter_map(|r| sheet.cell(r, 2).as_trimmed_text()).collect();
    assert!(names.contains(&"Nhân sự".to_owned()) && names.len() == 6, "{names:?}");
    let be = call(
        &a,
        Method::GET,
        &format!("{B}/birthdays/export?month=5"),
        Some(HR),
        None,
    )
    .await;
    assert!(
        be.headers["content-disposition"]
            .to_str()
            .unwrap()
            .contains("danh-sach-sinh-nhat-thang-5.xlsx")
    );
    assert!(
        read_first_sheet(&be.raw)
            .unwrap()
            .cell(1, 0)
            .as_trimmed_text()
            .unwrap()
            .starts_with("Tháng 5")
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn them_sua_khoa_mo_khoa_xoa_va_giai_doan_lam_viec() {
    setup().await;
    let a = app().await;

    // Thêm: 400 đúng câu; 201 tạo user + hồ sơ, chọn Team ⇒ quản lý + phòng ban theo team; trùng email 409; trùng SĐT 409.
    let bad = call(
        &a,
        Method::POST,
        B,
        Some(HR),
        Some(json!({ "email": "khong-email", "full_name": "A", "phone": "0123" })),
    )
    .await;
    assert_eq!(bad.status, 400);
    let team_id: i64 = scalar("SELECT id::bigint FROM teams WHERE name = 'm10 Team'").await;
    let created = call(
        &a,
        Method::POST,
        B,
        Some(HR),
        Some(json!({ "email": "moi@m10.test", "full_name": "Nhân viên mới", "phone": "0910000099", "team_id": team_id, "gender": "F", "status": "probation", "birth_date": "1995-12-31" })),
    )
    .await;
    assert_eq!(created.status, 201, "{:?}", created.body);
    let new_id = created.body["id"].as_i64().unwrap();
    assert_eq!(
        (created.body["department"].as_str(), created.body["manager_id"].as_i64()),
        (Some("Kinh doanh"), Some(i64::from(HR)))
    );
    assert_eq!(created.body["status"], "probation");
    let dup = call(
        &a,
        Method::POST,
        B,
        Some(HR),
        Some(json!({ "email": "moi@m10.test", "full_name": "Trùng email" })),
    )
    .await;
    assert_eq!(dup.status, 409);
    let dup_phone = call(
        &a,
        Method::POST,
        B,
        Some(HR),
        Some(json!({ "email": "khac@m10.test", "full_name": "Trùng SĐT", "phone": "0910000099" })),
    )
    .await;
    assert_eq!(
        (dup_phone.status, msg(&dup_phone)),
        (StatusCode::CONFLICT, "Số điện thoại đã được sử dụng".to_owned())
    );
    let no_title = call(
        &a,
        Method::POST,
        B,
        Some(HR),
        Some(json!({ "email": "t@m10.test", "full_name": "Chức danh lạ", "job_title_id": 999_999 })),
    )
    .await;
    assert_eq!(no_title.status, 404);

    // Sửa: `status: null`/tên `null` bị DTO chặn; sửa hợp lệ; quản lý vòng ⇒ 400; tự đặt quản lý chính mình ⇒ 403.
    let p = format!("{B}/{new_id}");
    assert_eq!(
        call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "status": null })))
            .await
            .status,
        400
    );
    assert_eq!(
        call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "full_name": null })))
            .await
            .status,
        400
    );
    let upd = call(
        &a,
        Method::PATCH,
        &p,
        Some(HR),
        Some(json!({ "full_name": "Tên mới", "bank_name": "  VCB  ", "current_address": "", "birth_date": "" })),
    )
    .await;
    assert_eq!(upd.status, 200, "{:?}", upd.body);
    assert_eq!(
        (
            upd.body["full_name"].as_str(),
            upd.body["bank_name"].as_str(),
            upd.body["birth_date"].is_null()
        ),
        (Some("Tên mới"), Some("VCB"), true)
    );
    let new_user: i64 = created.body["user_id"].as_i64().unwrap();
    assert_eq!(
        call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "manager_id": new_user })))
            .await
            .status,
        403
    );
    let hr_emp: i64 = scalar(&format!("SELECT id::bigint FROM employees WHERE user_id = {HR}")).await;
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/{hr_emp}"),
            Some(HR),
            Some(json!({ "manager_id": new_user }))
        )
        .await
        .status,
        400,
        "HR là quản lý của người này: đặt ngược sẽ tạo vòng"
    );
    // Người có quyền cao hơn mình không sửa/khoá được; Quản trị thì sửa được.
    let hi_emp: i64 = scalar(&format!("SELECT id::bigint FROM employees WHERE user_id = {HI}")).await;
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &format!("{B}/{hi_emp}"),
            Some(HR),
            Some(json!({ "position": "x" }))
        )
        .await
        .status,
        403
    );
    assert_eq!(
        call(&a, Method::PATCH, &format!("{B}/{hi_emp}/lock"), Some(HR), None)
            .await
            .status,
        403
    );

    // Khoá: tài khoản locked, hồ sơ resigned, giai đoạn làm việc đóng; không tự khoá mình.
    assert_eq!(
        call(&a, Method::PATCH, &format!("{B}/{hr_emp}/lock"), Some(HR), None)
            .await
            .status,
        403
    );
    let lk = call(&a, Method::PATCH, &format!("{p}/lock"), Some(HR), None).await;
    assert_eq!(
        (lk.status, lk.body["message"].as_str()),
        (StatusCode::OK, Some("Đã khoá tài khoản nhân viên"))
    );
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM users WHERE id = {new_user}")).await,
        "locked"
    );
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM employees WHERE id = {new_id}")).await,
        "resigned"
    );
    assert_eq!(
        scalar::<i64>(&format!(
            "SELECT count(*) FROM employment_periods WHERE employee_id = {new_id} AND ended_on IS NOT NULL"
        ))
        .await,
        1
    );
    // Mở khoá: chỉ Quản trị; không tự mở khoá; khoá rồi mới mở được; ca khoá rồi mở KHÔNG tính lại khoảng bị khoá.
    assert_eq!(
        call(&a, Method::PATCH, &format!("{p}/unlock"), Some(HR), None)
            .await
            .status,
        403
    );
    // Giả lập đã khoá cách đây 5 ngày.
    exec(&format!("UPDATE employment_periods SET ended_on = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 5 WHERE employee_id = {new_id}")).await;
    let un = call(&a, Method::PATCH, &format!("{p}/unlock"), Some(ADMIN), None).await;
    assert_eq!(
        (un.status, un.body["message"].as_str()),
        (StatusCode::OK, Some("Đã mở khoá tài khoản nhân viên")),
        "{:?}",
        un.body
    );
    assert_eq!(
        call(&a, Method::PATCH, &format!("{p}/unlock"), Some(ADMIN), None)
            .await
            .status,
        409,
        "đang không bị khoá"
    );
    let covered = |d: i32| {
        format!(
            "SELECT count(*) FROM employment_periods WHERE employee_id = {new_id} AND (started_on IS NULL OR started_on <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ({d})) AND (ended_on IS NULL OR (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ({d}) < ended_on)"
        )
    };
    assert_eq!(scalar::<i64>(&covered(10)).await, 1, "trước khi khoá vẫn tính");
    assert_eq!(
        scalar::<i64>(&covered(3)).await,
        0,
        "khoảng bị khoá KHÔNG được tính lại sau khi mở khoá"
    );
    assert_eq!(scalar::<i64>(&covered(0)).await, 1, "từ hôm nay đi làm lại");
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM employees WHERE id = {new_id}")).await,
        "active"
    );
    assert_eq!(
        scalar::<String>(&format!("SELECT status FROM users WHERE id = {new_user}")).await,
        "active"
    );
    assert!(scalar::<i64>(&format!("SELECT count(*) FROM audit_logs WHERE action IN ('employee_lock', 'employee_unlock') AND resource_id = {new_id}")).await >= 2);
    // Đổi trạng thái hồ sơ sang resigned qua PATCH cũng đóng giai đoạn; sửa lại vẫn resigned không dời ngày nghỉ.
    assert_eq!(
        call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "status": "resigned" })))
            .await
            .status,
        200
    );
    let resigned: String = scalar(&format!("SELECT resigned_at::text FROM employees WHERE id = {new_id}")).await;
    exec(&format!(
        "UPDATE employees SET resigned_at = resigned_at - interval '3 days' WHERE id = {new_id}"
    ))
    .await;
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &p,
            Some(HR),
            Some(json!({ "status": "resigned", "position": "Chức vụ mới" }))
        )
        .await
        .status,
        200
    );
    assert_ne!(
        scalar::<String>(&format!("SELECT resigned_at::text FROM employees WHERE id = {new_id}")).await,
        resigned
    );
    assert!(
        scalar::<bool>(&format!(
            "SELECT resigned_at < now() - interval '2 days' FROM employees WHERE id = {new_id}"
        ))
        .await,
        "không dời ngày nghỉ sang hôm nay"
    );

    // Xoá mềm: tài khoản bị khoá, hồ sơ mất khỏi danh sách; không xoá chính mình; xoá lại ⇒ 404.
    assert_eq!(
        call(&a, Method::DELETE, &format!("{B}/{hr_emp}"), Some(HR), None)
            .await
            .status,
        403
    );
    let del = call(&a, Method::DELETE, &p, Some(HR), None).await;
    assert_eq!(
        (del.status, del.body["message"].as_str()),
        (StatusCode::OK, Some("Đã xoá nhân viên"))
    );
    assert_eq!(call(&a, Method::DELETE, &p, Some(HR), None).await.status, 404);
    let list = call(
        &a,
        Method::GET,
        &format!("{B}?search=m10.test&page_size=100"),
        Some(HR),
        None,
    )
    .await;
    assert!(list.body["data"].as_array().unwrap().iter().all(|e| e["id"] != new_id));
    // Tạo lại cùng email sau khi xoá mềm ⇒ khôi phục hồ sơ (cùng id nhân viên); tài khoản vẫn khoá (mở khoá là thao tác riêng).
    let back = call(
        &a,
        Method::POST,
        B,
        Some(HR),
        Some(json!({ "email": "moi@m10.test", "full_name": "Quay lại" })),
    )
    .await;
    assert_eq!(back.status, 201, "{:?}", back.body);
    assert_eq!(back.body["id"].as_i64(), Some(new_id));
    assert_eq!(
        back.body["user_status"], "locked",
        "khôi phục hồ sơ KHÔNG tự mở khoá tài khoản"
    );
    teardown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "cần Postgres"]
async fn anh_dai_dien() {
    setup().await;
    let a = app().await;
    // PNG 1x1 hợp lệ.
    let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let emp_s2: i64 = scalar(&format!("SELECT id::bigint FROM employees WHERE user_id = {S2}")).await;
    let p = format!("{B}/{emp_s2}");
    let r = call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "avatar_url": png }))).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    let url = r.body["avatar_url"].as_str().unwrap().to_owned();
    assert!(
        url.starts_with("/uploads/avatars/empl_") && url.ends_with(".jpg"),
        "{url}"
    );
    let file = uploads_root().join(url.trim_start_matches("/uploads/"));
    assert!(file.exists(), "{file:?}");
    // Đường dẫn của người khác bị từ chối; giữ nguyên ảnh của chính mình được; ảnh hỏng ⇒ 400; bỏ ảnh xoá file.
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &p,
            Some(HR),
            Some(json!({ "avatar_url": "/uploads/avatars/khac.jpg" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "avatar_url": url })))
            .await
            .status,
        200
    );
    let bad = call(
        &a,
        Method::PATCH,
        &p,
        Some(HR),
        Some(json!({ "avatar_url": "data:image/png;base64,AAAA" })),
    )
    .await;
    assert_eq!(bad.status, 400);
    assert_eq!(
        call(
            &a,
            Method::PATCH,
            &p,
            Some(HR),
            Some(json!({ "avatar_url": "data:image/gif;base64,AAAA" }))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        call(&a, Method::PATCH, &p, Some(HR), Some(json!({ "avatar_url": null })))
            .await
            .status,
        200
    );
    assert!(!file.exists(), "xoá file ảnh cũ sau khi bỏ ảnh");
    let _ = std::fs::remove_dir_all(uploads_root());
    teardown().await;
}
