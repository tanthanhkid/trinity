//! Màn đồng ý (`oauth-authorize.service.ts`): `context` kiểm yêu cầu và trả thông tin hiển thị; `decision` kiểm LẠI từ đầu
//! (không tin FE) cộng token consent HMAC 10 phút ràng buộc quyết định với đúng người, đúng công ty, đúng tham số.

use chrono::{Duration, Utc};
use serde_json::{Value, json};
use trinity_db::CompanyRef;
use trinity_integrations::audit::AuditStatus;

use crate::authorize::{
    AuthorizeInput, ValidAuthorize, assert_redirect_uri, authorize_fingerprint, build_client_redirect,
    validate_authorize_rest,
};
use crate::config::{CODE_TTL_MS, CONSENT_TTL_SEC, scope_label};
use crate::crypto::{sha256_hex, sign_consent, verify_consent};
use crate::ctx::OauthCtx;
use crate::error::{OAuthError, R};
use crate::redirect::{is_loopback_uri, redirect_host};

/// Nhãn nhận diện CHỈ khi redirect đi tới đúng host đã biết: tên client do client tự khai nên không đáng tin một mình.
fn known_as(host: &str) -> Option<&'static str> {
    match host.to_lowercase().as_str() {
        "chatgpt.com" => Some("ChatGPT (OpenAI)"),
        "claude.ai" => Some("Claude (Anthropic)"),
        _ => None,
    }
}

fn secret(ctx: &OauthCtx) -> R<&str> {
    ctx.config
        .jwt_secret
        .as_deref()
        .ok_or_else(|| OAuthError::internal("consent", "JWT_SECRET chưa đặt"))
}

impl OauthCtx {
    /// Kiểm đầy đủ. Lỗi thường ⇒ hiện trên trang; `redirectable` ⇒ redirect về client.
    async fn validate_authorize(&self, input: &AuthorizeInput) -> R<ValidAuthorize> {
        let base = self.base()?;
        let client_id = input.get("client_id").and_then(Value::as_str).unwrap_or("");
        let client = self.resolve_client(client_id, true).await?;
        let uri = assert_redirect_uri(&client, input)?;
        validate_authorize_rest(client, uri, input, base)
    }

    fn error_redirect(&self, err: &OAuthError, input: &AuthorizeInput) -> R<String> {
        let state: Option<String> = input
            .get("state")
            .and_then(Value::as_str)
            .map(|s| s.encode_utf16().take(512).collect::<Vec<u16>>())
            .map(|u| String::from_utf16_lossy(&u));
        let uri = match input.get("redirect_uri") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        build_client_redirect(
            &uri,
            self.base()?,
            &[
                ("error", Some(&err.code)),
                ("error_description", Some(&err.description)),
                ("state", state.as_deref()),
            ],
        )
    }

    pub async fn consent_context(&self, company: CompanyRef, user_id: i32, input: &AuthorizeInput) -> R<Value> {
        let v = match self.validate_authorize(input).await {
            Ok(v) => v,
            Err(e) if e.redirectable => {
                return Ok(json!({ "ok": false, "redirect_to": self.error_redirect(&e, input)? }));
            }
            Err(e) => return Err(e),
        };
        let host = redirect_host(&v.redirect_uri);
        let scopes: Vec<Value> = v
            .scopes
            .iter()
            .filter_map(|s| {
                scope_label(s).map(|l| {
                    json!({ "scope": s, "label": l.label, "description": l.description,
                            "available": l.available, "optional": l.optional })
                })
            })
            .collect();
        let token = sign_consent(
            secret(self)?,
            user_id,
            company.id(),
            &authorize_fingerprint(&v),
            Utc::now().timestamp() + CONSENT_TTL_SEC,
        );
        Ok(json!({
            "ok": true,
            "client": {
                "name": v.client.name,
                "logo_uri": v.client.logo_uri,
                "client_uri": v.client.client_uri,
                "kind": v.client.kind,
                "redirect_uri": v.redirect_uri,
                "redirect_host": host,
                "loopback": is_loopback_uri(&v.redirect_uri),
                "known_as": known_as(&host),
            },
            "scopes": scopes,
            "consent_token": token,
            "expires_in": CONSENT_TTL_SEC,
        }))
    }

    /// Trả `redirect_to`: FE điều hướng trình duyệt tới đó. Mọi tham số được kiểm LẠI từ đầu.
    pub async fn consent_decision(
        &self,
        company: CompanyRef,
        user_id: i32,
        input: &AuthorizeInput,
        approve: bool,
        consent_token: &str,
        granted: Option<Vec<String>>,
    ) -> R<Value> {
        let v = match self.validate_authorize(input).await {
            Ok(v) => v,
            Err(e) if e.redirectable => return Ok(json!({ "redirect_to": self.error_redirect(&e, input)? })),
            Err(e) => return Err(e),
        };
        let claims = verify_consent(secret(self)?, consent_token, Utc::now().timestamp_millis());
        let expired = || {
            OAuthError::new(
                "invalid_request",
                "Phiên đồng ý không hợp lệ hoặc đã hết hạn — hãy tải lại trang",
            )
        };
        let Some(claims) = claims else { return Err(expired()) };
        if claims.u != f64::from(user_id)
            || claims.c.unwrap_or(1.0) != f64::from(company.id())
            || claims.h != authorize_fingerprint(&v)
        {
            return Err(expired());
        }
        // Người dùng có thể BỎ scope tuỳ chọn (crm.write): chỉ nhận tập con của scope đã hiển thị, không bao giờ rộng hơn.
        let scopes: Vec<String> = match granted {
            None => v.scopes.clone(),
            Some(g) => {
                let mut out: Vec<String> = Vec::new();
                for x in g {
                    if !out.contains(&x) {
                        out.push(x);
                    }
                }
                out
            }
        };
        let required_missing = v
            .scopes
            .iter()
            .any(|x| scope_label(x).is_some_and(|l| !l.optional) && !scopes.contains(x));
        if approve && (scopes.is_empty() || scopes.iter().any(|x| !v.scopes.contains(x)) || required_missing) {
            return Err(OAuthError::new(
                "invalid_request",
                "Phạm vi được cấp không hợp lệ — hãy tải lại trang",
            ));
        }
        let meta = json!({ "scopes": scopes, "requested_scopes": v.scopes, "client_name": v.client.name,
                           "redirect_host": redirect_host(&v.redirect_uri) });
        let base = self.base()?;
        if !approve {
            let mut m = meta;
            if let Value::Object(o) = &mut m {
                o.insert("reason".into(), json!("user_denied"));
            }
            self.audit(
                company,
                Self::entry(
                    "oauth.authorize",
                    AuditStatus::Denied,
                    &v.client.client_id,
                    Some(user_id),
                    m,
                ),
            )
            .await;
            let to = build_client_redirect(
                &v.redirect_uri,
                base,
                &[
                    ("error", Some("access_denied")),
                    ("error_description", Some("Người dùng từ chối")),
                    ("state", v.state.as_deref()),
                ],
            )?;
            return Ok(json!({ "redirect_to": to }));
        }
        // Nhiều công ty: mã mang công ty (`c<id>.`, công ty 1 không có) để /oauth/token biết tra ở schema nào.
        let code = format!("{}{}", crate::company_token_prefix(company.id()), self.random(32)?);
        {
            let mut c = self.conn(company).await?;
            sqlx::query(
                "INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, \
                 scopes, resource, family_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(sha256_hex(&code))
            .bind(&v.client.client_id)
            .bind(user_id)
            .bind(&v.redirect_uri)
            .bind(&v.code_challenge)
            .bind(&scopes)
            .bind(&v.resource)
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(Utc::now() + Duration::milliseconds(CODE_TTL_MS))
            .execute(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("tạo mã", e))?;
        }
        self.touch_client(&v.client).await;
        self.audit(
            company,
            Self::entry(
                "oauth.authorize",
                AuditStatus::Ok,
                &v.client.client_id,
                Some(user_id),
                meta,
            ),
        )
        .await;
        let to = build_client_redirect(
            &v.redirect_uri,
            base,
            &[("code", Some(&code)), ("state", v.state.as_deref())],
        )?;
        Ok(json!({ "redirect_to": to }))
    }
}

/// `granted_scopes`: mảng ≤ 8 chuỗi.
pub fn parse_granted(v: Option<&Value>) -> R<Option<Vec<String>>> {
    let bad = || OAuthError::new("invalid_request", "granted_scopes phải là mảng chuỗi");
    match v {
        None => Ok(None),
        Some(Value::Array(a)) if a.len() <= 8 => a
            .iter()
            .map(|x| x.as_str().map(str::to_owned).ok_or_else(bad))
            .collect::<R<Vec<_>>>()
            .map(Some),
        Some(_) => Err(bad()),
    }
}
