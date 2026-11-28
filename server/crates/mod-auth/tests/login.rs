//! Đăng nhập không mật khẩu (#675) trên Postgres thật (`public` đã migrate, một công ty):
//! `TEST_DATABASE_URL=postgresql://<user>@localhost:5432/trinity_<tên> cargo test -p mod-auth --test login -- --ignored --test-threads=1`
//!
//! Thư đi qua `lettre` tới SMTP giả trong tiến trình (`trinity_mail::fake_smtp`) hoặc hộp thư RAM — không thư nào ra ngoài.
//! Google: token endpoint + JWKS giả bằng wiremock, id_token ký bằng khoá RSA chỉ dùng cho test (`fixtures/`).
//! Người dùng id 9200..9210, email `@login.example.org`.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mod_auth::google::{GoogleConfig, GoogleOutcome};
use mod_auth::{AuthConfig, AuthFail, AuthService, LoginOptions, StaticGrants, UserGrants};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use trinity_auth::{Security, password};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db, DbConfig};
use trinity_kernel::error::Message;
use trinity_mail::fake_smtp::FakeSmtp;
use trinity_mail::{MailSender, MemoryMailer, SmtpConfig, SmtpMailer};
use trinity_storage::LocalUploadsStore;

const SECRET: &str = "i675-test-secret";
const CO: CompanyRef = CompanyRef::DEFAULT;
const PASS: &str = "Matkhau-675-ok";
const TEST_KEY: &[u8] = include_bytes!("fixtures/oidc-test-key.pk8.der");
const CLIENT_ID: &str = "trinity-test.apps.googleusercontent.com";

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

async fn reset() {
    exec(
        "DELETE FROM login_challenges WHERE email LIKE '%@login.example.org';
         DELETE FROM user_identities WHERE user_id BETWEEN 9200 AND 9210;
         DELETE FROM audit_logs WHERE user_id BETWEEN 9200 AND 9210 OR resource_id BETWEEN 9200 AND 9210
           OR metadata->>'email' LIKE '%@login.example.org';
         DELETE FROM revoked_sessions WHERE user_id BETWEEN 9200 AND 9210;
         DELETE FROM token_blacklist WHERE user_id BETWEEN 9200 AND 9210;
         DELETE FROM active_sessions WHERE user_id BETWEEN 9200 AND 9210;
         DELETE FROM users WHERE id BETWEEN 9200 AND 9210;",
    )
    .await;
    let hash = password::hash(PASS.to_owned()).await.unwrap();
    exec(&format!(
        "INSERT INTO users (id, email, password_hash, full_name, status, updated_at) VALUES
           (9201, 'Mot@Login.example.org', '{hash}', 'Người Một', 'active', now()),
           (9202, 'khoa@login.example.org', '{hash}', 'Người Khoá', 'locked', now()),
           (9203, 'khongmk@login.example.org', '', 'Không Mật Khẩu', 'active', now());"
    ))
    .await;
}

fn grants() -> StaticGrants {
    StaticGrants(UserGrants::default())
}

async fn service(opts: LoginOptions) -> AuthService<StaticGrants> {
    let mut dbc = DbConfig::new(url());
    dbc.pool_size = 4;
    let db = Db::connect(&dbc).await.unwrap();
    let platform = Platform::new(&db, None);
    let security = Security::new(db.clone(), platform.clone(), false);
    let dir = std::env::temp_dir().join(format!("i675-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = AuthConfig::from_lookup(|k| (k == "JWT_SECRET").then(|| SECRET.to_owned())).unwrap();
    AuthService::new(db, platform, security, grants(), LocalUploadsStore::new(&dir), cfg).with_login_options(opts)
}

fn mem_opts(mail: &MemoryMailer) -> LoginOptions {
    LoginOptions {
        mailer: Some(Arc::new(mail.clone())),
        public_url: Some("https://crm.example.test".to_owned()),
        ..LoginOptions::default()
    }
}

async fn wait_mail(mail: &MemoryMailer) -> trinity_mail::OutgoingMail {
    for _ in 0..100 {
        if let Some(m) = mail.take().pop() {
            return m;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("không có thư");
}

fn code_of(m: &trinity_mail::OutgoingMail) -> String {
    m.subject.rsplit(' ').next().unwrap().to_owned()
}

fn token_of(text: &str) -> String {
    text.split("#token=")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

fn other(code: &str) -> String {
    format!("{:06}", (code.parse::<u32>().unwrap() + 1) % 1_000_000)
}

fn msg(e: &AuthFail) -> (u16, String) {
    let m = match e.error().body().message {
        Message::One(s) => s,
        Message::Many(v) => v.join("; "),
    };
    (e.error().status(), m)
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn ma_qua_smtp_gia_dang_nhap_mot_lan() {
    let _g = SERIAL.lock().await;
    reset().await;
    let smtp = FakeSmtp::start().await.unwrap();
    let port = smtp.port.to_string();
    let cfg = SmtpConfig::from_lookup(|k| match k {
        "SMTP_HOST" => Some("127.0.0.1".into()),
        "SMTP_PORT" => Some(port.clone()),
        "SMTP_SECURITY" => Some("none".into()),
        "MAIL_FROM" => Some("Trinity <no-reply@example.test>".into()),
        "MAIL_REPLY_TO" => Some("ho-tro@example.test".into()),
        _ => None,
    })
    .unwrap()
    .unwrap();
    let mailer: Arc<dyn MailSender> = Arc::new(SmtpMailer::new(cfg).unwrap());
    let svc = service(LoginOptions {
        mailer: Some(mailer),
        public_url: Some("https://crm.example.test".into()),
        ..LoginOptions::default()
    })
    .await;
    assert_eq!(svc.login_methods()["email_login_enabled"], true);
    assert_eq!(svc.login_methods()["google_enabled"], false);

    // Email có tài khoản và email lạ: phản hồi giống hệt nhau; chỉ email có tài khoản nhận thư.
    let a = svc
        .email_start("  MOT@login.example.org ", Some("10.0.0.1"), true, Some("UA/1"))
        .await
        .unwrap();
    let b = svc
        .email_start("la@login.example.org", Some("10.0.0.1"), true, None)
        .await
        .unwrap();
    let c = svc
        .email_start("khoa@login.example.org", Some("10.0.0.1"), true, None)
        .await
        .unwrap();
    assert_eq!(a["message"], b["message"]);
    assert_eq!(
        a.as_object().unwrap().keys().collect::<Vec<_>>(),
        b.as_object().unwrap().keys().collect::<Vec<_>>()
    );
    assert_eq!(a["email"], "m***@login.example.org");
    assert_eq!(b["email"], "l***@login.example.org");
    assert_eq!(
        (a["expires_in"].clone(), a["resend_after"].clone()),
        (json!(600), json!(30))
    );
    assert_eq!(b["expires_in"], c["expires_in"]);
    let got = smtp.wait_for(1).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(
        got.len() + smtp.take().len(),
        1,
        "chỉ một thư: email lạ và tài khoản khoá không nhận"
    );
    let m = &got[0];
    assert_eq!(m.to, vec!["Mot@Login.example.org".to_owned()]);
    assert_eq!(m.header("Reply-To").as_deref(), Some("ho-tro@example.test"));
    let body = m.decoded_text();
    let code = body
        .split("Mã của bạn: ")
        .nth(1)
        .unwrap()
        .chars()
        .take(6)
        .collect::<String>();
    assert!(code.bytes().all(|b| b.is_ascii_digit()), "{body}");
    assert!(body.contains("https://crm.example.test/auth/email#token="));
    // DB chỉ giữ hash, kèm IP + user-agent.
    let (hash, ip, ua): (String, Option<String>, Option<String>) = {
        let mut c = PgConnection::connect(&url()).await.unwrap();
        sqlx::query_as(
            "SELECT code_hash, ip_address, user_agent FROM login_challenges WHERE email = 'mot@login.example.org'",
        )
        .fetch_one(&mut c)
        .await
        .unwrap()
    };
    assert!(!hash.contains(&code) && hash.len() == 64);
    assert_eq!((ip.as_deref(), ua.as_deref()), (Some("10.0.0.1"), Some("UA/1")));

    let out = svc
        .email_verify("mot@login.example.org", &code, Some("10.0.0.2"), true)
        .await
        .unwrap();
    assert!(out["access_token"].is_string() && out["refresh_token"].is_string());
    assert_eq!(out["user"]["id"], 9201);
    // Dùng lần 2 bị từ chối.
    let again = svc
        .email_verify("mot@login.example.org", &code, Some("10.0.0.2"), true)
        .await
        .unwrap_err();
    assert_eq!(again.error().status(), 400);
    assert_eq!(
        scalar::<String>("SELECT metadata->>'method' FROM audit_logs WHERE user_id = 9201 AND metadata->>'success' = 'true' ORDER BY id DESC LIMIT 1").await,
        "email_code"
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn sai_ma_het_han_ma_moi_va_tran_thu() {
    let _g = SERIAL.lock().await;
    reset().await;
    let mail = MemoryMailer::default();
    let svc = service(mem_opts(&mail)).await;
    let email = "mot@login.example.org";
    svc.email_start(email, Some("10.0.1.1"), true, None).await.unwrap();
    let code = code_of(&wait_mail(&mail).await);
    // Sai 5 lần: đếm ngược rồi khoá, kể cả mã đúng sau đó.
    for left in [4, 3, 2, 1] {
        let e = svc
            .email_verify(email, &other(&code), Some("10.0.1.2"), true)
            .await
            .unwrap_err();
        assert_eq!(msg(&e), (400, format!("Mã không đúng. Bạn còn {left} lần thử.")));
    }
    let e = svc
        .email_verify(email, &other(&code), Some("10.0.1.2"), true)
        .await
        .unwrap_err();
    assert!(msg(&e).1.contains("quá 5 lần"));
    let e = svc
        .email_verify(email, &code, Some("10.0.1.2"), true)
        .await
        .unwrap_err();
    assert!(msg(&e).1.contains("quá 5 lần"), "đã khoá thì mã đúng cũng không vào");
    assert_eq!(scalar::<i64>("SELECT count(*) FROM audit_logs WHERE metadata->>'reason' = 'bad_code' AND metadata->>'email' = 'mot@login.example.org'").await, 5);

    // Mã mới vô hiệu mã cũ.
    svc.email_start(email, Some("10.0.1.1"), true, None).await.unwrap();
    let c2 = code_of(&wait_mail(&mail).await);
    svc.email_start(email, Some("10.0.1.1"), true, None).await.unwrap();
    let c3 = code_of(&wait_mail(&mail).await);
    if c2 != c3 {
        assert_eq!(
            svc.email_verify(email, &c2, Some("10.0.1.3"), true)
                .await
                .unwrap_err()
                .error()
                .status(),
            400
        );
    }
    // Đã 3 thư/15 phút: lượt thứ 4 trả y hệt nhưng không gửi.
    let r = svc.email_start(email, Some("10.0.1.1"), true, None).await.unwrap();
    assert_eq!(r["email"], "m***@login.example.org");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(mail.take().is_empty(), "quá 3 thư/15 phút thì không gửi");
    // Quá hạn 10 phút: từ chối.
    exec("UPDATE login_challenges SET expires_at = now() - interval '1 second' WHERE email = 'mot@login.example.org' AND consumed_at IS NULL AND invalidated_at IS NULL").await;
    let e = svc.email_verify(email, &c3, Some("10.0.1.4"), true).await.unwrap_err();
    assert!(msg(&e).1.contains("hết hạn"), "{:?}", msg(&e));
    // Cửa sổ 15 phút qua đi thì gửi lại được, mã mới dùng được.
    exec(
        "UPDATE login_challenges SET created_at = now() - interval '16 minutes' WHERE email = 'mot@login.example.org'",
    )
    .await;
    svc.email_start(email, Some("10.0.1.1"), true, None).await.unwrap();
    let c4 = code_of(&wait_mail(&mail).await);
    assert!(svc.email_verify(email, &c4, Some("10.0.1.5"), true).await.is_ok());
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn link_mot_lan_va_qua_han() {
    let _g = SERIAL.lock().await;
    reset().await;
    let mail = MemoryMailer::default();
    let svc = service(mem_opts(&mail)).await;
    svc.email_start("khongmk@login.example.org", Some("10.0.2.1"), true, None)
        .await
        .unwrap();
    let m = wait_mail(&mail).await;
    let token = token_of(&m.text);
    let out = svc.email_link(&token, Some("10.0.2.2"), true).await.unwrap();
    assert_eq!(out["user"]["id"], 9203, "tài khoản không mật khẩu đăng nhập bằng link");
    assert_eq!(
        svc.email_link(&token, Some("10.0.2.2"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        400,
        "link dùng lần 2"
    );
    // Mã của cùng thư cũng đã chết (một lượt).
    assert!(
        svc.email_verify("khongmk@login.example.org", &code_of(&m), Some("10.0.2.2"), true)
            .await
            .is_err()
    );
    assert_eq!(
        scalar::<String>("SELECT metadata->>'method' FROM audit_logs WHERE user_id = 9203 AND metadata->>'success' = 'true' ORDER BY id DESC LIMIT 1").await,
        "email_link"
    );
    // Link quá hạn.
    svc.email_start("khongmk@login.example.org", Some("10.0.2.1"), true, None)
        .await
        .unwrap();
    let t2 = token_of(&wait_mail(&mail).await.text);
    exec("UPDATE login_challenges SET expires_at = now() - interval '1 minute' WHERE email = 'khongmk@login.example.org' AND consumed_at IS NULL").await;
    assert_eq!(
        svc.email_link(&t2, Some("10.0.2.3"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        400
    );
    assert_eq!(
        svc.email_link("rac-khong-ton-tai", Some("10.0.2.3"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        400
    );
    // Tài khoản không mật khẩu: đăng nhập mật khẩu luôn sai (kể cả mật khẩu rỗng).
    assert_eq!(
        svc.login("khongmk@login.example.org", "", Some("10.0.2.4"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        401
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn khong_smtp_thi_an_luong_email_va_tat_mat_khau() {
    let _g = SERIAL.lock().await;
    reset().await;
    let svc = service(LoginOptions::default()).await;
    let m = svc.login_methods();
    assert_eq!(
        (m["email_login_enabled"].clone(), m["password_login_enabled"].clone()),
        (json!(false), json!(true))
    );
    assert_eq!(
        svc.email_start("mot@login.example.org", None, true, None)
            .await
            .unwrap_err()
            .error()
            .status(),
        404
    );
    assert!(
        svc.login("mot@login.example.org", PASS, Some("10.0.3.1"), true)
            .await
            .is_ok()
    );
    let off = service(LoginOptions {
        password_login: false,
        ..LoginOptions::default()
    })
    .await;
    assert_eq!(
        off.login("mot@login.example.org", PASS, Some("10.0.3.2"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        403
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn gioi_han_start_theo_ip() {
    let _g = SERIAL.lock().await;
    reset().await;
    let mail = MemoryMailer::default();
    let svc = service(mem_opts(&mail)).await;
    for i in 0..10 {
        svc.email_start(&format!("la{i}@login.example.org"), Some("10.0.4.1"), true, None)
            .await
            .unwrap();
    }
    let e = svc
        .email_start("la@login.example.org", Some("10.0.4.1"), true, None)
        .await
        .unwrap_err();
    assert_eq!(e.error().status(), 429);
    assert!(e.retry_after().is_some());
    assert!(
        svc.email_start("la@login.example.org", Some("10.0.4.2"), true, None)
            .await
            .is_ok(),
        "IP khác không bị chặn"
    );
}

// ---------------------------------------------------------------- Google

struct Idp {
    server: wiremock::MockServer,
    key: ring::signature::RsaKeyPair,
}

impl Idp {
    async fn start() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let key = ring::signature::RsaKeyPair::from_pkcs8(TEST_KEY).unwrap();
        let server = wiremock::MockServer::start().await;
        let pk = ring::signature::RsaPublicKeyComponents::<Vec<u8>>::from(key.public());
        let jwks = json!({ "keys": [{
            "kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
            "n": URL_SAFE_NO_PAD.encode(&pk.n), "e": URL_SAFE_NO_PAD.encode(&pk.e),
        }]});
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/certs"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(jwks))
            .mount(&server)
            .await;
        Self { server, key }
    }

    fn config(&self) -> GoogleConfig {
        GoogleConfig {
            client_id: CLIENT_ID.into(),
            client_secret: "bi-mat-test".into(),
            redirect_uri: "http://localhost:3000/api/v1/auth/google/callback".into(),
            auth_url: format!("{}/auth", self.server.uri()),
            token_url: format!("{}/token", self.server.uri()),
            jwks_url: format!("{}/certs", self.server.uri()),
        }
    }

    fn sign(&self, claims: &Value, kid: &str) -> String {
        let h = URL_SAFE_NO_PAD.encode(json!({ "alg": "RS256", "kid": kid, "typ": "JWT" }).to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let input = format!("{h}.{p}");
        let mut sig = vec![0u8; self.key.public().modulus_len()];
        self.key
            .sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                input.as_bytes(),
                &mut sig,
            )
            .unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
    }

    /// Lần đổi mã kế tiếp trả id_token này (chỉ nhận đúng code + PKCE verifier đúng dạng).
    async fn next_token(&self, id_token: String) {
        self.server.reset().await;
        let _ = self.server.received_requests().await;
        let jwks_again = Self::jwks_of(&self.key);
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/certs"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(jwks_again))
            .mount(&self.server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/token"))
            .and(wiremock::matchers::body_string_contains("code=ma-google"))
            .and(wiremock::matchers::body_string_contains("code_verifier="))
            .and(wiremock::matchers::body_string_contains(
                "grant_type=authorization_code",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(json!({ "id_token": id_token, "access_token": "x" })),
            )
            .mount(&self.server)
            .await;
    }

    fn jwks_of(key: &ring::signature::RsaKeyPair) -> Value {
        let pk = ring::signature::RsaPublicKeyComponents::<Vec<u8>>::from(key.public());
        json!({ "keys": [{ "kty": "RSA", "alg": "RS256", "kid": "k1",
            "n": URL_SAFE_NO_PAD.encode(&pk.n), "e": URL_SAFE_NO_PAD.encode(&pk.e) }]})
    }
}

/// Dựng claim hỏng từ nonce của lượt.
type MakeClaims = Box<dyn Fn(&str) -> Value>;

fn claims(nonce: &str, sub: &str, email: &str) -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    json!({
        "iss": "https://accounts.google.com", "aud": CLIENT_ID, "azp": CLIENT_ID, "sub": sub, "email": email,
        "email_verified": true, "nonce": nonce, "iat": now, "exp": now + 3600, "name": "Người Google",
    })
}

/// Bắt đầu một lượt: (state, nonce) đọc từ URL Google.
fn begin(svc: &AuthService<StaticGrants>, next: Option<&str>, link: Option<(CompanyRef, i32)>) -> (String, String) {
    let (u, state) = svc.google_begin(next, link).unwrap().unwrap();
    let q: HashMap<String, String> = url::Url::parse(&u).unwrap().query_pairs().into_owned().collect();
    assert_eq!(q["state"], state);
    (state, q["nonce"].clone())
}

fn cb(state: &str) -> HashMap<String, String> {
    HashMap::from([
        ("state".to_owned(), state.to_owned()),
        ("code".to_owned(), "ma-google".to_owned()),
    ])
}

fn location(o: GoogleOutcome) -> String {
    let GoogleOutcome::Redirect(l) = o;
    l
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn google_gan_vao_tai_khoan_trung_email_va_ve_mot_lan() {
    let _g = SERIAL.lock().await;
    reset().await;
    let idp = Idp::start().await;
    let svc = service(LoginOptions {
        google: Some(idp.config()),
        ..LoginOptions::default()
    })
    .await;
    assert_eq!(svc.login_methods()["google_enabled"], true);

    // Email Google đã xác minh trùng tài khoản 9201 (khác hoa/thường) ⇒ vào đúng tài khoản đó, gắn danh tính.
    let (state, nonce) = begin(&svc, Some("/contacts"), None);
    idp.next_token(idp.sign(&claims(&nonce, "g-sub-1", "MOT@login.example.org"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.5.1"), true)
            .await,
    );
    assert!(loc.starts_with("/auth/complete#ticket="), "{loc}");
    assert!(loc.contains("next=%2Fcontacts"), "{loc}");
    let frag: HashMap<String, String> = form_urlencoded::parse(loc.split('#').nth(1).unwrap().as_bytes())
        .into_owned()
        .collect();
    let out = svc.redeem_ticket(&frag["ticket"]).unwrap();
    assert_eq!(out["user"]["id"], 9201);
    assert!(out["access_token"].is_string());
    assert_eq!(
        svc.redeem_ticket(&frag["ticket"]).unwrap_err().error().status(),
        400,
        "vé dùng một lần"
    );
    assert_eq!(
        scalar::<i64>(
            "SELECT count(*) FROM user_identities WHERE user_id = 9201 AND provider = 'google' AND subject = 'g-sub-1'"
        )
        .await,
        1
    );
    assert_eq!(
        scalar::<String>("SELECT metadata->>'method' FROM audit_logs WHERE user_id = 9201 AND metadata->>'success' = 'true' ORDER BY id DESC LIMIT 1").await,
        "google"
    );
    // state dùng một lần: gọi lại callback cùng state bị từ chối.
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.5.1"), true)
            .await,
    );
    assert!(loc.starts_with("/login?error=google"), "{loc}");

    // Lần sau: tìm theo danh tính (sub), kể cả khi email Google đã đổi chữ hoa.
    let (state, nonce) = begin(&svc, None, None);
    idp.next_token(idp.sign(&claims(&nonce, "g-sub-1", "mot@login.example.org"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.5.2"), true)
            .await,
    );
    assert!(loc.starts_with("/auth/complete#ticket="), "{loc}");
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn google_tu_choi_state_nonce_aud_email_chua_xac_minh_va_email_la() {
    let _g = SERIAL.lock().await;
    reset().await;
    let idp = Idp::start().await;
    let svc = service(LoginOptions {
        google: Some(idp.config()),
        ..LoginOptions::default()
    })
    .await;
    // Cookie không khớp state (CSRF đăng nhập).
    let (state, nonce) = begin(&svc, None, None);
    idp.next_token(idp.sign(&claims(&nonce, "g-2", "mot@login.example.org"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some("khac"), Some("10.0.6.1"), true)
            .await,
    );
    assert!(
        loc.contains("kh%C3%B4ng+kh%E1%BB%9Bp") || loc.contains("error=google"),
        "{loc}"
    );
    let loc = location(svc.google_callback(&cb(&state), None, Some("10.0.6.1"), true).await);
    assert!(loc.starts_with("/login?error=google"), "{loc}");

    let bad_cases: Vec<(&str, MakeClaims)> = vec![
        (
            "nonce sai",
            Box::new(|_n: &str| claims("nonce-khac", "g-2", "mot@login.example.org")),
        ),
        (
            "aud sai",
            Box::new(|n: &str| {
                let mut c = claims(n, "g-2", "mot@login.example.org");
                c["aud"] = json!("client-khac");
                c["azp"] = json!("client-khac");
                c
            }),
        ),
        (
            "iss sai",
            Box::new(|n: &str| {
                let mut c = claims(n, "g-2", "mot@login.example.org");
                c["iss"] = json!("https://evil.example");
                c
            }),
        ),
        (
            "hết hạn",
            Box::new(|n: &str| {
                let mut c = claims(n, "g-2", "mot@login.example.org");
                c["exp"] = json!(1_000_000_000);
                c
            }),
        ),
        (
            "email chưa xác minh",
            Box::new(|n: &str| {
                let mut c = claims(n, "g-2", "mot@login.example.org");
                c["email_verified"] = json!(false);
                c
            }),
        ),
    ];
    for (name, make) in bad_cases {
        let (state, nonce) = begin(&svc, None, None);
        idp.next_token(idp.sign(&make(&nonce), "k1")).await;
        let loc = location(
            svc.google_callback(&cb(&state), Some(&state), Some("10.0.6.2"), true)
                .await,
        );
        assert!(loc.starts_with("/login?error=google"), "{name}: {loc}");
    }
    // Chữ ký sai (payload bị sửa sau khi ký).
    let (state, nonce) = begin(&svc, None, None);
    let good = idp.sign(&claims(&nonce, "g-2", "mot@login.example.org"), "k1");
    let parts: Vec<&str> = good.split('.').collect();
    let forged_payload = URL_SAFE_NO_PAD.encode(claims(&nonce, "g-2", "khoa@login.example.org").to_string());
    idp.next_token(format!("{}.{forged_payload}.{}", parts[0], parts[2]))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.6.3"), true)
            .await,
    );
    assert!(loc.starts_with("/login?error=google"), "{loc}");
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM user_identities WHERE user_id BETWEEN 9200 AND 9210").await,
        0
    );

    // Email Google chưa có tài khoản: không tự tạo.
    let (state, nonce) = begin(&svc, None, None);
    idp.next_token(idp.sign(&claims(&nonce, "g-3", "moi@login.example.org"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.6.4"), true)
            .await,
    );
    assert!(loc.starts_with("/login?error=google"), "{loc}");
    assert!(loc.contains("ch%C6%B0a+c%C3%B3+t%C3%A0i+kho%E1%BA%A3n"), "{loc}");
    assert_eq!(
        scalar::<i64>("SELECT count(*) FROM users WHERE lower(email) = 'moi@login.example.org'").await,
        0
    );
    // Tài khoản khoá.
    let (state, nonce) = begin(&svc, None, None);
    idp.next_token(idp.sign(&claims(&nonce, "g-4", "khoa@login.example.org"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.6.5"), true)
            .await,
    );
    assert!(loc.contains("kho%C3%A1"), "{loc}");
    // next ngoài (open redirect) bị bỏ.
    let (state, nonce) = begin(&svc, Some("//evil.example/x"), None);
    idp.next_token(idp.sign(&claims(&nonce, "g-1", "mot@login.example.org"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.6.6"), true)
            .await,
    );
    assert!(
        loc.starts_with("/auth/complete#ticket=") && !loc.contains("evil"),
        "{loc}"
    );
}

#[tokio::test]
#[ignore = "cần Postgres (TEST_DATABASE_URL)"]
async fn cai_dat_tai_khoan_lien_ket_google_va_mat_khau_tuy_chon() {
    let _g = SERIAL.lock().await;
    reset().await;
    let idp = Idp::start().await;
    let svc = service(LoginOptions {
        google: Some(idp.config()),
        ..LoginOptions::default()
    })
    .await;
    // 9203 chưa có mật khẩu, chưa liên kết.
    let a = svc.account_overview(CO, 9203).await.unwrap();
    assert_eq!(
        (a["has_password"].clone(), a["identities"].clone()),
        (json!(false), json!([]))
    );
    // Liên kết Google khi đang đăng nhập (email Google khác email tài khoản vẫn được).
    let (state, nonce) = begin(&svc, Some("/settings?tab=account"), Some((CO, 9203)));
    idp.next_token(idp.sign(&claims(&nonce, "g-lk", "canhan@gmail.example"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.7.1"), true)
            .await,
    );
    assert_eq!(loc, "/settings?tab=account&google=linked");
    let a = svc.account_overview(CO, 9203).await.unwrap();
    assert_eq!(a["identities"][0]["provider"], "google");
    assert_eq!(a["identities"][0]["email"], "canhan@gmail.example");
    // Google đó không gắn được cho người khác.
    let (state, nonce) = begin(&svc, Some("/settings"), Some((CO, 9201)));
    idp.next_token(idp.sign(&claims(&nonce, "g-lk", "canhan@gmail.example"), "k1"))
        .await;
    let loc = location(
        svc.google_callback(&cb(&state), Some(&state), Some("10.0.7.2"), true)
            .await,
    );
    assert!(loc.starts_with("/settings?google_error="), "{loc}");
    // Không có SMTP, không mật khẩu: Google là đường duy nhất ⇒ không cho gỡ.
    assert_eq!(svc.unlink_google(CO, 9203).await.unwrap_err().error().status(), 400);
    // Đặt mật khẩu (chưa có thì không cần mật khẩu cũ) rồi gỡ được Google.
    svc.set_account_password(CO, 9203, None, "Mat-khau-moi-1", None)
        .await
        .unwrap();
    assert_eq!(svc.account_overview(CO, 9203).await.unwrap()["has_password"], true);
    assert!(
        svc.login("khongmk@login.example.org", "Mat-khau-moi-1", Some("10.0.7.3"), true)
            .await
            .is_ok()
    );
    svc.unlink_google(CO, 9203).await.unwrap();
    assert_eq!(svc.unlink_google(CO, 9203).await.unwrap_err().error().status(), 404);
    // Đã có mật khẩu: đổi phải nhập đúng mật khẩu cũ.
    assert_eq!(
        svc.set_account_password(CO, 9203, None, "Mat-khau-moi-2", None)
            .await
            .unwrap_err()
            .error()
            .status(),
        400
    );
    assert_eq!(
        svc.set_account_password(CO, 9203, Some("sai"), "Mat-khau-moi-2", None)
            .await
            .unwrap_err()
            .error()
            .status(),
        401
    );
    // Không còn đường khác (không SMTP, không Google) ⇒ không cho bỏ mật khẩu.
    assert_eq!(
        svc.remove_account_password(CO, 9203, "Mat-khau-moi-1", None)
            .await
            .unwrap_err()
            .error()
            .status(),
        400
    );
    // Có SMTP thì bỏ được; sau đó đăng nhập mật khẩu sai.
    let mail = MemoryMailer::default();
    let with_mail = service(LoginOptions {
        mailer: Some(Arc::new(mail.clone())),
        ..LoginOptions::default()
    })
    .await;
    with_mail
        .remove_account_password(CO, 9203, "Mat-khau-moi-1", None)
        .await
        .unwrap();
    assert_eq!(
        with_mail.account_overview(CO, 9203).await.unwrap()["has_password"],
        false
    );
    assert_eq!(
        scalar::<String>("SELECT password_hash FROM users WHERE id = 9203").await,
        ""
    );
    assert_eq!(
        with_mail
            .login("khongmk@login.example.org", "Mat-khau-moi-1", Some("10.0.7.4"), true)
            .await
            .unwrap_err()
            .error()
            .status(),
        401
    );
}
