//! K11 với Postgres thật: guard từ đầu đến cuối, blacklist và phiên lưu bền, đồng bộ giữa hai tiến trình qua NOTIFY.
//!
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p trinity-auth --test pg_auth -- --ignored --test-threads=1`
//! (schema `public` đã migrate bằng Prisma). Test tự tạo và xoá user 9101..9109 và dòng bảo mật của họ.

use std::sync::Arc;
use std::time::Duration;

use sqlx::{Connection, PgConnection};
use trinity_auth::jwt::{self, Claims};
use trinity_auth::{AuthError, Authenticator, Security};
use trinity_db::platform::Platform;
use trinity_db::{Db, DbConfig};

const SECRET: &str = "k11-pg-secret-0123456789abcdef0123456789abcdef";
const SVC: &str = "svc-secret-xyz";

fn url() -> String {
    std::env::var("TEST_DATABASE_URL").expect("test pg cần TEST_DATABASE_URL")
}

async fn security(sync_on: bool) -> Arc<Security> {
    let db = Db::connect(&DbConfig::new(url())).await.unwrap();
    let platform = Platform::new(&db, None);
    Security::new(db, platform, sync_on)
}

async fn exec(sql: &str) {
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(&mut c)
        .await
        .unwrap();
}

async fn setup() {
    teardown().await;
    for (id, status, deleted) in [(9101, "active", false), (9102, "locked", false), (9103, "active", true)] {
        let del = if deleted { "now()" } else { "NULL" };
        exec(&format!(
            "INSERT INTO users (id, email, password_hash, full_name, status, deleted_at, updated_at)
             VALUES ({id}, 'k11-{id}@example.test', 'x', 'K11 {id}', '{status}', {del}, now())"
        ))
        .await;
    }
}

async fn teardown() {
    exec("DELETE FROM token_blacklist WHERE user_id BETWEEN 9101 AND 9109").await;
    exec("DELETE FROM active_sessions WHERE user_id BETWEEN 9101 AND 9109").await;
    exec("DELETE FROM users WHERE id BETWEEN 9101 AND 9109").await;
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn bearer(c: &Claims) -> String {
    format!("Bearer {}", jwt::sign(c, SECRET).unwrap())
}

fn access(user: i64, sid: Option<&str>, cid: Option<i64>) -> Claims {
    Claims::access(user, "k11@example.test", sid.map(str::to_owned), cid, now())
}

async fn eventually(what: &str, mut f: impl AsyncFnMut() -> bool) {
    for _ in 0..60 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("không đạt trong 3 giây: {what}");
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn guard_dung_thu_tu_va_cau_loi() {
    setup().await;
    let auth = Authenticator::new(security(false).await, SECRET, &[SVC, ""]);
    let sec = auth.security().clone();
    let ok = auth
        .authenticate(Some(&bearer(&access(9101, None, None))))
        .await
        .unwrap();
    assert_eq!(
        (ok.user_id, ok.company_id, ok.email.as_str()),
        (9101, 1, "k11@example.test")
    );
    assert!(
        auth.authenticate(Some(&bearer(&access(9101, None, Some(1)))))
            .await
            .is_ok(),
        "cid = 1 tường minh"
    );

    let err = |r: Result<_, AuthError>| r.map(|_: trinity_auth::AuthUser| ()).unwrap_err();
    assert_eq!(err(auth.authenticate(None).await), AuthError::MissingToken);
    assert_eq!(
        err(auth.authenticate(Some("Bearer rác")).await),
        AuthError::InvalidToken
    );
    let refresh = Claims {
        kind: Some("refresh".into()),
        ..access(9101, None, None)
    };
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&refresh))).await),
        AuthError::InvalidToken
    );
    // Một công ty: token của công ty khác không được đóng vai user cùng id.
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9101, None, Some(2))))).await),
        AuthError::InvalidToken
    );
    // leeway = 0: hết hạn 1 giây là từ chối.
    let expired = Claims {
        exp: Some(now() - 1),
        iat: Some(now() - 901),
        ..access(9101, None, None)
    };
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&expired))).await),
        AuthError::InvalidToken
    );
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9199, None, None)))).await),
        AuthError::AccountMissing
    );
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9102, None, None)))).await),
        AuthError::AccountLocked
    );
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9103, None, None)))).await),
        AuthError::AccountDeleted
    );

    // Blacklist đứng trước phiên, phiên đứng trước tài khoản.
    sec.blacklist_user(1, 9102).await;
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9102, None, None)))).await),
        AuthError::Blacklisted
    );
    sec.remove_user(1, 9102).await;
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9102, None, None)))).await),
        AuthError::AccountLocked
    );

    let s1 = sec.start_session(1, 9101).await;
    let s2 = sec.start_session(1, 9101).await;
    assert_ne!(s1, s2);
    assert_eq!(
        err(auth.authenticate(Some(&bearer(&access(9101, Some(&s1), None)))).await),
        AuthError::SessionReplaced
    );
    assert!(
        auth.authenticate(Some(&bearer(&access(9101, Some(&s2), None))))
            .await
            .is_ok()
    );
    assert!(
        auth.authenticate(Some(&bearer(&access(9101, None, None))))
            .await
            .is_ok(),
        "thiếu sid ⇒ fail-open"
    );
    sec.clear_user(1, 9101).await;
    assert!(
        auth.authenticate(Some(&bearer(&access(9101, Some(&s1), None))))
            .await
            .is_ok()
    );

    assert!(auth.check_service_secret(Some(SVC)).is_ok());
    assert_eq!(auth.check_service_secret(Some("sai")), Err(AuthError::ServiceSecret));
    assert_eq!(auth.check_service_secret(Some("")), Err(AuthError::ServiceSecret));
    assert_eq!(auth.check_service_secret(None), Err(AuthError::ServiceSecret));
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn blacklist_va_phien_song_qua_khoi_dong_lai() {
    setup().await;
    let a = security(false).await;
    a.blacklist_user(1, 9101).await;
    let sid = a.start_session(1, 9101).await;
    // Tiến trình mới (RAM trống) nạp từ bảng.
    let b = security(false).await;
    assert!(!b.is_blacklisted(1, 9101));
    b.reload().await;
    assert!(b.is_blacklisted(1, 9101));
    assert!(b.is_current_session(1, 9101, Some(&sid)));
    assert!(!b.is_current_session(1, 9101, Some("khác")));
    // Dòng hết hạn bị bỏ khi nạp.
    exec("UPDATE token_blacklist SET expires_at = now() - interval '1 second' WHERE user_id = 9101").await;
    let c = security(false).await;
    c.reload().await;
    assert!(!c.is_blacklisted(1, 9101));
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn notify_dong_bo_giua_hai_tien_trinh_va_tin_cua_minh_bi_bo_qua() {
    setup().await;
    let a = security(true).await;
    let b = security(true).await;
    let _la = a.spawn_listener();
    let lb = b.spawn_listener();
    tokio::time::sleep(Duration::from_millis(500)).await; // chờ LISTEN
    a.blacklist_user(1, 9101).await;
    eventually("B thấy block của A", async || b.is_blacklisted(1, 9101)).await;
    a.remove_user(1, 9101).await;
    eventually("B thấy unblock", async || !b.is_blacklisted(1, 9101)).await;
    let sid = a.start_session(1, 9101).await;
    eventually("B thấy phiên mới", async || {
        !b.is_current_session(1, 9101, Some("khác"))
    })
    .await;
    assert!(b.is_current_session(1, 9101, Some(&sid)));
    a.clear_user(1, 9101).await;
    eventually("B thấy phiên bị gỡ", async || {
        b.is_current_session(1, 9101, Some("khác"))
    })
    .await;
    // Tin của chính mình bị bỏ qua: payload mang origin của A đưa vào A không đổi gì.
    let own = trinity_auth::sync::envelope(
        a.origin(),
        "token",
        1,
        serde_json::json!({ "op": "block", "u": 9105, "t": 1 }),
    )
    .unwrap();
    a.handle_payload(&own);
    assert!(!a.is_blacklisted(1, 9105));
    lb.abort();
    teardown().await;
}

#[tokio::test]
#[ignore = "cần Postgres"]
async fn tin_notify_do_node_gui_duoc_ap() {
    setup().await;
    let a = security(true).await;
    let _l = a.spawn_listener();
    tokio::time::sleep(Duration::from_millis(500)).await;
    // Đúng khuôn tin Node phát (docs/sync-notify.md), origin khác.
    let t = chrono::Utc::now().timestamp_millis();
    let payload = format!(r#"{{"v":1,"o":"node-1-abc","k":"token","c":1,"op":"block","u":9101,"t":{t}}}"#);
    let mut c = PgConnection::connect(&url()).await.unwrap();
    sqlx::query("SELECT pg_notify('trinity_sync', $1)")
        .bind(payload)
        .execute(&mut c)
        .await
        .unwrap();
    eventually("nhận tin Node", async || a.is_blacklisted(1, 9101)).await;
    teardown().await;
}
