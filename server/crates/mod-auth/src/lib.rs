//! Module auth (M01, docs/rust/PLAN.md mục 4.6): đăng nhập, làm mới, đăng xuất, hồ sơ, đổi mật khẩu, avatar, cấu hình
//! kiểm Wi-Fi văn phòng và một phiên/tài khoản. Chuyển từ `services/auth/src/auth/auth.service.ts` (bản TS là chuẩn
//! hành vi: câu lỗi, thứ tự kiểm, khoá giới hạn tốc độ, fail-open của Wi-Fi).
//!
//! Đây là lớp logic + DB. Nối route (K14), xác thực DTO ở lớp route, quyền (`Can`) và đọc IP khách (`ClientIp`) làm ở
//! router; hàm ở đây nhận IP đã xác định: `ip_address` là khoá giới hạn tốc độ/nhật ký (IP khách, hoặc IP peer khi không
//! tin được) và `ip_trusted` cho biết có được so với IP văn phòng không.
//!
//! Quyền của người dùng (`grantsFor`) thuộc K12 nên đi qua [`GrantsSource`]; K12 xong thì nối bản thật.

mod invitations;
mod rate_limit;
mod wifi;

use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sqlx::types::chrono::{DateTime, Utc};
use trinity_auth::jwt::{self, Claims};
use trinity_auth::security::now_ms;
use trinity_auth::{Security, password};
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db};
use trinity_kernel::error::HttpError;
use trinity_storage::{LocalUploadsStore, UPLOADS_URL_PREFIX, uploads_rel_path_from_url};

pub use invitations::{
    Actor, INVITATION_GONE_MESSAGE, INVITE_TTL_DAYS, InvitationStatus, USABLE_INVITATION_SQL, USER_SLOT_LOCK,
    assert_user_slot_available, company_id_of_token, company_token_prefix, hash_invite_token, invitable_roles,
    invitation_scope, invitation_status, invite_path, lock_user_slots, new_invite_token, revoke_pending_invitations_by,
    revoke_pending_invitations_for_email, revoke_pending_invitations_for_role, user_limit_message,
};
pub use rate_limit::{RateLimiter, untrusted_delay_ms};
pub use wifi::{
    TargetSets, bypass_listed, group_targets, is_targeted, is_unusable_login_ip, login_ip_matches_office,
    normalize_login_ip,
};

const LOGIN_WIFI_KEY: &str = "login_wifi_check_enabled";
const SINGLE_SESSION_KEY: &str = "single_session_enabled";
/// Băm bcrypt cost 10 của một chuỗi bỏ đi, chỉ để `verify` tốn thời gian như thật khi email không tồn tại.
const DUMMY_HASH: &str = "$2b$10$O0xObAkclwADUt.dHEZ00eCbkdekqwI5MRIF7q9nhNwS8i46abtp2";
const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;

/// Quyền của một người dùng: `{ "<quyền>": true | "<phạm vi>" }` và cờ Quản trị.
#[derive(Debug, Clone, Default)]
pub struct UserGrants {
    pub grants: Map<String, Value>,
    pub is_admin: bool,
}

impl UserGrants {
    /// `can(grants, permission)` của `@trinity/rbac`: có khoá là có.
    pub fn can(&self, permission: &str) -> bool {
        self.grants.contains_key(permission)
    }
}

/// Nguồn quyền (K12 `PermissionService.grantsFor`).
pub trait GrantsSource: Send + Sync {
    fn grants_for(&self, company: CompanyRef, user: i32) -> impl Future<Output = Result<UserGrants, String>> + Send;
}

/// Nguồn quyền cố định, cho test và cho tới khi K12 xong.
#[derive(Debug, Clone, Default)]
pub struct StaticGrants(pub UserGrants);

impl GrantsSource for StaticGrants {
    async fn grants_for(&self, _company: CompanyRef, _user: i32) -> Result<UserGrants, String> {
        Ok(self.0.clone())
    }
}

/// Cấu hình đọc từ môi trường.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub jwt_secret: String,
    /// `SIGNUP_ENABLED !== 'false'` (còn phải bật nhiều công ty).
    pub signup_env_on: bool,
    /// `LOGIN_WIFI_CHECK_ENABLED=true`.
    pub login_wifi_env: bool,
    /// `LOGIN_WIFI_CHECK_BYPASS_EMAILS`.
    pub login_wifi_bypass: String,
    /// `SINGLE_SESSION_ENABLED=true`.
    pub single_session_env: bool,
}

impl AuthConfig {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        Some(Self {
            jwt_secret: get("JWT_SECRET").filter(|s| !s.is_empty())?,
            signup_env_on: get("SIGNUP_ENABLED").as_deref() != Some("false"),
            login_wifi_env: get("LOGIN_WIFI_CHECK_ENABLED").as_deref() == Some("true"),
            login_wifi_bypass: get("LOGIN_WIFI_CHECK_BYPASS_EMAILS").unwrap_or_default(),
            single_session_env: get("SINGLE_SESSION_ENABLED").as_deref() == Some("true"),
        })
    }
}

/// Nội dung lỗi trả ra ngoài: `HttpError` (câu nguyên văn bản TS) và `retry_after` cho 429.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthFailBody {
    pub error: HttpError,
    pub retry_after: Option<u64>,
}

/// Lỗi của module (đóng hộp để `Result` nhỏ).
#[derive(Debug, Clone, PartialEq)]
pub struct AuthFail(pub Box<AuthFailBody>);

impl AuthFail {
    fn http(e: HttpError) -> Self {
        Self(Box::new(AuthFailBody {
            error: e,
            retry_after: None,
        }))
    }

    pub fn error(&self) -> &HttpError {
        &self.0.error
    }

    pub fn retry_after(&self) -> Option<u64> {
        self.0.retry_after
    }
}

impl From<HttpError> for AuthFail {
    fn from(e: HttpError) -> Self {
        Self::http(e)
    }
}

fn internal(what: &str, e: impl std::fmt::Display) -> AuthFail {
    tracing::error!("[auth] {what}: {e}");
    AuthFail::http(HttpError::nest(500, None))
}

fn unauthorized(msg: &str) -> AuthFail {
    HttpError::unauthorized(msg).into()
}

type Res<T> = Result<T, AuthFail>;

#[derive(Debug, sqlx::FromRow)]
struct UserRow {
    id: i32,
    email: String,
    password_hash: String,
    full_name: String,
    avatar_url: Option<String>,
    manager_id: Option<i32>,
    status: String,
    tokens_valid_after: Option<DateTime<Utc>>,
    #[allow(dead_code)]
    team_name: Option<String>,
}

const USER_SELECT: &str = "SELECT u.id, u.email, u.password_hash, u.full_name, u.avatar_url, u.manager_id, \
     u.status, u.tokens_valid_after, t.name AS team_name FROM users u LEFT JOIN teams t ON t.id = u.team_id";

/// Trường của PATCH: không gửi (giữ), gửi `null` (xoá), gửi giá trị (đặt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Patch<T> {
    Keep,
    Clear,
    Set(T),
}

/// Tệp ảnh người dùng tải lên.
#[derive(Debug, Clone)]
pub struct Upload {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// Lý do ghi vào `audit_logs` cho một lượt đăng nhập.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginReason {
    Ok,
    EmailNotFound,
    BadPassword,
    AccountLocked,
    RateLimited,
    WifiBlocked,
}

impl LoginReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::EmailNotFound => "email_not_found",
            Self::BadPassword => "bad_password",
            Self::AccountLocked => "account_locked",
            Self::RateLimited => "rate_limited",
            Self::WifiBlocked => "wifi_blocked",
        }
    }
}

pub struct AuthService<G> {
    db: Db,
    platform: Platform,
    security: Arc<Security>,
    grants: G,
    uploads: LocalUploadsStore,
    cfg: AuthConfig,
    limiter: Mutex<RateLimiter>,
}

impl<G: GrantsSource> AuthService<G> {
    pub fn new(
        db: Db,
        platform: Platform,
        security: Arc<Security>,
        grants: G,
        uploads: LocalUploadsStore,
        cfg: AuthConfig,
    ) -> Self {
        Self {
            db,
            platform,
            security,
            grants,
            uploads,
            cfg,
            limiter: Mutex::new(RateLimiter::default()),
        }
    }

    fn limiter(&self) -> std::sync::MutexGuard<'_, RateLimiter> {
        self.limiter.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn now() -> u64 {
        u64::try_from(now_ms()).unwrap_or(0)
    }

    pub fn signup_enabled(&self) -> bool {
        self.platform.multi_tenant() && self.cfg.signup_env_on
    }

    async fn conn(&self, company: CompanyRef) -> Res<trinity_db::TenantConn> {
        let t = self.db.tenant(company).await.map_err(|e| internal("tenant", e))?;
        t.acquire().await.map_err(|e| internal("acquire", e))
    }

    async fn grants_of(&self, company: CompanyRef, user: i32) -> Res<UserGrants> {
        self.grants
            .grants_for(company, user)
            .await
            .map_err(|e| internal("grantsFor", e))
    }

    // ---------------------------------------------------------------- người dùng

    async fn find_by_email(&self, company: CompanyRef, email: &str) -> Res<Option<UserRow>> {
        let mut c = self.conn(company).await?;
        // So khớp không phân biệt hoa/thường; trùng thì luôn lấy tài khoản tạo trước (id nhỏ nhất).
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{USER_SELECT} WHERE lower(u.email) = lower($1) ORDER BY u.id ASC LIMIT 1"
        )))
        .bind(email)
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| internal("tìm theo email", e))
    }

    async fn find_by_id(&self, company: CompanyRef, id: i32) -> Res<Option<UserRow>> {
        let mut c = self.conn(company).await?;
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{USER_SELECT} WHERE u.id = $1")))
            .bind(id)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| internal("tìm theo id", e))
    }

    async fn roles_of(&self, company: CompanyRef, user: i32) -> Res<Vec<Value>> {
        let mut c = self.conn(company).await?;
        let rows: Vec<(i32, String, bool)> = sqlx::query_as(
            "SELECT r.id, r.name, r.is_system FROM user_roles ur JOIN roles r ON r.id = ur.role_id \
             WHERE ur.user_id = $1 ORDER BY ur.id",
        )
        .bind(user)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| internal("vai trò", e))?;
        Ok(rows
            .into_iter()
            .map(|(id, name, is_system)| json!({ "id": id, "name": name, "is_system": is_system }))
            .collect())
    }

    async fn company_info(&self, company: CompanyRef) -> Res<Value> {
        let row = self
            .platform
            .company(company.id())
            .await
            .map_err(|e| internal("công ty", e))?;
        Ok(json!({
            "id": company.id(),
            "name": row.map(|r| r.name).unwrap_or_default(),
            "multi_tenant": self.platform.multi_tenant(),
        }))
    }

    /// Hình dạng chung của `/auth/me` và phản hồi đăng nhập/làm mới.
    async fn me_value(&self, company: CompanyRef, user: &UserRow) -> Res<Value> {
        let g = self.grants_of(company, user.id).await?;
        Ok(json!({
            "company": self.company_info(company).await?,
            "user": {
                "id": user.id,
                "email": user.email,
                "full_name": user.full_name,
                "avatar_url": user.avatar_url,
                "manager_id": user.manager_id,
            },
            "roles": self.roles_of(company, user.id).await?,
            "permissions": g.grants,
            "isAdmin": g.is_admin,
        }))
    }

    /// `GET /auth/me`.
    pub async fn get_me(&self, company: CompanyRef, user_id: i32) -> Res<Value> {
        let user = self
            .find_by_id(company, user_id)
            .await?
            .ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
        self.me_value(company, &user).await
    }

    async fn token_response(
        &self,
        company: CompanyRef,
        user: &UserRow,
        sid: Option<String>,
        session_id: String,
    ) -> Res<Value> {
        let cid = self.platform.multi_tenant().then(|| i64::from(company.id()));
        let now = Self::now() / 1000;
        let access = Claims::access(i64::from(user.id), &user.email, sid.clone(), cid, now);
        let refresh = Claims::refresh(i64::from(user.id), sid, cid, Some(session_id), now);
        let sign = |c: &Claims| jwt::sign(c, &self.cfg.jwt_secret).map_err(|e| internal("ký token", e));
        let mut out = Map::new();
        out.insert("access_token".to_owned(), Value::String(sign(&access)?));
        out.insert("refresh_token".to_owned(), Value::String(sign(&refresh)?));
        if let Value::Object(me) = self.me_value(company, user).await? {
            out.extend(me);
        }
        Ok(Value::Object(out))
    }

    // ---------------------------------------------------------------- nhật ký

    async fn log_login(
        &self,
        company: CompanyRef,
        user_id: Option<i32>,
        email: &str,
        success: bool,
        ip: Option<&str>,
        reason: LoginReason,
    ) {
        // Lỗi ghi nhật ký chỉ ghi log, không làm hỏng đăng nhập/đăng ký đã xong (như `log_password_change`).
        let res = async {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "INSERT INTO audit_logs (user_id, action, resource, ip_address, metadata) \
                 VALUES ($1, 'login', 'auth', $2, $3)",
            )
            .bind(user_id)
            .bind(ip)
            .bind(json!({ "email": email, "success": success, "reason": reason.as_str() }))
            .execute(&mut *c)
            .await
            .map_err(|e| internal("nhật ký đăng nhập", e))?;
            Ok::<(), AuthFail>(())
        }
        .await;
        if res.is_err() {
            tracing::error!("[auth] không ghi được nhật ký đăng nhập [reason={}]", reason.as_str());
        }
    }

    /// Lỗi ghi nhật ký đổi mật khẩu chỉ ghi log, không làm hỏng việc đổi (như bản TS).
    async fn log_password_change(&self, company: CompanyRef, user: i32, method: &str, ip: Option<&str>) {
        let res = async {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "INSERT INTO audit_logs (user_id, action, resource, resource_id, ip_address, metadata) \
                 VALUES ($1, 'password_change', 'users', $1, $2, $3)",
            )
            .bind(user)
            .bind(ip)
            .bind(json!({ "method": method, "actor_role": null, "target_user_id": user }))
            .execute(&mut *c)
            .await
            .map_err(|e| internal("nhật ký đổi mật khẩu", e))?;
            Ok::<(), AuthFail>(())
        }
        .await;
        if res.is_err() {
            tracing::error!("[auth] không ghi được nhật ký đổi mật khẩu [method={method} target={user}]");
        }
    }

    // ---------------------------------------------------------------- cấu hình (settings)

    async fn setting_on(&self, company: CompanyRef, key: &str) -> bool {
        let res = async {
            let mut c = self.conn(company).await?;
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
                .bind(key)
                .fetch_optional(&mut *c)
                .await
                .map_err(|e| internal("settings", e))
        }
        .await;
        // Lỗi đọc DB: coi là TẮT (không chặn đăng nhập, không tự bật tính năng vì lỗi hạ tầng).
        matches!(res, Ok(Some(v)) if v == "true")
    }

    async fn set_setting(&self, company: CompanyRef, key: &str, on: bool, user: i32, what: &str) -> Res<()> {
        let mut c = self.conn(company).await?;
        sqlx::query(
            "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()",
        )
        .bind(key)
        .bind(if on { "true" } else { "false" })
        .bind(user)
        .execute(&mut *c)
        .await
        .map_err(|e| {
            tracing::error!("[auth] {what} (user={user}): {e}");
            AuthFail::http(HttpError::nest(
                500,
                Some(
                    match key {
                        LOGIN_WIFI_KEY => "Không cập nhật được cấu hình đăng nhập theo wifi văn phòng",
                        _ => "Không cập nhật được cấu hình giới hạn 1 phiên đăng nhập",
                    }
                    .into(),
                ),
            ))
        })?;
        Ok(())
    }

    /// `GET /auth/settings/login-wifi-check`.
    pub async fn login_wifi_config(&self, company: CompanyRef) -> Value {
        json!({ "enabled": self.setting_on(company, LOGIN_WIFI_KEY).await, "envForced": self.cfg.login_wifi_env })
    }

    /// `PATCH /auth/settings/login-wifi-check` (quyền `settings.integrations` kiểm ở route).
    pub async fn update_login_wifi_config(&self, company: CompanyRef, enabled: bool, user: i32) -> Res<Value> {
        self.set_setting(company, LOGIN_WIFI_KEY, enabled, user, "updateLoginWifiCheckConfig")
            .await?;
        Ok(json!({ "enabled": enabled }))
    }

    /// `GET /auth/settings/single-session`.
    pub async fn single_session_config(&self, company: CompanyRef) -> Value {
        json!({ "enabled": self.setting_on(company, SINGLE_SESSION_KEY).await, "envForced": self.cfg.single_session_env })
    }

    /// `PATCH /auth/settings/single-session`.
    pub async fn update_single_session_config(&self, company: CompanyRef, enabled: bool, user: i32) -> Res<Value> {
        self.set_setting(company, SINGLE_SESSION_KEY, enabled, user, "updateSingleSessionConfig")
            .await?;
        Ok(json!({ "enabled": enabled }))
    }

    async fn login_wifi_active(&self, company: CompanyRef) -> bool {
        self.cfg.login_wifi_env || self.setting_on(company, LOGIN_WIFI_KEY).await
    }

    async fn single_session_active(&self, company: CompanyRef) -> bool {
        self.cfg.single_session_env || self.setting_on(company, SINGLE_SESSION_KEY).await
    }

    // ---------------------------------------------------------------- kiểm Wi-Fi

    /// Fail-open tuyệt đối: trả `(cho_qua, lý_do)`.
    async fn check_login_wifi(
        &self,
        company: CompanyRef,
        user: &UserRow,
        grants: &UserGrants,
        ip: Option<&str>,
        ip_trusted: bool,
    ) -> (bool, String) {
        if grants.can("settings.integrations") || bypass_listed(&self.cfg.login_wifi_bypass, user.id, &user.email) {
            return (true, "bypassed".to_owned());
        }
        if !self.targeted(company, user.id).await {
            return (true, "not_targeted".to_owned());
        }
        if !ip_trusted {
            return (true, "fail_open_untrusted_ip".to_owned());
        }
        let Some(ip) = ip.filter(|i| !is_unusable_login_ip(Some(i))) else {
            return (true, "fail_open_no_usable_ip".to_owned());
        };
        let res = async {
            let mut c = self.conn(company).await?;
            // Văn phòng demo không dùng để so IP.
            sqlx::query_scalar::<_, Option<Vec<String>>>(
                "SELECT ips FROM attendance_offices WHERE is_active = true AND is_demo = false",
            )
            .fetch_all(&mut *c)
            .await
            .map_err(|e| internal("văn phòng", e))
        }
        .await;
        let Ok(rows) = res else {
            return (true, "fail_open_error".to_owned());
        };
        let all: Vec<String> = rows.into_iter().flatten().flatten().collect();
        if all.is_empty() {
            return (true, "fail_open_no_offices_configured".to_owned());
        }
        if login_ip_matches_office(ip, &all) {
            (true, "matched".to_owned())
        } else {
            (false, "ip_mismatch:any_office".to_owned())
        }
    }

    /// Lỗi DB ⇒ không thuộc danh sách (cho qua).
    async fn targeted(&self, company: CompanyRef, user: i32) -> bool {
        let res = async {
            let mut c = self.conn(company).await?;
            let rows: Vec<(String, i32)> =
                sqlx::query_as("SELECT scope_type, target_user_id FROM login_wifi_check_targets")
                    .fetch_all(&mut *c)
                    .await
                    .map_err(|e| internal("danh sách áp dụng", e))?;
            if rows.is_empty() {
                return Ok(false);
            }
            let chain: Option<(Option<i32>, Option<i32>)> = sqlx::query_as(
                "SELECT u.manager_id, m.manager_id FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.id = $1",
            )
            .bind(user)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| internal("chuỗi quản lý", e))?;
            Ok::<bool, AuthFail>(
                chain.is_some_and(|(m, g)| is_targeted(user, m, g, &group_targets(&rows))),
            )
        }
        .await;
        res.unwrap_or(false)
    }

    // ---------------------------------------------------------------- đăng nhập

    fn norm_email(email: &str) -> String {
        email.trim().to_lowercase()
    }

    /// Đa công ty: email quyết định công ty; email lạ hoặc công ty ngưng hoạt động ở lại công ty 1 (không câu trả lời
    /// riêng để không dò được email).
    async fn company_of_email(&self, email: &str) -> Res<CompanyRef> {
        if !self.platform.multi_tenant() {
            return Ok(CompanyRef::DEFAULT);
        }
        let id = self
            .platform
            .company_for_email(email)
            .await
            .map_err(|e| internal("công ty theo email", e))?;
        let Some(id) = id else { return Ok(CompanyRef::DEFAULT) };
        Ok(self
            .platform
            .active_company(i64::from(id))
            .await
            .map_err(|e| internal("công ty", e))?
            .unwrap_or(CompanyRef::DEFAULT))
    }

    fn enforce_rate_limit(&self, key: &str) -> Option<u64> {
        let now = Self::now();
        let mut l = self.limiter();
        l.is_rate_limited(key, now).then(|| l.retry_after_seconds(key, now))
    }

    async fn rate_limited(&self, company: CompanyRef, email: &str, ip: Option<&str>, retry: u64) -> AuthFail {
        self.log_login(company, None, email, false, ip, LoginReason::RateLimited)
            .await;
        AuthFail(Box::new(AuthFailBody {
            error: HttpError::new(429, "Quá nhiều lần thử, vui lòng thử lại sau"),
            retry_after: Some(retry),
        }))
    }

    /// `POST /auth/login`.
    pub async fn login(&self, email: &str, password_in: &str, ip: Option<&str>, ip_trusted: bool) -> Res<Value> {
        let norm = Self::norm_email(email);
        let ip_s = ip.unwrap_or("unknown");
        let key = if ip_trusted {
            format!("login:{ip_s}:{norm}")
        } else {
            format!("login-untrusted:{ip_s}")
        };
        let slow = (!ip_trusted).then(|| format!("login-untrusted-email:{norm}"));
        let company = self.company_of_email(email).await?;
        if let Some(retry) = self.enforce_rate_limit(&key) {
            return Err(self.rate_limited(company, email, ip, retry).await);
        }
        if let Some(slow) = &slow {
            if let Some(retry) = self.enforce_rate_limit(slow) {
                return Err(self.rate_limited(company, email, ip, retry).await);
            }
            let n = self.limiter().attempts(slow, Self::now());
            let delay = untrusted_delay_ms(n);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
        let fail = |this: &Self| {
            let now = Self::now();
            let mut l = this.limiter();
            l.record_attempt(&key, now);
            if let Some(s) = &slow {
                l.record_attempt(s, now);
            }
        };
        let Some(user) = self.find_by_email(company, email).await? else {
            // Email lạ vẫn tốn một lần băm: thời gian trả lời không phân biệt được email có tài khoản hay không.
            password::verify(password_in.to_owned(), DUMMY_HASH.to_owned()).await;
            fail(self);
            self.log_login(company, None, email, false, ip, LoginReason::EmailNotFound)
                .await;
            return Err(unauthorized("Email hoặc mật khẩu không đúng"));
        };
        if !password::verify(password_in.to_owned(), user.password_hash.clone()).await {
            fail(self);
            self.log_login(company, Some(user.id), email, false, ip, LoginReason::BadPassword)
                .await;
            return Err(unauthorized("Email hoặc mật khẩu không đúng"));
        }
        if user.status != "active" {
            fail(self);
            self.log_login(company, Some(user.id), email, false, ip, LoginReason::AccountLocked)
                .await;
            return Err(unauthorized("Tài khoản đã bị khoá"));
        }
        if self.login_wifi_active(company).await {
            let grants = self.grants_of(company, user.id).await?;
            let (allowed, reason) = self.check_login_wifi(company, &user, &grants, ip, ip_trusted).await;
            if !allowed {
                tracing::warn!(
                    "[login-wifi-check] BLOCKED user={} email={email} ip={} reason={reason}",
                    user.id,
                    ip.unwrap_or("unknown")
                );
                self.log_login(company, Some(user.id), email, false, ip, LoginReason::WifiBlocked)
                    .await;
                return Err(unauthorized(
                    "Bạn đang không kết nối wifi của văn phòng công ty. Vui lòng kết nối wifi tại một trong các văn phòng rồi đăng nhập lại.",
                ));
            }
            if reason.starts_with("fail_open") {
                tracing::debug!(
                    "[login-wifi-check] fail-open user={} email={email} reason={reason}",
                    user.id
                );
            }
        }
        {
            let mut l = self.limiter();
            l.reset_attempts(&key);
            if let Some(s) = &slow {
                l.reset_attempts(s);
            }
        }
        self.log_login(company, Some(user.id), email, true, ip, LoginReason::Ok)
            .await;
        // Đăng nhập thành công gỡ chặn: vừa đăng xuất/đổi vai trò rồi đăng nhập lại phải vào được ngay.
        self.security.remove_user(company.id(), user.id).await;
        let sid = if self.single_session_active(company).await {
            Some(self.security.start_session(company.id(), user.id).await)
        } else {
            None
        };
        self.token_response(company, &user, sid, uuid::Uuid::new_v4().to_string())
            .await
    }

    // ---------------------------------------------------------------- làm mới, đăng xuất

    fn verify_refresh(&self, token: &str) -> Res<Claims> {
        let claims = jwt::verify(token, &self.cfg.jwt_secret)
            .map_err(|_| unauthorized("Refresh token không hợp lệ hoặc đã hết hạn"))?;
        if !claims.is_refresh() {
            return Err(unauthorized("Token không hợp lệ"));
        }
        Ok(claims)
    }

    /// `POST /auth/refresh`.
    pub async fn refresh(&self, refresh_token: &str) -> Res<Value> {
        let claims = self.verify_refresh(refresh_token)?;
        let cid = claims.company_id();
        let company = if self.platform.multi_tenant() {
            // Token quyết định công ty, bất kể gợi ý nào ở route công khai.
            self.platform
                .active_company(cid)
                .await
                .map_err(|e| internal("công ty", e))?
                .ok_or_else(|| unauthorized("Công ty của tài khoản này không còn hoạt động"))?
        } else if cid != 1 {
            return Err(unauthorized("Refresh token không hợp lệ hoặc đã hết hạn"));
        } else {
            CompanyRef::DEFAULT
        };
        let expired = || unauthorized("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại");
        let user = i32::try_from(claims.sub).ok();
        let user = match user {
            Some(id) => self.find_by_id(company, id).await?,
            None => None,
        };
        let Some(user) = user.filter(|u| u.status == "active") else {
            return Err(unauthorized("Tài khoản không hợp lệ hoặc đã bị khoá"));
        };
        if self.security.is_blacklisted(company.id(), user.id) {
            return Err(expired());
        }
        // Token cấp trước lần đổi/reset mật khẩu gần nhất thì mất hiệu lực.
        // So theo giây: token cấp ngay sau lần đổi (cùng giây, `iat` chỉ có độ phân giải giây) vẫn hợp lệ.
        if let Some(after) = user.tokens_valid_after
            && claims.iat.unwrap_or(0.0).floor() < after.timestamp() as f64
        {
            return Err(expired());
        }
        if let Some(jti) = &claims.jti {
            let mut c = self.conn(company).await?;
            let revoked: Option<String> =
                sqlx::query_scalar("SELECT session_id FROM revoked_sessions WHERE session_id = $1")
                    .bind(jti)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(|e| internal("phiên thu hồi", e))?;
            if revoked.is_some() {
                return Err(expired());
            }
        }
        if !self
            .security
            .is_current_session(company.id(), user.id, claims.sid.as_deref())
        {
            return Err(unauthorized(
                "Tài khoản vừa đăng nhập ở nơi khác, phiên này đã bị đăng xuất",
            ));
        }
        // Giữ nguyên `sid` của phiên: làm mới chỉ gia hạn token, không phải đăng nhập mới.
        let session = claims.jti.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        self.token_response(company, &user, claims.sid, session).await
    }

    /// `POST /auth/logout`: thu hồi theo id phiên (mọi token đã xoay vòng của phiên cũng chết).
    pub async fn logout(&self, company: CompanyRef, user_id: i32, refresh_token: Option<&str>) -> Res<Value> {
        if let Some(token) = refresh_token
            && let Ok(claims) = self.verify_refresh(token)
            && claims.sub == i64::from(user_id)
            && let Some(jti) = &claims.jti
        {
            // Thiếu `exp` thì giữ tới hết hạn refresh mặc định (như TS), không để 1970 rồi bị dọn ngay.
            let exp = claims
                .exp
                .unwrap_or_else(|| (Self::now() / 1000 + jwt::REFRESH_TTL_SECS) as f64);
            let mut c = self.conn(company).await?;
            sqlx::query(
                "INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ($1, $2, to_timestamp($3)) \
                 ON CONFLICT (session_id) DO NOTHING",
            )
            .bind(jti)
            .bind(user_id)
            .bind(exp)
            .execute(&mut *c)
            .await
            .map_err(|e| internal("thu hồi phiên", e))?;
            sqlx::query("DELETE FROM revoked_sessions WHERE expires_at < now()")
                .execute(&mut *c)
                .await
                .map_err(|e| internal("dọn phiên thu hồi", e))?;
        }
        self.security.blacklist_user(company.id(), user_id).await;
        self.security.clear_user(company.id(), user_id).await;
        Ok(json!({ "message": "Đăng xuất thành công" }))
    }

    // ---------------------------------------------------------------- mật khẩu, hồ sơ

    async fn user_for_password(&self, company: CompanyRef, id: i32, current: &str) -> Res<()> {
        let user = self
            .find_by_id(company, id)
            .await?
            .ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
        if !password::verify(current.to_owned(), user.password_hash).await {
            return Err(unauthorized("Mật khẩu hiện tại không đúng"));
        }
        Ok(())
    }

    async fn store_password(&self, company: CompanyRef, id: i32, new_password: &str) -> Res<()> {
        let hash = password::hash(new_password.to_owned())
            .await
            .map_err(|e| internal("băm mật khẩu", e))?;
        let mut c = self.conn(company).await?;
        sqlx::query(
            "UPDATE users SET password_hash = $1, password_updated_at = now(), tokens_valid_after = now(), \
             updated_at = now() WHERE id = $2",
        )
        .bind(hash)
        .bind(id)
        .execute(&mut *c)
        .await
        .map_err(|e| internal("đổi mật khẩu", e))?;
        Ok(())
    }

    /// `PATCH /auth/password` (mật khẩu mới tối thiểu 8 ký tự kiểm ở lớp route).
    pub async fn change_password(
        &self,
        company: CompanyRef,
        user_id: i32,
        current: &str,
        new_password: &str,
        ip: Option<&str>,
    ) -> Res<Value> {
        self.user_for_password(company, user_id, current).await?;
        self.store_password(company, user_id, new_password).await?;
        self.security.blacklist_user(company.id(), user_id).await;
        self.log_password_change(company, user_id, "self_change", ip).await;
        Ok(json!({ "message": "Đổi mật khẩu thành công" }))
    }

    /// `POST /auth/reset-password`: tự đặt lại bằng mật khẩu ngẫu nhiên, vẫn phải nhập mật khẩu hiện tại.
    pub async fn reset_my_password(
        &self,
        company: CompanyRef,
        user_id: i32,
        current: &str,
        ip: Option<&str>,
    ) -> Res<Value> {
        self.user_for_password(company, user_id, current).await?;
        let new_password = generate_password(12);
        self.store_password(company, user_id, &new_password).await?;
        self.security.blacklist_user(company.id(), user_id).await;
        self.log_password_change(company, user_id, "self_reset", ip).await;
        Ok(json!({ "newPassword": new_password, "message": "Reset mật khẩu thành công" }))
    }

    /// `PATCH /auth/profile`: chỉ ghi trường có gửi (tên, SĐT; định dạng kiểm ở lớp route).
    pub async fn update_profile(
        &self,
        company: CompanyRef,
        user_id: i32,
        full_name: Option<&str>,
        phone: Patch<&str>,
    ) -> Res<Value> {
        self.find_by_id(company, user_id)
            .await?
            .ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
        if full_name.is_none() && phone == Patch::Keep {
            return Ok(json!({ "message": "Không có thông tin cần cập nhật" }));
        }
        let mut c = self.conn(company).await?;
        sqlx::query(
            "UPDATE users SET full_name = COALESCE($1, full_name), \
             phone = CASE WHEN $2 THEN $3 ELSE phone END, updated_at = now() WHERE id = $4",
        )
        .bind(full_name)
        .bind(phone != Patch::Keep)
        .bind(match phone {
            Patch::Set(p) => Some(p),
            _ => None,
        })
        .bind(user_id)
        .execute(&mut *c)
        .await
        .map_err(|e| internal("cập nhật hồ sơ", e))?;
        Ok(json!({ "message": "Cập nhật hồ sơ thành công" }))
    }

    // ---------------------------------------------------------------- avatar

    /// Công ty 1 giữ `avatars/`; công ty khác `c<id>/avatars/`.
    fn avatar_subdir(company: CompanyRef) -> String {
        if company.id() == 1 {
            "avatars/".to_owned()
        } else {
            format!("c{}/avatars/", company.id())
        }
    }

    /// `POST /auth/profile/avatar`: JPEG 200x200 `cover`, ảnh cũ chỉ xoá sau khi ảnh mới đã lưu và DB đã trỏ sang.
    pub async fn upload_avatar(&self, company: CompanyRef, user_id: i32, file: Option<Upload>) -> Res<Value> {
        self.find_by_id(company, user_id)
            .await?
            .ok_or_else(|| HttpError::not_found("Không tìm thấy người dùng"))?;
        let file = file.ok_or_else(|| HttpError::bad_request("Vui lòng chọn ảnh để upload"))?;
        if !["image/jpeg", "image/jpg", "image/png", "image/webp"].contains(&file.content_type.as_str()) {
            return Err(HttpError::bad_request(format!(
                "Định dạng ảnh không hợp lệ: {}. Chỉ chấp nhận: JPG, PNG, WebP.",
                file.content_type
            ))
            .into());
        }
        if file.bytes.len() > MAX_AVATAR_BYTES {
            return Err(HttpError::bad_request(format!(
                "Ảnh quá lớn: {:.1}MB. Tối đa 5MB.",
                file.bytes.len() as f64 / 1024.0 / 1024.0
            ))
            .into());
        }
        // `content_type` do client khai: tệp giả ảnh ⇒ 400, không phải 500.
        let jpeg = trinity_docgen::image::avatar_jpeg(&file.bytes)
            .map_err(|_| HttpError::bad_request("Tệp không phải ảnh hợp lệ"))?;
        let subdir = Self::avatar_subdir(company);
        let rel = format!("{subdir}{user_id}_{}.jpg", now_ms());
        self.uploads
            .save(&rel, &jpeg.bytes, "image/jpeg")
            .await
            .map_err(|e| internal("lưu avatar", e))?;
        let url = format!("{UPLOADS_URL_PREFIX}{rel}");
        let mut c = self.conn(company).await?;
        // Khoá dòng và lấy đúng avatar đang có tại thời điểm thay: hai lượt đổi đồng thời không xoá nhầm ảnh của nhau.
        let previous: Option<Option<String>> = sqlx::query_scalar(
            "WITH old AS (SELECT avatar_url FROM users WHERE id = $2 FOR UPDATE) \
             UPDATE users SET avatar_url = $1, updated_at = now() FROM old WHERE users.id = $2 RETURNING old.avatar_url",
        )
        .bind(&url)
        .bind(user_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| internal("cập nhật avatar", e))?;
        let previous = previous.flatten();
        // Chỉ thư mục avatar của công ty này; URL trỏ vào tệp của công ty khác không bao giờ bị xoá.
        if let Some(old) = uploads_rel_path_from_url(previous.as_deref())
            && old.starts_with(&subdir)
        {
            self.uploads.remove(old).await;
        }
        Ok(json!({ "avatar_url": url, "message": "Cập nhật ảnh đại diện thành công" }))
    }
}

/// Mật khẩu ngẫu nhiên: `length - 1` ký tự không nhầm lẫn rồi 1 ký tự đặc biệt (như `generatePassword` của bản TS).
/// Byte lấy từ bộ sinh ngẫu nhiên của hệ điều hành (như `crypto.randomBytes`). `length = 0` ⇒ chuỗi rỗng.
pub fn generate_password(length: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    const SPECIAL: &[u8] = b"@#$%&*!";
    if length == 0 {
        return String::new();
    }
    let mut bytes = vec![0u8; length];
    if let Err(e) = getrandom::fill(&mut bytes) {
        // Không có nguồn ngẫu nhiên an toàn thì không tạo mật khẩu yếu: dừng như `randomBytes` ném lỗi.
        panic!("không đọc được nguồn ngẫu nhiên của hệ điều hành: {e}");
    }
    let mut out = String::with_capacity(length);
    for b in &bytes[..length - 1] {
        out.push(char::from(CHARS[usize::from(*b) % CHARS.len()]));
    }
    out.push(char::from(SPECIAL[usize::from(bytes[length - 1]) % SPECIAL.len()]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mat_khau_ngau_nhien_dung_dang() {
        for _ in 0..50 {
            let p = generate_password(12);
            assert_eq!(p.chars().count(), 12);
            assert!(b"@#$%&*!".contains(&(p.as_bytes()[11])));
            assert!(
                p[..11]
                    .bytes()
                    .all(|b| b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789".contains(&b))
            );
        }
        assert_ne!(generate_password(12), generate_password(12));
        assert_eq!(generate_password(0), "");
        assert_eq!(generate_password(1).len(), 1);
    }

    #[test]
    fn cau_hinh_tu_env() {
        let env = |k: &str| match k {
            "JWT_SECRET" => Some("s".to_owned()),
            "SIGNUP_ENABLED" => Some("false".to_owned()),
            "LOGIN_WIFI_CHECK_ENABLED" => Some("true".to_owned()),
            _ => None,
        };
        let c = AuthConfig::from_lookup(env).unwrap();
        assert!(!c.signup_env_on && c.login_wifi_env && !c.single_session_env);
        assert!(AuthConfig::from_lookup(|_| None).is_none());
    }
}
