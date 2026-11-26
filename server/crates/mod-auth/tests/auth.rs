//! M01: luồng auth trên Postgres thật (`public` đã migrate bằng Prisma):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-auth --tests -- --ignored`
//! Test tự tạo người dùng id 9000+ và dọn lại.

use std::sync::Arc;

use mod_auth::{AuthConfig, AuthFail, AuthService, GrantsSource, Patch, StaticGrants, Upload, UserGrants};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{AuthError, Authenticator, Security, password};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_storage::LocalUploadsStore;

const SECRET: &str = "m01-test-secret";
const CO: CompanyRef = CompanyRef::DEFAULT;
const PASS: &str = "Matkhau-123";

// Token do Node (`jsonwebtoken` 9.0.2) ký bằng SECRET, hạn năm 2100: refresh `{sub,type,jti}`, access `{sub,email}`,
// refresh có `cid: 1`.
const NODE_REFRESH: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjkwMDEsInR5cGUiOiJyZWZyZXNoIiwianRpIjoibm9kZS1zZXNzaW9uLTEiLCJleHAiOjQxMDI0NDQ4MDAsImlhdCI6MTc5NTcwNDM4Nn0.nceG_TDbTyD1B0s_NmZJiUesx06xlO_MJKFjuTthqW0";
const NODE_ACCESS: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjkwMDEsImVtYWlsIjoibm9kZXVzZXJAZXhhbXBsZS5jb20iLCJleHAiOjQxMDI0NDQ4MDAsImlhdCI6MTc5NTcwNDM4Nn0.Ec-M4XptuM6ELxrZPa5-Fiscr19d3gqw6pKi36zEYso";
const NODE_REFRESH_CID: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjkwMDEsInR5cGUiOiJyZWZyZXNoIiwiY2lkIjoxLCJqdGkiOiJub2RlLXNlc3Npb24tMiIsImV4cCI6NDEwMjQ0NDgwMCwiaWF0IjoxNzk1NzA0Mzg2fQ.0Zgs4kdidtZ4qC8kkTXfdNdRCwRcLvVXjSUvYnex2pw";

const PNG_1X1: [u8; 67] = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
    137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68,
    174, 66, 96, 130,
];

/// Các test dùng chung người dùng 9001..9003 và bảng văn phòng/danh sách áp dụng: chạy lần lượt.
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

struct Env {
    svc: AuthService<StaticGrants>,
    auth: Authenticator,
    security: Arc<Security>,
    dir: std::path::PathBuf,
}

async fn setup_with<G: GrantsSource>(
    grants: G,
    f: impl FnOnce(&mut AuthConfig),
) -> (AuthService<G>, Authenticator, Arc<Security>, std::path::PathBuf) {
    let mut dbc = DbConfig::new(url());
    dbc.pool_size = 4;
    let db = Db::connect(&dbc).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let dir = std::env::temp_dir().join(format!("m01-uploads-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = AuthConfig::from_lookup(|k| (k == "JWT_SECRET").then(|| SECRET.to_owned())).unwrap();
    f(&mut cfg);
    let svc = AuthService::new(
        db,
        platform,
        security.clone(),
        grants,
        LocalUploadsStore::new(&dir),
        cfg,
    );
    let auth = Authenticator::new(security.clone(), SECRET, &[]);
    (svc, auth, security, dir)
}

async fn setup() -> Env {
    reset().await;
    let (svc, auth, security, dir) = setup_with(StaticGrants(admin_grants()), |_| {}).await;
    Env {
        svc,
        auth,
        security,
        dir,
    }
}

fn admin_grants() -> UserGrants {
    let mut g = serde_json::Map::new();
    g.insert("contacts.view".to_owned(), json!("all"));
    UserGrants {
        grants: g,
        is_admin: false,
    }
}

async fn reset() {
    exec(
        "DELETE FROM audit_logs WHERE user_id BETWEEN 9000 AND 9100 OR resource_id BETWEEN 9000 AND 9100
           OR metadata->>'email' LIKE '%@example.com';
         DELETE FROM revoked_sessions WHERE user_id BETWEEN 9000 AND 9100;
         DELETE FROM token_blacklist WHERE user_id BETWEEN 9000 AND 9100;
         DELETE FROM active_sessions WHERE user_id BETWEEN 9000 AND 9100;
         DELETE FROM user_roles WHERE user_id BETWEEN 9000 AND 9100;
         DELETE FROM login_wifi_check_targets WHERE target_user_id BETWEEN 9000 AND 9100;
         DELETE FROM attendance_offices WHERE name IN ('Văn phòng', 'Demo');
         DELETE FROM settings WHERE key IN ('login_wifi_check_enabled', 'single_session_enabled');
         DELETE FROM users WHERE id BETWEEN 9000 AND 9100;",
    )
    .await;
    let hash = password::hash(PASS.to_owned()).await.unwrap();
    exec(&format!(
        "INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES
           (9001, 'NodeUser@Example.com', '{hash}', 'Người Một', 'active', now()),
           (9002, 'khoa@example.com', '{hash}', 'Người Khoá', 'locked', now()),
           (9003, 'lead@example.com', '{hash}', 'Trưởng', 'active', now());
         UPDATE users SET id = id WHERE false;
         INSERT INTO roles (id, name, is_system, updated_at) VALUES (9001, 'Vai thử', false, now())
           ON CONFLICT (id) DO NOTHING;
         INSERT INTO user_roles (user_id, role_id) VALUES (9001, 9001);"
    ))
    .await;
}

fn code(e: &AuthFail) -> u16 {
    e.error().status()
}

fn msg(e: &AuthFail) -> String {
    match e.error().body().message {
        trinity_kernel::error::Message::One(s) => s,
        many => serde_json::to_string(&many).unwrap(),
    }
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_owned()
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn dang_nhap_lam_moi_dang_xuat() {
    let _g = SERIAL.lock().await;
    let e = setup().await;
    let r = e
        .svc
        .login("nodeuser@example.com", PASS, Some("203.0.113.1"), true)
        .await
        .unwrap();
    // Hình dạng phản hồi như bản TS.
    assert_eq!(
        r["user"],
        json!({ "id": 9001, "email": "NodeUser@Example.com", "full_name": "Người Một", "avatar_url": null, "manager_id": null })
    );
    assert_eq!(
        r["roles"],
        json!([{ "id": 9001, "name": "Vai thử", "is_system": false }])
    );
    assert_eq!(r["permissions"], json!({ "contacts.view": "all" }));
    assert_eq!(r["isAdmin"], json!(false));
    assert_eq!(
        r["company"],
        json!({ "id": 1, "name": "Công ty mặc định", "multi_tenant": false })
    );
    let access = s(&r, "access_token");
    let refresh = s(&r, "refresh_token");
    let a = jwt::verify(&access, SECRET).unwrap();
    assert_eq!(
        (a.sub, a.email.as_str(), a.sid, a.cid, a.kind),
        (9001, "NodeUser@Example.com", None, None, None)
    );
    assert_eq!(a.exp.unwrap() - a.iat.unwrap(), 900.0);
    let rc = jwt::verify(&refresh, SECRET).unwrap();
    assert!(rc.is_refresh() && rc.email.is_empty() && rc.jti.is_some());
    assert_eq!(rc.exp.unwrap() - rc.iat.unwrap(), 7.0 * 86400.0);
    // Chữ ký và payload khớp Node: refresh của Rust KHÔNG có trường email (như Node), nên đọc lại JSON thô.
    let payload = String::from_utf8(base64_payload(&refresh)).unwrap();
    assert!(
        payload.starts_with(r#"{"sub":9001,"type":"refresh","jti":""#),
        "{payload}"
    );
    // access dùng được với guard.
    let u = e.auth.authenticate(Some(&format!("Bearer {access}"))).await.unwrap();
    assert_eq!((u.user_id, u.company_id), (9001, 1));
    // refresh token không dùng làm access token.
    assert_eq!(
        e.auth
            .authenticate(Some(&format!("Bearer {refresh}")))
            .await
            .unwrap_err(),
        AuthError::InvalidToken
    );

    // Nhật ký đăng nhập.
    assert_eq!(scalar::<i64>("SELECT count(*) FROM audit_logs WHERE user_id = 9001 AND metadata->>'reason' = 'ok' AND ip_address = '203.0.113.1'").await, 1);

    // Làm mới giữ nguyên jti, cấp token mới.
    let r2 = e.svc.refresh(&refresh).await.unwrap();
    let rc2 = jwt::verify(&s(&r2, "refresh_token"), SECRET).unwrap();
    assert_eq!(rc2.jti, rc.jti);
    assert_eq!(r2["user"]["id"], json!(9001));
    // Token truy cập không dùng làm refresh.
    let bad = e.svc.refresh(&access).await.unwrap_err();
    assert_eq!((code(&bad), msg(&bad).as_str()), (401, "Token không hợp lệ"));
    let bad = e.svc.refresh("rác").await.unwrap_err();
    assert_eq!(msg(&bad), "Refresh token không hợp lệ hoặc đã hết hạn");

    // Đăng xuất thu hồi phiên theo jti và chặn token 15 phút.
    let out = e.svc.logout(CO, 9001, Some(&s(&r2, "refresh_token"))).await.unwrap();
    assert_eq!(out, json!({ "message": "Đăng xuất thành công" }));
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM revoked_sessions WHERE user_id = 9001").await,
        1
    );
    let bad = e.svc.refresh(&refresh).await.unwrap_err();
    assert_eq!(msg(&bad), "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại");
    assert_eq!(
        e.auth
            .authenticate(Some(&format!("Bearer {access}")))
            .await
            .unwrap_err(),
        AuthError::Blacklisted
    );
    // Chỉ thu hồi phiên của chính mình: refresh của người khác bị bỏ qua.
    e.svc.logout(CO, 9003, Some(&refresh)).await.unwrap();
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM revoked_sessions WHERE user_id = 9003").await,
        0
    );
    // Đăng nhập lại gỡ chặn ngay.
    let r3 = e
        .svc
        .login("NODEUSER@example.com", PASS, Some("203.0.113.1"), true)
        .await
        .unwrap();
    e.auth
        .authenticate(Some(&format!("Bearer {}", s(&r3, "access_token"))))
        .await
        .unwrap();
    // Token của phiên đã đăng xuất vẫn bị từ chối dù đã gỡ chặn (revoked_sessions).
    let bad = e.svc.refresh(&refresh).await.unwrap_err();
    assert_eq!(code(&bad), 401);
    std::fs::remove_dir_all(&e.dir).ok();
}

fn base64_payload(token: &str) -> Vec<u8> {
    let p = token.split('.').nth(1).unwrap();
    let t: Vec<u8> = p
        .bytes()
        .filter_map(|b| match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        })
        .collect();
    let mut out = Vec::new();
    for ch in t.chunks(4) {
        let n = ch
            .iter()
            .enumerate()
            .fold(0u32, |a, (i, v)| a | (u32::from(*v) << (18 - 6 * i)));
        out.push((n >> 16) as u8);
        if ch.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if ch.len() > 3 {
            out.push(n as u8);
        }
    }
    out
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn cheo_token_node_rust() {
    let _g = SERIAL.lock().await;
    let e = setup().await;
    // Token Node dùng được ở Rust: access qua guard, refresh qua làm mới (có và không có cid).
    let u = e
        .auth
        .authenticate(Some(&format!("Bearer {NODE_ACCESS}")))
        .await
        .unwrap();
    assert_eq!((u.user_id, u.email.as_str()), (9001, "nodeuser@example.com"));
    let r = e.svc.refresh(NODE_REFRESH).await.unwrap();
    assert_eq!(
        jwt::verify(&s(&r, "refresh_token"), SECRET).unwrap().jti.as_deref(),
        Some("node-session-1")
    );
    e.svc.refresh(NODE_REFRESH_CID).await.unwrap();
    // Đăng xuất bằng refresh do Node ký thu hồi đúng jti của nó.
    e.svc.logout(CO, 9001, Some(NODE_REFRESH)).await.unwrap();
    assert_eq!(
        scalar::<String>("SELECT session_id FROM revoked_sessions WHERE user_id = 9001 ORDER BY session_id LIMIT 1")
            .await,
        "node-session-1"
    );
    // Chiều ngược lại: token do Rust ký, xuất ra để kiểm bằng `jsonwebtoken` của Node (X_TOKEN_OUT).
    let r = e
        .svc
        .login("nodeuser@example.com", PASS, Some("203.0.113.1"), true)
        .await
        .unwrap();
    if let Ok(out) = std::env::var("X_TOKEN_OUT") {
        std::fs::write(
            out,
            serde_json::to_string(&json!({ "access": r["access_token"], "refresh": r["refresh_token"] })).unwrap(),
        )
        .unwrap();
    }
    // Refresh token không có `exp`: đăng xuất vẫn thu hồi và dòng không bị dọn ngay (hạn mặc định 7 ngày).
    let mut no_exp = Claims::refresh(9001, None, None, Some("khong-exp".to_owned()), 1_700_000_000);
    no_exp.exp = None;
    e.svc
        .logout(CO, 9001, Some(&jwt::sign(&no_exp, SECRET).unwrap()))
        .await
        .unwrap();
    assert!(
        scalar::<bool>(
            "SELECT expires_at > now() + interval '6 days' FROM revoked_sessions WHERE session_id = 'khong-exp'"
        )
        .await
    );
    // Token hết hạn 1 giây bị từ chối (leeway = 0).
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut old = Claims::refresh(9001, None, None, Some("hh".to_owned()), now - 100);
    old.exp = Some((now - 1) as f64);
    let tok = jwt::sign(&old, SECRET).unwrap();
    assert_eq!(
        msg(&e.svc.refresh(&tok).await.unwrap_err()),
        "Refresh token không hợp lệ hoặc đã hết hạn"
    );
    std::fs::remove_dir_all(&e.dir).ok();
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn dang_nhap_loi_va_gioi_han_toc_do() {
    let _g = SERIAL.lock().await;
    let e = setup().await;
    let l = |email: &str, pw: &str| {
        let svc = &e.svc;
        let (email, pw) = (email.to_owned(), pw.to_owned());
        async move { svc.login(&email, &pw, Some("198.51.100.7"), true).await }
    };
    assert_eq!(
        msg(&l("khongco@example.com", PASS).await.unwrap_err()),
        "Email hoặc mật khẩu không đúng"
    );
    assert_eq!(
        msg(&l("nodeuser@example.com", "sai").await.unwrap_err()),
        "Email hoặc mật khẩu không đúng"
    );
    assert_eq!(
        msg(&l("khoa@example.com", PASS).await.unwrap_err()),
        "Tài khoản đã bị khoá"
    );
    for (reason, n) in [("email_not_found", 1), ("bad_password", 1), ("account_locked", 1)] {
        assert_eq!(scalar::<i64>(&format!("SELECT count(*) FROM audit_logs WHERE metadata->>'email' LIKE '%@example.com' AND action = 'login' AND metadata->>'reason' = '{reason}' AND metadata->>'success' = 'false'")).await, n, "{reason}");
    }
    // Trần 10 lần sai theo IP + email (đã sai 0 lần với email này cho tới giờ): sai thêm 10 lần rồi bị 429.
    for _ in 0..10 {
        assert_eq!(code(&l("Spam@Example.com", "x").await.unwrap_err()), 401);
    }
    let err = l("spam@example.com", "x").await.unwrap_err();
    assert_eq!(
        (code(&err), msg(&err).as_str()),
        (429, "Quá nhiều lần thử, vui lòng thử lại sau")
    );
    assert!(err.retry_after().unwrap() > 0 && err.retry_after().unwrap() <= 900);
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM audit_logs WHERE metadata->>'email' LIKE '%@example.com' AND metadata->>'reason' = 'rate_limited'").await,
        1
    );
    // Mọi biến thể hoa/thường của email dùng chung một xô; người khác cùng IP không bị ảnh hưởng.
    assert_eq!(code(&l("SPAM@EXAMPLE.COM", "x").await.unwrap_err()), 429);
    l("nodeuser@example.com", PASS).await.unwrap();
    // Đăng nhập thành công xoá bộ đếm của xô đó.
    for _ in 0..3 {
        l("nodeuser@example.com", "sai").await.unwrap_err();
    }
    l("nodeuser@example.com", PASS).await.unwrap();
    std::fs::remove_dir_all(&e.dir).ok();
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn doi_mat_khau_va_dat_lai() {
    let _g = SERIAL.lock().await;
    let e = setup().await;
    let login = e.svc.login("nodeuser@example.com", PASS, None, true).await.unwrap();
    let refresh = s(&login, "refresh_token");
    // `iat` chỉ có độ phân giải giây và so theo giây: chờ sang giây khác rồi mới đổi mật khẩu.
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let bad = e
        .svc
        .change_password(CO, 9001, "sai", "MatKhauMoi-9", None)
        .await
        .unwrap_err();
    assert_eq!((code(&bad), msg(&bad).as_str()), (401, "Mật khẩu hiện tại không đúng"));
    let bad = e
        .svc
        .change_password(CO, 8999, PASS, "MatKhauMoi-9", None)
        .await
        .unwrap_err();
    assert_eq!((code(&bad), msg(&bad).as_str()), (404, "Không tìm thấy người dùng"));
    let ok = e
        .svc
        .change_password(CO, 9001, PASS, "MatKhauMoi-9", Some("10.1.1.1"))
        .await
        .unwrap();
    assert_eq!(ok, json!({ "message": "Đổi mật khẩu thành công" }));
    assert!(
        scalar::<bool>(
            "SELECT tokens_valid_after IS NOT NULL AND password_updated_at IS NOT NULL FROM users WHERE id = 9001"
        )
        .await
    );
    assert_eq!(
        scalar::<String>(
            "SELECT metadata->>'method' FROM audit_logs WHERE action = 'password_change' AND resource_id = 9001"
        )
        .await,
        "self_change"
    );
    // Token cũ chết: bị chặn ngay; gỡ chặn rồi vẫn chết vì `tokens_valid_after`.
    assert_eq!(
        msg(&e.svc.refresh(&refresh).await.unwrap_err()),
        "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại"
    );
    e.security.remove_user(1, 9001).await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(
        msg(&e.svc.refresh(&refresh).await.unwrap_err()),
        "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại"
    );
    assert_eq!(
        msg(&e.svc.login("nodeuser@example.com", PASS, None, true).await.unwrap_err()),
        "Email hoặc mật khẩu không đúng"
    );
    e.svc
        .login("nodeuser@example.com", "MatKhauMoi-9", None, true)
        .await
        .unwrap();

    // Đặt lại bằng mật khẩu ngẫu nhiên.
    let bad = e.svc.reset_my_password(CO, 9001, "sai", None).await.unwrap_err();
    assert_eq!(code(&bad), 401);
    let r = e.svc.reset_my_password(CO, 9001, "MatKhauMoi-9", None).await.unwrap();
    let np = s(&r, "newPassword");
    assert_eq!(np.chars().count(), 12);
    assert_eq!(r["message"], json!("Reset mật khẩu thành công"));
    e.svc.login("nodeuser@example.com", &np, None, true).await.unwrap();
    assert_eq!(
        scalar::<i64>(
            "SELECT count(*) FROM audit_logs WHERE action = 'password_change' AND resource_id = 9001 AND metadata->>'method' = 'self_reset'"
        )
        .await,
        1
    );
    std::fs::remove_dir_all(&e.dir).ok();
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn ho_so_va_avatar() {
    let _g = SERIAL.lock().await;
    let e = setup().await;
    let me = e.svc.get_me(CO, 9001).await.unwrap();
    assert_eq!(me["user"]["full_name"], json!("Người Một"));
    assert_eq!(code(&e.svc.get_me(CO, 8999).await.unwrap_err()), 404);

    assert_eq!(
        e.svc.update_profile(CO, 9001, None, Patch::Keep).await.unwrap(),
        json!({ "message": "Không có thông tin cần cập nhật" })
    );
    e.svc
        .update_profile(CO, 9001, Some("Tên Mới"), Patch::Keep)
        .await
        .unwrap();
    e.svc
        .update_profile(CO, 9001, None, Patch::Set("0912345678"))
        .await
        .unwrap();
    assert_eq!(
        scalar::<String>("SELECT full_name || '|' || phone FROM users WHERE id = 9001").await,
        "Tên Mới|0912345678"
    );

    let up = |ct: &str, bytes: Vec<u8>| {
        Some(Upload {
            bytes,
            content_type: ct.to_owned(),
        })
    };
    assert_eq!(
        msg(&e.svc.upload_avatar(CO, 9001, None).await.unwrap_err()),
        "Vui lòng chọn ảnh để upload"
    );
    let bad = e
        .svc
        .upload_avatar(CO, 9001, up("image/gif", PNG_1X1.to_vec()))
        .await
        .unwrap_err();
    assert_eq!(
        msg(&bad),
        "Định dạng ảnh không hợp lệ: image/gif. Chỉ chấp nhận: JPG, PNG, WebP."
    );
    let bad = e
        .svc
        .upload_avatar(CO, 9001, up("image/png", vec![0; 5 * 1024 * 1024 + 1]))
        .await
        .unwrap_err();
    assert_eq!(msg(&bad), "Ảnh quá lớn: 5.0MB. Tối đa 5MB.");
    let bad = e
        .svc
        .upload_avatar(CO, 9001, up("image/png", b"khong phai anh".to_vec()))
        .await
        .unwrap_err();
    assert_eq!((code(&bad), msg(&bad).as_str()), (400, "Tệp không phải ảnh hợp lệ"));

    let r = e
        .svc
        .upload_avatar(CO, 9001, up("image/png", PNG_1X1.to_vec()))
        .await
        .unwrap();
    let url = s(&r, "avatar_url");
    assert!(
        url.starts_with("/uploads/avatars/9001_") && url.ends_with(".jpg"),
        "{url}"
    );
    let path = e.dir.join(url.trim_start_matches("/uploads/"));
    assert_eq!(&std::fs::read(&path).unwrap()[..3], &[0xFF, 0xD8, 0xFF]);
    assert_eq!(
        scalar::<String>("SELECT avatar_url FROM users WHERE id = 9001").await,
        url
    );
    // Hai lượt đổi đồng thời: mỗi ảnh cũ bị xoá đúng một lần, ảnh cuối còn lại, không xoá nhầm ảnh của nhau.
    let (x, y) = tokio::join!(
        e.svc.upload_avatar(CO, 9001, up("image/png", PNG_1X1.to_vec())),
        e.svc.upload_avatar(CO, 9001, up("image/png", PNG_1X1.to_vec()))
    );
    let (x, y) = (s(&x.unwrap(), "avatar_url"), s(&y.unwrap(), "avatar_url"));
    let current = scalar::<String>("SELECT avatar_url FROM users WHERE id = 9001").await;
    assert!(current == x || current == y);
    assert!(e.dir.join(current.trim_start_matches("/uploads/")).exists());
    let files = std::fs::read_dir(e.dir.join("avatars")).unwrap().count();
    assert!(files <= 2, "còn {files} tệp avatar");
    // Ảnh mới thay ảnh cũ: ảnh cũ bị xoá; URL trỏ ra ngoài thư mục avatar của công ty thì không đụng tới.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let r2 = e
        .svc
        .upload_avatar(CO, 9001, up("image/jpeg", PNG_1X1.to_vec()))
        .await
        .unwrap();
    assert!(!path.exists());
    assert!(
        e.dir
            .join(s(&r2, "avatar_url").trim_start_matches("/uploads/"))
            .exists()
    );
    std::fs::create_dir_all(e.dir.join("products")).unwrap();
    std::fs::write(e.dir.join("products/x.jpg"), b"x").unwrap();
    exec("UPDATE users SET avatar_url = '/uploads/products/x.jpg' WHERE id = 9001").await;
    e.svc
        .upload_avatar(CO, 9001, up("image/png", PNG_1X1.to_vec()))
        .await
        .unwrap();
    assert!(e.dir.join("products/x.jpg").exists());
    std::fs::remove_dir_all(&e.dir).ok();
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn cau_hinh_va_mot_phien() {
    let _g = SERIAL.lock().await;
    let e = setup().await;
    assert_eq!(
        e.svc.login_wifi_config(CO).await,
        json!({ "enabled": false, "envForced": false })
    );
    e.svc.update_login_wifi_config(CO, true, 9003).await.unwrap();
    assert_eq!(e.svc.login_wifi_config(CO).await["enabled"], json!(true));
    e.svc.update_login_wifi_config(CO, false, 9003).await.unwrap();
    assert_eq!(
        e.svc.update_login_wifi_config(CO, false, 9003).await.unwrap(),
        json!({ "enabled": false })
    );
    assert!(!e.svc.signup_enabled(), "bản một công ty không mở đăng ký");

    // Một phiên một tài khoản: bật ⇒ token có sid; đăng nhập lần hai làm phiên đầu bị đăng xuất.
    assert_eq!(
        e.svc.update_single_session_config(CO, true, 9003).await.unwrap(),
        json!({ "enabled": true })
    );
    assert_eq!(
        e.svc.single_session_config(CO).await,
        json!({ "enabled": true, "envForced": false })
    );
    let a = e.svc.login("nodeuser@example.com", PASS, None, true).await.unwrap();
    let b = e.svc.login("nodeuser@example.com", PASS, None, true).await.unwrap();
    let sid_a = jwt::verify(&s(&a, "access_token"), SECRET).unwrap().sid.unwrap();
    let sid_b = jwt::verify(&s(&b, "access_token"), SECRET).unwrap().sid.unwrap();
    assert_ne!(sid_a, sid_b);
    let bad = e
        .auth
        .authenticate(Some(&format!("Bearer {}", s(&a, "access_token"))))
        .await
        .unwrap_err();
    assert_eq!(bad, AuthError::SessionReplaced);
    assert_eq!(
        msg(&e.svc.refresh(&s(&a, "refresh_token")).await.unwrap_err()),
        "Tài khoản vừa đăng nhập ở nơi khác, phiên này đã bị đăng xuất"
    );
    // Phiên còn hiệu lực làm mới được và giữ nguyên sid.
    let c = e.svc.refresh(&s(&b, "refresh_token")).await.unwrap();
    assert_eq!(jwt::verify(&s(&c, "access_token"), SECRET).unwrap().sid, Some(sid_b));
    std::fs::remove_dir_all(&e.dir).ok();
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn kiem_wifi_van_phong_fail_open() {
    let _g = SERIAL.lock().await;
    reset().await;
    let (svc, _a, _s, dir) = setup_with(StaticGrants(admin_grants()), |_| {}).await;
    let office = "203.0.113.5";
    exec(&format!(
        "UPDATE settings SET value = value WHERE false;
         INSERT INTO settings (key, value, updated_at) VALUES ('login_wifi_check_enabled', 'true', now());
         INSERT INTO attendance_offices (name, ips, is_active, is_demo, updated_at) VALUES
           ('Văn phòng', ARRAY['{office}'], true, false, now()),
           ('Demo', ARRAY['198.51.100.99'], true, true, now());"
    ))
    .await;
    let login = |ip: Option<&'static str>, trusted: bool| svc.login("nodeuser@example.com", PASS, ip, trusted);
    // Chưa có danh sách áp dụng (rỗng) ⇒ không ai bị kiểm.
    login(Some("8.8.8.8"), true).await.unwrap();
    // Người 9001 thuộc danh sách (theo nhân viên) ⇒ kiểm IP.
    exec("INSERT INTO login_wifi_check_targets (scope_type, target_user_id) VALUES ('user', 9001)").await;
    let blocked = login(Some("8.8.8.8"), true).await.unwrap_err();
    assert_eq!(code(&blocked), 401);
    assert!(msg(&blocked).starts_with("Bạn đang không kết nối wifi của văn phòng công ty."));
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM audit_logs WHERE metadata->>'email' LIKE '%@example.com' AND metadata->>'reason' = 'wifi_blocked'").await,
        1
    );
    // Văn phòng demo không dùng để so IP; IP văn phòng thật (kể cả dạng ::ffff:) vào được.
    assert_eq!(code(&login(Some("198.51.100.99"), true).await.unwrap_err()), 401);
    login(Some("::ffff:203.0.113.5"), true).await.unwrap();
    // Fail-open: IP không tin được, thiếu IP, loopback.
    login(Some("8.8.8.8"), false).await.unwrap();
    login(None, true).await.unwrap();
    login(Some("127.0.0.1"), true).await.unwrap();
    // Người không thuộc danh sách (9003, không phải mục tiêu) không bị kiểm.
    svc.login("lead@example.com", PASS, Some("8.8.8.8"), true)
        .await
        .unwrap();
    // Theo quản lý: 9001 có quản lý 9003 là trưởng nhóm được chọn.
    exec("DELETE FROM login_wifi_check_targets WHERE target_user_id BETWEEN 9000 AND 9100; INSERT INTO login_wifi_check_targets (scope_type, target_user_id) VALUES ('team', 9003); UPDATE users SET manager_id = 9003 WHERE id = 9001").await;
    assert_eq!(code(&login(Some("8.8.8.8"), true).await.unwrap_err()), 401);
    // Không có văn phòng nào cấu hình IP ⇒ cho qua.
    exec("UPDATE attendance_offices SET is_active = false").await;
    login(Some("8.8.8.8"), true).await.unwrap();
    exec("UPDATE attendance_offices SET is_active = true").await;
    // Quyền `settings.integrations` luôn được bỏ qua (không tự khoá chân mình).
    let mut g = admin_grants();
    g.grants.insert("settings.integrations".to_owned(), json!(true));
    let (svc2, ..) = setup_with(StaticGrants(g), |_| {}).await;
    svc2.login("nodeuser@example.com", PASS, Some("8.8.8.8"), true)
        .await
        .unwrap();
    // Bypass theo email hoặc id trong env.
    let (svc3, ..) = setup_with(StaticGrants(admin_grants()), |c| {
        c.login_wifi_bypass = "x@y.com, 9001".to_owned()
    })
    .await;
    svc3.login("nodeuser@example.com", PASS, Some("8.8.8.8"), true)
        .await
        .unwrap();
    // Công tắc env bật dù Settings tắt.
    exec("UPDATE settings SET value = 'false' WHERE key = 'login_wifi_check_enabled'").await;
    login(Some("8.8.8.8"), true).await.unwrap();
    let (svc4, ..) = setup_with(StaticGrants(admin_grants()), |c| c.login_wifi_env = true).await;
    assert_eq!(
        code(
            &svc4
                .login("nodeuser@example.com", PASS, Some("8.8.8.8"), true)
                .await
                .unwrap_err()
        ),
        401
    );
    assert_eq!(
        svc4.login_wifi_config(CO).await,
        json!({ "enabled": false, "envForced": true })
    );
    std::fs::remove_dir_all(&dir).ok();
}
