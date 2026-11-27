//! Client OAuth: đăng ký động (RFC 7591), CIMD (client_id là URL metadata), tra cứu và xác thực (`oauth-clients.service.ts`).
//!
//! Nhiều công ty: client là MỘT sổ đăng ký chung nằm ở schema của công ty 1 (đăng ký và khám phá CIMD xảy ra trước khi
//! biết người dùng thuộc công ty nào, và client không phải dữ liệu công ty); mã và token thì ở schema từng công ty.
//! Mọi đọc/ghi `oauth_clients` đi qua đây nên luôn trúng sổ chung.

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::FromRow;
use trinity_db::CompanyRef;
use trinity_http::outbound::safe_get::safe_get_json;
use url::Url;

use crate::ctx::OauthCtx;
use crate::error::{OAuthError, R};
use crate::util::{js_len, js_trim};

const MAX_REDIRECTS: usize = 10;
const MAX_DCR_CLIENTS: i64 = 5000;
const CIMD_MIN_TTL_SEC: u64 = 5 * 60;
const CIMD_MAX_TTL_SEC: u64 = 24 * 60 * 60;
const CIMD_DEFAULT_TTL_SEC: u64 = 60 * 60;
pub const MAX_CLIENT_ID_LEN: usize = 512;
const LAST_USED_THROTTLE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, FromRow)]
pub struct OauthClient {
    pub id: i32,
    pub client_id: String,
    pub kind: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
    pub logo_uri: Option<String>,
    pub client_uri: Option<String>,
    pub token_endpoint_auth_method: String,
    pub client_secret_hash: Option<String>,
    pub metadata_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

const COLS: &str = "id, client_id, kind, name, COALESCE(redirect_uris, '{}') AS redirect_uris, logo_uri, client_uri, \
                    token_endpoint_auth_method, client_secret_hash, metadata_expires_at, created_at, last_used_at";

/// Ký tự điều khiển và điều khiển chiều chữ (bidi): bỏ để tên client không đánh lừa mắt người đọc ở màn đồng ý.
fn hidden(c: char) -> bool {
    c <= '\u{1f}'
        || c == '\u{7f}'
        || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// `str(v, max)`: chuỗi ≤ `max` đơn vị UTF-16, bỏ ký tự ẩn, cắt khoảng trắng; rỗng ⇒ `None`.
fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    if js_len(s) > max {
        return None;
    }
    let clean: String = s.chars().filter(|c| !hidden(*c)).collect();
    let t = js_trim(&clean);
    (!t.is_empty()).then(|| t.to_owned())
}

/// URL ảnh/trang chỉ để HIỂN THỊ: bắt buộc https, không userinfo.
fn https_url(v: Option<&Value>) -> Option<String> {
    let s = text(v, 1024)?;
    let u = Url::parse(&s).ok()?;
    (u.scheme() == "https" && u.username().is_empty() && u.password().is_none()).then(|| u.to_string())
}

/// `http://` chỉ được nhận khi môi trường dev/test + cờ tường minh (cùng điều kiện nới SSRF).
pub fn is_cimd_client_id(id: &str, allow_private: bool) -> bool {
    id.starts_with("https://") || (allow_private && id.starts_with("http://"))
}

/// `client_id` kiểu URL hợp lệ cho CIMD: https, có path (khác "/"), không fragment/userinfo/dot-segment, đã chuẩn hoá.
pub fn parse_cimd_client_id(id: &str, allow_private: bool) -> R<Url> {
    let invalid = |m: &str| OAuthError::with_status("invalid_client", m, 401);
    let u = Url::parse(id).map_err(|_| invalid("client_id không hợp lệ"))?;
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && allow_private);
    let bad = js_len(id) > MAX_CLIENT_ID_LEN
        || !scheme_ok
        || u.fragment().is_some_and(|f| !f.is_empty())
        || id.contains('#')
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() == "/"
        || u.path().split('/').any(|s| s == "." || s == "..")
        || u.as_str() != id;
    if bad {
        return Err(invalid("client_id (URL metadata) không hợp lệ"));
    }
    Ok(u)
}

fn validate_redirect_list(raw: Option<&Value>) -> R<Vec<String>> {
    let range = format!("redirect_uris phải có từ 1 đến {MAX_REDIRECTS} địa chỉ");
    let arr = match raw.and_then(Value::as_array) {
        Some(a) if !a.is_empty() && a.len() <= MAX_REDIRECTS => a,
        _ => return Err(OAuthError::new("invalid_redirect_uri", &range)),
    };
    let mut out: Vec<String> = Vec::new();
    for v in arr {
        let s = v
            .as_str()
            .ok_or_else(|| OAuthError::new("invalid_redirect_uri", "redirect_uri không hợp lệ"))?;
        crate::redirect::parse_redirect_uri(s)?;
        if !out.iter().any(|x| x == s) {
            out.push(s.to_owned());
        }
    }
    Ok(out)
}

impl OauthCtx {
    async fn registry_conn(&self) -> R<trinity_db::TenantConn> {
        self.conn(CompanyRef::DEFAULT).await
    }

    /// RFC 7591: đăng ký động. Giới hạn theo IP làm ở route; ở đây chặn trần tổng số client DCR.
    pub async fn register_client(&self, body: &Map<String, Value>) -> R<Value> {
        let redirect_uris = validate_redirect_list(body.get("redirect_uris"))?;
        let method = match body.get("token_endpoint_auth_method") {
            None => "none",
            Some(Value::String(m)) if m == "none" || m == "client_secret_post" => m.as_str(),
            _ => {
                return Err(OAuthError::new(
                    "invalid_client_metadata",
                    "token_endpoint_auth_method chỉ hỗ trợ none hoặc client_secret_post",
                ));
            }
        };
        let grants: Vec<Value> = match body.get("grant_types") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![json!("authorization_code"), json!("refresh_token")],
        };
        if grants
            .iter()
            .any(|g| !matches!(g.as_str(), Some("authorization_code" | "refresh_token")))
        {
            return Err(OAuthError::new(
                "invalid_client_metadata",
                "grant_types chỉ hỗ trợ authorization_code và refresh_token",
            ));
        }
        if let Some(rt) = body.get("response_types")
            && !rt
                .as_array()
                .is_some_and(|a| a.iter().all(|r| r.as_str() == Some("code")))
        {
            return Err(OAuthError::new(
                "invalid_client_metadata",
                "response_types chỉ hỗ trợ code",
            ));
        }
        let mut c = self.registry_conn().await?;
        let dcr: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_clients WHERE kind = 'dcr'")
            .fetch_one(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("đếm client", e))?;
        if dcr >= MAX_DCR_CLIENTS {
            return Err(OAuthError::with_status(
                "temporarily_unavailable",
                "Máy chủ đang tạm dừng đăng ký client mới",
                503,
            ));
        }
        let name = text(body.get("client_name"), 200).unwrap_or_else(|| "Ứng dụng chưa đặt tên".to_owned());
        let scope = body.get("scope").and_then(Value::as_str).map(|s| {
            crate::util::split_js_space(s)
                .into_iter()
                .filter(|x| crate::config::ADVERTISED_SCOPES.contains(x))
                .collect::<Vec<_>>()
                .join(" ")
        });
        let client_id = format!("trn_c_{}", self.random(18)?);
        let secret = (method == "client_secret_post")
            .then(|| self.random(32).map(|r| format!("trn_s_{r}")))
            .transpose()?;
        let metadata = json!({ "grant_types": grants, "scope": scope.clone().unwrap_or_default() });
        let created: DateTime<Utc> = sqlx::query_scalar(
            "INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, logo_uri, client_uri, \
             token_endpoint_auth_method, client_secret_hash, metadata) \
             VALUES ($1, 'dcr', $2, $3, $4, $5, $6, $7, $8::text::jsonb) RETURNING created_at",
        )
        .bind(&client_id)
        .bind(&name)
        .bind(&redirect_uris)
        .bind(https_url(body.get("logo_uri")))
        .bind(https_url(body.get("client_uri")))
        .bind(method)
        .bind(secret.as_deref().map(crate::crypto::sha256_hex))
        .bind(trinity_kernel::json::js_json(&metadata))
        .fetch_one(&mut *c)
        .await
        .map_err(|e| OAuthError::internal("tạo client", e))?;
        let mut out = Map::new();
        out.insert("client_id".into(), json!(client_id));
        out.insert("client_id_issued_at".into(), json!(created.timestamp()));
        if let Some(s) = &secret {
            out.insert("client_secret".into(), json!(s));
            out.insert("client_secret_expires_at".into(), json!(0));
        }
        out.insert("redirect_uris".into(), json!(redirect_uris));
        out.insert("client_name".into(), json!(name));
        out.insert("grant_types".into(), Value::Array(grants));
        out.insert("response_types".into(), json!(["code"]));
        out.insert("token_endpoint_auth_method".into(), json!(method));
        if let Some(s) = scope.filter(|s| !s.is_empty()) {
            out.insert("scope".into(), json!(s));
        }
        Ok(Value::Object(out))
    }

    async fn find_client(&self, client_id: &str) -> R<Option<OauthClient>> {
        let mut c = self.registry_conn().await?;
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {COLS} FROM oauth_clients WHERE client_id = $1"
        )))
        .bind(client_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| OAuthError::internal("tra client", e))
    }

    /// Tra client cho màn đồng ý (`allow_fetch`: CIMD được tải/làm mới) hoặc cho endpoint token/revoke (`false`: CHỈ đọc bản
    /// đã lưu, endpoint công khai không bao giờ kích hoạt tải URL ngoài).
    pub async fn resolve_client(&self, client_id: &str, allow_fetch: bool) -> R<OauthClient> {
        let invalid = |m: &str| OAuthError::with_status("invalid_client", m, 401);
        if client_id.is_empty() || js_len(client_id) > MAX_CLIENT_ID_LEN {
            return Err(invalid("client_id không hợp lệ"));
        }
        let row = self.find_client(client_id).await?;
        let allow_private = self.config.policy.allow_private;
        if !is_cimd_client_id(client_id, allow_private) {
            return match row {
                Some(r) if r.kind == "dcr" => Ok(r),
                _ => Err(invalid("client_id không tồn tại")),
            };
        }
        if !allow_fetch {
            return match row {
                Some(r) if r.kind == "cimd" => Ok(r),
                _ => Err(invalid("client_id không tồn tại")),
            };
        }
        let url = parse_cimd_client_id(client_id, allow_private)?;
        let host = url.host_str().unwrap_or("").to_lowercase();
        if !self.config.cimd_hosts.is_empty() && !self.config.cimd_hosts.contains(&host) {
            return Err(invalid("Tên miền client không nằm trong danh sách cho phép"));
        }
        if let Some(r) = row
            && r.metadata_expires_at.is_some_and(|t| t > Utc::now())
        {
            return Ok(r);
        }
        self.fetch_cimd(client_id).await
    }

    async fn fetch_cimd(&self, client_id: &str) -> R<OauthClient> {
        let invalid = |m: &str| OAuthError::with_status("invalid_client", m, 401);
        let Some(opts) = &self.safe_get else {
            return Err(invalid("Không tải được metadata của client"));
        };
        let res = safe_get_json(client_id, opts).await.map_err(|e| {
            tracing::warn!("CIMD fetch lỗi ({}) cho client_id có độ dài {}", e.0, js_len(client_id));
            invalid("Không tải được metadata của client")
        })?;
        let doc = res
            .json
            .as_object()
            .filter(|d| d.get("client_id").and_then(Value::as_str) == Some(client_id))
            .ok_or_else(|| invalid("Metadata client không hợp lệ: client_id không khớp URL"))?;
        let method = doc.get("token_endpoint_auth_method");
        if let Some(m) = method
            && !matches!(m.as_str(), Some("none" | "private_key_jwt"))
        {
            return Err(invalid("CIMD không được dùng client secret"));
        }
        let redirect_uris = validate_redirect_list(doc.get("redirect_uris"))
            .map_err(|_| invalid("Metadata client có redirect_uris không hợp lệ"))?;
        let ttl = res
            .max_age_sec
            .unwrap_or(CIMD_DEFAULT_TTL_SEC)
            .clamp(CIMD_MIN_TTL_SEC, CIMD_MAX_TTL_SEC);
        let host = Url::parse(client_id)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        let name = text(doc.get("client_name"), 200).unwrap_or(host);
        let grants = match doc.get("grant_types") {
            Some(Value::Array(a)) => Value::Array(a.iter().filter(|g| g.is_string()).take(5).cloned().collect()),
            _ => Value::Null,
        };
        let metadata = json!({
            "client_id": client_id,
            "grant_types": grants,
            "token_endpoint_auth_method": method.cloned().unwrap_or_else(|| json!("none")),
        });
        let now = Utc::now();
        let expires = now + chrono::Duration::seconds(i64::try_from(ttl).unwrap_or(i64::MAX / 1000));
        let mut c = self.registry_conn().await?;
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, logo_uri, client_uri, \
             token_endpoint_auth_method, metadata, metadata_fetched_at, metadata_expires_at) \
             VALUES ($1, 'cimd', $2, $3, $4, $5, 'none', $6::text::jsonb, $7, $8) \
             ON CONFLICT (client_id) DO UPDATE SET kind = 'cimd', name = EXCLUDED.name, \
             redirect_uris = EXCLUDED.redirect_uris, logo_uri = EXCLUDED.logo_uri, client_uri = EXCLUDED.client_uri, \
             token_endpoint_auth_method = 'none', metadata = EXCLUDED.metadata, \
             metadata_fetched_at = EXCLUDED.metadata_fetched_at, metadata_expires_at = EXCLUDED.metadata_expires_at \
             RETURNING {COLS}"
        )))
        .bind(client_id)
        .bind(&name)
        .bind(&redirect_uris)
        .bind(https_url(doc.get("logo_uri")))
        .bind(https_url(doc.get("client_uri")))
        .bind(trinity_kernel::json::js_json(&metadata))
        .bind(now)
        .bind(expires)
        .fetch_one(&mut *c)
        .await
        .map_err(|e| OAuthError::internal("lưu CIMD", e))
    }

    /// Xác thực client ở endpoint token/revoke: public ⇒ chỉ cần tồn tại; `client_secret_post` ⇒ phải đúng secret.
    pub async fn authenticate_client(&self, client_id: &str, secret: Option<&str>) -> R<OauthClient> {
        let client = self.resolve_client(client_id, false).await?;
        if client.token_endpoint_auth_method == "client_secret_post" {
            let ok = secret.is_some_and(|s| !s.is_empty())
                && client
                    .client_secret_hash
                    .as_deref()
                    .is_some_and(|h| crate::crypto::safe_equal(&crate::crypto::sha256_hex(secret.unwrap_or("")), h));
            if !ok {
                return Err(OAuthError::with_status("invalid_client", "Sai client_secret", 401));
            }
        }
        Ok(client)
    }

    /// Ghi `last_used_at` (tối đa 5 phút một lần); lỗi bỏ qua.
    pub async fn touch_client(&self, client: &OauthClient) {
        let last = client.last_used_at.map_or(0, |t| t.timestamp_millis());
        if Utc::now().timestamp_millis() - last < LAST_USED_THROTTLE_MS {
            return;
        }
        if let Ok(mut c) = self.registry_conn().await {
            let _ = sqlx::query("UPDATE oauth_clients SET last_used_at = now() WHERE id = $1")
                .bind(client.id)
                .execute(&mut *c)
                .await;
        }
    }
}
