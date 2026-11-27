//! Đổi mã, xoay refresh, thu hồi và xác minh access token (`oauth-token.service.ts`).
//!
//! Mã và token mang tiền tố công ty (`c<id>.`, công ty 1 không có) nên endpoint công khai biết tra ở schema nào. Chỉ băm
//! SHA-256 được lưu, không bao giờ lưu giá trị gốc. Mọi bước DB lấy kết nối riêng rồi trả ngay: không giữ kết nối trong khi
//! gọi `PermissionService` (cũng xin kết nối).

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::FromRow;
use trinity_db::CompanyRef;
use trinity_integrations::audit::AuditStatus;
use trinity_rbac::can;

use crate::config::{ACCESS_TTL_SEC, OAUTH_SCOPES, REFRESH_TTL_MS, is_canonical_resource};
use crate::crypto::{is_code_verifier, pkce_s256, safe_equal, sha256_hex};
use crate::ctx::OauthCtx;
use crate::error::{OAuthError, R, invalid_grant};
use crate::util::split_js_space;

const LAST_USED_THROTTLE_MS: i64 = 60_000;
const REFRESH_GRACE_MS: i64 = 10_000;

fn s<'a>(body: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str).filter(|v| !v.is_empty())
}

#[derive(Debug, FromRow)]
struct CodeRow {
    client_id: String,
    user_id: i32,
    redirect_uri: String,
    code_challenge: String,
    scopes: Vec<String>,
    resource: String,
    family_id: String,
    used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct TokenRow {
    id: i64,
    client_id: String,
    user_id: i32,
    scopes: Vec<String>,
    resource: String,
    family_id: String,
    refresh_expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct UsedRow {
    refresh_used_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct AccessRow {
    id: i64,
    user_id: i32,
    client_id: String,
    scopes: Vec<String>,
    resource: String,
    family_id: String,
    access_expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
}

/// Access token đã xác minh (cho MCP, M39).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAccessToken {
    pub company: CompanyRef,
    pub token_id: i64,
    pub user_id: i32,
    pub email: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub family_id: String,
}

impl OauthCtx {
    pub async fn token(&self, body: &Map<String, Value>) -> R<Value> {
        let grant = s(body, "grant_type");
        if !matches!(grant, Some("authorization_code" | "refresh_token")) {
            return Err(OAuthError::new(
                "unsupported_grant_type",
                "Chỉ hỗ trợ authorization_code và refresh_token",
            ));
        }
        let is_code = grant == Some("authorization_code");
        let client = self
            .authenticate_client(s(body, "client_id").unwrap_or(""), s(body, "client_secret"))
            .await?;
        // Nhiều công ty: mã / refresh token tự nêu công ty; mọi tra cứu bên dưới chạy ở schema của công ty đó.
        let secret = s(body, if is_code { "code" } else { "refresh_token" });
        let company = match secret {
            Some(raw) => self.token_company(raw).await.ok_or_else(|| {
                invalid_grant(if is_code {
                    "Mã uỷ quyền không hợp lệ, đã hết hạn hoặc đã dùng"
                } else {
                    "refresh_token không hợp lệ"
                })
            })?,
            None => CompanyRef::DEFAULT,
        };
        let out = if is_code {
            self.exchange_code(company, &client, body).await?
        } else {
            self.refresh(company, &client, body).await?
        };
        self.touch_client(&client).await;
        Ok(out)
    }

    /// Người dùng còn dùng được (chưa khoá/xoá) VÀ còn quyền nối AI: kiểm MỖI lần đổi mã/refresh.
    async fn user_still_allowed(&self, company: CompanyRef, user_id: i32) -> R<bool> {
        let row: Option<(String, Option<DateTime<Utc>>)> = {
            let mut c = self.conn(company).await?;
            sqlx::query_as("SELECT status, deleted_at FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(&mut *c)
                .await
                .map_err(|e| OAuthError::internal("người dùng", e))?
        };
        let Some((status, deleted)) = row else { return Ok(false) };
        if deleted.is_some() || status != "active" {
            return Ok(false);
        }
        let g = self
            .perms
            .grants_for(company, user_id)
            .await
            .map_err(|e| OAuthError::internal("quyền", e))?;
        Ok(g.is_admin || can(&g.grants, "integrations.ai_connect", None))
    }

    pub async fn revoke_family(&self, company: CompanyRef, family_id: &str) -> R<()> {
        let mut c = self.conn(company).await?;
        sqlx::query("UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL")
            .bind(family_id)
            .execute(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("thu hồi chuỗi", e))?;
        Ok(())
    }

    async fn exchange_code(
        &self,
        company: CompanyRef,
        client: &crate::clients::OauthClient,
        body: &Map<String, Value>,
    ) -> R<Value> {
        let (Some(code), Some(verifier)) = (s(body, "code"), s(body, "code_verifier")) else {
            return Err(OAuthError::new("invalid_request", "Thiếu code hoặc code_verifier"));
        };
        let hash = sha256_hex(code);
        let msg = "Mã uỷ quyền không hợp lệ, đã hết hạn hoặc đã dùng";
        // Nhận mã NGUYÊN TỬ (chỉ một request thắng); kể cả khi PKCE sai mã vẫn bị đốt (OAuth 2.1 §4.1.3).
        let (claimed, row) = {
            let mut c = self.conn(company).await?;
            let claimed = sqlx::query(
                "UPDATE oauth_authorization_codes SET used_at = now() \
                 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()",
            )
            .bind(&hash)
            .execute(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("nhận mã", e))?
            .rows_affected();
            let row: Option<CodeRow> = sqlx::query_as(
                "SELECT client_id, user_id, redirect_uri, code_challenge, COALESCE(scopes, '{}') AS scopes, resource, \
                 family_id, used_at FROM oauth_authorization_codes WHERE code_hash = $1",
            )
            .bind(&hash)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("đọc mã", e))?;
            (claimed, row)
        };
        let Some(row) = row else {
            return Err(invalid_grant(msg));
        };
        if claimed != 1 {
            // Dùng lại mã ⇒ thu hồi mọi token sinh từ nó, CHỈ khi đúng client (người lạ biết client_id công khai không
            // được ép thu hồi phiên của nạn nhân).
            if row.used_at.is_some() && row.client_id == client.client_id {
                self.revoke_family(company, &row.family_id).await?;
            }
            return Err(invalid_grant(msg));
        }
        if row.client_id != client.client_id {
            return Err(invalid_grant("Mã không cấp cho client này"));
        }
        if s(body, "redirect_uri") != Some(row.redirect_uri.as_str()) {
            return Err(invalid_grant("redirect_uri không khớp lúc xin mã"));
        }
        if !is_code_verifier(verifier) || !safe_equal(&pkce_s256(verifier), &row.code_challenge) {
            return Err(invalid_grant("code_verifier sai (PKCE)"));
        }
        if let Some(r) = s(body, "resource")
            && !is_canonical_resource(r, self.base()?)
        {
            return Err(OAuthError::new("invalid_target", "resource không hợp lệ"));
        }
        if !self.user_still_allowed(company, row.user_id).await? {
            self.revoke_family(company, &row.family_id).await?;
            return Err(invalid_grant("Tài khoản không còn quyền kết nối AI"));
        }
        let out = self
            .issue(
                company,
                &client.client_id,
                row.user_id,
                &row.scopes,
                &row.resource,
                &row.family_id,
            )
            .await?;
        self.audit(
            company,
            Self::entry(
                "oauth.token_issued",
                AuditStatus::Ok,
                &client.client_id,
                Some(row.user_id),
                json!({ "grant": "authorization_code", "scopes": row.scopes }),
            ),
        )
        .await;
        Ok(out)
    }

    async fn refresh(
        &self,
        company: CompanyRef,
        client: &crate::clients::OauthClient,
        body: &Map<String, Value>,
    ) -> R<Value> {
        let Some(raw) = s(body, "refresh_token") else {
            return Err(OAuthError::new("invalid_request", "Thiếu refresh_token"));
        };
        let row: Option<TokenRow> = {
            let mut c = self.conn(company).await?;
            sqlx::query_as(
                "SELECT id, client_id, user_id, COALESCE(scopes, '{}') AS scopes, resource, family_id, \
                 refresh_expires_at, revoked_at FROM oauth_tokens WHERE refresh_hash = $1",
            )
            .bind(sha256_hex(raw))
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("đọc refresh", e))?
        };
        let Some(row) = row.filter(|r| r.client_id == client.client_id) else {
            return Err(invalid_grant("refresh_token không hợp lệ"));
        };
        if row.revoked_at.is_some() || row.refresh_expires_at <= Utc::now() {
            return Err(invalid_grant("refresh_token đã bị thu hồi hoặc hết hạn"));
        }
        // Xoay vòng: nhận NGUYÊN TỬ. Đã dùng rồi (hoặc thua cuộc đua) ⇒ coi là bị đánh cắp/dùng lại ⇒ thu hồi CẢ chuỗi.
        let claimed = {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "UPDATE oauth_tokens SET refresh_used_at = now() \
                 WHERE id = $1 AND refresh_used_at IS NULL AND revoked_at IS NULL",
            )
            .bind(row.id)
            .execute(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("xoay refresh", e))?
            .rows_affected()
        };
        if claimed != 1 && !self.is_concurrent_refresh(company, row.id).await? {
            self.revoke_family(company, &row.family_id).await?;
            self.audit(
                company,
                Self::entry(
                    "oauth.refresh_reuse",
                    AuditStatus::Denied,
                    &client.client_id,
                    Some(row.user_id),
                    json!({ "family_revoked": true }),
                ),
            )
            .await;
            return Err(invalid_grant(
                "refresh_token đã được dùng — toàn bộ phiên kết nối đã bị thu hồi để an toàn",
            ));
        }
        if !self.user_still_allowed(company, row.user_id).await? {
            self.revoke_family(company, &row.family_id).await?;
            return Err(invalid_grant("Tài khoản không còn quyền kết nối AI"));
        }
        // `offline_access` được quảng bá và chấp nhận ở authorize/DCR nhưng không phải scope cấp quyền (refresh luôn có):
        // client gửi lại nguyên scope đã xin thì bỏ nó đi, tránh invalid_scope oan. Chỉ còn mỗi nó ⇒ coi như không hỏi.
        let asked: Option<Vec<&str>> = s(body, "scope")
            .map(|v| {
                split_js_space(v)
                    .into_iter()
                    .filter(|x| *x != "offline_access")
                    .collect::<Vec<_>>()
            })
            .filter(|v| !v.is_empty());
        let scopes: Vec<String> = match &asked {
            Some(a) => a
                .iter()
                .filter(|x| OAUTH_SCOPES.contains(x))
                .map(|x| (*x).to_owned())
                .collect(),
            None => row.scopes.clone(),
        };
        if let Some(a) = &asked
            && (scopes.len() != a.len() || scopes.iter().any(|x| !row.scopes.contains(x)))
        {
            return Err(OAuthError::new("invalid_scope", "scope vượt quá phạm vi đã được cấp"));
        }
        if let Some(r) = s(body, "resource")
            && !is_canonical_resource(r, self.base()?)
        {
            return Err(OAuthError::new("invalid_target", "resource không hợp lệ"));
        }
        let out = self
            .issue(
                company,
                &row.client_id,
                row.user_id,
                &scopes,
                &row.resource,
                &row.family_id,
            )
            .await?;
        self.audit(
            company,
            Self::entry(
                "oauth.token_refreshed",
                AuditStatus::Ok,
                &client.client_id,
                Some(row.user_id),
                json!({ "scopes": scopes }),
            ),
        )
        .await;
        Ok(out)
    }

    /// Client gọi song song nhiều request cùng lúc hết hạn ⇒ nhiều lần refresh với CÙNG token trong vài giây. Trong cửa sổ
    /// ngắn sau lần xoay đầu, coi là trùng lặp lành tính (cấp cặp mới cùng chuỗi, không thu hồi). Quá cửa sổ ⇒ dùng lại
    /// là bị đánh cắp.
    async fn is_concurrent_refresh(&self, company: CompanyRef, id: i64) -> R<bool> {
        let mut c = self.conn(company).await?;
        let cur: Option<UsedRow> = sqlx::query_as("SELECT refresh_used_at, revoked_at FROM oauth_tokens WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("đọc refresh", e))?;
        Ok(match cur {
            Some(UsedRow {
                refresh_used_at: Some(used),
                revoked_at: None,
            }) => (Utc::now() - used).num_milliseconds() < REFRESH_GRACE_MS,
            _ => false,
        })
    }

    async fn issue(
        &self,
        company: CompanyRef,
        client_id: &str,
        user_id: i32,
        scopes: &[String],
        resource: &str,
        family_id: &str,
    ) -> R<Value> {
        let prefix = crate::company_token_prefix(company.id());
        let access = format!("{prefix}trn_at_{}", self.random(32)?);
        let refresh = format!("{prefix}trn_rt_{}", self.random(32)?);
        let now = Utc::now();
        let mut c = self.conn(company).await?;
        let created: i64 = sqlx::query_scalar(
            "INSERT INTO oauth_tokens (access_hash, refresh_hash, client_id, user_id, scopes, resource, family_id, \
             access_expires_at, refresh_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
        )
        .bind(sha256_hex(&access))
        .bind(sha256_hex(&refresh))
        .bind(client_id)
        .bind(user_id)
        .bind(scopes)
        .bind(resource)
        .bind(family_id)
        .bind(now + chrono::Duration::seconds(ACCESS_TTL_SEC))
        .bind(now + chrono::Duration::milliseconds(REFRESH_TTL_MS))
        .fetch_one(&mut *c)
        .await
        .map_err(|e| OAuthError::internal("cấp token", e))?;
        // Người dùng có thể bấm "Thu hồi" đúng lúc ta đang cấp ⇒ chuỗi đã có dòng bị thu hồi: huỷ luôn dòng vừa tạo.
        let dead: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM oauth_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL AND id <> $2 LIMIT 1",
        )
        .bind(family_id)
        .bind(created)
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| OAuthError::internal("kiểm thu hồi", e))?;
        drop(c);
        if dead.is_some() {
            self.revoke_family(company, family_id).await?;
            return Err(invalid_grant("Kết nối đã bị thu hồi"));
        }
        Ok(json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_TTL_SEC,
            "refresh_token": refresh,
            "scope": scopes.join(" "),
        }))
    }

    /// RFC 7009: luôn thành công (không lộ token có tồn tại không); thu hồi CẢ chuỗi của token đó.
    pub async fn revoke_token(&self, body: &Map<String, Value>) -> R<()> {
        let raw = s(body, "token");
        let client = self
            .authenticate_client(s(body, "client_id").unwrap_or(""), s(body, "client_secret"))
            .await?;
        let Some(raw) = raw else { return Ok(()) };
        let Some(company) = self.token_company(raw).await else {
            return Ok(());
        };
        let h = sha256_hex(raw);
        let row: Option<(String, String, i32)> = {
            let mut c = self.conn(company).await?;
            sqlx::query_as(
                "SELECT family_id, client_id, user_id FROM oauth_tokens WHERE access_hash = $1 OR refresh_hash = $1 LIMIT 1",
            )
            .bind(&h)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("tra token", e))?
        };
        let Some((family, client_id, user_id)) = row else {
            return Ok(());
        };
        if client_id != client.client_id {
            return Ok(());
        }
        self.revoke_family(company, &family).await?;
        self.audit(
            company,
            Self::entry(
                "oauth.revoke",
                AuditStatus::Ok,
                &client.client_id,
                Some(user_id),
                json!({ "by": "client" }),
            ),
        )
        .await;
        Ok(())
    }

    /// Xác minh access token cho MCP: băm, tra, chưa thu hồi, chưa hết hạn, ĐÚNG audience (`resource`), người dùng còn hoạt
    /// động. Việc "mất quyền nối AI" do người gọi kiểm (cần quyền theo từng lời gọi).
    pub async fn verify_access_token(&self, raw: &str) -> Option<VerifiedAccessToken> {
        if raw.is_empty() || raw.len() > 256 {
            return None;
        }
        // Gắn request vào công ty của token trước (công ty lạ/bị treo ⇒ None ⇒ 401).
        let company = self.token_company(raw).await?;
        let mut c = self.conn(company).await.ok()?;
        let row: AccessRow = sqlx::query_as(
            "SELECT id, user_id, client_id, COALESCE(scopes, '{}') AS scopes, resource, family_id, access_expires_at,              revoked_at, last_used_at FROM oauth_tokens WHERE access_hash = $1",
        )
        .bind(sha256_hex(raw))
        .fetch_optional(&mut *c)
        .await
        .ok()??;
        if row.revoked_at.is_some() || row.access_expires_at <= Utc::now() {
            return None;
        }
        if !is_canonical_resource(&row.resource, self.config.base.as_deref()?) {
            return None;
        }
        let (status, deleted, email): (String, Option<DateTime<Utc>>, String) =
            sqlx::query_as("SELECT status, deleted_at, email FROM users WHERE id = $1")
                .bind(row.user_id)
                .fetch_optional(&mut *c)
                .await
                .ok()??;
        if deleted.is_some() || status != "active" {
            return None;
        }
        if row
            .last_used_at
            .is_none_or(|t| (Utc::now() - t).num_milliseconds() > LAST_USED_THROTTLE_MS)
        {
            let _ = sqlx::query("UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1")
                .bind(row.id)
                .execute(&mut *c)
                .await;
        }
        Some(VerifiedAccessToken {
            company,
            token_id: row.id,
            user_id: row.user_id,
            email,
            client_id: row.client_id,
            scopes: row.scopes,
            family_id: row.family_id,
        })
    }
}
