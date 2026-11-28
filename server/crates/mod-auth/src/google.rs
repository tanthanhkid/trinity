//! Đăng nhập bằng Google — OAuth 2.0 / OpenID Connect, luồng mã có PKCE (#675). Chỉ xin `openid email profile`.
//!
//! - `start`: sinh `state` (chống CSRF, buộc vào trình duyệt bằng cookie HttpOnly), `nonce` (chống phát lại id_token) và
//!   PKCE verifier (S256); giữ trong RAM 10 phút, rồi chuyển hướng sang Google.
//! - `callback`: so `state` với cookie (hằng thời gian), lấy lượt chờ ra (một lần), đổi `code` lấy token, kiểm `id_token`:
//!   chữ ký RS256 theo JWKS của Google (`ring`, có bộ nhớ đệm, kid lạ thì tải lại), `iss`, `aud`/`azp`, `exp`, `iat`,
//!   `nonce`, `email_verified = true`.
//! - Liên kết: tìm `user_identities (google, sub)`; chưa có thì email đã xác minh khớp tài khoản sẵn có ⇒ gắn danh tính vào
//!   tài khoản đó. Không có tài khoản ⇒ không tự tạo (theo luật hiện tại: đăng ký công ty hoặc nhận lời mời).
//! - Phiên trao cho web qua vé một lần trong fragment `/auth/complete#ticket=…` (token không nằm trên URL máy chủ thấy).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use trinity_db::CompanyRef;

use crate::login::{random_secret, safe_next, same_hash};
use crate::{AuthService, GrantsSource, LoginReason, Res, internal};

pub const DEFAULT_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const DEFAULT_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
pub const GOOGLE_ISSUERS: &[&str] = &["https://accounts.google.com", "accounts.google.com"];
/// Cookie buộc `state` vào trình duyệt đã bấm "Tiếp tục với Google".
pub const STATE_COOKIE: &str = "trinity_google_state";
pub const STATE_COOKIE_PATH: &str = "/api/v1/auth/google";
const PENDING_TTL_MS: u64 = 10 * 60 * 1000;
const MAX_PENDING: usize = 10_000;
/// Lệch đồng hồ chấp nhận khi kiểm `exp`/`iat`.
const CLOCK_SKEW_SECS: i64 = 60;
const JWKS_TTL_MS: u64 = 3600 * 1000;
const JWKS_MIN_REFETCH_MS: u64 = 60 * 1000;

/// Cấu hình Google OIDC (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`). Endpoint đổi được để test.
#[derive(Clone)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub auth_url: String,
    pub token_url: String,
    pub jwks_url: String,
}

impl std::fmt::Debug for GoogleConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleConfig")
            .field("client_id", &self.client_id)
            .field("client_secret", &"[ẩn]")
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

impl GoogleConfig {
    /// Thiếu cả ba biến ⇒ `Ok(None)` (ẩn nút Google). Có một phần hoặc redirect URI sai ⇒ `Err`.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let (id, secret, redirect) = (
            val("GOOGLE_CLIENT_ID"),
            val("GOOGLE_CLIENT_SECRET"),
            val("GOOGLE_REDIRECT_URI"),
        );
        match (id, secret, redirect) {
            (None, None, None) => Ok(None),
            (Some(client_id), Some(client_secret), Some(redirect_uri)) => {
                let u = url::Url::parse(&redirect_uri).map_err(|e| format!("GOOGLE_REDIRECT_URI không hợp lệ: {e}"))?;
                let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
                if !(u.scheme() == "https" || (u.scheme() == "http" && local)) {
                    return Err("GOOGLE_REDIRECT_URI phải là https (http chỉ cho localhost)".to_owned());
                }
                if !u.path().ends_with("/api/v1/auth/google/callback") {
                    return Err(
                        "GOOGLE_REDIRECT_URI phải trỏ tới <địa chỉ web>/api/v1/auth/google/callback".to_owned(),
                    );
                }
                Ok(Some(Self {
                    client_id,
                    client_secret,
                    redirect_uri,
                    auth_url: DEFAULT_AUTH_URL.to_owned(),
                    token_url: DEFAULT_TOKEN_URL.to_owned(),
                    jwks_url: DEFAULT_JWKS_URL.to_owned(),
                }))
            }
            _ => Err("Google OIDC cần đủ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI".to_owned()),
        }
    }

    /// Cookie `state` chỉ gửi qua https khi web chạy https.
    pub fn secure_cookie(&self) -> bool {
        self.redirect_uri.starts_with("https://")
    }
}

/// Một lượt chờ Google trả về.
struct Pending {
    verifier: String,
    nonce: String,
    next: Option<String>,
    /// Liên kết vào tài khoản đang đăng nhập (công ty, người dùng) thay vì đăng nhập.
    link: Option<(CompanyRef, i32)>,
    expires_at: u64,
}

/// Một khoá công khai RSA trong JWKS.
#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    #[serde(default)]
    pub kid: Option<String>,
    pub kty: String,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

#[derive(Default)]
struct JwksCache {
    keys: Vec<Jwk>,
    fetched_at: u64,
}

/// Trạng thái RAM: lượt chờ, bộ nhớ đệm JWKS, client HTTP.
#[derive(Default)]
pub struct GoogleState {
    pending: Mutex<HashMap<String, Pending>>,
    jwks: tokio::sync::Mutex<JwksCache>,
    http: std::sync::OnceLock<reqwest::Client>,
}

/// Claim cần dùng của id_token đã kiểm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdClaims {
    pub sub: String,
    pub email: String,
    pub name: Option<String>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `code_challenge` S256 của PKCE.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// URL chuyển sang trang đồng ý của Google.
pub fn authorization_url(cfg: &GoogleConfig, state: &str, nonce: &str, verifier: &str) -> String {
    let q = form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", &cfg.client_id)
        .append_pair("redirect_uri", &cfg.redirect_uri)
        .append_pair("scope", "openid email profile")
        .append_pair("state", state)
        .append_pair("nonce", nonce)
        .append_pair("code_challenge", &pkce_challenge(verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "select_account")
        .finish();
    format!("{}?{q}", cfg.auth_url)
}

fn b64(s: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .map_err(|_| "base64url hỏng".to_owned())
}

/// Kiểm id_token (JWS RS256) bằng bộ khoá `keys`: chữ ký, `iss`, `aud`/`azp`, `exp`, `iat`, `nonce`, `email_verified`.
/// `Err(Some(kid))` khi không có khoá khớp `kid` (nơi gọi tải lại JWKS rồi thử lại).
pub fn verify_id_token(
    token: &str,
    keys: &[Jwk],
    client_id: &str,
    nonce: &str,
    now_secs: i64,
) -> Result<IdClaims, VerifyError> {
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err(VerifyError::Invalid("id_token không đúng dạng JWS".into()));
    };
    let header: Value = serde_json::from_slice(&b64(h).map_err(VerifyError::Invalid)?)
        .map_err(|_| VerifyError::Invalid("header hỏng".into()))?;
    if header["alg"].as_str() != Some("RS256") {
        return Err(VerifyError::Invalid("alg phải là RS256".into()));
    }
    let kid = header["kid"].as_str().map(str::to_owned);
    let key = keys
        .iter()
        .filter(|k| k.kty == "RSA" && k.alg.as_deref().is_none_or(|a| a == "RS256"))
        .find(|k| kid.is_none() || k.kid == kid);
    let Some(key) = key else {
        return Err(VerifyError::UnknownKid(kid));
    };
    let (Some(n), Some(e)) = (&key.n, &key.e) else {
        return Err(VerifyError::Invalid("JWK thiếu n/e".into()));
    };
    let pk = ring::signature::RsaPublicKeyComponents {
        n: b64(n).map_err(VerifyError::Invalid)?,
        e: b64(e).map_err(VerifyError::Invalid)?,
    };
    let sig = b64(s).map_err(VerifyError::Invalid)?;
    let signed = &token[..h.len() + 1 + p.len()];
    pk.verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &sig)
        .map_err(|_| VerifyError::Invalid("chữ ký id_token sai".into()))?;
    let c: Value = serde_json::from_slice(&b64(p).map_err(VerifyError::Invalid)?)
        .map_err(|_| VerifyError::Invalid("payload hỏng".into()))?;
    let bad = |m: &str| Err(VerifyError::Invalid(m.to_owned()));
    if !c["iss"].as_str().is_some_and(|i| GOOGLE_ISSUERS.contains(&i)) {
        return bad("iss không phải Google");
    }
    let aud_ok = match &c["aud"] {
        Value::String(a) => a == client_id,
        Value::Array(a) => a.iter().any(|x| x.as_str() == Some(client_id)) && c["azp"].as_str() == Some(client_id),
        _ => false,
    };
    if !aud_ok {
        return bad("aud không khớp client");
    }
    if c["azp"].as_str().is_some_and(|azp| azp != client_id) {
        return bad("azp không khớp client");
    }
    let exp = c["exp"].as_i64().unwrap_or(0);
    if exp + CLOCK_SKEW_SECS < now_secs {
        return bad("id_token đã hết hạn");
    }
    if c["iat"].as_i64().is_some_and(|iat| iat > now_secs + CLOCK_SKEW_SECS) {
        return bad("iat ở tương lai");
    }
    match c["nonce"].as_str() {
        Some(n) if same_hash(n, nonce) => {}
        _ => return bad("nonce không khớp"),
    }
    // Google trả `email_verified` là bool (bản cũ có lúc là chuỗi "true").
    let verified = matches!(&c["email_verified"], Value::Bool(true)) || c["email_verified"].as_str() == Some("true");
    if !verified {
        return bad("email Google chưa xác minh");
    }
    let (Some(sub), Some(email)) = (c["sub"].as_str(), c["email"].as_str()) else {
        return bad("thiếu sub/email");
    };
    if sub.is_empty() || sub.len() > 255 || email.len() > 254 {
        return bad("sub/email không hợp lệ");
    }
    Ok(IdClaims {
        sub: sub.to_owned(),
        email: email.trim().to_lowercase(),
        name: c["name"].as_str().map(str::to_owned),
    })
}

/// Lỗi kiểm id_token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    UnknownKid(Option<String>),
    Invalid(String),
}

/// Nơi web nhận kết quả sau Google.
pub enum GoogleOutcome {
    /// Chuyển hướng tới đường dẫn nội bộ này.
    Redirect(String),
}

fn login_error(msg: &str) -> GoogleOutcome {
    let q = form_urlencoded::Serializer::new(String::new())
        .append_pair("error", "google")
        .append_pair("message", msg)
        .finish();
    GoogleOutcome::Redirect(format!("/login?{q}"))
}

/// Câu lỗi đưa lên URL cho web hiện (lỗi máy chủ thì câu chung).
fn fail_text(e: &crate::AuthFail) -> String {
    if e.error().status() >= 500 {
        return "Máy chủ đang lỗi, vui lòng thử lại sau.".to_owned();
    }
    match e.error().body().message {
        trinity_kernel::error::Message::One(s) => s,
        trinity_kernel::error::Message::Many(v) => v.join("; "),
    }
}

fn with_query(path: &str, key: &str, value: &str) -> String {
    let sep = if path.contains('?') { '&' } else { '?' };
    let q = form_urlencoded::Serializer::new(String::new())
        .append_pair(key, value)
        .finish();
    format!("{path}{sep}{q}")
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    id_token: Option<String>,
}

impl<G: GrantsSource> AuthService<G> {
    fn google_cfg(&self) -> Option<&GoogleConfig> {
        self.login.opts.google.as_ref()
    }

    pub fn google_enabled(&self) -> bool {
        self.google_cfg().is_some()
    }

    pub fn google_secure_cookie(&self) -> bool {
        self.google_cfg().is_some_and(GoogleConfig::secure_cookie)
    }

    fn http(&self) -> Res<&reqwest::Client> {
        if let Some(c) = self.login.google.http.get() {
            return Ok(c);
        }
        let c = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| internal("client HTTP", e))?;
        Ok(self.login.google.http.get_or_init(|| c))
    }

    /// Bắt đầu một lượt: trả (URL Google, state để đặt cookie). `link`: liên kết vào tài khoản đang đăng nhập.
    pub fn google_begin(&self, next: Option<&str>, link: Option<(CompanyRef, i32)>) -> Res<Option<(String, String)>> {
        let Some(cfg) = self.google_cfg() else { return Ok(None) };
        let state = random_secret(32).map_err(|e| internal("sinh state", e))?;
        let nonce = random_secret(32).map_err(|e| internal("sinh nonce", e))?;
        let verifier = random_secret(48).map_err(|e| internal("sinh PKCE", e))?;
        let url = authorization_url(cfg, &state, &nonce, &verifier);
        let now = Self::now();
        let mut p = lock(&self.login.google.pending);
        p.retain(|_, v| v.expires_at > now);
        if p.len() >= MAX_PENDING {
            return Err(
                trinity_kernel::error::HttpError::new(429, "Quá nhiều lượt đăng nhập, vui lòng thử lại sau").into(),
            );
        }
        p.insert(
            crate::login::sha256_hex(&state),
            Pending {
                verifier,
                nonce,
                next: safe_next(next),
                link,
                expires_at: now + PENDING_TTL_MS,
            },
        );
        Ok(Some((url, state)))
    }

    async fn jwks(&self, force: bool) -> Result<Vec<Jwk>, String> {
        let cfg = self.google_cfg().ok_or("Google chưa bật")?;
        let now = Self::now();
        let mut cache = self.login.google.jwks.lock().await;
        let stale = cache.keys.is_empty() || now.saturating_sub(cache.fetched_at) > JWKS_TTL_MS;
        let may_refetch = now.saturating_sub(cache.fetched_at) > JWKS_MIN_REFETCH_MS;
        if stale || (force && may_refetch) {
            let http = self.http().map_err(|_| "client HTTP".to_owned())?;
            let res = http
                .get(&cfg.jwks_url)
                .send()
                .await
                .map_err(|e| format!("tải JWKS: {e}"))?;
            if !res.status().is_success() {
                return Err(format!("tải JWKS: HTTP {}", res.status()));
            }
            let set: JwkSet = res.json().await.map_err(|e| format!("JWKS hỏng: {e}"))?;
            cache.keys = set.keys;
            cache.fetched_at = now;
        }
        Ok(cache.keys.clone())
    }

    async fn exchange_code(&self, cfg: &GoogleConfig, code: &str, verifier: &str) -> Result<String, String> {
        let body = form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", &cfg.redirect_uri)
            .append_pair("client_id", &cfg.client_id)
            .append_pair("client_secret", &cfg.client_secret)
            .append_pair("code_verifier", verifier)
            .finish();
        let http = self.http().map_err(|_| "client HTTP".to_owned())?;
        let res = http
            .post(&cfg.token_url)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("đổi mã Google: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("đổi mã Google: HTTP {status}"));
        }
        let t: TokenResponse = res.json().await.map_err(|e| format!("phản hồi token hỏng: {e}"))?;
        t.id_token.ok_or_else(|| "phản hồi token thiếu id_token".to_owned())
    }

    async fn verified_claims(&self, cfg: &GoogleConfig, id_token: &str, nonce: &str) -> Result<IdClaims, String> {
        let now = (Self::now() / 1000) as i64;
        let keys = self.jwks(false).await?;
        match verify_id_token(id_token, &keys, &cfg.client_id, nonce, now) {
            Ok(c) => Ok(c),
            Err(VerifyError::UnknownKid(_)) => {
                // Google xoay khoá: tải lại JWKS một lần.
                let keys = self.jwks(true).await?;
                verify_id_token(id_token, &keys, &cfg.client_id, nonce, now).map_err(|e| format!("{e:?}"))
            }
            Err(e) => Err(format!("{e:?}")),
        }
    }

    /// `GET /auth/google/callback`: luôn trả một chuyển hướng nội bộ (lỗi ⇒ `/login?error=google&message=…`).
    pub async fn google_callback(
        &self,
        query: &HashMap<String, String>,
        cookie_state: Option<&str>,
        ip: Option<&str>,
        ip_trusted: bool,
    ) -> GoogleOutcome {
        let Some(cfg) = self.google_cfg().cloned() else {
            return login_error("Đăng nhập bằng Google chưa được bật.");
        };
        let Some(state) = query.get("state") else {
            return login_error("Thiếu tham số state. Hãy thử lại.");
        };
        // state phải khớp cookie của CHÍNH trình duyệt đã bắt đầu (chống CSRF đăng nhập).
        if !cookie_state.is_some_and(|c| same_hash(c, state)) {
            return login_error("Phiên đăng nhập Google không khớp trình duyệt này. Hãy thử lại.");
        }
        let pending = lock(&self.login.google.pending).remove(&crate::login::sha256_hex(state));
        let Some(pending) = pending.filter(|p| p.expires_at > Self::now()) else {
            return login_error("Phiên đăng nhập Google đã hết hạn. Hãy thử lại.");
        };
        if query.contains_key("error") {
            return match pending.link {
                Some(_) => GoogleOutcome::Redirect(with_query(
                    pending.next.as_deref().unwrap_or("/settings"),
                    "google",
                    "cancelled",
                )),
                None => login_error("Bạn đã huỷ đăng nhập bằng Google."),
            };
        }
        let Some(code) = query.get("code") else {
            return login_error("Google không trả mã đăng nhập. Hãy thử lại.");
        };
        let claims = match self.exchange_code(&cfg, code, &pending.verifier).await {
            Ok(id_token) => self.verified_claims(&cfg, &id_token, &pending.nonce).await,
            Err(e) => Err(e),
        };
        let claims = match claims {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[auth] Google OIDC lỗi: {e}");
                return login_error("Không xác minh được tài khoản Google. Hãy thử lại.");
            }
        };
        match pending.link {
            Some((company, user_id)) => {
                let next = pending.next.as_deref().unwrap_or("/settings");
                match self.link_identity(company, user_id, &claims).await {
                    Ok(()) => GoogleOutcome::Redirect(with_query(next, "google", "linked")),
                    Err(e) => GoogleOutcome::Redirect(with_query(next, "google_error", &fail_text(&e))),
                }
            }
            None => {
                self.google_login(&claims, pending.next.as_deref(), ip, ip_trusted)
                    .await
            }
        }
    }

    async fn google_login(
        &self,
        claims: &IdClaims,
        next: Option<&str>,
        ip: Option<&str>,
        ip_trusted: bool,
    ) -> GoogleOutcome {
        let res = async {
            let company = self.company_of_email(&claims.email).await?;
            let mut c = self.conn(company).await?;
            let by_identity: Option<i32> =
                sqlx::query_scalar("SELECT user_id FROM user_identities WHERE provider = 'google' AND subject = $1")
                    .bind(&claims.sub)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(|e| internal("danh tính Google", e))?;
            drop(c);
            let user = match by_identity {
                Some(id) => self.find_by_id(company, id).await?,
                None => match self.find_by_email(company, &claims.email).await? {
                    Some(u) => {
                        // Email Google đã xác minh khớp tài khoản sẵn có ⇒ gắn danh tính vào đúng tài khoản đó.
                        let mut c = self.conn(company).await?;
                        sqlx::query(
                            "INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1, 'google', $2, $3) \
                             ON CONFLICT DO NOTHING",
                        )
                        .bind(u.id)
                        .bind(&claims.sub)
                        .bind(&claims.email)
                        .execute(&mut *c)
                        .await
                        .map_err(|e| internal("gắn danh tính Google", e))?;
                        Some(u)
                    }
                    None => None,
                },
            };
            let Some(user) = user else {
                self.log_login_via(company, None, &claims.email, false, ip, LoginReason::NoAccount, "google")
                    .await;
                return Ok(None);
            };
            let user_id = user.id;
            let value = self.complete_login(company, user, ip, ip_trusted, "google").await?;
            let mut c = self.conn(company).await?;
            let _ = sqlx::query(
                "UPDATE user_identities SET last_login_at = now(), email = $3 WHERE user_id = $1 AND provider = 'google' AND subject = $2",
            )
            .bind(user_id)
            .bind(&claims.sub)
            .bind(&claims.email)
            .execute(&mut *c)
            .await;
            Ok::<Option<Value>, crate::AuthFail>(Some(value))
        }
        .await;
        match res {
            Ok(Some(value)) => match self.issue_ticket(value) {
                Ok(ticket) => {
                    let mut frag = form_urlencoded::Serializer::new(String::new());
                    frag.append_pair("ticket", &ticket);
                    if let Some(n) = next {
                        frag.append_pair("next", n);
                    }
                    GoogleOutcome::Redirect(format!("/auth/complete#{}", frag.finish()))
                }
                Err(_) => login_error("Quá nhiều lượt đăng nhập, vui lòng thử lại sau."),
            },
            Ok(None) => login_error(
                "Email Google này chưa có tài khoản Trinity. Hãy nhờ quản trị công ty gửi lời mời, hoặc đăng ký công ty mới.",
            ),
            Err(e) => login_error(&fail_text(&e)),
        }
    }

    /// Gắn Google vào tài khoản đang đăng nhập (thay danh tính Google cũ nếu có). Tài khoản Google đã gắn người khác ⇒ 409.
    async fn link_identity(&self, company: CompanyRef, user_id: i32, claims: &IdClaims) -> Res<()> {
        let mut tx = self.tenant_tx(company).await?;
        let owner: Option<i32> = sqlx::query_scalar(
            "SELECT user_id FROM user_identities WHERE provider = 'google' AND subject = $1 FOR UPDATE",
        )
        .bind(&claims.sub)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| internal("danh tính Google", e))?;
        if owner.is_some_and(|o| o != user_id) {
            return Err(trinity_kernel::error::HttpError::conflict(
                "Tài khoản Google này đã liên kết với một người dùng khác",
            )
            .into());
        }
        sqlx::query("DELETE FROM user_identities WHERE user_id = $1 AND provider = 'google'")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("gỡ danh tính cũ", e))?;
        sqlx::query("INSERT INTO user_identities (user_id, provider, subject, email) VALUES ($1, 'google', $2, $3)")
            .bind(user_id)
            .bind(&claims.sub)
            .bind(&claims.email)
            .execute(&mut *tx)
            .await
            .map_err(|e| internal("gắn danh tính Google", e))?;
        tx.commit().await.map_err(|e| internal("commit", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_s256_theo_rfc7636() {
        // Ví dụ phụ lục B của RFC 7636.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn cau_hinh_google() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(a, _)| *a == k).map(|(_, b)| (*b).to_owned())
        };
        assert!(GoogleConfig::from_lookup(env(&[])).unwrap().is_none());
        assert!(GoogleConfig::from_lookup(env(&[("GOOGLE_CLIENT_ID", "x")])).is_err());
        let ok = GoogleConfig::from_lookup(env(&[
            ("GOOGLE_CLIENT_ID", "id.apps.googleusercontent.com"),
            ("GOOGLE_CLIENT_SECRET", "s"),
            (
                "GOOGLE_REDIRECT_URI",
                "https://crm.example.com/api/v1/auth/google/callback",
            ),
        ]))
        .unwrap()
        .unwrap();
        assert!(ok.secure_cookie());
        assert!(!format!("{ok:?}").contains("\"s\""));
        assert!(
            GoogleConfig::from_lookup(env(&[
                ("GOOGLE_CLIENT_ID", "id"),
                ("GOOGLE_CLIENT_SECRET", "s"),
                (
                    "GOOGLE_REDIRECT_URI",
                    "http://crm.example.com/api/v1/auth/google/callback"
                ),
            ]))
            .is_err()
        );
        assert!(
            GoogleConfig::from_lookup(env(&[
                ("GOOGLE_CLIENT_ID", "id"),
                ("GOOGLE_CLIENT_SECRET", "s"),
                (
                    "GOOGLE_REDIRECT_URI",
                    "http://localhost:3000/api/v1/auth/google/callback"
                ),
            ]))
            .unwrap()
            .is_some()
        );
        assert!(
            GoogleConfig::from_lookup(env(&[
                ("GOOGLE_CLIENT_ID", "id"),
                ("GOOGLE_CLIENT_SECRET", "s"),
                ("GOOGLE_REDIRECT_URI", "https://crm.example.com/callback"),
            ]))
            .is_err()
        );
    }

    #[test]
    fn url_dong_y_co_pkce_state_nonce() {
        let cfg = GoogleConfig {
            client_id: "cid".into(),
            client_secret: "s".into(),
            redirect_uri: "https://crm.example.com/api/v1/auth/google/callback".into(),
            auth_url: DEFAULT_AUTH_URL.into(),
            token_url: DEFAULT_TOKEN_URL.into(),
            jwks_url: DEFAULT_JWKS_URL.into(),
        };
        let u = url::Url::parse(&authorization_url(&cfg, "st", "no", "ve")).unwrap();
        let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["scope"], "openid email profile");
        assert_eq!(q["state"], "st");
        assert_eq!(q["nonce"], "no");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], pkce_challenge("ve"));
        assert_eq!(q["redirect_uri"], cfg.redirect_uri);
        assert!(!q.contains_key("client_secret"));
    }

    #[test]
    fn id_token_hong_bi_tu_choi() {
        assert!(matches!(
            verify_id_token("a.b", &[], "c", "n", 0),
            Err(VerifyError::Invalid(_))
        ));
        // alg none
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let p = URL_SAFE_NO_PAD.encode(br#"{"sub":"1"}"#);
        assert!(matches!(
            verify_id_token(&format!("{h}.{p}."), &[], "c", "n", 0),
            Err(VerifyError::Invalid(_))
        ));
        // HS256 (tấn công đổi thuật toán)
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256"}"#);
        assert!(matches!(
            verify_id_token(&format!("{h}.{p}.x"), &[], "c", "n", 0),
            Err(VerifyError::Invalid(_))
        ));
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"k9"}"#);
        assert_eq!(
            verify_id_token(&format!("{h}.{p}.x"), &[], "c", "n", 0),
            Err(VerifyError::UnknownKid(Some("k9".into())))
        );
    }

    #[test]
    fn them_query_vao_duong_dan() {
        assert_eq!(with_query("/settings", "google", "linked"), "/settings?google=linked");
        assert_eq!(
            with_query("/settings?tab=a", "google", "linked"),
            "/settings?tab=a&google=linked"
        );
    }
}
