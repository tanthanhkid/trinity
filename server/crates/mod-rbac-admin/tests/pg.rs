//! M04 với Postgres thật. Cần DB riêng đã migrate bằng Prisma (bảng của test bị TRUNCATE):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-rbac-admin --test pg -- --ignored --test-threads=1`

use mod_rbac_admin::guardrails::parse_grants_input;
use mod_rbac_admin::{
    Actor, Ctx, audit, roles, validate_audit_query, validate_create_role, validate_set_user_roles, validate_update_role,
};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, PgConnection};
use trinity_auth::Security;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig, TenantDb};
use trinity_kernel::error::AppError;
use trinity_rbac::grants::grants_from_json;
use trinity_rbac::{PermissionService, RbacCache, ScopeService, admin_grants};

const CO: CompanyRef = CompanyRef::DEFAULT;

struct Env {
    t: TenantDb,
    ctx: Ctx,
}

async fn exec(c: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// Người dùng: 1 và 5 Quản trị; 2 quản lý (quản trị người dùng mọi phạm vi, quản trị vai trò, xem khách theo nhóm);
/// 3 và 4 nhân viên; 6 đã xoá mềm; 7 chỉ quản lý được chính mình. Vai trò: 1 hệ thống, 2 Quản lý, 3 Nhân viên (xem khách
/// của mình), 4 Kinh doanh (xem khách mọi nơi, to hơn quản lý), 5 Chỉ mình.
async fn setup() -> Env {
    let mut cfg = DbConfig::new(std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL"));
    cfg.pool_size = 8;
    let db = Db::connect(&cfg).await.expect("kết nối DB");
    let security = Security::new(db.clone(), Platform::new(&db, None), false);
    let cache = RbacCache::new(security);
    let ctx = Ctx {
        company: CO,
        permissions: PermissionService::new(db.clone(), cache.clone()),
        scope: ScopeService::new(db.clone(), cache.clone()),
        cache,
    };
    let t = db.tenant(CO).await.unwrap();
    let mut c = t.acquire().await.unwrap();
    exec(&mut c, "TRUNCATE rbac_audit_log, user_invitations, role_permissions, user_roles, roles, users RESTART IDENTITY CASCADE").await;
    for (id, deleted) in [
        (1, false),
        (2, false),
        (3, false),
        (4, false),
        (5, false),
        (6, true),
        (7, false),
    ] {
        sqlx::query("INSERT INTO users (id, email, password_hash, full_name, status, updated_at, deleted_at) VALUES ($1, $2, 'x', $3, 'active', now(), CASE WHEN $4 THEN now() END)")
            .bind(id)
            .bind(format!("u{id}@example.com"))
            .bind(format!("Người {id}"))
            .bind(deleted)
            .execute(&mut *c)
            .await
            .unwrap();
    }
    exec(&mut c, "INSERT INTO roles (id, name, description, is_system, updated_at) VALUES (1, 'Quản trị', NULL, true, now()), (2, 'Quản lý', 'q', false, now()), (3, 'Nhân viên', NULL, false, now()), (4, 'Kinh doanh', NULL, false, now()), (5, 'Chỉ mình', NULL, false, now())").await;
    exec(&mut c, "INSERT INTO role_permissions (role_id, permission, scope) VALUES (2, 'users.manage', 'all'), (2, 'users.view', 'all'), (2, 'roles.manage', NULL), (2, 'contacts.view', 'team'), (3, 'contacts.view', 'own'), (4, 'contacts.view', 'all'), (5, 'users.manage', 'own'), (5, 'users.view', 'own')").await;
    exec(
        &mut c,
        "INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (5, 1), (2, 2), (3, 3), (4, 3), (6, 3), (7, 5)",
    )
    .await;
    exec(&mut c, "SELECT setval(pg_get_serial_sequence('roles', 'id'), 100)").await;
    Env { t, ctx }
}

fn admin(id: i32) -> Actor {
    Actor {
        user_id: id,
        is_admin: true,
        grants: admin_grants(),
    }
}

fn manager() -> Actor {
    Actor {
        user_id: 2,
        is_admin: false,
        grants: grants_from_json(
            &json!({"users.manage": "all", "users.view": "all", "roles.manage": true, "contacts.view": "team"}),
        ),
    }
}

fn only_self() -> Actor {
    Actor {
        user_id: 7,
        is_admin: false,
        grants: grants_from_json(&json!({"users.manage": "own", "users.view": "own"})),
    }
}

fn jv<T: serde::Serialize>(v: &T) -> Value {
    serde_json::from_str(&serde_json::to_string(v).unwrap()).unwrap()
}

fn create_input(name: &str, grants: Value) -> mod_rbac_admin::CreateRole {
    validate_create_role(&json!({"name": name, "description": "  mô tả  ", "grants": grants})).unwrap()
}

fn status(e: AppError) -> (u16, String) {
    match e {
        AppError::Http(h) => (h.status(), serde_json::to_string(&h.body()).unwrap()),
        other => panic!("lỗi không phải HTTP: {other:?}"),
    }
}

fn expect_err<T: std::fmt::Debug>(r: Result<T, AppError>, code: u16, text: &str) {
    let (s, body) = status(r.unwrap_err());
    assert_eq!(s, code, "{body}");
    assert!(body.contains(text), "{body} thiếu {text}");
}

async fn count(env: &Env, sql: &str) -> i64 {
    let mut c = env.t.acquire().await.unwrap();
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *c)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn vong_doi_vai_tro_va_nhat_ky() {
    let env = setup().await;
    let a = admin(1);
    let mut c = env.t.acquire().await.unwrap();

    let r = roles::create(
        &mut c,
        &a,
        &create_input(
            "  Kế toán ",
            json!({"contacts.view": "team", "products.manage": null, "kanban.boards": false}),
        ),
    )
    .await
    .unwrap();
    let v = jv(&r);
    assert_eq!(
        v.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        ["id", "name", "description", "is_system", "member_count", "grants"]
    );
    assert_eq!(
        (v["name"].clone(), v["description"].clone(), v["member_count"].clone()),
        (json!("Kế toán"), json!("mô tả"), json!(0))
    );
    assert_eq!(v["grants"], json!({"contacts.view": "team", "products.manage": true}));
    let id = r.summary.id;

    // Danh sách theo id; vai trò hệ thống đủ mọi quyền.
    let list = roles::list(&mut c).await.unwrap();
    assert_eq!(
        list.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
        ["Quản trị", "Quản lý", "Nhân viên", "Kinh doanh", "Chỉ mình", "Kế toán"]
    );
    assert_eq!(list[2].member_count, 2, "người đã xoá mềm không tính");
    let sys = jv(&roles::get(&mut c, 1).await.unwrap());
    assert_eq!(
        sys["grants"].as_object().unwrap().len(),
        trinity_rbac::catalog().permissions().len()
    );

    // Tên trùng không phân biệt hoa thường; nhân bản đặt tên bản sao.
    expect_err(
        roles::create(&mut c, &a, &create_input("kế TOÁN", json!({}))).await,
        409,
        "Tên vai trò đã tồn tại",
    );
    let c1 = roles::clone(&mut c, &a, id).await.unwrap();
    let c2 = roles::clone(&mut c, &a, id).await.unwrap();
    assert_eq!(
        (c1.summary.name.as_str(), c2.summary.name.as_str()),
        ("Kế toán (bản sao)", "Kế toán (bản sao 2)")
    );
    assert_eq!(jv(&c1)["grants"], v["grants"]);

    // Đổi tên/mô tả (null = xoá); trùng tên 409; vai trò hệ thống 403.
    let up = roles::update(
        &mut c,
        &a,
        id,
        &validate_update_role(&json!({"name": " Kế toán trưởng ", "description": null})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        (up.summary.name.as_str(), up.summary.description.clone()),
        ("Kế toán trưởng", None)
    );
    expect_err(
        roles::update(
            &mut c,
            &a,
            id,
            &validate_update_role(&json!({"name": "NHÂN VIÊN"})).unwrap(),
        )
        .await,
        409,
        "Tên vai trò đã tồn tại",
    );
    expect_err(
        roles::update(&mut c, &a, 1, &validate_update_role(&json!({"name": "Khác"})).unwrap()).await,
        403,
        "Không thể sửa vai trò hệ thống",
    );
    expect_err(
        roles::update(&mut c, &a, 9999, &validate_update_role(&json!({})).unwrap()).await,
        404,
        "Không tìm thấy vai trò",
    );

    // Thay toàn bộ quyền.
    let g = serde_json::from_value(json!({"contacts.view": "all"})).unwrap();
    let sg = roles::set_grants(&mut c, &env.ctx, &a, id, &g).await.unwrap();
    assert_eq!(jv(&sg)["grants"], json!({"contacts.view": "all"}));
    assert_eq!(
        count(
            &env,
            &format!("SELECT count(*) FROM role_permissions WHERE role_id = {id}")
        )
        .await,
        1
    );
    expect_err(
        roles::set_grants(&mut c, &env.ctx, &a, 1, &g).await,
        403,
        "Không thể sửa vai trò hệ thống",
    );

    // Xoá: hệ thống 409, còn người giữ 409, lời mời còn chờ bị huỷ cùng giao dịch.
    expect_err(
        roles::remove(&mut c, &env.ctx, &a, 1).await,
        409,
        "Không thể xoá vai trò hệ thống",
    );
    expect_err(
        roles::remove(&mut c, &env.ctx, &a, 3).await,
        409,
        "Không thể xoá vai trò đang có 2 người giữ",
    );
    exec(&mut c, &format!("INSERT INTO user_invitations (email, role_id, token_hash, expires_at, created_by) VALUES ('m@x.vn', {id}, 'h', now() + interval '1 day', 1)")).await;
    let m = roles::remove(&mut c, &env.ctx, &a, id).await.unwrap();
    assert_eq!(jv(&m), json!({"message": "Đã xoá vai trò"}));
    assert_eq!(
        count(
            &env,
            &format!("SELECT count(*) FROM user_invitations WHERE role_id = {id} AND revoked_at IS NOT NULL")
        )
        .await,
        1
    );
    assert_eq!(
        count(&env, &format!("SELECT count(*) FROM roles WHERE id = {id}")).await,
        0
    );
    expect_err(
        roles::remove(&mut c, &env.ctx, &a, id).await,
        404,
        "Không tìm thấy vai trò",
    );

    // Nhật ký: tạo, tạo bản sao x2, sửa, quyền, xoá (trong cùng giao dịch với thay đổi).
    let actions: Vec<String> = sqlx::query_scalar("SELECT action FROM rbac_audit_log ORDER BY id")
        .fetch_all(&mut *c)
        .await
        .unwrap();
    assert_eq!(
        actions,
        [
            "role.create",
            "role.create",
            "role.create",
            "role.update",
            "role.grants",
            "role.delete"
        ]
    );
    let del: (Value, Option<Value>) =
        sqlx::query_as("SELECT before, after FROM rbac_audit_log WHERE action = 'role.delete'")
            .fetch_one(&mut *c)
            .await
            .map(|r: (sqlx::types::Json<Value>, Option<sqlx::types::Json<Value>>)| (r.0.0, r.1.map(|x| x.0)))
            .unwrap();
    assert_eq!(del.0["name"], "Kế toán trưởng");
    assert!(del.1.is_none());
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn chong_tu_nang_quyen_o_vai_tro() {
    let env = setup().await;
    let m = manager();
    let mut c = env.t.acquire().await.unwrap();
    // Quản lý chỉ có contacts.view team: cấp được team/own, không cấp được all hay quyền họ không có.
    roles::create(&mut c, &m, &create_input("Phụ việc", json!({"contacts.view": "own"})))
        .await
        .unwrap();
    expect_err(
        roles::create(&mut c, &m, &create_input("Quá tay", json!({"contacts.view": "all"}))).await,
        403,
        "Không thể cấp quyền bạn không có",
    );
    expect_err(
        roles::create(&mut c, &m, &create_input("Quá tay 2", json!({"products.manage": null}))).await,
        403,
        "Không thể cấp quyền bạn không có",
    );
    // Không sửa/xoá/nhân bản vai trò "to" hơn mình (Kinh doanh xem khách mọi nơi).
    let g = serde_json::from_value(json!({"contacts.view": "own"})).unwrap();
    expect_err(
        roles::set_grants(&mut c, &env.ctx, &m, 4, &g).await,
        403,
        "Không thể sửa vai trò có quyền cao hơn bạn",
    );
    expect_err(
        roles::update(
            &mut c,
            &m,
            4,
            &validate_update_role(&json!({"name": "Hạ cấp"})).unwrap(),
        )
        .await,
        403,
        "Không thể sửa vai trò có quyền cao hơn bạn",
    );
    expect_err(
        roles::remove(&mut c, &env.ctx, &m, 4).await,
        403,
        "Không thể sửa vai trò có quyền cao hơn bạn",
    );
    expect_err(
        roles::clone(&mut c, &m, 4).await,
        403,
        "Không thể cấp quyền bạn không có",
    );
    // Vai trò hệ thống không ai sửa được; quyền mới ⊆ quyền mình nhưng vai trò cũ to hơn thì vẫn chặn.
    expect_err(
        roles::set_grants(&mut c, &env.ctx, &m, 1, &g).await,
        403,
        "Không thể sửa vai trò hệ thống",
    );
    // Khoá lạ, thiếu phạm vi, phạm vi thừa: 400 trước mọi kiểm quyền.
    for (g, text) in [
        (json!({"khong.co": true}), "Quyền không tồn tại: khong.co"),
        (
            json!({"contacts.view": null}),
            "cần chọn phạm vi (own, team, subtree, all)",
        ),
        (json!({"products.manage": "all"}), "không có phạm vi"),
    ] {
        let m_ = g.as_object().unwrap();
        expect_err(parse_grants_input(m_), 400, text);
    }
    assert_eq!(
        parse_grants_input(
            json!({"products.manage": false, "contacts.view": "team"})
                .as_object()
                .unwrap()
        )
        .unwrap()
        .len(),
        1
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn gan_vai_tro_cho_nguoi_dung() {
    let env = setup().await;
    let m = manager();
    let mut c = env.t.acquire().await.unwrap();
    // Cache quyền của nhân viên 3 được nạp trước, rồi phải đổi NGAY sau khi gán (vô hiệu sau commit).
    let before = env.ctx.permissions.grants_for(CO, 3).await.unwrap();
    assert!(!before.grants.contains_key("users.view"));
    // Quản lý gán vai trò "Quản lý" (quyền ⊆ quyền mình? users.manage all, roles.manage… có đủ): hợp lệ.
    let r = roles::set_user_roles(&mut c, &env.ctx, &m, 3, &[2]).await.unwrap();
    assert_eq!(
        jv(&r),
        json!({"user_id": 3, "roles": [{"id": 2, "name": "Quản lý", "is_system": false}]})
    );
    assert!(
        env.ctx
            .permissions
            .grants_for(CO, 3)
            .await
            .unwrap()
            .grants
            .contains_key("users.view")
    );
    // Nhật ký before/after; gửi lại đúng tập cũ không ghi gì thêm.
    let n = count(&env, "SELECT count(*) FROM rbac_audit_log WHERE action = 'user.roles'").await;
    assert_eq!(n, 1);
    roles::set_user_roles(&mut c, &env.ctx, &m, 3, &[2]).await.unwrap();
    assert_eq!(
        count(&env, "SELECT count(*) FROM rbac_audit_log WHERE action = 'user.roles'").await,
        1
    );
    let log: sqlx::types::Json<Value> =
        sqlx::query_scalar("SELECT after FROM rbac_audit_log WHERE action = 'user.roles'")
            .fetch_one(&mut *c)
            .await
            .unwrap();
    assert_eq!(log.0, json!({"roleIds": [2], "roles": ["Quản lý"]}));

    // Các chốt: vai trò hệ thống, quyền cao hơn, tự đổi, người to hơn, không tồn tại, ngoài phạm vi.
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 4, &[1]).await,
        403,
        "Chỉ Quản trị mới được gán vai trò Quản trị",
    );
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 4, &[4]).await,
        403,
        "Không thể cấp quyền bạn không có",
    );
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 2, &[3]).await,
        403,
        "Không thể tự đổi vai trò của mình",
    );
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 1, &[3]).await,
        403,
        "Không thể thao tác người có quyền cao hơn bạn",
    );
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 4, &[9999]).await,
        404,
        "Không tìm thấy vai trò",
    );
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 9999, &[3]).await,
        404,
        "Không tìm thấy người dùng",
    );
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 6, &[3]).await,
        404,
        "Không tìm thấy người dùng",
    );
    let o = only_self();
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &o, 4, &[3]).await,
        404,
        "Không tìm thấy",
    );
    // Quản trị gán được vai trò hệ thống và gỡ hết vai trò của người thường.
    let a = admin(1);
    let r = roles::set_user_roles(&mut c, &env.ctx, &a, 4, &[1]).await.unwrap();
    assert!(r.roles[0].is_system);
    assert!(env.ctx.permissions.grants_for(CO, 4).await.unwrap().is_admin);
    let r = roles::set_user_roles(&mut c, &env.ctx, &a, 4, &[]).await.unwrap();
    assert!(r.roles.is_empty());
    // Người thường không gỡ được vai trò Quản trị của người khác dù chỉ gửi danh sách không chứa nó (đã chặn ở bước thao tác người to hơn).
    roles::set_user_roles(&mut c, &env.ctx, &a, 4, &[1]).await.unwrap();
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &m, 4, &[3]).await,
        403,
        "Không thể thao tác người có quyền cao hơn bạn",
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn khong_de_het_quan_tri_ke_ca_khi_hai_quan_tri_go_nhau_dong_thoi() {
    let env = setup().await;
    // Còn hai Quản trị (1 và 5): hai bên cùng gỡ vai trò của nhau; khoá advisory tuần tự hoá nên đúng một bên thành công.
    let (a1, a5) = (admin(1), admin(5));
    let (t1, t2) = (env.t.clone(), env.t.clone());
    let (c1, c2) = (env.ctx.clone(), env.ctx.clone());
    let h1 = tokio::spawn(async move {
        let mut c = t1.acquire().await.unwrap();
        roles::set_user_roles(&mut c, &c1, &a1, 5, &[]).await.map(drop)
    });
    let h5 = tokio::spawn(async move {
        let mut c = t2.acquire().await.unwrap();
        roles::set_user_roles(&mut c, &c2, &a5, 1, &[]).await.map(drop)
    });
    let (r1, r5) = (h1.await.unwrap(), h5.await.unwrap());
    let oks = [r1.is_ok(), r5.is_ok()].iter().filter(|x| **x).count();
    assert_eq!(oks, 1, "đúng một bên thành công: {r1:?} / {r5:?}");
    let failed = if r1.is_err() { r1 } else { r5 };
    expect_err(failed, 409, "Phải còn ít nhất 1 Quản trị");
    assert_eq!(
        count(
            &env,
            "SELECT count(DISTINCT ur.user_id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.is_system"
        )
        .await,
        1
    );
    // Quản trị cuối cùng không tự gỡ mình được.
    let last: i32 = {
        let mut c = env.t.acquire().await.unwrap();
        sqlx::query_scalar("SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.is_system")
            .fetch_one(&mut *c)
            .await
            .unwrap()
    };
    let mut c = env.t.acquire().await.unwrap();
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &admin(last), last, &[]).await,
        409,
        "Phải còn ít nhất 1 Quản trị",
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn thanh_vien_chi_lo_email_trong_pham_vi_users_view() {
    let env = setup().await;
    let mut c = env.t.acquire().await.unwrap();
    let all = roles::members(&mut c, &env.ctx, &admin(1), 3).await.unwrap();
    assert_eq!(
        all.iter().map(|m| (m.id, m.email.is_some())).collect::<Vec<_>>(),
        [(3, true), (4, true)],
        "người đã xoá mềm không hiện"
    );
    // users.view chỉ "own": chỉ thấy email của chính mình trong danh sách.
    exec(&mut c, "INSERT INTO user_roles (user_id, role_id) VALUES (7, 3)").await;
    let own = roles::members(&mut c, &env.ctx, &only_self(), 3).await.unwrap();
    assert_eq!(
        own.iter().map(|m| (m.id, m.email.is_some())).collect::<Vec<_>>(),
        [(3, false), (4, false), (7, true)]
    );
    let v = jv(&own[0]);
    assert_eq!(
        v,
        json!({"id": 3, "full_name": "Người 3", "email": null, "status": "active"})
    );
    // Không có quyền users.view: không email nào.
    let none = Actor {
        user_id: 2,
        is_admin: false,
        grants: grants_from_json(&json!({"roles.manage": true})),
    };
    assert!(
        roles::members(&mut c, &env.ctx, &none, 3)
            .await
            .unwrap()
            .iter()
            .all(|m| m.email.is_none())
    );
    expect_err(
        roles::members(&mut c, &env.ctx, &admin(1), 9999).await,
        404,
        "Không tìm thấy vai trò",
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn nhat_ky_loc_phan_trang_va_gop_dong_gan_nguoi() {
    let env = setup().await;
    let a = admin(1);
    let mut c = env.t.acquire().await.unwrap();
    let r = roles::create(&mut c, &a, &create_input("Nhóm A", json!({"contacts.view": "own"})))
        .await
        .unwrap();
    let rid = r.summary.id;
    roles::set_user_roles(&mut c, &env.ctx, &a, 3, &[rid]).await.unwrap();
    roles::set_user_roles(&mut c, &env.ctx, &a, 3, &[]).await.unwrap();
    roles::set_user_roles(&mut c, &env.ctx, &a, 4, &[2]).await.unwrap(); // vai trò khác: không liên quan
    let all = audit::list(&mut c, &validate_audit_query(None, None, None, None).unwrap())
        .await
        .unwrap();
    assert_eq!((all.total, all.page, all.limit), (4, 1, 30));
    assert_eq!(all.data[0].action, "user.roles");
    assert_eq!(
        (all.data[0].actor_name.as_str(), all.data[0].target_name.as_deref()),
        ("Người 1", Some("Người 4"))
    );
    // Lọc theo người: chỉ dòng user.roles của người đó; vai trò: dòng của vai trò + dòng gán/gỡ người có chứa id.
    let user3 = audit::list(
        &mut c,
        &validate_audit_query(Some("user"), Some("3"), None, None).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(user3.total, 2);
    let role = audit::list(
        &mut c,
        &validate_audit_query(Some("role"), Some(&rid.to_string()), None, None).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(role.total, 3, "role.create + gán + gỡ");
    assert_eq!(
        role.data.iter().map(|d| d.action.as_str()).collect::<Vec<_>>(),
        ["user.roles", "user.roles", "role.create"]
    );
    assert!(role.data[2].target_name.is_none());
    // Phân trang.
    let p2 = audit::list(&mut c, &validate_audit_query(None, None, Some("2"), Some("3")).unwrap())
        .await
        .unwrap();
    assert_eq!((p2.data.len(), p2.total, p2.page, p2.limit), (1, 4, 2, 3));
    let v = jv(&all.data[3]);
    assert_eq!(v["after"]["name"], "Nhóm A");
    assert!(v["before"].is_null());
    assert!(v["id"].is_number());
}

#[tokio::test]
async fn kiem_dau_vao_nhu_class_validator() {
    let e = |r: Result<_, trinity_kernel::error::HttpError>| -> String {
        serde_json::to_string(&r.map(|_: Vec<i32>| ()).unwrap_err().body()).unwrap()
    };
    // Vai trò.
    let body = serde_json::to_string(
        &validate_create_role(&json!({"name": "a", "grants": 5}))
            .unwrap_err()
            .body(),
    )
    .unwrap();
    assert!(
        body.contains("Tên vai trò tối thiểu 2 ký tự") && body.contains("grants phải là object"),
        "{body}"
    );
    let body = serde_json::to_string(
        &validate_create_role(&json!({"name": "x".repeat(81), "grants": {}, "description": "d".repeat(501)}))
            .unwrap_err()
            .body(),
    )
    .unwrap();
    assert!(
        body.contains("Tên vai trò tối đa 80 ký tự")
            && body.contains("description must be shorter than or equal to 500 characters"),
        "{body}"
    );
    assert!(validate_create_role(&json!({"name": "ab", "grants": {}, "description": null})).is_ok());
    assert!(validate_update_role(&json!({})).is_ok());
    assert!(validate_update_role(&json!({"name": null})).is_err());
    // Gán vai trò: mảng nguyên, không trùng, ≤ 50.
    assert_eq!(validate_set_user_roles(&json!({"roleIds": [2, 5]})).unwrap(), [2, 5]);
    assert_eq!(
        validate_set_user_roles(&json!({"roleIds": []})).unwrap(),
        Vec::<i32>::new()
    );
    assert!(e(validate_set_user_roles(&json!({"roleIds": [1, 1]}))).contains("roleIds bị trùng"));
    assert!(e(validate_set_user_roles(&json!({"roleIds": ["a"]}))).contains("roleIds phải là số nguyên"));
    assert!(
        e(validate_set_user_roles(
            &json!({"roleIds": (0..51).collect::<Vec<i32>>()})
        ))
        .contains("Tối đa 50 vai trò")
    );
    assert!(e(validate_set_user_roles(&json!({"roleIds": 1}))).contains("roleIds phải là mảng"));
    // Query nhật ký.
    assert!(validate_audit_query(Some("x"), None, None, None).is_err());
    assert!(validate_audit_query(None, Some("a"), None, None).is_err());
    assert!(validate_audit_query(None, None, Some("0"), None).is_err());
    assert!(validate_audit_query(None, None, None, Some("101")).is_err());
    assert!(validate_audit_query(None, None, Some("3"), Some("100")).is_ok());
    // Number("0x10") = 16 như Node.
    let q = validate_audit_query(None, Some("0x10"), Some("0b11"), Some("0o12")).unwrap();
    assert_eq!((q.target_id, q.page, q.limit), (Some(16), Some(3), Some(10)));
    assert!(validate_audit_query(None, Some("0x"), None, None).is_err());
    // Tên toàn dấu cách không lọt MinLength.
    assert!(validate_create_role(&json!({"name": "   ", "grants": {}})).is_err());
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn go_vai_tro_quan_tri_cua_nguoi_da_khoa_khong_tinh_la_quan_tri_hoat_dong() {
    let env = setup().await;
    let mut c = env.t.acquire().await.unwrap();
    // Người 5 bị khoá: Quản trị hoạt động duy nhất còn lại là người 1, nhưng gỡ vai trò của 5 vẫn được phép.
    exec(&mut c, "UPDATE users SET status = 'locked' WHERE id = 5").await;
    let r = roles::set_user_roles(&mut c, &env.ctx, &admin(1), 5, &[])
        .await
        .unwrap();
    assert!(r.roles.is_empty());
    // Còn đúng một Quản trị hoạt động (1): vẫn không tự gỡ mình được.
    expect_err(
        roles::set_user_roles(&mut c, &env.ctx, &admin(1), 1, &[]).await,
        409,
        "Phải còn ít nhất 1 Quản trị",
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn xoa_vai_tro_kiem_lai_nguoi_giu_trong_giao_dich_va_dat_ten_khong_trung_dong_thoi() {
    let env = setup().await;
    let a = admin(1);
    let mut c = env.t.acquire().await.unwrap();
    // Vai trò 4 vừa có người giữ: xoá phải 409 và không mất dòng nào.
    exec(&mut c, "INSERT INTO user_roles (user_id, role_id) VALUES (3, 4)").await;
    expect_err(roles::remove(&mut c, &env.ctx, &a, 4).await, 409, "đang có 1 người giữ");
    assert_eq!(count(&env, "SELECT count(*) FROM roles WHERE id = 4").await, 1);
    drop(c);
    // Hai request cùng tên khác hoa/thường: đúng một bên thành công.
    let (t1, t2) = (env.t.clone(), env.t.clone());
    let h1 = tokio::spawn(async move {
        let mut c = t1.acquire().await.unwrap();
        roles::create(&mut c, &admin(1), &create_input("Song song", json!({})))
            .await
            .map(drop)
    });
    let h2 = tokio::spawn(async move {
        let mut c = t2.acquire().await.unwrap();
        roles::create(&mut c, &admin(1), &create_input("SONG SONG", json!({})))
            .await
            .map(drop)
    });
    let (r1, r2) = (h1.await.unwrap(), h2.await.unwrap());
    assert_eq!(
        [r1.is_ok(), r2.is_ok()].iter().filter(|x| **x).count(),
        1,
        "{r1:?} / {r2:?}"
    );
    assert_eq!(
        count(&env, "SELECT count(*) FROM roles WHERE lower(name) = 'song song'").await,
        1
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn index_duy_nhat_lower_name_chan_ten_khac_hoa_thuong_o_tang_db() {
    let env = setup().await;
    let mut c = env.t.acquire().await.unwrap();
    // Migration 0027: ghi thẳng (không qua assert_name_free) vẫn bị chặn, và service đổi 23505 thành 409.
    let r = sqlx::query("INSERT INTO roles (name, is_system, updated_at) VALUES ('QUẢN LÝ', false, now())")
        .execute(&mut *c)
        .await;
    let e = r.expect_err("index lower(name) phải chặn");
    assert_eq!(e.as_database_error().and_then(|d| d.code()).as_deref(), Some("23505"));
    assert_eq!(
        count(
            &env,
            "SELECT count(*) FROM pg_indexes WHERE indexname = 'roles_name_lower_key'"
        )
        .await,
        1
    );
}

#[tokio::test]
#[ignore = "cần TEST_DATABASE_URL"]
async fn vai_tro_thanh_vien_co_dinh_khong_sua_khong_xoa() {
    let env = setup().await;
    let mut c = env.t.acquire().await.unwrap();
    let id = trinity_rbac::fixed_roles::ensure_member_role(&mut c).await.unwrap();
    // Tạo lười chạy lại cho cùng một dòng; tên tuỳ biến trùng đã bị đổi, không xoá.
    assert_eq!(trinity_rbac::fixed_roles::ensure_member_role(&mut c).await.unwrap(), id);
    assert_eq!(
        count(&env, "SELECT count(*) FROM role_permissions WHERE role_id > 100").await,
        trinity_rbac::fixed_roles::MEMBER_GRANTS.len() as i64
    );
    // Quản trị cũng không sửa tên, đổi quyền hay xoá được vai trò cố định.
    let upd = validate_update_role(&json!({"name": "Khác"})).unwrap();
    expect_err(roles::update(&mut c, &admin(1), id, &upd).await, 403, "cố định");
    let grants = json!({"users.manage": "all"});
    expect_err(
        roles::set_grants(&mut c, &env.ctx, &admin(1), id, grants.as_object().unwrap()).await,
        403,
        "cố định",
    );
    expect_err(roles::remove(&mut c, &env.ctx, &admin(1), id).await, 403, "cố định");
    assert_eq!(
        count(
            &env,
            "SELECT count(*) FROM role_permissions WHERE role_id > 100 AND permission = 'users.manage'"
        )
        .await,
        0
    );
}
