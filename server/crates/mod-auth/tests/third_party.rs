//! M05: `POST /public/auth/login` (đăng nhập bên thứ ba) trên Postgres thật (`public` đã migrate bằng Prisma):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-auth --test third_party -- --ignored`
//! Test tự tạo người dùng id 9101..9103 và dọn lại.

use mod_auth::{AuthConfig, AuthFail, AuthService, StaticGrants, UserGrants};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_auth::jwt;
use trinity_auth::{Security, password};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_storage::LocalUploadsStore;

const SECRET: &str = "m05-test-secret";
const CO: CompanyRef = CompanyRef::DEFAULT;
const PASS: &str = "Matkhau-123";

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

async fn svc(grants: UserGrants) -> AuthService<StaticGrants> {
    let mut dbc = DbConfig::new(url());
    dbc.pool_size = 4;
    let db = Db::connect(&dbc).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let dir = std::env::temp_dir().join(format!("m05-uploads-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = AuthConfig::from_lookup(|k| (k == "JWT_SECRET").then(|| SECRET.to_owned())).unwrap();
    AuthService::new(
        db,
        platform,
        security,
        StaticGrants(grants),
        LocalUploadsStore::new(&dir),
        cfg,
    )
}

fn staff() -> UserGrants {
    let mut g = serde_json::Map::new();
    g.insert("contacts.create".to_owned(), json!("all"));
    UserGrants {
        grants: g,
        is_admin: false,
    }
}

async fn reset() {
    exec(
        "DELETE FROM audit_logs WHERE user_id BETWEEN 9100 AND 9110 OR metadata->>'email' LIKE '%@m05.example.com';
         DELETE FROM user_roles WHERE user_id BETWEEN 9100 AND 9110;
         DELETE FROM users WHERE id BETWEEN 9100 AND 9110;
         DELETE FROM teams WHERE id = 9101;
         INSERT INTO teams (id, name) VALUES (9101, 'Nhóm thử');
         INSERT INTO roles (id, name, is_system, updated_at) VALUES (9101, 'Vai m05', false, now()) ON CONFLICT (id) DO NOTHING;",
    )
    .await;
    let hash = password::hash(PASS.to_owned()).await.unwrap();
    exec(&format!(
        "INSERT INTO users (id, email, password_hash, full_name, status, team_id, updated_at) VALUES
           (9101, 'owner@m05.example.com', '{hash}', 'Chủ khoá', 'active', 9101, now()),
           (9102, 'khac@m05.example.com', '{hash}', 'Người khác', 'active', NULL, now()),
           (9103, 'khoa@m05.example.com', '{hash}', 'Bị khoá', 'locked', NULL, now());
         INSERT INTO user_roles (user_id, role_id) VALUES (9101, 9101);"
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

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn dang_nhap_ben_thu_ba() {
    let _g = SERIAL.lock().await;
    reset().await;
    let s = svc(staff()).await;
    let r: Value = s
        .login_third_party(CO, "OWNER@m05.example.com", PASS, Some("203.0.113.5"), 9101, true)
        .await
        .unwrap();
    // Chỉ access token 15 phút, KHÔNG có refresh_token; hình `user` như bản TS.
    assert_eq!(
        r.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        ["access_token", "token_type", "expires_in", "user"]
    );
    assert_eq!(
        (r["token_type"].clone(), r["expires_in"].clone()),
        (json!("Bearer"), json!(900))
    );
    assert_eq!(
        r["user"],
        json!({"id": 9101, "email": "owner@m05.example.com", "full_name": "Chủ khoá", "roles": ["Vai m05"], "team_id": 9101, "team_name": "Nhóm thử"})
    );
    let a = jwt::verify(r["access_token"].as_str().unwrap(), SECRET).unwrap();
    assert_eq!(
        (a.sub, a.email.as_str(), a.sid, a.cid, a.kind),
        (9101, "owner@m05.example.com", None, None, None)
    );
    assert_eq!(a.exp.unwrap() - a.iat.unwrap(), 900.0);
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM audit_logs WHERE user_id = 9101 AND metadata->>'reason' = 'ok'").await,
        1
    );
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn tu_choi_dung_cau_va_ghi_nhat_ky() {
    let _g = SERIAL.lock().await;
    reset().await;
    let s = svc(staff()).await;
    let ip = Some("203.0.113.6");
    // Sai mật khẩu / email lạ: cùng một câu.
    let e = s
        .login_third_party(CO, "owner@m05.example.com", "sai", ip, 9101, true)
        .await
        .unwrap_err();
    assert_eq!((code(&e), msg(&e).as_str()), (401, "Email hoặc mật khẩu không đúng"));
    let e = s
        .login_third_party(CO, "la@m05.example.com", PASS, ip, 9101, true)
        .await
        .unwrap_err();
    assert_eq!((code(&e), msg(&e).as_str()), (401, "Email hoặc mật khẩu không đúng"));
    // Tài khoản khoá.
    let e = s
        .login_third_party(CO, "khoa@m05.example.com", PASS, ip, 9103, true)
        .await
        .unwrap_err();
    assert_eq!((code(&e), msg(&e).as_str()), (401, "Tài khoản đã bị khoá"));
    // Khoá cấp cho owner khác: không lấy được JWT của người khác.
    let e = s
        .login_third_party(CO, "khac@m05.example.com", PASS, ip, 9101, true)
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), msg(&e).as_str()),
        (401, "Email không khớp với owner của API key")
    );
    // Owner là Quản trị, hoặc thiếu contacts.create: bị chặn.
    let admin = svc(UserGrants {
        grants: staff().grants,
        is_admin: true,
    })
    .await;
    let e = admin
        .login_third_party(CO, "owner@m05.example.com", PASS, ip, 9101, true)
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), msg(&e).as_str()),
        (401, "Tài khoản này không được phép đăng nhập qua public API")
    );
    let none = svc(UserGrants::default()).await;
    let e = none
        .login_third_party(CO, "owner@m05.example.com", PASS, ip, 9101, true)
        .await
        .unwrap_err();
    assert_eq!(
        (code(&e), msg(&e).as_str()),
        (401, "Tài khoản này không được phép đăng nhập qua public API")
    );
    let reasons: Vec<String> = {
        let mut c = PgConnection::connect(&url()).await.unwrap();
        sqlx::query_scalar(
            "SELECT metadata->>'reason' FROM audit_logs WHERE metadata->>'email' LIKE '%@m05.example.com' ORDER BY id",
        )
        .fetch_all(&mut c)
        .await
        .unwrap()
    };
    assert_eq!(
        reasons,
        [
            "bad_password",
            "email_not_found",
            "account_locked",
            "owner_mismatch",
            "role_not_allowed",
            "role_not_allowed"
        ]
    );
}

#[tokio::test]
#[ignore = "cần Postgres: TEST_DATABASE_URL"]
async fn gioi_han_toc_do_luon_bat() {
    let _g = SERIAL.lock().await;
    reset().await;
    let s = svc(staff()).await;
    let ip = Some("203.0.113.7");
    let mut limited = None;
    for _ in 0..30 {
        let e = s
            .login_third_party(CO, "owner@m05.example.com", "sai", ip, 9101, true)
            .await
            .unwrap_err();
        if code(&e) == 429 {
            limited = Some(e);
            break;
        }
    }
    let e = limited.expect("phải bị giới hạn tốc độ");
    assert_eq!(msg(&e), "Quá nhiều lần thử, vui lòng thử lại sau");
    assert!(e.retry_after().is_some_and(|s| s > 0));
    // Đã bị chặn thì mật khẩu đúng cũng không vào được (khoá theo IP + email).
    assert_eq!(
        code(
            &s.login_third_party(CO, "owner@m05.example.com", PASS, ip, 9101, true)
                .await
                .unwrap_err()
        ),
        429
    );
    // IP khác không bị ảnh hưởng.
    assert!(
        s.login_third_party(CO, "owner@m05.example.com", PASS, Some("203.0.113.8"), 9101, true)
            .await
            .is_ok()
    );
}
