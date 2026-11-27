//! Client Graph API mỏng (`graph-client.ts`): MỘT chỗ duy nhất gọi Meta. Token gửi bằng header `Authorization: Bearer` (không
//! nằm trong URL nên không lọt vào log truy cập); KHÔNG BAO GIỜ ghi token/secret vào log hay thông báo lỗi. Mọi kết quả
//! gọi (trừ lỗi kết nối) báo cho `observer` ([`GraphOutcome`]) để cửa sổ lỗi của [`mod_channel_guard::ChannelGuard`] phân loại.
//! Docs: <https://developers.facebook.com/docs/graph-api/overview>.

use std::sync::Arc;
use std::time::Duration;

use mod_channel_guard::GraphOutcome;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::config::{Env, graph_url, load_facebook_config};

/// Hạn một lời gọi Graph (`AbortSignal.timeout(15_000)`).
pub const GRAPH_TIMEOUT: Duration = Duration::from_secs(15);

/// Lỗi Graph (hoặc lỗi cấu hình/kết nối). `Display` là thông báo của Facebook hoặc câu tiếng Việt của Trinity.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GraphApiError {
    pub http_status: u16,
    pub code: Option<i64>,
    pub subcode: Option<i64>,
    pub message: String,
    /// Lỗi cấu hình phía Trinity (địa chỉ gốc Graph sai, đường dẫn lạ): chưa gửi gì tới Facebook.
    pub config_error: bool,
}

impl GraphApiError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            http_status: 0,
            code: None,
            subcode: None,
            message: message.into(),
            config_error: false,
        }
    }

    /// Lỗi cấu hình: VĨNH VIỄN (gửi lại y nguyên vẫn hỏng): không ném lại để webhook trả 5xx, Meta sẽ gửi lại mãi.
    pub fn is_config_error(&self) -> bool {
        self.config_error
    }

    /// `190` = token hết hạn hoặc bị thu hồi.
    pub fn is_token_error(&self) -> bool {
        self.code == Some(190)
    }

    /// `10` hoặc `200`–`299` = thiếu quyền.
    pub fn is_permission_error(&self) -> bool {
        self.code == Some(10) || self.code.is_some_and(|c| (200..300).contains(&c))
    }

    /// `4`/`17`/`32`/`613` hoặc HTTP 429 = giới hạn tần suất: tạm thời, phải để Meta gửi lại.
    pub fn is_rate_limit(&self) -> bool {
        self.http_status == 429 || self.code.is_some_and(|c| matches!(c, 4 | 17 | 32 | 613))
    }

    /// Subcode `2018278` (mã 10) hoặc `1545041` (subcode của mã 551, hay chính mã) = ngoài cửa sổ nhắn tin.
    pub fn is_outside_window(&self) -> bool {
        matches!(self.subcode, Some(2_018_278 | 1_545_041)) || self.code == Some(1_545_041)
    }
}

/// Page người dùng quản trị, kèm page token.
#[derive(Debug, Clone, Deserialize)]
pub struct GraphPage {
    pub id: String,
    pub name: String,
    pub access_token: String,
    /// Việc người dùng làm được trên Page (`CREATE_CONTENT`, `MANAGE`, `MESSAGING`…).
    #[serde(default)]
    pub tasks: Option<Vec<String>>,
    #[serde(default)]
    pub picture: Option<PictureEnvelope>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PictureEnvelope {
    #[serde(default)]
    pub data: Option<PictureData>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PictureData {
    #[serde(default)]
    pub url: Option<String>,
}

impl GraphPage {
    pub fn picture_url(&self) -> Option<&str> {
        self.picture.as_ref()?.data.as_ref()?.url.as_deref()
    }
}

/// Kết quả `debug_token`. `expires_at` = 0 hoặc vắng: không hết hạn.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenDebug {
    pub is_valid: bool,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub data_access_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LeadData {
    pub id: String,
    #[serde(default)]
    pub created_time: Option<String>,
    #[serde(default)]
    pub form_id: Option<String>,
    #[serde(default)]
    pub ad_id: Option<String>,
    #[serde(default)]
    pub field_data: Option<Vec<LeadField>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LeadField {
    pub name: String,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConversationMessage {
    pub id: String,
    pub created_time: String,
    #[serde(default)]
    pub from: Option<MessageFrom>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageFrom {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SentMessage {
    pub message_id: String,
    #[serde(default)]
    pub recipient_id: Option<String>,
}

/// Nơi nhận kết quả mỗi lời gọi (thường là `move |o| guard.record_graph(company, o)`).
pub type Observer = Arc<dyn Fn(GraphOutcome) + Send + Sync>;

type Query = Vec<(String, String)>;

fn q(pairs: &[(&str, &str)]) -> Query {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
}

#[derive(Default)]
struct Opts {
    token: Option<String>,
    query: Query,
    body: Option<Value>,
    /// Lời gọi GỬI RA (tin, trả lời/ẩn bình luận, đăng bài): chỉ loại này tính vào ngưỡng tự tạm dừng.
    send: bool,
}

/// Client Graph. Rẻ để nhân bản (dùng chung `reqwest::Client`); dựng một cái cho mỗi công ty với `observer` riêng.
#[derive(Clone)]
pub struct GraphClient {
    env: Env,
    http: reqwest::Client,
    observer: Observer,
}

impl GraphClient {
    pub fn new(env: Env, observer: Observer) -> Self {
        Self::with_http(
            env,
            observer,
            reqwest::Client::builder()
                .timeout(GRAPH_TIMEOUT)
                .build()
                .unwrap_or_default(),
        )
    }

    /// Dùng `reqwest::Client` có sẵn (dùng chung giữa các công ty).
    pub fn with_http(env: Env, observer: Observer, http: reqwest::Client) -> Self {
        Self { env, http, observer }
    }

    async fn call(&self, method: Method, path: &str, o: Opts) -> Result<Value, GraphApiError> {
        let cfg = load_facebook_config(&self.env);
        // Dựng URL trước: cấu hình địa chỉ gốc sai (vd `http://` ngoài loopback) phải báo đúng là lỗi cấu hình vĩnh viễn,
        // không thành "không kết nối được".
        let url = graph_url(&cfg.graph_version, path, &o.query, false, &self.env).map_err(|m| GraphApiError {
            http_status: 0,
            code: None,
            subcode: None,
            message: m,
            config_error: true,
        })?;
        let mut req = if method == Method::Get {
            self.http.get(&url)
        } else {
            self.http.post(&url)
        };
        if let Some(t) = &o.token {
            req = req.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        if let Some(b) = &o.body {
            req = req.header(CONTENT_TYPE, "application/json").body(b.to_string());
        }
        let res = match req.timeout(GRAPH_TIMEOUT).send().await {
            Ok(r) => r,
            Err(e) => {
                // Không ghi URL (có thể chứa id) hay chi tiết lỗi: chỉ loại lỗi.
                let kind = if e.is_timeout() { "timeout" } else { "connect" };
                tracing::warn!(
                    "Graph {} {path}: không kết nối được ({kind})",
                    if method == Method::Get { "GET" } else { "POST" }
                );
                return Err(GraphApiError::plain("Không kết nối được tới Facebook"));
            }
        };
        let status = res.status();
        let json: Value = res.json().await.unwrap_or_else(|_| json!({}));
        let err_obj = json.get("error").filter(|e| !e.is_null() && *e != &Value::Bool(false));
        if !status.is_success() || err_obj.is_some() {
            let e = err_obj.cloned().unwrap_or_else(|| json!({}));
            let code = e.get("code").and_then(Value::as_i64);
            let subcode = e.get("error_subcode").and_then(Value::as_i64);
            let message = e
                .get("message")
                .and_then(Value::as_str)
                .map_or_else(|| format!("Facebook trả lỗi HTTP {}", status.as_u16()), str::to_owned);
            tracing::warn!(
                "Graph {path}: HTTP {} code={} subcode={}",
                status.as_u16(),
                code.map_or_else(|| "-".to_owned(), |c| c.to_string()),
                subcode.map_or_else(|| "-".to_owned(), |c| c.to_string())
            );
            (self.observer)(GraphOutcome {
                ok: false,
                http_status: i64::from(status.as_u16()),
                code,
                subcode,
                send: o.send,
            });
            return Err(GraphApiError {
                http_status: status.as_u16(),
                code,
                subcode,
                message,
                config_error: false,
            });
        }
        (self.observer)(GraphOutcome {
            ok: true,
            http_status: i64::from(status.as_u16()),
            code: None,
            subcode: None,
            send: o.send,
        });
        Ok(json)
    }

    async fn get(&self, path: &str, token: Option<&str>, query: Query) -> Result<Value, GraphApiError> {
        self.call(
            Method::Get,
            path,
            Opts {
                token: token.map(str::to_owned),
                query,
                ..Opts::default()
            },
        )
        .await
    }

    async fn post(
        &self,
        path: &str,
        token: &str,
        query: Query,
        body: Option<Value>,
        send: bool,
    ) -> Result<Value, GraphApiError> {
        self.call(
            Method::Post,
            path,
            Opts {
                token: Some(token.to_owned()),
                query,
                body,
                send,
            },
        )
        .await
    }

    fn typed<T: for<'de> Deserialize<'de>>(v: Value) -> Result<T, GraphApiError> {
        serde_json::from_value(v).map_err(|_| GraphApiError::plain("Facebook trả dữ liệu không đúng định dạng"))
    }

    /// `code` (từ hộp thoại đăng nhập) ⇒ user token ngắn hạn.
    pub async fn exchange_code(&self, code: &str, redirect_uri: &str) -> Result<String, GraphApiError> {
        let c = load_facebook_config(&self.env);
        let r = self
            .get(
                "oauth/access_token",
                None,
                q(&[
                    ("client_id", &c.app_id),
                    ("client_secret", &c.app_secret),
                    ("redirect_uri", redirect_uri),
                    ("code", code),
                ]),
            )
            .await?;
        access_token(&r)
    }

    /// User token ngắn hạn ⇒ dài hạn (khoảng 60 ngày), để lấy page token KHÔNG hết hạn.
    pub async fn to_long_lived(&self, user_token: &str) -> Result<String, GraphApiError> {
        let c = load_facebook_config(&self.env);
        let r = self
            .get(
                "oauth/access_token",
                None,
                q(&[
                    ("grant_type", "fb_exchange_token"),
                    ("client_id", &c.app_id),
                    ("client_secret", &c.app_secret),
                    ("fb_exchange_token", user_token),
                ]),
            )
            .await?;
        access_token(&r)
    }

    /// Các Page người dùng quản trị kèm page token (từ user token dài hạn ⇒ page token không hết hạn).
    pub async fn list_pages(&self, user_token: &str) -> Result<Vec<GraphPage>, GraphApiError> {
        let r = self
            .get(
                "me/accounts",
                Some(user_token),
                q(&[("fields", "id,name,access_token,tasks,picture{url}"), ("limit", "100")]),
            )
            .await?;
        Self::typed(r.get("data").cloned().unwrap_or_else(|| json!([])))
    }

    /// Quyền người dùng đã THẬT SỰ cấp trong lần đăng nhập này (`status = granted`).
    pub async fn granted_permissions(&self, user_token: &str) -> Result<Vec<String>, GraphApiError> {
        let r = self.get("me/permissions", Some(user_token), Vec::new()).await?;
        Ok(r.get("data")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|x| x.get("status").and_then(Value::as_str) == Some("granted"))
                    .filter_map(|x| x.get("permission").and_then(Value::as_str).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Đăng ký Page nhận webhook (messages, leadgen…). Cần `pages_manage_metadata`.
    pub async fn subscribe_page(
        &self,
        page_id: &str,
        page_token: &str,
        fields: &[String],
    ) -> Result<(), GraphApiError> {
        self.post(
            &format!("{page_id}/subscribed_apps"),
            page_token,
            q(&[("subscribed_fields", &fields.join(","))]),
            None,
            false,
        )
        .await
        .map(|_| ())
    }

    pub async fn unsubscribe_page(&self, page_id: &str, page_token: &str) -> Result<(), GraphApiError> {
        self.post(
            &format!("{page_id}/subscribed_apps"),
            page_token,
            q(&[("subscribed_fields", "")]),
            None,
            false,
        )
        .await
        .map(|_| ())
    }

    /// Kiểm hạn/hiệu lực token bằng app token `app_id|app_secret`.
    pub async fn debug_token(&self, input_token: &str) -> Result<TokenDebug, GraphApiError> {
        let c = load_facebook_config(&self.env);
        let r = self
            .get(
                "debug_token",
                Some(&format!("{}|{}", c.app_id, c.app_secret)),
                q(&[("input_token", input_token)]),
            )
            .await?;
        Self::typed(r.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Chi tiết lead theo `leadgen_id` (dùng page token).
    pub async fn get_lead(&self, leadgen_id: &str, page_token: &str) -> Result<LeadData, GraphApiError> {
        let r = self
            .get(
                leadgen_id,
                Some(page_token),
                q(&[("fields", "id,created_time,form_id,ad_id,field_data")]),
            )
            .await?;
        Self::typed(r)
    }

    /// Gửi tin văn bản: `messaging_type: RESPONSE` (trong cửa sổ 24 giờ). `human_agent`: tin nhân viên gõ, 24 giờ đến 7
    /// ngày sau tin khách, gửi `MESSAGE_TAG` + `HUMAN_AGENT`.
    pub async fn send_text(
        &self,
        page_token: &str,
        psid: &str,
        text: &str,
        human_agent: bool,
    ) -> Result<SentMessage, GraphApiError> {
        let mut body = json!({ "recipient": { "id": psid } });
        if human_agent {
            body["messaging_type"] = json!("MESSAGE_TAG");
            body["tag"] = json!("HUMAN_AGENT");
        } else {
            body["messaging_type"] = json!("RESPONSE");
        }
        body["message"] = json!({ "text": text });
        Self::typed(
            self.post("me/messages", page_token, Vec::new(), Some(body), true)
                .await?,
        )
    }

    /// Gửi tin kèm nút trả lời nhanh (tối đa 13 nút, tiêu đề ≤ 20 ký tự); `payload` quay về trong `message.quick_reply`.
    pub async fn send_quick_replies(
        &self,
        page_token: &str,
        psid: &str,
        text: &str,
        buttons: &[(String, String)],
    ) -> Result<SentMessage, GraphApiError> {
        let quick: Vec<Value> = buttons
            .iter()
            .map(|(title, payload)| json!({ "content_type": "text", "title": utf16_prefix(title, 20), "payload": utf16_prefix(payload, 1000) }))
            .collect();
        let body = json!({ "recipient": { "id": psid }, "messaging_type": "RESPONSE", "message": { "text": text, "quick_replies": quick } });
        Self::typed(
            self.post("me/messages", page_token, Vec::new(), Some(body), true)
                .await?,
        )
    }

    /// Bật nút "Bắt đầu" của Page nếu chưa có (không đè cấu hình sẵn). Trả `true` nếu vừa bật.
    pub async fn ensure_get_started(&self, page_token: &str) -> Result<bool, GraphApiError> {
        let cur = self
            .get(
                "me/messenger_profile",
                Some(page_token),
                q(&[("fields", "get_started")]),
            )
            .await?;
        let has = cur.get("data").and_then(Value::as_array).is_some_and(|a| {
            a.iter().any(|d| {
                d.get("get_started")
                    .is_some_and(|g| !g.is_null() && *g != Value::Bool(false))
            })
        });
        if has {
            return Ok(false);
        }
        self.post(
            "me/messenger_profile",
            page_token,
            Vec::new(),
            Some(json!({ "get_started": { "payload": "GET_STARTED" } })),
            false,
        )
        .await?;
        Ok(true)
    }

    /// Trả lời công khai một bình luận. Cần `pages_manage_engagement`.
    pub async fn reply_to_comment(
        &self,
        page_token: &str,
        comment_id: &str,
        text: &str,
    ) -> Result<String, GraphApiError> {
        let r = self
            .post(
                &format!("{comment_id}/comments"),
                page_token,
                Vec::new(),
                Some(json!({ "message": text })),
                true,
            )
            .await?;
        Ok(r.get("id").and_then(Value::as_str).unwrap_or_default().to_owned())
    }

    /// Private Reply: nhắn riêng người đã bình luận (1 tin mỗi bình luận, trong 7 ngày). Cần `pages_messaging`.
    pub async fn private_reply(
        &self,
        page_token: &str,
        page_id: &str,
        comment_id: &str,
        text: &str,
    ) -> Result<SentMessage, GraphApiError> {
        let body = json!({ "recipient": { "comment_id": comment_id }, "message": { "text": text } });
        Self::typed(
            self.post(&format!("{page_id}/messages"), page_token, Vec::new(), Some(body), true)
                .await?,
        )
    }

    /// Ẩn bình luận (người khác không thấy, người viết vẫn thấy). Cần `pages_manage_engagement`.
    pub async fn hide_comment(&self, page_token: &str, comment_id: &str) -> Result<(), GraphApiError> {
        self.post(
            comment_id,
            page_token,
            Vec::new(),
            Some(json!({ "is_hidden": true })),
            true,
        )
        .await
        .map(|_| ())
    }

    /// Tên hiển thị của khách (best-effort: cần `pages_user_profile` hoặc đã nhắn tin). Lỗi ⇒ `None`.
    pub async fn get_user_name(&self, psid: &str, page_token: &str) -> Option<String> {
        let r = self
            .get(psid, Some(page_token), q(&[("fields", "name,first_name,last_name")]))
            .await
            .ok()?;
        let s = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
        let name = s("name").unwrap_or_else(|| {
            format!(
                "{} {}",
                s("first_name").unwrap_or_default(),
                s("last_name").unwrap_or_default()
            )
            .trim()
            .to_owned()
        });
        (!name.is_empty()).then_some(name)
    }

    /// Tin gần nhất của hội thoại Page và khách (mới đến cũ), đọc thẳng từ Facebook để bù tin webhook không về.
    pub async fn get_recent_messages(
        &self,
        page_id: &str,
        psid: &str,
        page_token: &str,
        limit: u32,
    ) -> Result<Vec<ConversationMessage>, GraphApiError> {
        let fields = format!("messages.limit({limit}){{id,created_time,from,message}}");
        let r = self
            .get(
                &format!("{page_id}/conversations"),
                Some(page_token),
                q(&[("platform", "messenger"), ("user_id", psid), ("fields", &fields)]),
            )
            .await?;
        let msgs = r.pointer("/data/0/messages/data").cloned().unwrap_or_else(|| json!([]));
        Self::typed(msgs)
    }

    /// Tên khách lấy từ hội thoại của Page (`participants`): đường dự phòng khi `/{PSID}` bị chặn (người nhắn không có vai
    /// trò trong app mà app chưa được duyệt Business Asset User Profile Access). Lỗi ⇒ `None`.
    pub async fn get_conversation_name(&self, page_id: &str, psid: &str, page_token: &str) -> Option<String> {
        let r = self
            .get(
                &format!("{page_id}/conversations"),
                Some(page_token),
                q(&[("platform", "messenger"), ("user_id", psid), ("fields", "participants")]),
            )
            .await
            .ok()?;
        for c in r.get("data").and_then(Value::as_array)? {
            let found = c
                .pointer("/participants/data")
                .and_then(Value::as_array)
                .and_then(|p| p.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(psid)))
                .and_then(|x| x.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|n| !n.is_empty());
            if let Some(n) = found {
                return Some(n.to_owned());
            }
        }
        None
    }
}

fn access_token(r: &Value) -> Result<String, GraphApiError> {
    r.get("access_token")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| GraphApiError::plain("Facebook không trả access_token"))
}

/// `s.slice(0, n)` của JS tính theo đơn vị UTF-16 (không cắt giữa cặp thay thế).
pub(crate) fn utf16_prefix(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(http: u16, code: Option<i64>, sub: Option<i64>) -> GraphApiError {
        GraphApiError {
            http_status: http,
            code,
            subcode: sub,
            message: "m".into(),
            config_error: false,
        }
    }

    #[test]
    fn phan_loai_ma_loi_graph() {
        assert!(e(400, Some(190), None).is_token_error() && !e(400, Some(10), None).is_token_error());
        for c in [10, 200, 250, 299] {
            assert!(e(403, Some(c), None).is_permission_error(), "{c}");
        }
        for c in [9, 300, 190, 4] {
            assert!(!e(400, Some(c), None).is_permission_error(), "{c}");
        }
        for c in [4, 17, 32, 613] {
            assert!(e(400, Some(c), None).is_rate_limit(), "{c}");
        }
        assert!(
            e(429, None, None).is_rate_limit()
                && !e(400, Some(368), None).is_rate_limit()
                && !e(500, None, None).is_rate_limit()
        );
        assert!(e(400, Some(10), Some(2_018_278)).is_outside_window());
        assert!(e(400, Some(551), Some(1_545_041)).is_outside_window());
        assert!(e(400, Some(1_545_041), None).is_outside_window());
        assert!(!e(400, Some(551), None).is_outside_window() && !e(400, Some(10), None).is_outside_window());
        assert!(
            GraphApiError {
                config_error: true,
                ..e(0, None, None)
            }
            .is_config_error()
        );
    }

    #[test]
    fn cat_theo_utf16() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("Xin chào các bạn ơi, hôm nay", 20), "Xin chào các bạn ơi,");
        // Emoji chiếm 2 đơn vị UTF-16: không cắt đôi.
        assert_eq!(utf16_prefix("ab😀", 3), "ab");
        assert_eq!(utf16_prefix("ab😀", 4), "ab😀");
    }
}
