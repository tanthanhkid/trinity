//! Đăng nhập không mật khẩu (#675): mã 6 số + link một lần gửi qua email, phần dùng chung với Google (hoàn tất đăng nhập,
//! vé một lần trao phiên cho web, chống open redirect) và trang Cài đặt › Tài khoản (liên kết Google, mật khẩu tuỳ chọn).
//!
//! Bảo mật:
//! - DB chỉ giữ HMAC-SHA256 của mã/token, khoá ("pepper") suy từ `JWT_SECRET`; mã so bằng phép so hằng thời gian.
//! - `start` trả cùng một phản hồi dù email có tài khoản hay không; thư gửi ở tác vụ nền nên thời gian trả lời cũng như nhau.
//! - Mỗi lượt (challenge) tối đa 5 lần nhập sai, hạn 10 phút, dùng một lần; mã mới làm mã cũ mất hiệu lực;
//!   tối đa 3 thư/email/15 phút; 10 lần `start`/IP/giờ (IP không tin được: một xô chung trần cao hơn).
//! - Link trong thư trỏ về trang web `/auth/email#token=…` (fragment không vào log máy chủ/Referer); trang web gọi
//!   `POST /auth/email/callback`. Không tiêu thụ token bằng GET để trình quét link của hộp thư không đốt mất link.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::types::chrono::{DateTime, Utc};
use subtle::ConstantTimeEq;
use trinity_auth::password;
use trinity_db::CompanyRef;
use trinity_kernel::error::HttpError;
use trinity_mail::MailSender;
use trinity_mail::template::{CodePurpose, login_code_mail};

use crate::google::{GoogleConfig, GoogleState};
use crate::{AuthFail, AuthService, GrantsSource, LoginReason, Res, UserRow, company_token_prefix, internal};

/// Hạn của mã/link.
pub const CHALLENGE_TTL_MINUTES: i64 = 10;
/// Số lần nhập sai tối đa của một lượt.
pub const MAX_CODE_ATTEMPTS: i32 = 5;
/// Số thư tối đa cho một email trong [`MAIL_WINDOW_MINUTES`].
pub const MAX_MAILS_PER_WINDOW: i64 = 3;
pub const MAIL_WINDOW_MINUTES: i64 = 15;
/// Số lần `start` tối đa mỗi IP mỗi giờ.
pub const MAX_STARTS_PER_IP_HOUR: u32 = 10;
/// Trần cho xô chung khi IP khách không tin được (mọi người sau proxy chung một khoá).
pub const MAX_STARTS_UNTRUSTED_HOUR: u32 = 500;
/// Số lần nhập mã/mở link tối đa mỗi IP mỗi giờ (chặn dò mã trên nhiều email).
pub const MAX_VERIFIES_PER_IP_HOUR: u32 = 60;
pub const MAX_VERIFIES_UNTRUSTED_HOUR: u32 = 2000;
/// Web cho bấm "Gửi lại" sau bao nhiêu giây.
pub const RESEND_AFTER_SECS: u64 = 30;
const HOUR_MS: u64 = 3600 * 1000;
/// Hạn của vé trao phiên sau Google.
const TICKET_TTL_MS: u64 = 60 * 1000;
const MAX_TICKETS: usize = 10_000;

const NOT_ENABLED: &str = "Đăng nhập bằng email chưa được bật trên bản cài đặt này";
const INVALID_CODE: &str = "Mã không đúng hoặc đã hết hạn. Hãy gửi lại mã mới.";
const EXPIRED_CODE: &str = "Mã đã hết hạn (10 phút). Hãy gửi lại mã mới.";
const LOCKED_CODE: &str = "Bạn đã nhập sai quá 5 lần. Hãy gửi lại mã mới.";
const INVALID_LINK: &str = "Link đăng nhập không hợp lệ, đã dùng hoặc đã hết hạn. Hãy gửi lại mã mới.";
const START_MESSAGE: &str = "Nếu email này có tài khoản Trinity, mã đăng nhập đã được gửi tới hộp thư.";

/// Tuỳ chọn đăng nhập đọc từ env (mặc định: chỉ mật khẩu).
#[derive(Clone)]
pub struct LoginOptions {
    /// Có mailer ⇒ bật đăng nhập bằng email.
    pub mailer: Option<Arc<dyn MailSender>>,
    /// URL gốc công khai của web (`APP_PUBLIC_URL`, không có thì `INTEGRATIONS_PUBLIC_BASE_URL`) để dựng link trong thư.
    /// Không có ⇒ thư chỉ có mã.
    pub public_url: Option<String>,
    pub google: Option<GoogleConfig>,
    /// `PASSWORD_LOGIN_ENABLED` khác `false`.
    pub password_login: bool,
}

impl Default for LoginOptions {
    fn default() -> Self {
        Self {
            mailer: None,
            public_url: None,
            google: None,
            password_login: true,
        }
    }
}

impl std::fmt::Debug for LoginOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginOptions")
            .field("mailer", &self.mailer.is_some())
            .field("public_url", &self.public_url)
            .field("google", &self.google.is_some())
            .field("password_login", &self.password_login)
            .finish()
    }
}

impl LoginOptions {
    /// Đọc env. Lỗi cấu hình SMTP/Google ⇒ `Err` (máy chủ báo rõ lúc khởi động thay vì tắt lặng lẽ).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let mailer = trinity_mail::from_lookup(&get)?;
        if mailer.is_none() {
            tracing::warn!("[auth] chưa cấu hình SMTP (SMTP_HOST, MAIL_FROM): ẩn đăng nhập bằng email");
        }
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let public_url = val("APP_PUBLIC_URL")
            .or_else(|| val("INTEGRATIONS_PUBLIC_BASE_URL"))
            .map(|u| u.trim_end_matches('/').to_owned());
        Ok(Self {
            mailer,
            public_url,
            google: GoogleConfig::from_lookup(&get)?,
            password_login: val("PASSWORD_LOGIN_ENABLED").as_deref() != Some("false"),
        })
    }
}

/// Bộ đếm cửa sổ cố định có độ dài tuỳ ý (mili giây; đồng hồ là tham số để test).
#[derive(Debug, Default)]
pub struct WindowLimiter {
    store: HashMap<String, (u32, u64)>,
}

impl WindowLimiter {
    /// Ghi một lần và trả `Some(giây chờ)` nếu đã vượt `limit` trong cửa sổ.
    pub fn hit(&mut self, key: &str, limit: u32, window_ms: u64, now: u64) -> Option<u64> {
        if self.store.len() > 50_000 {
            self.store.retain(|_, (_, reset)| *reset > now);
        }
        let e = self.store.entry(key.to_owned()).or_insert((0, now + window_ms));
        if e.1 <= now {
            *e = (0, now + window_ms);
        }
        if e.0 >= limit {
            return Some(e.1.saturating_sub(now).div_ceil(1000).max(1));
        }
        e.0 += 1;
        None
    }
}

/// Vé một lần mang phản hồi đăng nhập từ callback Google về web.
struct Ticket {
    value: Value,
    expires_at: u64,
}

/// Trạng thái RAM của đăng nhập không mật khẩu.
#[derive(Default)]
pub struct LoginState {
    pub opts: LoginOptions,
    limiter: Mutex<WindowLimiter>,
    tickets: Mutex<HashMap<String, Ticket>>,
    pub(crate) google: GoogleState,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Che email để hiện trên màn chờ: `a***@gmail.com`.
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) if !local.is_empty() => {
            let first: String = local.chars().take(1).collect();
            format!("{first}***@{domain}")
        }
        _ => "***".to_owned(),
    }
}

/// Mã 6 số đều nhau (lấy mẫu loại bỏ để không lệch về số nhỏ).
pub fn new_code() -> Result<String, String> {
    const LIMIT: u32 = 4_294_000_000; // bội của 1_000_000 nhỏ hơn u32::MAX
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).map_err(|e| format!("không đọc được nguồn ngẫu nhiên: {e}"))?;
        let n = u32::from_le_bytes(b);
        if n < LIMIT {
            return Ok(format!("{:06}", n % 1_000_000));
        }
    }
}

/// Token của link (32 byte ngẫu nhiên, base64url), có tiền tố công ty như token lời mời.
pub fn new_link_token(company_id: i32) -> Result<String, String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("không đọc được nguồn ngẫu nhiên: {e}"))?;
    Ok(format!(
        "{}{}",
        company_token_prefix(company_id),
        URL_SAFE_NO_PAD.encode(b)
    ))
}

/// Bí mật ngẫu nhiên base64url (state, nonce, PKCE verifier, vé).
pub fn random_secret(bytes: usize) -> Result<String, String> {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).map_err(|e| format!("không đọc được nguồn ngẫu nhiên: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

/// Băm mã/token bằng HMAC-SHA256 với khoá suy từ `JWT_SECRET` (pepper không nằm trong DB).
#[derive(Clone)]
pub struct ChallengeHasher {
    key: [u8; 32],
}

impl ChallengeHasher {
    pub fn new(jwt_secret: &str) -> Self {
        let mut m =
            <Hmac<Sha256> as KeyInit>::new_from_slice(jwt_secret.as_bytes()).expect("HMAC nhận mọi độ dài khoá");
        m.update(b"trinity-login-challenge-v1");
        let mut key = [0u8; 32];
        key.copy_from_slice(&m.finalize().into_bytes());
        Self { key }
    }

    fn mac(&self, parts: &[&str]) -> String {
        let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.key).expect("HMAC nhận mọi độ dài khoá");
        for p in parts {
            m.update(p.as_bytes());
            m.update(&[0]);
        }
        hex(&m.finalize().into_bytes())
    }

    /// Mã gắn với email và mục đích: cùng mã cho email khác ra hash khác.
    pub fn code(&self, purpose: &str, email: &str, code: &str) -> String {
        self.mac(&["code", purpose, email, code])
    }

    pub fn token(&self, token: &str) -> String {
        self.mac(&["token", token])
    }
}

/// So hai hash hằng thời gian.
pub fn same_hash(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// `next` chỉ nhận đường dẫn nội bộ (`/…`), không `//`, không `/\`, không ký tự điều khiển: chống open redirect.
pub fn safe_next(next: Option<&str>) -> Option<String> {
    let n = next?.trim();
    let ok = n.starts_with('/')
        && !n.starts_with("//")
        && !n.starts_with("/\\")
        && n.len() <= 512
        && !n.chars().any(|c| c.is_control() || c == '\\');
    ok.then(|| n.to_owned())
}

/// (provider, email, created_at, last_login_at) của `user_identities`.
type IdentityRow = (String, Option<String>, DateTime<Utc>, Option<DateTime<Utc>>);

/// Hàng `login_challenges` cần để kiểm.
#[derive(Debug, sqlx::FromRow)]
struct ChallengeRow {
    id: i32,
    email: String,
    code_hash: String,
    expires_at: DateTime<Utc>,
    attempts: i32,
    consumed_at: Option<DateTime<Utc>>,
    invalidated_at: Option<DateTime<Utc>>,
}

const CHALLENGE_COLS: &str = "id, email, code_hash, expires_at, attempts, consumed_at, invalidated_at";

/// Kết quả kiểm mã của một lượt.
pub(crate) enum CodeCheck {
    Ok { id: i32 },
    Fail(AuthFail, LoginReason),
}

fn bad(msg: &str) -> AuthFail {
    HttpError::bad_request(msg).into()
}

impl<G: GrantsSource> AuthService<G> {
    pub fn login_options(&self) -> &LoginOptions {
        &self.login.opts
    }

    /// Bật đăng nhập email/Google theo cấu hình (gọi một lần lúc dựng dịch vụ).
    pub fn with_login_options(mut self, opts: LoginOptions) -> Self {
        self.login.opts = opts;
        self
    }

    fn hasher(&self) -> ChallengeHasher {
        ChallengeHasher::new(&self.cfg.jwt_secret)
    }

    pub fn email_login_enabled(&self) -> bool {
        self.login.opts.mailer.is_some()
    }

    pub fn password_login_enabled(&self) -> bool {
        self.login.opts.password_login
    }

    /// `GET /auth/methods` (công khai): web dựng màn đăng nhập theo đây.
    pub fn login_methods(&self) -> Value {
        json!({
            "email_login_enabled": self.email_login_enabled(),
            "google_enabled": self.login.opts.google.is_some(),
            "password_login_enabled": self.password_login_enabled(),
            "signup_enabled": self.signup_enabled(),
            "code_length": 6,
            "resend_after": RESEND_AFTER_SECS,
            "expires_in": CHALLENGE_TTL_MINUTES * 60,
        })
    }

    fn limit_hit(
        &self,
        kind: &str,
        ip: Option<&str>,
        ip_trusted: bool,
        trusted_cap: u32,
        untrusted_cap: u32,
    ) -> Res<()> {
        let ip = ip.unwrap_or("unknown");
        let (key, cap) = if ip_trusted {
            (format!("{kind}:{ip}"), trusted_cap)
        } else {
            (format!("{kind}-untrusted:{ip}"), untrusted_cap)
        };
        match lock(&self.login.limiter).hit(&key, cap, HOUR_MS, Self::now()) {
            None => Ok(()),
            Some(retry) => Err(AuthFail(Box::new(crate::AuthFailBody {
                error: HttpError::new(429, "Quá nhiều lần thử, vui lòng thử lại sau"),
                retry_after: Some(retry),
            }))),
        }
    }

    /// Gửi thư ở tác vụ nền: lỗi SMTP chỉ ghi log (phản hồi không đổi theo kết quả gửi).
    fn send_in_background(&self, mail: trinity_mail::OutgoingMail) {
        let Some(mailer) = self.login.opts.mailer.clone() else {
            return;
        };
        let to = mask_email(&mail.to);
        tokio::spawn(async move {
            if let Err(e) = mailer.send(mail).await {
                tracing::error!("[auth] gửi mã đăng nhập tới {to} lỗi: {e}");
            }
        });
    }

    /// Tạo một lượt mã mới (vô hiệu lượt cũ cùng email + mục đích). `Ok(None)` khi email đã nhận đủ 3 thư/15 phút.
    #[allow(clippy::too_many_arguments)]
    async fn create_challenge(
        &self,
        company: CompanyRef,
        email: &str,
        purpose: &str,
        invitation_id: Option<i32>,
        with_link: bool,
        ip: Option<&str>,
        user_agent: Option<&str>,
    ) -> Res<Option<(String, Option<String>)>> {
        let code = new_code().map_err(|e| internal("sinh mã", e))?;
        let token = if with_link {
            Some(new_link_token(company.id()).map_err(|e| internal("sinh token", e))?)
        } else {
            None
        };
        let h = self.hasher();
        let mut tx = self.tenant_tx(company).await?;
        // Khoá theo email trong giao dịch: hai lượt `start` cùng lúc không vượt trần 3 thư.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('login_challenge:' || $1))")
            .bind(email)
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("khoá lượt mã", e))?;
        let recent: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM login_challenges WHERE email = $1 AND purpose = $2 \
             AND created_at > now() - make_interval(mins => $3::int)",
        )
        .bind(email)
        .bind(purpose)
        .bind(MAIL_WINDOW_MINUTES as i32)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| internal("đếm thư", e))?;
        if recent >= MAX_MAILS_PER_WINDOW {
            return Ok(None);
        }
        sqlx::query(
            "UPDATE login_challenges SET invalidated_at = now() WHERE email = $1 AND purpose = $2 \
             AND consumed_at IS NULL AND invalidated_at IS NULL",
        )
        .bind(email)
        .bind(purpose)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("vô hiệu mã cũ", e))?;
        let ua: Option<String> = user_agent.map(|u| u.chars().take(500).collect());
        let ip: Option<String> = ip.map(|i| i.chars().take(64).collect());
        sqlx::query(
            "INSERT INTO login_challenges (email, purpose, invitation_id, code_hash, token_hash, expires_at, ip_address, user_agent) \
             VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int), $7, $8)",
        )
        .bind(email)
        .bind(purpose)
        .bind(invitation_id)
        .bind(h.code(purpose, email, &code))
        .bind(token.as_deref().map(|t| h.token(t)))
        .bind(CHALLENGE_TTL_MINUTES as i32)
        .bind(ip)
        .bind(ua)
        .execute(&mut *tx)
        .await
        .map_err(|e| internal("tạo lượt mã", e))?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        Ok(Some((code, token)))
    }

    /// `POST /auth/email/start`: luôn trả cùng một phản hồi 200 (chống dò tài khoản).
    pub async fn email_start(
        &self,
        email: &str,
        ip: Option<&str>,
        ip_trusted: bool,
        user_agent: Option<&str>,
    ) -> Res<Value> {
        if !self.email_login_enabled() {
            return Err(HttpError::not_found(NOT_ENABLED).into());
        }
        self.limit_hit(
            "email-start",
            ip,
            ip_trusted,
            MAX_STARTS_PER_IP_HOUR,
            MAX_STARTS_UNTRUSTED_HOUR,
        )?;
        let norm = Self::norm_email(email);
        let company = self.company_of_email(&norm).await?;
        let user = self.find_by_email(company, &norm).await?;
        match user {
            Some(u) if u.status == "active" => {
                let with_link = self.login.opts.public_url.is_some();
                match self
                    .create_challenge(company, &norm, "login", None, with_link, ip, user_agent)
                    .await?
                {
                    Some((code, token)) => {
                        let link = token.map(|t| {
                            format!(
                                "{}/auth/email#token={t}",
                                self.login.opts.public_url.as_deref().unwrap_or("")
                            )
                        });
                        self.send_in_background(login_code_mail(
                            &u.email,
                            &code,
                            link.as_deref(),
                            CHALLENGE_TTL_MINUTES as u32,
                            CodePurpose::Login,
                        ));
                    }
                    None => tracing::warn!(
                        "[auth] {} đã nhận đủ {MAX_MAILS_PER_WINDOW} mã trong {MAIL_WINDOW_MINUTES} phút: không gửi thêm",
                        mask_email(&norm)
                    ),
                }
            }
            // Email lạ hoặc tài khoản khoá: không gửi gì, phản hồi y hệt.
            _ => {}
        }
        Ok(json!({
            "message": START_MESSAGE,
            "email": mask_email(&norm),
            "expires_in": CHALLENGE_TTL_MINUTES * 60,
            "resend_after": RESEND_AFTER_SECS,
        }))
    }

    /// Kiểm mã của lượt mới nhất (email + mục đích [+ lời mời]). Sai ⇒ tăng `attempts`; đúng ⇒ CHƯA tiêu thụ (nơi gọi
    /// tiêu thụ trong giao dịch của mình bằng [`consume_challenge`]).
    pub(crate) async fn check_code(
        &self,
        company: CompanyRef,
        email: &str,
        purpose: &str,
        invitation_id: Option<i32>,
        code: &str,
    ) -> Res<CodeCheck> {
        let mut tx = self.tenant_tx(company).await?;
        let row: Option<ChallengeRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {CHALLENGE_COLS} FROM login_challenges WHERE email = $1 AND purpose = $2 \
             AND ($3::int IS NULL OR invitation_id = $3) ORDER BY id DESC LIMIT 1 FOR UPDATE"
        )))
        .bind(email)
        .bind(purpose)
        .bind(invitation_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| internal("đọc lượt mã", e))?;
        let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| internal("giờ DB", e))?;
        let Some(row) = row.filter(|r| r.consumed_at.is_none() && r.invalidated_at.is_none()) else {
            return Ok(CodeCheck::Fail(bad(INVALID_CODE), LoginReason::BadCode));
        };
        if row.expires_at <= now {
            return Ok(CodeCheck::Fail(bad(EXPIRED_CODE), LoginReason::CodeExpired));
        }
        if row.attempts >= MAX_CODE_ATTEMPTS {
            return Ok(CodeCheck::Fail(bad(LOCKED_CODE), LoginReason::TooManyAttempts));
        }
        let want = self.hasher().code(purpose, &row.email, code.trim());
        if same_hash(&want, &row.code_hash) {
            tx.commit().await.map_err(|e| internal("commit", e))?;
            return Ok(CodeCheck::Ok { id: row.id });
        }
        sqlx::query("UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1")
            .bind(row.id)
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("ghi lần sai", e))?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        let left = MAX_CODE_ATTEMPTS - row.attempts - 1;
        let msg = if left > 0 {
            format!("Mã không đúng. Bạn còn {left} lần thử.")
        } else {
            LOCKED_CODE.to_owned()
        };
        Ok(CodeCheck::Fail(bad(&msg), LoginReason::BadCode))
    }

    /// Tiêu thụ một lượt (một lần): `false` nếu đã bị dùng/vô hiệu bởi lượt song song.
    pub(crate) async fn consume_challenge(conn: &mut sqlx::PgConnection, id: i32) -> Res<bool> {
        let n = sqlx::query(
            "UPDATE login_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL \
             AND invalidated_at IS NULL AND expires_at > now()",
        )
        .bind(id)
        .execute(conn)
        .await
        .map_err(|e| internal("tiêu thụ mã", e))?
        .rows_affected();
        Ok(n == 1)
    }

    async fn consume_alone(&self, company: CompanyRef, id: i32) -> Res<bool> {
        let mut c = self.conn(company).await?;
        Self::consume_challenge(&mut c, id).await
    }

    /// `POST /auth/email/verify`.
    pub async fn email_verify(&self, email: &str, code: &str, ip: Option<&str>, ip_trusted: bool) -> Res<Value> {
        if !self.email_login_enabled() {
            return Err(HttpError::not_found(NOT_ENABLED).into());
        }
        self.limit_hit(
            "email-verify",
            ip,
            ip_trusted,
            MAX_VERIFIES_PER_IP_HOUR,
            MAX_VERIFIES_UNTRUSTED_HOUR,
        )?;
        let norm = Self::norm_email(email);
        let company = self.company_of_email(&norm).await?;
        let id = match self.check_code(company, &norm, "login", None, code).await? {
            CodeCheck::Ok { id, .. } => id,
            CodeCheck::Fail(e, reason) => {
                self.log_login_via(company, None, &norm, false, ip, reason, "email_code")
                    .await;
                return Err(e);
            }
        };
        if !self.consume_alone(company, id).await? {
            return Err(bad(INVALID_CODE));
        }
        let user = self.find_by_email(company, &norm).await?;
        let Some(user) = user else {
            self.log_login_via(
                company,
                None,
                &norm,
                false,
                ip,
                LoginReason::EmailNotFound,
                "email_code",
            )
            .await;
            return Err(bad(INVALID_CODE));
        };
        self.complete_login(company, user, ip, ip_trusted, "email_code").await
    }

    /// `POST /auth/email/callback` (token của link trong thư).
    pub async fn email_link(&self, token: &str, ip: Option<&str>, ip_trusted: bool) -> Res<Value> {
        if !self.email_login_enabled() {
            return Err(HttpError::not_found(NOT_ENABLED).into());
        }
        self.limit_hit(
            "email-verify",
            ip,
            ip_trusted,
            MAX_VERIFIES_PER_IP_HOUR,
            MAX_VERIFIES_UNTRUSTED_HOUR,
        )?;
        let token = token.trim();
        let Some(company) = self.token_company(token).await? else {
            return Err(bad(INVALID_LINK));
        };
        let hash = self.hasher().token(token);
        let mut tx = self.tenant_tx(company).await?;
        let row: Option<ChallengeRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {CHALLENGE_COLS} FROM login_challenges WHERE token_hash = $1 AND purpose = 'login' FOR UPDATE"
        )))
        .bind(&hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| internal("đọc link", e))?;
        let Some(row) = row else {
            return Err(bad(INVALID_LINK));
        };
        if row.attempts >= MAX_CODE_ATTEMPTS || !Self::consume_challenge(&mut tx, row.id).await? {
            tx.rollback().await.ok();
            self.log_login_via(
                company,
                None,
                &row.email,
                false,
                ip,
                LoginReason::CodeExpired,
                "email_link",
            )
            .await;
            return Err(bad(INVALID_LINK));
        }
        tx.commit().await.map_err(|e| internal("commit", e))?;
        let Some(user) = self.find_by_email(company, &row.email).await? else {
            return Err(bad(INVALID_LINK));
        };
        self.complete_login(company, user, ip, ip_trusted, "email_link").await
    }

    /// Đăng nhập không qua mật khẩu đã xác minh xong danh tính: cùng các cổng với `login()` (khoá tài khoản, Wi-Fi văn
    /// phòng, một phiên), ghi nhật ký kèm phương thức rồi cấp access/refresh token như cũ.
    pub(crate) async fn complete_login(
        &self,
        company: CompanyRef,
        user: UserRow,
        ip: Option<&str>,
        ip_trusted: bool,
        method: &str,
    ) -> Res<Value> {
        if user.status != "active" {
            self.log_login_via(
                company,
                Some(user.id),
                &user.email,
                false,
                ip,
                LoginReason::AccountLocked,
                method,
            )
            .await;
            return Err(HttpError::unauthorized("Tài khoản đã bị khoá").into());
        }
        if self.login_wifi_active(company).await {
            let grants = self.grants_of(company, user.id).await?;
            let (allowed, reason) = self.check_login_wifi(company, &user, &grants, ip, ip_trusted).await;
            if !allowed {
                tracing::warn!(
                    "[login-wifi-check] BLOCKED user={} method={method} reason={reason}",
                    user.id
                );
                self.log_login_via(
                    company,
                    Some(user.id),
                    &user.email,
                    false,
                    ip,
                    LoginReason::WifiBlocked,
                    method,
                )
                .await;
                return Err(HttpError::unauthorized(
                    "Bạn đang không kết nối wifi của văn phòng công ty. Vui lòng kết nối wifi tại một trong các văn phòng rồi đăng nhập lại.",
                )
                .into());
            }
        }
        self.log_login_via(company, Some(user.id), &user.email, true, ip, LoginReason::Ok, method)
            .await;
        self.security.remove_user(company.id(), user.id).await;
        let sid = if self.single_session_active(company).await {
            Some(self.security.start_session(company.id(), user.id).await)
        } else {
            None
        };
        self.token_response(company, &user, sid, uuid::Uuid::new_v4().to_string())
            .await
    }

    // ---------------------------------------------------------------- lời mời

    /// `POST /auth/invitations/send-code` (công khai): gửi mã xác nhận tới email của lời mời.
    pub async fn invitation_send_code(
        &self,
        token: &str,
        ip: Option<&str>,
        ip_trusted: bool,
        ua: Option<&str>,
    ) -> Res<Value> {
        if !self.email_login_enabled() {
            return Err(HttpError::not_found(NOT_ENABLED).into());
        }
        self.limit_hit(
            "email-start",
            ip,
            ip_trusted,
            MAX_STARTS_PER_IP_HOUR,
            MAX_STARTS_UNTRUSTED_HOUR,
        )?;
        let token = token.trim();
        let Some(company) = self.token_company(token).await? else {
            return Err(HttpError::new(410, crate::INVITATION_GONE_MESSAGE).into());
        };
        let inv = self.find_pending_invitation(company, token).await?;
        let email = Self::norm_email(&inv.email);
        let Some((code, _)) = self
            .create_challenge(company, &email, "invite", Some(inv.id), false, ip, ua)
            .await?
        else {
            return Err(HttpError::new(429, "Bạn vừa yêu cầu nhiều mã. Hãy thử lại sau ít phút.").into());
        };
        let company_name = self
            .platform
            .company(company.id())
            .await
            .map_err(|e| internal("công ty", e))?
            .map(|r| r.name)
            .unwrap_or_else(|| "công ty".to_owned());
        self.send_in_background(login_code_mail(
            &inv.email,
            &code,
            None,
            CHALLENGE_TTL_MINUTES as u32,
            CodePurpose::Invite(&company_name),
        ));
        Ok(json!({
            "email": mask_email(&email),
            "expires_in": CHALLENGE_TTL_MINUTES * 60,
            "resend_after": RESEND_AFTER_SECS,
        }))
    }

    // ---------------------------------------------------------------- vé trao phiên

    /// Cất phản hồi đăng nhập, trả vé một lần (60 giây).
    pub(crate) fn issue_ticket(&self, value: Value) -> Res<String> {
        let ticket = random_secret(32).map_err(|e| internal("sinh vé", e))?;
        let now = Self::now();
        let mut t = lock(&self.login.tickets);
        t.retain(|_, v| v.expires_at > now);
        if t.len() >= MAX_TICKETS {
            return Err(HttpError::new(429, "Quá nhiều lượt đăng nhập, vui lòng thử lại sau").into());
        }
        t.insert(
            sha256_hex(&ticket),
            Ticket {
                value,
                expires_at: now + TICKET_TTL_MS,
            },
        );
        Ok(ticket)
    }

    /// `POST /auth/ticket` (công khai): đổi vé lấy phản hồi đăng nhập (một lần).
    pub fn redeem_ticket(&self, ticket: &str) -> Res<Value> {
        let now = Self::now();
        let got = lock(&self.login.tickets).remove(&sha256_hex(ticket.trim()));
        match got {
            Some(t) if t.expires_at > now => Ok(t.value),
            _ => Err(bad("Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.")),
        }
    }

    // ---------------------------------------------------------------- Cài đặt › Tài khoản

    async fn has_password(&self, company: CompanyRef, user_id: i32) -> Res<bool> {
        let mut c = self.conn(company).await?;
        let h: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| internal("đọc mật khẩu", e))?;
        Ok(h.is_some_and(|h| has_usable_password(&h)))
    }

    /// `GET /auth/account`: phương thức đăng nhập của chính mình.
    pub async fn account_overview(&self, company: CompanyRef, user_id: i32) -> Res<Value> {
        let has_password = self.has_password(company, user_id).await?;
        let mut c = self.conn(company).await?;
        let rows: Vec<IdentityRow> = sqlx::query_as(
            "SELECT provider, email, created_at, last_login_at FROM user_identities WHERE user_id = $1 ORDER BY id",
        )
        .bind(user_id)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| internal("danh tính", e))?;
        let identities: Vec<Value> = rows
            .into_iter()
            .map(|(provider, email, created, last)| {
                json!({
                    "provider": provider,
                    "email": email,
                    "created_at": created.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    "last_login_at": last.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                })
            })
            .collect();
        Ok(json!({
            "has_password": has_password,
            "identities": identities,
            "email_login_enabled": self.email_login_enabled(),
            "google_enabled": self.login.opts.google.is_some(),
            "password_login_enabled": self.password_login_enabled(),
        }))
    }

    /// Còn đường đăng nhập nào khác ngoài `except` không (không để người dùng tự khoá mình ngoài cửa).
    async fn other_method_left(&self, company: CompanyRef, user_id: i32, except: &str) -> Res<bool> {
        if self.email_login_enabled() {
            return Ok(true);
        }
        let password =
            except != "password" && self.password_login_enabled() && self.has_password(company, user_id).await?;
        if password {
            return Ok(true);
        }
        if except == "google" {
            return Ok(false);
        }
        let mut c = self.conn(company).await?;
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM user_identities WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *c)
            .await
            .map_err(|e| internal("danh tính", e))?;
        Ok(n > 0 && self.login.opts.google.is_some())
    }

    /// `DELETE /auth/account/identities/google`: gỡ liên kết Google.
    pub async fn unlink_google(&self, company: CompanyRef, user_id: i32) -> Res<Value> {
        if !self.other_method_left(company, user_id, "google").await? {
            return Err(bad(
                "Hãy đặt mật khẩu trước khi gỡ Google: đây đang là cách đăng nhập duy nhất của bạn.",
            ));
        }
        let mut c = self.conn(company).await?;
        let n = sqlx::query("DELETE FROM user_identities WHERE user_id = $1 AND provider = 'google'")
            .bind(user_id)
            .execute(&mut *c)
            .await
            .map_err(|e| internal("gỡ liên kết", e))?
            .rows_affected();
        if n == 0 {
            return Err(HttpError::not_found("Tài khoản chưa liên kết Google").into());
        }
        Ok(json!({ "message": "Đã gỡ liên kết Google" }))
    }

    /// `PUT /auth/account/password`: đặt mật khẩu (chưa có thì không cần mật khẩu cũ; đã có thì phải nhập đúng).
    pub async fn set_account_password(
        &self,
        company: CompanyRef,
        user_id: i32,
        current: Option<&str>,
        new_password: &str,
        ip: Option<&str>,
    ) -> Res<Value> {
        if self.has_password(company, user_id).await? {
            let Some(current) = current else {
                return Err(bad("Vui lòng nhập mật khẩu hiện tại"));
            };
            self.user_for_password(company, user_id, current).await?;
        }
        self.store_password(company, user_id, new_password).await?;
        self.security.blacklist_user(company.id(), user_id).await;
        self.log_password_change(company, user_id, "self_set", ip).await;
        Ok(json!({ "message": "Đã đặt mật khẩu" }))
    }

    /// `DELETE /auth/account/password`: bỏ mật khẩu (chỉ khi còn cách đăng nhập khác), phải nhập mật khẩu hiện tại.
    pub async fn remove_account_password(
        &self,
        company: CompanyRef,
        user_id: i32,
        current: &str,
        ip: Option<&str>,
    ) -> Res<Value> {
        if !self.has_password(company, user_id).await? {
            return Err(HttpError::not_found("Tài khoản chưa có mật khẩu").into());
        }
        self.user_for_password(company, user_id, current).await?;
        if !self.other_method_left(company, user_id, "password").await? {
            return Err(bad(
                "Chưa thể bỏ mật khẩu: bản cài đặt này chưa bật đăng nhập bằng email và bạn chưa liên kết Google.",
            ));
        }
        let mut c = self.conn(company).await?;
        sqlx::query(
            "UPDATE users SET password_hash = '', password_updated_at = now(), tokens_valid_after = now(), updated_at = now() \
             WHERE id = $1",
        )
        .bind(user_id)
        .execute(&mut *c)
        .await
        .map_err(|e| internal("bỏ mật khẩu", e))?;
        self.security.blacklist_user(company.id(), user_id).await;
        self.log_password_change(company, user_id, "self_remove", ip).await;
        Ok(json!({ "message": "Đã bỏ mật khẩu. Lần sau hãy đăng nhập bằng email hoặc Google." }))
    }
}

/// Tài khoản không mật khẩu lưu `password_hash = ''` (cột NOT NULL); hash bcrypt hợp lệ mới tính là có mật khẩu.
pub fn has_usable_password(hash: &str) -> bool {
    hash.starts_with("$2")
}

/// Kiểm mật khẩu: tài khoản không mật khẩu vẫn tốn một lần băm (thời gian không lộ tài khoản nào chưa đặt mật khẩu).
pub(crate) async fn verify_password(input: &str, hash: &str) -> bool {
    if has_usable_password(hash) {
        password::verify(input.to_owned(), hash.to_owned()).await
    } else {
        password::verify(input.to_owned(), crate::DUMMY_HASH.to_owned()).await;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn che_email() {
        assert_eq!(mask_email("anh@gmail.com"), "a***@gmail.com");
        assert_eq!(mask_email("Ánh.Le@example.com"), "Á***@example.com");
        assert_eq!(mask_email("khong-co-a-cong"), "***");
        assert_eq!(mask_email("@x.com"), "***");
    }

    #[test]
    fn ma_sau_so_deu() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..200 {
            let c = new_code().unwrap();
            assert_eq!(c.len(), 6);
            assert!(c.bytes().all(|b| b.is_ascii_digit()));
            seen.insert(c);
        }
        assert!(seen.len() > 190, "mã phải ngẫu nhiên");
    }

    #[test]
    fn token_link_co_tien_to_cong_ty() {
        let t = new_link_token(7).unwrap();
        assert!(t.starts_with("c7."));
        assert_eq!(crate::company_id_of_token(&t), 7);
        let t1 = new_link_token(1).unwrap();
        assert_eq!(crate::company_id_of_token(&t1), 1);
        assert!(t1.len() >= 43);
    }

    #[test]
    fn hash_gan_email_muc_dich_va_khoa() {
        let h = ChallengeHasher::new("s1");
        let a = h.code("login", "a@x.com", "123456");
        assert_eq!(a.len(), 64);
        assert_eq!(a, h.code("login", "a@x.com", "123456"));
        assert_ne!(a, h.code("login", "b@x.com", "123456"), "khác email");
        assert_ne!(a, h.code("invite", "a@x.com", "123456"), "khác mục đích");
        assert_ne!(a, h.code("login", "a@x.com", "123457"));
        assert_ne!(
            a,
            ChallengeHasher::new("s2").code("login", "a@x.com", "123456"),
            "khác pepper"
        );
        assert!(!a.contains("123456"));
        assert_ne!(h.token("t"), h.code("login", "t", ""));
        assert!(same_hash(&a, &a.clone()));
        assert!(!same_hash(&a, &h.token("x")));
        assert!(!same_hash("ab", "abc"));
    }

    #[test]
    fn next_chi_nhan_duong_noi_bo() {
        assert_eq!(safe_next(Some("/dashboard")).as_deref(), Some("/dashboard"));
        assert_eq!(
            safe_next(Some("/oauth/authorize?x=1")).as_deref(),
            Some("/oauth/authorize?x=1")
        );
        for bad in [
            "//evil.com",
            "/\\evil.com",
            "https://evil.com",
            "evil.com",
            "/a\\b",
            "/a\nb",
            "",
        ] {
            assert_eq!(safe_next(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(safe_next(None), None);
    }

    #[test]
    fn gioi_han_cua_so() {
        let mut l = WindowLimiter::default();
        for _ in 0..10 {
            assert!(l.hit("k", 10, HOUR_MS, 0).is_none());
        }
        assert_eq!(l.hit("k", 10, HOUR_MS, 1000), Some(3599));
        assert!(l.hit("k2", 10, HOUR_MS, 1000).is_none(), "khoá khác không bị ảnh hưởng");
        assert!(l.hit("k", 10, HOUR_MS, HOUR_MS).is_none(), "hết cửa sổ thì mở lại");
    }

    #[test]
    fn mat_khau_rong_la_chua_co() {
        assert!(!has_usable_password(""));
        assert!(has_usable_password(crate::DUMMY_HASH));
    }

    #[tokio::test]
    async fn kiem_mat_khau_tai_khoan_khong_mat_khau_luon_sai() {
        assert!(!verify_password("", "").await);
        assert!(!verify_password("bat-ky", "").await);
    }
}
