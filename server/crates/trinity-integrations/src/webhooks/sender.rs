//! Dựng thân, ký, gửi một lần, ghi nhật ký (port `webhook-sender.service.ts` + `webhook-http-client.ts`). KHÔNG đụng bảng
//! delivery (việc của dispatcher, worker và endpoints).
//!
//! Chống SSRF dùng lớp K35 (`trinity_http::outbound`): kiểm đích trước, rồi client `reqwest` phân giải qua `SafeDnsResolver`
//! nên kiểm và kết nối dùng CÙNG kết quả DNS (rebinding vô tác dụng); không theo chuyển hướng; không đọc thân phản hồi.

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_http::outbound::ssrf::{
    HostResolver, SsrfBlocked, SsrfPolicy, SystemResolver, assert_safe_url, safe_client,
};

use super::secret::{KeyError, KeySource, decrypt_secret};
use super::signature::build_signature_header;
use crate::audit::{self, AuditEntry, AuditStatus, Channel};

pub const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct SendTarget {
    pub endpoint_id: i32,
    pub url: String,
    pub secret_enc: String,
    pub created_by: i32,
}

#[derive(Debug, Clone)]
pub struct SendItem {
    pub delivery_id: String,
    pub event_type: String,
    pub data: Value,
    pub created_at: DateTime<Utc>,
    pub attempt: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostResult {
    pub ok: bool,
    pub status_code: Option<i32>,
    /// Mã lỗi ngắn, an toàn để lưu và hiển thị (KHÔNG chứa URL, IP hay nội dung phản hồi).
    pub error: Option<String>,
    pub duration_ms: i64,
}

/// Người gửi: giữ client `reqwest` dựng một lần (tái dùng kết nối).
#[derive(Clone)]
pub struct Sender {
    policy: SsrfPolicy,
    resolver: Arc<dyn HostResolver>,
    client: reqwest::Client,
    key: KeySource,
    timeout: Duration,
}

impl Sender {
    pub fn new(policy: SsrfPolicy, resolver: Arc<dyn HostResolver>, key: KeySource) -> reqwest::Result<Self> {
        let client = safe_client(policy, Arc::clone(&resolver), DELIVERY_TIMEOUT)?;
        Ok(Self {
            policy,
            resolver,
            client,
            key,
            timeout: DELIVERY_TIMEOUT,
        })
    }

    /// DNS hệ thống, chính sách đọc từ env tiến trình.
    pub fn from_env(key: KeySource) -> reqwest::Result<Self> {
        Self::new(SsrfPolicy::from_process_env(), Arc::new(SystemResolver), key)
    }

    #[must_use]
    pub fn with_timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    pub fn policy(&self) -> SsrfPolicy {
        self.policy
    }

    pub fn resolver(&self) -> &Arc<dyn HostResolver> {
        &self.resolver
    }

    pub fn key(&self) -> Result<super::secret::Key, KeyError> {
        (self.key)()
    }

    /// Dựng thân JSON MỘT lần: chính các byte này vừa được ký vừa được gửi. Thứ tự khoá như bản Node
    /// (`id`, `type`, `created_at`, `data`).
    pub fn build_body(item: &SendItem) -> String {
        format!(
            "{{\"id\":{},\"type\":{},\"created_at\":{},\"data\":{}}}",
            json!(item.delivery_id),
            json!(item.event_type),
            json!(item.created_at.to_rfc3339_opts(SecondsFormat::Millis, true)),
            trinity_kernel::json::js_json(&item.data),
        )
    }

    /// Giải mã secret, ký và gửi MỘT lần. KHÔNG giữ kết nối DB trong lúc chờ HTTP (tối đa 10 giây): người gọi ghi nhật ký
    /// bằng [`Self::record`] trên kết nối lấy lại sau đó.
    pub async fn send(&self, target: &SendTarget, item: &SendItem) -> PostResult {
        let secret = (self.key)().and_then(|k| decrypt_secret(&target.secret_enc, &k));
        let secret = match secret {
            Ok(s) => s,
            Err(_) => {
                let code = "secret_unavailable";
                tracing::error!(
                    "Webhook endpoint={}: không giải mã được secret ({code})",
                    target.endpoint_id
                );
                return PostResult {
                    ok: false,
                    status_code: None,
                    error: Some(code.to_owned()),
                    duration_ms: 0,
                };
            }
        };
        let body = Self::build_body(item);
        let signature = build_signature_header(&secret, body.as_bytes(), Utc::now().timestamp_millis());
        self.post(&target.url, body, &item.event_type, &item.delivery_id, &signature)
            .await
    }

    /// POST JSON, không theo chuyển hướng, hạn `timeout` cho cả lượt (gồm phân giải DNS kiểm đích).
    pub async fn post(&self, url: &str, body: String, event: &str, delivery_id: &str, signature: &str) -> PostResult {
        let started = Instant::now();
        let done = |ok: bool, status: Option<i32>, error: Option<String>| PostResult {
            ok,
            status_code: status,
            error,
            duration_ms: i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
        };
        let work = async {
            assert_safe_url(url, self.policy, self.resolver.as_ref())
                .await
                .map_err(|_| "blocked_target".to_owned())?;
            let resp = self
                .client
                .post(url)
                .header("Content-Type", "application/json")
                .header("User-Agent", "Trinity-Webhooks/1.0")
                .header("X-Trinity-Event", event)
                .header("X-Trinity-Delivery", delivery_id)
                .header("X-Trinity-Signature", signature)
                .body(body)
                .send()
                .await
                .map_err(|e| classify_network_error(&e))?;
            Ok::<i32, String>(i32::from(resp.status().as_u16()))
        };
        match tokio::time::timeout(self.timeout, work).await {
            Err(_) => done(false, None, Some("timeout".into())),
            Ok(Err(code)) => done(false, None, Some(code)),
            Ok(Ok(status)) => {
                let ok = (200..300).contains(&status);
                let err = if ok {
                    None
                } else if (300..400).contains(&status) {
                    Some("redirect_not_followed".to_owned())
                } else {
                    Some(format!("http_{status}"))
                };
                done(ok, Some(status), err)
            }
        }
    }

    /// Ghi nhật ký `webhook_out` (nuốt lỗi ghi). Nhật ký: KHÔNG ghi URL (có thể chứa token), KHÔNG ghi thân (có SĐT): chỉ định danh và kết quả.
    pub async fn record(&self, conn: &mut PgConnection, target: &SendTarget, item: &SendItem, res: &PostResult) {
        let mut e = AuditEntry::new(
            Channel::WebhookOut,
            &item.event_type,
            if res.ok { AuditStatus::Ok } else { AuditStatus::Error },
        );
        e.user_id = Some(target.created_by);
        e.resource = Some("webhook_endpoint".into());
        e.resource_id = Some(target.endpoint_id.to_string());
        e.http_status = res.status_code.map(i64::from);
        e.duration_ms = Some(res.duration_ms);
        e.error.clone_from(&res.error);
        e.metadata = Some(json!({"delivery_id": item.delivery_id, "attempt": item.attempt}));
        audit::log(conn, &e).await;
    }
}

/// Mã lỗi mạng ngắn (khớp `classifyNetworkError` của Node). Duyệt chuỗi nguyên nhân của lỗi `reqwest`.
pub fn classify_network_error(err: &reqwest::Error) -> String {
    let mut chain = Vec::new();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if e.downcast_ref::<SsrfBlocked>().is_some() {
            return "blocked_target".into();
        }
        chain.push(e.to_string().to_lowercase());
        if let Some(io) = e.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => return "connection_refused".into(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
                    return "connection_reset".into();
                }
                std::io::ErrorKind::TimedOut => return "timeout".into(),
                _ => {}
            }
        }
        cur = e.source();
    }
    let all = chain.join(" | ");
    if err.is_timeout() {
        "timeout".into()
    } else if all.contains("certificate") || all.contains("tls") || all.contains("ssl") || all.contains("handshake") {
        "tls_error".into()
    } else if all.contains("dns") || all.contains("resolve") || all.contains("lookup") {
        "dns_error".into()
    } else if all.contains("unreachable") {
        "unreachable".into()
    } else {
        "network_error".into()
    }
}
