//! Lớp HTTP mỏng gọi Zalo (`zalo-oa-api.client.ts`). Phản hồi Zalo có hai dạng lỗi: `{ error: <khác 0>, message }` (API) và
//! `{ error: <khác 0>, error_name, error_reason }` (OAuth), gộp thành [`ZaloApiError`]. Token đi bằng header (`access_token`,
//! `secret_key`), không bao giờ ở URL hay log.

use std::time::Duration;

use reqwest::header::CONTENT_TYPE;
use serde_json::{Value, json};

use crate::config::{Env, ZaloEndpoint, zalo_url};
use crate::errors::{ZALO_BAD_TOKEN_BODY, ZALO_CONFIG_ERROR, ZaloApiError};

pub const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZaloTokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Giây.
    pub expires_in: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZaloUserProfile {
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub phone: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ZnsResult {
    pub msg_id: Option<String>,
    pub quota: Value,
}

/// Tham số gửi ZNS.
#[derive(Debug, Clone)]
pub struct ZnsRequest<'a> {
    pub phone: &'a str,
    pub template_id: &'a str,
    pub template_data: &'a serde_json::Map<String, Value>,
    pub tracking_id: Option<&'a str>,
    /// `development` = chế độ thử.
    pub mode: Option<&'static str>,
}

#[derive(Clone)]
pub struct ZaloClient {
    env: Env,
    http: reqwest::Client,
}

fn id_string(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

impl ZaloClient {
    pub fn new(env: Env) -> Self {
        Self::with_http(
            env,
            reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .unwrap_or_default(),
        )
    }

    pub fn with_http(env: Env, http: reqwest::Client) -> Self {
        Self { env, http }
    }

    /// `endpoint` + `suffix`: URL dựng TRONG đây; địa chỉ gốc sai ⇒ `ZaloApiError(ZALO_CONFIG_ERROR)`, không thành lỗi 500 thô.
    async fn call(
        &self,
        endpoint: ZaloEndpoint,
        suffix: &str,
        post: bool,
        headers: &[(&str, &str)],
        body: Option<(&'static str, String)>,
    ) -> Result<Value, ZaloApiError> {
        let url = format!(
            "{}{suffix}",
            zalo_url(endpoint, &self.env).map_err(|m| ZaloApiError::new(ZALO_CONFIG_ERROR, m, None))?
        );
        let mut req = if post {
            self.http.post(&url)
        } else {
            self.http.get(&url)
        };
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        if let Some((ct, b)) = body {
            req = req.header(CONTENT_TYPE, ct).body(b);
        }
        let res = match req.timeout(HTTP_TIMEOUT).send().await {
            Ok(r) => r,
            Err(e) => {
                // Không đưa chi tiết lỗi (có thể chứa URL) ra ngoài: chỉ loại lỗi.
                let kind = if e.is_timeout() {
                    "quá hạn"
                } else {
                    "lỗi kết nối"
                };
                return Err(ZaloApiError::new(-1, format!("Không gọi được Zalo ({kind})"), None));
            }
        };
        let status = res.status();
        let Ok(body) = res.json::<Value>().await else {
            return Err(ZaloApiError::new(
                -2,
                "Zalo trả phản hồi không phải JSON",
                Some(status.as_u16()),
            ));
        };
        let code = match body.get("error") {
            None | Some(Value::Null) => 0,
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
            Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
            Some(_) => 0,
        };
        if code != 0 || !status.is_success() {
            let text = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_owned);
            let msg = text("message")
                .or_else(|| text("error_reason"))
                .or_else(|| text("error_name"))
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
            return Err(ZaloApiError::new(
                if code == 0 { -i64::from(status.as_u16()) } else { code },
                msg,
                Some(status.as_u16()),
            ));
        }
        Ok(body)
    }

    async fn token_request(
        &self,
        app_id: &str,
        app_secret: &str,
        form: &[(&str, &str)],
    ) -> Result<ZaloTokenSet, ZaloApiError> {
        let mut pairs = vec![("app_id", app_id)];
        pairs.extend_from_slice(form);
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        let b = self
            .call(
                ZaloEndpoint::Token,
                "",
                true,
                &[("secret_key", app_secret)],
                Some(("application/x-www-form-urlencoded", body)),
            )
            .await?;
        let s = |k: &str| b.get(k).and_then(Value::as_str).map(str::to_owned);
        let exp = match b.get("expires_in") {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(t)) => t.trim().parse::<f64>().ok(),
            _ => None,
        };
        match (s("access_token"), s("refresh_token"), exp) {
            (Some(access_token), Some(refresh_token), Some(e)) if e.is_finite() => Ok(ZaloTokenSet {
                access_token,
                refresh_token,
                expires_in: e as i64,
            }),
            _ => Err(ZaloApiError::new(
                ZALO_BAD_TOKEN_BODY,
                "Phản hồi token của Zalo thiếu trường",
                None,
            )),
        }
    }

    pub async fn exchange_code(
        &self,
        app_id: &str,
        app_secret: &str,
        code: &str,
        code_verifier: &str,
    ) -> Result<ZaloTokenSet, ZaloApiError> {
        self.token_request(
            app_id,
            app_secret,
            &[
                ("code", code),
                ("grant_type", "authorization_code"),
                ("code_verifier", code_verifier),
            ],
        )
        .await
    }

    /// Refresh token dùng MỘT LẦN: mỗi lần làm mới Zalo cấp cặp mới, cặp cũ chết.
    pub async fn refresh(
        &self,
        app_id: &str,
        app_secret: &str,
        refresh_token: &str,
    ) -> Result<ZaloTokenSet, ZaloApiError> {
        self.token_request(
            app_id,
            app_secret,
            &[("refresh_token", refresh_token), ("grant_type", "refresh_token")],
        )
        .await
    }

    pub async fn send_text(
        &self,
        access_token: &str,
        user_id: &str,
        text: &str,
    ) -> Result<Option<String>, ZaloApiError> {
        let body = json!({ "recipient": { "user_id": user_id }, "message": { "text": text } }).to_string();
        let b = self
            .call(
                ZaloEndpoint::Api,
                "/message/cs",
                true,
                &[("access_token", access_token)],
                Some(("application/json", body)),
            )
            .await?;
        Ok(id_string(b.pointer("/data/message_id")))
    }

    pub async fn send_zns(&self, access_token: &str, p: &ZnsRequest<'_>) -> Result<ZnsResult, ZaloApiError> {
        let mut body = json!({ "phone": p.phone, "template_id": p.template_id, "template_data": p.template_data });
        if let Some(t) = p.tracking_id.filter(|t| !t.is_empty()) {
            body["tracking_id"] = json!(t);
        }
        if let Some(m) = p.mode {
            body["mode"] = json!(m);
        }
        let b = self
            .call(
                ZaloEndpoint::Zns,
                "",
                true,
                &[("access_token", access_token)],
                Some(("application/json", body.to_string())),
            )
            .await?;
        Ok(ZnsResult {
            msg_id: id_string(b.pointer("/data/msg_id")),
            quota: b.pointer("/data/quota").cloned().unwrap_or(Value::Null),
        })
    }

    pub async fn get_profile(&self, access_token: &str, user_id: &str) -> Result<ZaloUserProfile, ZaloApiError> {
        let data = json!({ "user_id": user_id }).to_string();
        let suffix = format!("/user/detail?data={}", crate::config::encode_uri_component(&data));
        let b = self
            .call(
                ZaloEndpoint::Api,
                &suffix,
                false,
                &[("access_token", access_token)],
                None,
            )
            .await?;
        let d = b.get("data").cloned().unwrap_or(Value::Null);
        let s = |k: &str| d.get(k).and_then(Value::as_str).map(str::to_owned);
        Ok(ZaloUserProfile {
            display_name: s("display_name"),
            avatar: s("avatar"),
            phone: id_string(d.pointer("/shared_info/phone")),
        })
    }
}
