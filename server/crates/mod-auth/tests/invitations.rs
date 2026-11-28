//! M02: đăng ký công ty và lời mời nhân viên trên Postgres THẬT, chế độ nhiều công ty. Chuyển từ
//! `services/auth/src/auth/invitations.pg.spec.ts`. Cần một DB riêng đã migrate bằng Prisma (`public`); test XOÁ mọi schema `c_*`,
//! schema `platform` và bảng `users` của `public`:
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_m02 cargo test -p mod-auth --test invitations -- --ignored --test-threads=1`

use std::sync::Arc;

use mod_auth::{
    Actor, AuthConfig, AuthService, GrantsSource, INVITATION_GONE_MESSAGE, InviteProof, LoginOptions, UserGrants,
    assert_user_slot_available, invitation_scope, revoke_pending_invitations_by, revoke_pending_invitations_for_email,
};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_auth::{Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::provision::{ProvisionInput, provision_company};
use trinity_db::{CompanyRef, Db, DbConfig, LATEST_MIGRATION};
use trinity_kernel::error::Message;
use trinity_mail::MemoryMailer;
use trinity_rbac::{OwnerIds, PermissionService, RbacCache, ScopeService, grants::grants_to_json};
use trinity_storage::LocalUploadsStore;

const SECRET: &str = "m02-test-secret";

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

/// Quyền thật theo vai trò trong DB (thay cho `PermissionService` của bản TS).
#[derive(Clone)]
struct RealGrants(PermissionService);

impl GrantsSource for RealGrants {
    async fn grants_for(&self, company: CompanyRef, user: i32) -> Result<UserGrants, String> {
        let g = self.0.grants_for(company, user).await.map_err(|e| e.to_string())?;
        let Value::Object(map) = grants_to_json(&g.grants) else {
            unreachable!()
        };
        Ok(UserGrants {
            grants: map,
            is_admin: g.is_admin,
        })
    }
}

struct Env {
    db: Db,
    svc: AuthService<RealGrants>,
    perms: PermissionService,
    scope: ScopeService,
    a: CompanyRef,
    b: CompanyRef,
    owner_a: i32,
    staff_role_a: i32,
    email_a: String,
    email_b: String,
    ip: std::sync::atomic::AtomicU32,
    /// Hộp thư giả của đăng nhập không mật khẩu (#675).
    mail: MemoryMailer,
}

async fn tsql(db: &Db, c: CompanyRef, sql: &str) {
    let mut conn = db.tenant(c).await.unwrap().acquire().await.unwrap();
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *conn)
        .await
        .expect(sql);
}

async fn tscalar<T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin>(
    db: &Db,
    c: CompanyRef,
    sql: &str,
) -> T {
    let mut conn = db.tenant(c).await.unwrap().acquire().await.unwrap();
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *conn)
        .await
        .expect(sql)
}

async fn setup_env(signup: bool) -> Env {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    let schemas: Vec<String> = sqlx::query_scalar("SELECT nspname FROM pg_namespace WHERE nspname ~ '^c_[0-9]+$'")
        .fetch_all(&mut c)
        .await
        .unwrap();
    for s in schemas {
        sqlx::raw_sql(AssertSqlSafe(format!("DROP SCHEMA \"{s}\" CASCADE")))
            .execute(&mut c)
            .await
            .unwrap();
    }
    for (trg, table) in [
        ("trinity_platform_sync_login", "users"),
        ("trinity_platform_sync_facebook_page", "facebook_pages"),
        ("trinity_platform_sync_zalo_oa", "zalo_oa_connections"),
    ] {
        sqlx::raw_sql(AssertSqlSafe(format!("DROP TRIGGER IF EXISTS {trg} ON public.{table}")))
            .execute(&mut c)
            .await
            .unwrap();
    }
    sqlx::raw_sql("DROP SCHEMA IF EXISTS platform CASCADE")
        .execute(&mut c)
        .await
        .unwrap();
    sqlx::raw_sql("TRUNCATE TABLE public.users RESTART IDENTITY CASCADE")
        .execute(&mut c)
        .await
        .unwrap();

    let mut dbc = DbConfig::new(url());
    dbc.pool_size = 6;
    dbc.multi_tenant = true;
    let db = Db::connect(&dbc).await.unwrap();
    let platform = Platform::new(&db, None);
    platform.ensure().await.unwrap();
    let migrations = trinity_db::migrate::embedded_migrations();
    let stamp = std::process::id();
    let (email_a, email_b) = (
        format!("chu-a-{stamp}@example.com"),
        format!("chu-b-{stamp}@example.com"),
    );
    let prov = |name: &str, email: &str, pw: &str, who: &str| ProvisionInput {
        company_name: name.to_owned(),
        admin_email: email.to_owned(),
        admin_password: pw.to_owned(),
        admin_name: who.to_owned(),
    };
    let ra = provision_company(
        &db,
        &platform,
        &migrations,
        LATEST_MIGRATION,
        &prov("Công ty A", &email_a, "password-a-123", "Chủ A"),
    )
    .await
    .unwrap();
    let rb = provision_company(
        &db,
        &platform,
        &migrations,
        LATEST_MIGRATION,
        &prov("Công ty B", &email_b, "password-b-123", "Chủ B"),
    )
    .await
    .unwrap();
    let (a, b) = (ra.company, rb.company);
    tsql(
        &db,
        a,
        "INSERT INTO roles (name, is_system) VALUES ('Nhân viên', false)",
    )
    .await;
    let staff_role_a: i32 = tscalar(&db, a, "SELECT id FROM roles WHERE name = 'Nhân viên'").await;
    tsql(
        &db,
        a,
        &format!(
            "INSERT INTO role_permissions (role_id, permission, scope) VALUES ({staff_role_a}, 'contacts.view', 'own')"
        ),
    )
    .await;

    let security = Security::new(db.clone(), platform.clone(), false);
    let cache = RbacCache::new(security.clone());
    let perms = PermissionService::new(db.clone(), cache.clone());
    let scope = ScopeService::new(db.clone(), cache);
    let _ = Authenticator::new(security.clone(), SECRET, &[]);
    let mut cfg = AuthConfig::from_lookup(|k| match k {
        "JWT_SECRET" => Some(SECRET.to_owned()),
        "SIGNUP_ENABLED" if !signup => Some("false".to_owned()),
        _ => None,
    })
    .unwrap();
    cfg.login_wifi_env = false;
    let dir = std::env::temp_dir().join(format!("m02-uploads-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mail = MemoryMailer::default();
    let svc = AuthService::new(
        db.clone(),
        platform,
        security,
        RealGrants(perms.clone()),
        LocalUploadsStore::new(&dir),
        cfg,
    )
    .with_login_options(LoginOptions {
        mailer: Some(Arc::new(mail.clone())),
        public_url: Some("https://crm.example.test".to_owned()),
        ..LoginOptions::default()
    });
    Env {
        db,
        svc,
        perms,
        scope,
        a,
        b,
        owner_a: ra.admin_user_id,
        staff_role_a,
        email_a,
        email_b,
        ip: std::sync::atomic::AtomicU32::new(1),
        mail,
    }
}

impl Env {
    /// Mỗi lần một IP khác để bộ giới hạn tốc độ không chặn các ca không liên quan.
    fn ip(&self) -> String {
        let n = self.ip.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        format!("10.1.{}.{}", n / 250, n % 250 + 1)
    }

    async fn actor(&self, company: CompanyRef, user: i32) -> Actor {
        let g = self.perms.grants_for(company, user).await.unwrap();
        Actor {
            user_id: user,
            company,
            is_admin: g.is_admin,
            grants: g.grants.clone(),
        }
    }

    async fn invite(&self, actor: &Actor, email: &str, role: i32) -> Result<Value, mod_auth::AuthFail> {
        let owners = invitation_scope(&self.scope, actor).await.unwrap();
        self.svc.create_invitation(actor, email, role, &owners).await
    }

    async fn accept(&self, token: &str, name: &str, pw: &str) -> Result<Value, mod_auth::AuthFail> {
        let ip = self.ip();
        self.svc.accept_invitation(token, name, pw, Some(&ip), true).await
    }
}

/// Chờ thư gửi ở tác vụ nền rồi lấy mã 6 số trong tiêu đề.
async fn wait_code(mail: &MemoryMailer) -> (String, trinity_mail::OutgoingMail) {
    for _ in 0..100 {
        let mut got = mail.take();
        if let Some(m) = got.pop() {
            let code = m.subject.rsplit(' ').next().unwrap().to_owned();
            assert_eq!(code.len(), 6, "{}", m.subject);
            return (code, m);
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("không có thư");
}

fn other_code(code: &str) -> String {
    let n: u32 = code.parse().unwrap();
    format!("{:06}", (n + 1) % 1_000_000)
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn nhan_loi_moi_bang_ma_email_khong_can_mat_khau() {
    let e = setup_env(true).await;
    let owner = e.actor(e.a, e.owner_a).await;
    let email = format!("ma-{}@example.com", std::process::id());
    let inv = e.invite(&owner, &email, e.staff_role_a).await.unwrap();
    let token = inv["token"].as_str().unwrap().to_owned();
    let sent = e
        .svc
        .invitation_send_code(&token, Some("10.9.0.1"), true, Some("UA"))
        .await
        .unwrap();
    assert_eq!(sent["email"], "m***@example.com");
    let (code, m) = wait_code(&e.mail).await;
    assert_eq!(m.to, email);
    assert!(m.subject.starts_with("Mã xác nhận Trinity: "));
    assert!(m.text.contains("Công ty A"));
    // Mã nằm trong schema công ty A, chỉ ở dạng băm.
    let stored: String = tscalar(
        &e.db,
        e.a,
        "SELECT code_hash FROM login_challenges ORDER BY id DESC LIMIT 1",
    )
    .await;
    assert_eq!(stored.len(), 64);
    assert!(!stored.contains(&code));
    // Sai mã: báo còn lượt, chưa tạo tài khoản.
    let wrong = e
        .svc
        .accept_invitation_with(
            &token,
            "Nhân Viên Mã",
            InviteProof::Code(&other_code(&code)),
            Some("10.9.0.2"),
            true,
        )
        .await
        .unwrap_err();
    assert_eq!(err_msg(&wrong), (400, mod_auth::login::INVALID_CODE.to_owned()));
    // Đúng mã: tạo tài khoản KHÔNG mật khẩu, đăng nhập luôn.
    let out = e
        .svc
        .accept_invitation_with(&token, "Nhân Viên Mã", InviteProof::Code(&code), Some("10.9.0.3"), true)
        .await
        .unwrap();
    assert!(out["access_token"].is_string());
    assert_eq!(out["company"]["id"], e.a.id());
    let hash: String = tscalar(
        &e.db,
        e.a,
        &format!("SELECT password_hash FROM users WHERE email = '{email}'"),
    )
    .await;
    assert_eq!(hash, "", "tài khoản mới không bắt buộc mật khẩu");
    let method: String = tscalar(
        &e.db,
        e.a,
        &format!("SELECT metadata->>'method' FROM audit_logs WHERE action = 'login' AND metadata->>'email' = '{email}' ORDER BY id DESC LIMIT 1"),
    )
    .await;
    assert_eq!(method, "email_code");
    // Lời mời và mã đều dùng một lần.
    let again = e
        .svc
        .accept_invitation_with(&token, "Khác", InviteProof::Code(&code), Some("10.9.0.4"), true)
        .await
        .unwrap_err();
    assert_eq!(again.error().status(), 410);
    // Đăng nhập lại bằng email trong công ty A (email quyết định công ty).
    e.svc
        .email_start(&email.to_uppercase(), Some("10.9.0.5"), true, None)
        .await
        .unwrap();
    let (code2, m2) = wait_code(&e.mail).await;
    assert!(
        m2.text.contains("https://crm.example.test/auth/email#token=c"),
        "link có tiền tố công ty: {}",
        m2.text
    );
    let me = e
        .svc
        .email_verify(&email, &code2, Some("10.9.0.6"), true)
        .await
        .unwrap();
    assert_eq!(me["company"]["id"], e.a.id());
    assert_eq!(me["user"]["email"], email.as_str());
    // Link của thư đó đã chết vì mã đã dùng (cùng một lượt).
    let link_token = m2
        .text
        .split("#token=")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        e.svc
            .email_link(&link_token, Some("10.9.0.7"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        400
    );
}

fn err_msg(e: &mod_auth::AuthFail) -> (u16, String) {
    let b = e.error().body();
    let msg = match b.message {
        Message::One(s) => s,
        Message::Many(v) => v.join("; "),
    };
    (e.error().status(), msg)
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn moi_xem_nhan_vao_dung_cong_ty_va_dang_nhap_luon() {
    let e = setup_env(true).await;
    let owner = e.actor(e.a, e.owner_a).await;
    let email = format!("nv-{}@example.com", std::process::id());
    let inv = e
        .invite(&owner, &format!("  {}  ", email.to_uppercase()), e.staff_role_a)
        .await
        .unwrap();
    let token = inv["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with(&format!("c{}.", e.a.id())), "công ty ≥ 2 có tiền tố");
    assert_eq!(inv["status"], "pending");
    assert_eq!(inv["email"], email.as_str(), "email chuẩn hoá chữ thường");
    assert_eq!(inv["path"], format!("/invite/{token}"));
    // DB chỉ giữ băm.
    let stored: String = tscalar(
        &e.db,
        e.a,
        "SELECT token_hash FROM user_invitations ORDER BY id DESC LIMIT 1",
    )
    .await;
    assert_eq!(stored, mod_auth::hash_invite_token(&token));
    assert!(!stored.contains(&token));

    let p = e.svc.preview_invitation(&token).await.unwrap();
    assert_eq!(
        (p["company_name"].as_str(), p["email"].as_str(), p["role_name"].as_str()),
        (Some("Công ty A"), Some(email.as_str()), Some("Nhân viên"))
    );

    let out = e.accept(&token, "  Nhân Viên Một ", "mat-khau-moi-1").await.unwrap();
    assert!(out["access_token"].is_string() && out["refresh_token"].is_string());
    assert_eq!(out["company"]["id"], e.a.id());
    assert_eq!(out["user"]["email"], email.as_str());
    assert_eq!(out["roles"][0]["name"], "Nhân viên");
    // User nằm đúng công ty A, có nhân viên; công ty B không thấy.
    let in_a: i64 = tscalar(
        &e.db,
        e.a,
        &format!("SELECT count(*) FROM users WHERE email = '{email}'"),
    )
    .await;
    let in_b: i64 = tscalar(
        &e.db,
        e.b,
        &format!("SELECT count(*) FROM users WHERE email = '{email}'"),
    )
    .await;
    assert_eq!((in_a, in_b), (1, 0));
    assert_eq!(
        tscalar::<i64>(
            &e.db,
            e.a,
            &format!("SELECT count(*) FROM employees WHERE user_id = (SELECT id FROM users WHERE email = '{email}')")
        )
        .await,
        1
    );
    // Link dùng một lần.
    let again = e.accept(&token, "Khác", "mat-khau-moi-2").await.unwrap_err();
    assert_eq!(err_msg(&again), (410, INVITATION_GONE_MESSAGE.to_owned()));
    assert_eq!(
        e.svc.preview_invitation(&token).await.unwrap_err().error().status(),
        410
    );
    // Danh sách: mặc định chỉ còn hiệu lực; all=1 thấy đã nhận.
    let pending = e.svc.list_invitations(e.a, true, None, &OwnerIds::All).await.unwrap();
    assert_eq!(pending["data"].as_array().unwrap().len(), 0);
    let all = e.svc.list_invitations(e.a, false, None, &OwnerIds::All).await.unwrap();
    assert_eq!(all["data"][0]["status"], "accepted");
    // Công ty khác không thấy lời mời của A.
    let other = e.svc.list_invitations(e.b, false, None, &OwnerIds::All).await.unwrap();
    assert_eq!(other["data"].as_array().unwrap().len(), 0);
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn doi_tien_to_va_email_cong_ty_khac() {
    let e = setup_env(true).await;
    let owner = e.actor(e.a, e.owner_a).await;
    let inv = e.invite(&owner, "x1@example.com", e.staff_role_a).await.unwrap();
    let token = inv["token"].as_str().unwrap();
    // Đổi tiền tố sang công ty B: không mở được; không có tiền tố (công ty 1): cũng không.
    let forged = token.replacen(&format!("c{}.", e.a.id()), &format!("c{}.", e.b.id()), 1);
    assert_eq!(
        e.svc.preview_invitation(&forged).await.unwrap_err().error().status(),
        410
    );
    assert_eq!(
        e.svc
            .preview_invitation("khong-co-tien-to")
            .await
            .unwrap_err()
            .error()
            .status(),
        410
    );
    assert_eq!(
        e.svc.preview_invitation("c999.abc").await.unwrap_err().error().status(),
        410
    );
    // Email đã thuộc công ty khác / đã có trong công ty.
    let r = e.invite(&owner, &e.email_b.clone(), e.staff_role_a).await.unwrap_err();
    assert_eq!(
        err_msg(&r),
        (
            409,
            "Email này đã được dùng cho một công ty khác trên Trinity".to_owned()
        )
    );
    let r = e.invite(&owner, &e.email_a.clone(), e.staff_role_a).await.unwrap_err();
    assert_eq!(
        err_msg(&r),
        (409, "Email này đã có tài khoản trong công ty của bạn".to_owned())
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn moi_lai_thay_link_cu_huy_va_het_han_lam_link_chet() {
    let e = setup_env(true).await;
    let owner = e.actor(e.a, e.owner_a).await;
    let first = e.invite(&owner, "lai@example.com", e.staff_role_a).await.unwrap();
    let second = e.invite(&owner, "lai@example.com", e.staff_role_a).await.unwrap();
    assert_eq!(
        e.svc
            .preview_invitation(first["token"].as_str().unwrap())
            .await
            .unwrap_err()
            .error()
            .status(),
        410,
        "link cũ chết"
    );
    assert!(
        e.svc
            .preview_invitation(second["token"].as_str().unwrap())
            .await
            .is_ok()
    );
    // Chỉ một lời mời mở cho mỗi email.
    assert_eq!(tscalar::<i64>(&e.db, e.a, "SELECT count(*) FROM user_invitations WHERE email = 'lai@example.com' AND revoked_at IS NULL AND accepted_at IS NULL").await, 1);
    // Huỷ.
    let id = second["id"].as_i64().unwrap() as i32;
    assert_eq!(
        e.svc.revoke_invitation(e.a, id, &OwnerIds::All).await.unwrap(),
        json!({"message": "Đã huỷ lời mời"})
    );
    assert_eq!(
        e.svc
            .preview_invitation(second["token"].as_str().unwrap())
            .await
            .unwrap_err()
            .error()
            .status(),
        410
    );
    let r = e.svc.revoke_invitation(e.a, id, &OwnerIds::All).await.unwrap_err();
    assert_eq!(err_msg(&r), (409, "Lời mời này không còn hiệu lực để huỷ".to_owned()));
    let r = e.svc.revoke_invitation(e.a, 99999, &OwnerIds::All).await.unwrap_err();
    assert_eq!(err_msg(&r), (404, "Không tìm thấy lời mời".to_owned()));
    // Hết hạn.
    let third = e.invite(&owner, "lai2@example.com", e.staff_role_a).await.unwrap();
    tsql(
        &e.db,
        e.a,
        "UPDATE user_invitations SET expires_at = now() - interval '1 minute' WHERE email = 'lai2@example.com'",
    )
    .await;
    assert_eq!(
        e.svc
            .preview_invitation(third["token"].as_str().unwrap())
            .await
            .unwrap_err()
            .error()
            .status(),
        410
    );
    let all = e.svc.list_invitations(e.a, false, None, &OwnerIds::All).await.unwrap();
    let st: Vec<&str> = all["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap())
        .collect();
    assert!(st.contains(&"expired") && st.contains(&"revoked"), "{st:?}");
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn khong_leo_quyen_khi_moi() {
    let e = setup_env(true).await;
    // Người mời không phải Quản trị: có users.manage (all) + contacts.view (own).
    tsql(
        &e.db,
        e.a,
        "INSERT INTO roles (name, is_system) VALUES ('Quản lý nhân sự', false)",
    )
    .await;
    let hr_role: i32 = tscalar(&e.db, e.a, "SELECT id FROM roles WHERE name = 'Quản lý nhân sự'").await;
    tsql(&e.db, e.a, &format!("INSERT INTO role_permissions (role_id, permission, scope) VALUES ({hr_role}, 'users.manage', NULL), ({hr_role}, 'contacts.view', 'own')")).await;
    tsql(
        &e.db,
        e.a,
        "INSERT INTO roles (name, is_system) VALUES ('To hơn', false)",
    )
    .await;
    let big: i32 = tscalar(&e.db, e.a, "SELECT id FROM roles WHERE name = 'To hơn'").await;
    tsql(
        &e.db,
        e.a,
        &format!("INSERT INTO role_permissions (role_id, permission, scope) VALUES ({big}, 'contacts.view', 'all')"),
    )
    .await;
    let admin_role: i32 = tscalar(&e.db, e.a, "SELECT id FROM roles WHERE is_system LIMIT 1").await;
    let inv = e
        .invite(&e.actor(e.a, e.owner_a).await, "hr@example.com", hr_role)
        .await
        .unwrap();
    let hr = e
        .accept(inv["token"].as_str().unwrap(), "HR", "mat-khau-hr-1")
        .await
        .unwrap();
    let hr_id = hr["user"]["id"].as_i64().unwrap() as i32;
    let hr_actor = e.actor(e.a, hr_id).await;
    assert!(!hr_actor.is_admin);
    let r = e.invite(&hr_actor, "a1@example.com", admin_role).await.unwrap_err();
    assert_eq!(
        err_msg(&r),
        (403, "Chỉ Quản trị mới được mời vào vai trò Quản trị".to_owned())
    );
    let r = e.invite(&hr_actor, "a2@example.com", big).await.unwrap_err();
    assert_eq!(err_msg(&r), (403, "Không thể cấp quyền bạn không có".to_owned()));
    assert!(e.invite(&hr_actor, "a3@example.com", e.staff_role_a).await.is_ok());
    let r = e.invite(&hr_actor, "a4@example.com", 99999).await.unwrap_err();
    assert_eq!(err_msg(&r), (404, "Không tìm thấy vai trò".to_owned()));
    // Danh sách vai trò mời được đã lọc đúng luật.
    let roles = mod_auth::invitable_roles(&e.db, &hr_actor).await.unwrap();
    let names: Vec<&str> = roles["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"Nhân viên") && !names.contains(&"Quản trị") && !names.contains(&"To hơn"),
        "{names:?}"
    );
    let admin_roles = mod_auth::invitable_roles(&e.db, &e.actor(e.a, e.owner_a).await)
        .await
        .unwrap();
    assert!(admin_roles["data"].as_array().unwrap().len() >= 4);
    // Nhận kiểm lại không leo quyền: người mời bị thu users.manage ⇒ 410.
    let inv = e.invite(&hr_actor, "late@example.com", e.staff_role_a).await.unwrap();
    tsql(
        &e.db,
        e.a,
        &format!("DELETE FROM role_permissions WHERE role_id = {hr_role} AND permission = 'users.manage'"),
    )
    .await;
    e.perms.cache().clear();
    let r = e
        .accept(inv["token"].as_str().unwrap(), "Muộn", "mat-khau-muon-1")
        .await
        .unwrap_err();
    assert_eq!(r.error().status(), 410);
    // Lùi cả giao dịch: lời mời không bị "ăn" khi nhận thất bại.
    assert_eq!(
        tscalar::<i64>(
            &e.db,
            e.a,
            "SELECT count(*) FROM user_invitations WHERE email = 'late@example.com' AND accepted_at IS NULL"
        )
        .await,
        1
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn han_muc_goi_giu_cho_theo_loi_moi_cho() {
    let e = setup_env(true).await;
    let owner = e.actor(e.a, e.owner_a).await;
    // Công ty đăng ký mới: gói mặc định có giới hạn 10 người (thiếu dòng gói vẫn không thành "không giới hạn").
    for i in 0..8 {
        tsql(&e.db, e.a, &format!("INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('seed{i}@x.test', 'x', 'S', 'active', now())")).await;
    }
    // 1 chủ + 8 = 9 active: còn đúng 1 chỗ.
    let first = e.invite(&owner, "cho1@example.com", e.staff_role_a).await.unwrap();
    let r = e.invite(&owner, "cho2@example.com", e.staff_role_a).await.unwrap_err();
    assert_eq!(
        err_msg(&r),
        (409, "Gói hiện tại tối đa 10 người, liên hệ để nâng gói.".to_owned()),
        "lời mời đang chờ giữ chỗ"
    );
    // Nhận khi đã đủ thì lùi lại: thêm một người active ngoài luồng làm đầy.
    tsql(&e.db, e.a, "INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('seed9@x.test', 'x', 'S', 'active', now())").await;
    let r = e
        .accept(first["token"].as_str().unwrap(), "Chờ", "mat-khau-cho-1")
        .await
        .unwrap_err();
    assert_eq!(
        err_msg(&r),
        (409, "Gói hiện tại tối đa 10 người, liên hệ để nâng gói.".to_owned())
    );
    assert_eq!(
        tscalar::<i64>(
            &e.db,
            e.a,
            "SELECT count(*) FROM user_invitations WHERE email = 'cho1@example.com' AND accepted_at IS NULL"
        )
        .await,
        1,
        "link còn dùng được sau khi lùi"
    );
    // Gói tuỳ biến: không giới hạn.
    tsql(&e.db, e.a, "INSERT INTO settings (key, value, updated_at) VALUES ('org_plan', 'custom', now()) ON CONFLICT (key) DO UPDATE SET value = 'custom'").await;
    for i in 0..3 {
        assert!(
            e.invite(&owner, &format!("tuychinh{i}@example.com"), e.staff_role_a)
                .await
                .is_ok()
        );
    }
    // Công ty 1... (bản cài đa công ty, công ty đầu): không dòng gói ⇒ custom; B có giới hạn.
    let mut conn = e.db.tenant(e.a).await.unwrap().begin().await.unwrap();
    assert!(assert_user_slot_available(&mut conn, e.a, true).await.is_ok());
    conn.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn hai_luot_dong_thoi_o_nguong_chi_mot_qua() {
    let e = Arc::new(setup_env(true).await);
    for i in 0..7 {
        tsql(&e.db, e.a, &format!("INSERT INTO users (email, password_hash, full_name, status, updated_at) VALUES ('d{i}@x.test', 'x', 'S', 'active', now())")).await;
    }
    // 1 chủ + 7 = 8 active, còn 2 chỗ. 4 lượt mời đồng thời khác email: đúng 2 qua, 2 bị 409 (không 500).
    let owner = Arc::new(e.actor(e.a, e.owner_a).await);
    let mut tasks = Vec::new();
    for i in 0..4 {
        let (e, owner) = (e.clone(), owner.clone());
        tasks.push(tokio::spawn(async move {
            e.invite(&owner, &format!("dt{i}@example.com"), e.staff_role_a).await
        }));
    }
    let mut ok = 0;
    let mut conflict = 0;
    for t in tasks {
        match t.await.unwrap() {
            Ok(_) => ok += 1,
            Err(f) if f.error().status() == 409 => conflict += 1,
            Err(f) => panic!("lỗi lạ: {:?}", f.error()),
        }
    }
    assert_eq!((ok, conflict), (2, 2));
    // Hai lượt mời CÙNG email đồng thời: không deadlock, không 500, đúng một lời mời mở.
    let (e1, e2) = (e.clone(), e.clone());
    let (o1, o2) = (owner.clone(), owner.clone());
    tsql(&e.db, e.a, "INSERT INTO settings (key, value, updated_at) VALUES ('org_plan', 'custom', now()) ON CONFLICT (key) DO UPDATE SET value = 'custom'").await;
    let (r1, r2) = tokio::join!(
        tokio::spawn(async move { e1.invite(&o1, "cung@example.com", e1.staff_role_a).await }),
        tokio::spawn(async move { e2.invite(&o2, "cung@example.com", e2.staff_role_a).await })
    );
    assert!(r1.unwrap().is_ok() && r2.unwrap().is_ok());
    assert_eq!(tscalar::<i64>(&e.db, e.a, "SELECT count(*) FROM user_invitations WHERE email = 'cung@example.com' AND revoked_at IS NULL AND accepted_at IS NULL").await, 1);
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn pham_vi_users_manage_va_nguoi_moi_duoi_nguoi_moi() {
    let e = setup_env(true).await;
    // Hai người mời phạm vi hẹp (`own`): mỗi người chỉ thấy/huỷ lời mời của mình.
    tsql(
        &e.db,
        e.a,
        "INSERT INTO roles (name, is_system) VALUES ('Trưởng nhóm', false)",
    )
    .await;
    let lead: i32 = tscalar(&e.db, e.a, "SELECT id FROM roles WHERE name = 'Trưởng nhóm'").await;
    tsql(&e.db, e.a, &format!("INSERT INTO role_permissions (role_id, permission, scope) VALUES ({lead}, 'users.manage', 'own'), ({lead}, 'contacts.view', 'own')")).await;
    let owner = e.actor(e.a, e.owner_a).await;
    let mut leads = Vec::new();
    for n in 0..2 {
        let inv = e.invite(&owner, &format!("lead{n}@example.com"), lead).await.unwrap();
        let out = e
            .accept(inv["token"].as_str().unwrap(), "Lead", "mat-khau-lead-1")
            .await
            .unwrap();
        leads.push(e.actor(e.a, out["user"]["id"].as_i64().unwrap() as i32).await);
    }
    let (l0, l1) = (&leads[0], &leads[1]);
    let inv0 = e.invite(l0, "moi0@example.com", e.staff_role_a).await.unwrap();
    let inv1 = e.invite(l1, "moi1@example.com", e.staff_role_a).await.unwrap();
    let own0 = invitation_scope(&e.scope, l0).await.unwrap();
    let seen = e.svc.list_invitations(e.a, true, None, &own0).await.unwrap();
    let emails: Vec<&str> = seen["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["email"].as_str().unwrap())
        .collect();
    assert_eq!(emails, vec!["moi0@example.com"]);
    // Huỷ lời mời của người khác: 404 như chưa từng có.
    let r = e
        .svc
        .revoke_invitation(e.a, inv1["id"].as_i64().unwrap() as i32, &own0)
        .await
        .unwrap_err();
    assert_eq!(r.error().status(), 404);
    // Mời lại cùng email của người khác: 409 (không huỷ lời mời mình không thấy).
    let r = e.invite(l0, "moi1@example.com", e.staff_role_a).await.unwrap_err();
    assert_eq!(r.error().status(), 409);
    assert_eq!(
        err_msg(&r).1,
        "Email này đã có lời mời do người khác tạo. Nhờ người đó huỷ lời mời trước khi mời lại."
    );
    // Người mới nằm dưới người mời (manager_id) để họ quản lý được.
    let out = e
        .accept(inv0["token"].as_str().unwrap(), "Dưới Lead", "mat-khau-moi-9")
        .await
        .unwrap();
    let uid = out["user"]["id"].as_i64().unwrap();
    assert_eq!(out["user"]["manager_id"].as_i64(), Some(i64::from(l0.user_id)));
    assert_eq!(
        tscalar::<i64>(
            &e.db,
            e.a,
            &format!("SELECT manager_id::bigint FROM users WHERE id = {uid}")
        )
        .await,
        i64::from(l0.user_id)
    );
    // Chủ (all) thì không gắn manager_id.
    let invo = e.invite(&owner, "dongchu@example.com", e.staff_role_a).await.unwrap();
    let out = e
        .accept(invo["token"].as_str().unwrap(), "Đồng", "mat-khau-moi-8")
        .await
        .unwrap();
    assert!(out["user"]["manager_id"].is_null());
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn thu_hoi_theo_email_nguoi_moi_va_vai_tro() {
    let e = setup_env(true).await;
    tsql(&e.db, e.a, "INSERT INTO settings (key, value, updated_at) VALUES ('org_plan', 'custom', now()) ON CONFLICT (key) DO UPDATE SET value = 'custom'").await;
    let owner = e.actor(e.a, e.owner_a).await;
    // Thêm người trực tiếp cho email đang có lời mời chờ: huỷ lời mời trước khi kiểm chỗ.
    let inv = e.invite(&owner, "truc-tiep@example.com", e.staff_role_a).await.unwrap();
    let mut tx = e.db.tenant(e.a).await.unwrap().begin().await.unwrap();
    revoke_pending_invitations_for_email(&mut tx, "Truc-Tiep@example.com", &OwnerIds::All)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        e.svc
            .preview_invitation(inv["token"].as_str().unwrap())
            .await
            .unwrap_err()
            .error()
            .status(),
        410
    );
    // Phạm vi hẹp + lời mời của người khác ⇒ 409.
    let inv2 = e
        .invite(&owner, "truc-tiep2@example.com", e.staff_role_a)
        .await
        .unwrap();
    let mut tx = e.db.tenant(e.a).await.unwrap().begin().await.unwrap();
    let r = revoke_pending_invitations_for_email(&mut tx, "truc-tiep2@example.com", &OwnerIds::Ids(vec![9999]))
        .await
        .unwrap_err();
    assert_eq!(r.error().status(), 409);
    tx.rollback().await.unwrap();
    assert!(e.svc.preview_invitation(inv2["token"].as_str().unwrap()).await.is_ok());
    // Người mời bị khoá/xoá: lời mời của họ chết cùng.
    let mut tx = e.db.tenant(e.a).await.unwrap().begin().await.unwrap();
    revoke_pending_invitations_by(&mut tx, e.owner_a).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        e.svc
            .preview_invitation(inv2["token"].as_str().unwrap())
            .await
            .unwrap_err()
            .error()
            .status(),
        410
    );
    // Vai trò bị xoá: lời mời vào vai trò đó chết; người mời mất quyền ⇒ trạng thái "unusable" và không giữ chỗ.
    let inv3 = e.invite(&owner, "vaitro@example.com", e.staff_role_a).await.unwrap();
    tsql(
        &e.db,
        e.a,
        &format!(
            "DELETE FROM role_permissions WHERE role_id = {}; DELETE FROM roles WHERE id = {}",
            e.staff_role_a, e.staff_role_a
        ),
    )
    .await;
    let all = e.svc.list_invitations(e.a, true, None, &OwnerIds::All).await.unwrap();
    let st = all["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["email"] == "vaitro@example.com")
        .unwrap()["status"]
        .clone();
    assert_eq!(st, "unusable");
    assert!(
        e.svc.preview_invitation(inv3["token"].as_str().unwrap()).await.is_ok(),
        "còn hiệu lực về mặt thời gian"
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn dang_ky_cong_ty_moi_bang_migrator_rust() {
    let e = setup_env(true).await;
    let ip = e.ip();
    let email = format!("moi-{}@example.com", std::process::id());
    let out = e
        .svc
        .register("Công ty Mới", &email, "mat-khau-dk-123", "Chủ Mới", Some(&ip), true)
        .await
        .unwrap();
    assert!(out["access_token"].is_string());
    let cid = out["company"]["id"].as_i64().unwrap();
    assert!(cid > i64::from(e.b.id()), "công ty mới có số kế tiếp");
    assert_eq!(out["company"]["name"], "Công ty Mới");
    assert_eq!(out["user"]["email"], email.as_str());
    assert_eq!(out["isAdmin"], true);
    // Schema riêng, CRM trống, đúng một người dùng; công ty đăng ký mới có gói mặc định có giới hạn.
    let c = CompanyRef::new(cid).unwrap();
    assert_eq!(tscalar::<i64>(&e.db, c, "SELECT count(*) FROM users").await, 1);
    assert_eq!(tscalar::<i64>(&e.db, c, "SELECT count(*) FROM contacts").await, 0);
    // Email trùng: 409; không mở đăng ký: 404.
    let ip2 = e.ip();
    let r = e
        .svc
        .register("Khác", &email, "mat-khau-dk-123", "X", Some(&ip2), true)
        .await
        .unwrap_err();
    assert_eq!(err_msg(&r), (409, "Email này đã được dùng — hãy đăng nhập".to_owned()));
    let closed = setup_env(false).await;
    let r = closed
        .svc
        .register("Z", "z@example.com", "mat-khau-dk-123", "Z", Some("10.9.9.9"), true)
        .await
        .unwrap_err();
    assert_eq!(err_msg(&r), (404, "Bản cài đặt này không mở đăng ký".to_owned()));
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL), nhiều công ty"]
async fn gioi_han_toc_do_nhan_loi_moi() {
    let e = setup_env(true).await;
    // 11 lần nhận token sai từ cùng một IP tin được ⇒ lần sau bị 429.
    for _ in 0..10 {
        let r = e
            .svc
            .accept_invitation("sai-token", "X", "mat-khau-x-123", Some("10.7.7.7"), true)
            .await
            .unwrap_err();
        assert_eq!(r.error().status(), 410);
    }
    let r = e
        .svc
        .accept_invitation("sai-token", "X", "mat-khau-x-123", Some("10.7.7.7"), true)
        .await
        .unwrap_err();
    assert_eq!(err_msg(&r), (429, "Quá nhiều lần thử, vui lòng thử lại sau".to_owned()));
}
