//! Sự kiện sản phẩm gửi từ máy chủ (PostHog capture API) — bản Rust của `packages/logger/src/product-events.ts`.
//! TẮT mặc định: thiếu khoá PostHog hoặc khoá băm thì [`ProductEvents`] ở trạng thái tắt, không tạo client HTTP, không
//! gọi mạng. Thuộc tính chỉ nhận khoá, số đếm, boolean; gửi không chờ, không bao giờ làm hỏng request.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::MonitoringConfig;
use crate::log::UserIdHasher;

const MAX_STRING: usize = 60;
const ANONYMOUS: &str = "anonymous-server";

/// Giá trị thuộc tính của sự kiện.
#[derive(Debug, Clone, PartialEq)]
pub enum PropValue {
    Bool(bool),
    Num(f64),
    Str(String),
    Null,
}

impl From<bool> for PropValue {
    fn from(v: bool) -> Self {
        Self::Bool(v)
    }
}
impl From<u32> for PropValue {
    fn from(v: u32) -> Self {
        Self::Num(f64::from(v))
    }
}
impl From<&str> for PropValue {
    fn from(v: &str) -> Self {
        Self::Str(v.to_owned())
    }
}

/// Lọc thuộc tính như `sanitizeProps` của bản TS: giữ boolean và số hữu hạn; chuỗi chứa `@` hoặc dãy >= 8 chữ số bị
/// bỏ, chuỗi dài bị cắt còn 60 ký tự; `Null` bỏ.
pub fn sanitize_props(props: &[(&str, PropValue)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in props {
        let val = match v {
            PropValue::Bool(b) => Value::Bool(*b),
            PropValue::Num(n) => match serde_json::Number::from_f64(*n) {
                Some(n) => Value::Number(n),
                None => continue,
            },
            PropValue::Str(s) => {
                if s.contains('@') || has_digit_run(s, 8) {
                    continue;
                }
                Value::String(s.chars().take(MAX_STRING).collect())
            }
            PropValue::Null => continue,
        };
        out.insert((*k).to_owned(), val);
    }
    out
}

fn has_digit_run(s: &str, n: usize) -> bool {
    let mut run = 0;
    for c in s.chars() {
        run = if c.is_ascii_digit() { run + 1 } else { 0 };
        if run >= n {
            return true;
        }
    }
    false
}

/// 7 sự kiện máy chủ hiện có (`docs/deployment.md`, mục "Server events").
#[derive(Debug, Clone, PartialEq)]
pub enum ProductEvent<'a> {
    OnboardingStep {
        step: &'a str,
        confirmed: bool,
    },
    FeatureToggled {
        feature: &'a str,
        enabled: bool,
    },
    PlanChanged {
        plan: &'a str,
    },
    TableCreated {
        fields: u32,
    },
    TableUpdated {
        fields: u32,
    },
    /// `source`: `web`, `mcp` hoặc `csv`.
    PostPublished {
        networks: u32,
        scheduled: bool,
        source: &'a str,
    },
    CommentRuleSaved {
        created: bool,
        actions: u32,
    },
}

impl ProductEvent<'_> {
    pub fn name(&self) -> &'static str {
        match self {
            Self::OnboardingStep { .. } => "onboarding_step",
            Self::FeatureToggled { .. } => "feature_toggled",
            Self::PlanChanged { .. } => "plan_changed",
            Self::TableCreated { .. } => "table_created",
            Self::TableUpdated { .. } => "table_updated",
            Self::PostPublished { .. } => "post_published",
            Self::CommentRuleSaved { .. } => "comment_rule_saved",
        }
    }

    fn props(&self) -> Vec<(&'static str, PropValue)> {
        match self {
            Self::OnboardingStep { step, confirmed } => vec![
                ("step", (*step).into()),
                ("action", if *confirmed { "confirm" } else { "skip" }.into()),
            ],
            Self::FeatureToggled { feature, enabled } => {
                vec![("feature", (*feature).into()), ("enabled", (*enabled).into())]
            }
            Self::PlanChanged { plan } => vec![("plan", (*plan).into())],
            Self::TableCreated { fields } | Self::TableUpdated { fields } => vec![("fields", (*fields).into())],
            Self::PostPublished {
                networks,
                scheduled,
                source,
            } => vec![
                ("networks", (*networks).into()),
                ("scheduled", (*scheduled).into()),
                ("source", (*source).into()),
            ],
            Self::CommentRuleSaved { created, actions } => {
                vec![("created", (*created).into()), ("actions", (*actions).into())]
            }
        }
    }
}

struct Active {
    key: String,
    url: String,
    environment: String,
    release: Option<String>,
    hasher: UserIdHasher,
    client: reqwest::Client,
}

/// Bộ gửi sự kiện sản phẩm. Rẻ để `clone`.
#[derive(Clone, Default)]
pub struct ProductEvents(Option<Arc<Active>>);

impl std::fmt::Debug for ProductEvents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProductEvents(enabled={})", self.enabled())
    }
}

impl ProductEvents {
    /// Bộ tắt: mọi lần `track` là no-op.
    pub fn disabled() -> Self {
        Self(None)
    }

    /// Bật khi có cả `POSTHOG_KEY` và khoá băm (như TS: không khoá băm thì không gửi gì, vì không định danh được).
    /// Provider TLS (`ring`) phải đã được cài trước khi gọi, như mọi client reqwest khác của tiến trình.
    pub fn from_config(cfg: &MonitoringConfig) -> Self {
        if cfg.node_env.as_deref() == Some("test") {
            return Self::disabled();
        }
        let (Some(key), Some(secret)) = (cfg.posthog_key.as_deref(), cfg.hash_secret.as_deref()) else {
            return Self::disabled();
        };
        let Ok(hasher) = UserIdHasher::new(secret) else {
            return Self::disabled();
        };
        if !crate::monitoring::tls_provider_ready("PostHog") {
            return Self::disabled();
        }
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
        else {
            return Self::disabled();
        };
        Self(Some(Arc::new(Active {
            key: key.to_owned(),
            url: format!("{}/i/v0/e/", cfg.posthog_host.trim_end_matches('/')),
            environment: cfg.environment.clone(),
            release: cfg.release.clone(),
            hasher,
            client,
        })))
    }

    pub fn enabled(&self) -> bool {
        self.0.is_some()
    }

    /// Nội dung gửi đi (tách ra để test). `None` khi tắt.
    pub fn payload(&self, event: &ProductEvent<'_>, user_id: Option<&str>) -> Option<Value> {
        let a = self.0.as_ref()?;
        let mut props = sanitize_props(&event.props());
        props.insert("environment".into(), json!(a.environment));
        if let Some(r) = &a.release {
            props.insert("release".into(), json!(r));
        }
        props.insert("$lib".into(), json!("trinity-server"));
        let distinct_id = match user_id {
            Some(id) => a.hasher.hash(id),
            None => {
                props.insert("$process_person_profile".into(), json!(false));
                ANONYMOUS.to_owned()
            }
        };
        Some(json!({"api_key": a.key, "event": event.name(), "distinct_id": distinct_id, "properties": props}))
    }

    /// Gửi không chờ (task nền). Tắt, hoặc không có runtime tokio ⇒ không làm gì. Lỗi mạng nuốt im.
    pub fn track(&self, event: &ProductEvent<'_>, user_id: Option<&str>) {
        let (Some(a), Some(body)) = (self.0.clone(), self.payload(event, user_id)) else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            let _ = a.client.post(&a.url).json(&body).send().await;
        });
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn cfg(key: Option<&str>, secret: Option<&str>, host: &str) -> MonitoringConfig {
        let k = key.map(str::to_owned);
        let s = secret.map(str::to_owned);
        let h = host.to_owned();
        MonitoringConfig::from_env(move |n| match n {
            "POSTHOG_KEY" => k.clone(),
            "MONITORING_HASH_SECRET" => s.clone(),
            "POSTHOG_HOST" => Some(h.clone()),
            _ => None,
        })
    }

    #[test]
    fn loc_thuoc_tinh_nhu_ban_ts() {
        let p = sanitize_props(&[
            ("ok", "plan_pro".into()),
            ("email", "a@b.co".into()),
            ("phone", "0912345678".into()),
            ("short_digits", "1234567".into()),
            ("long", PropValue::Str("x".repeat(100))),
            ("n", PropValue::Num(3.0)),
            ("nan", PropValue::Num(f64::NAN)),
            ("b", true.into()),
            ("null", PropValue::Null),
        ]);
        assert_eq!(p["ok"], "plan_pro");
        assert_eq!(p["short_digits"], "1234567");
        assert_eq!(p["long"].as_str().map(str::len), Some(60));
        assert_eq!((p["n"].as_f64(), p["b"].as_bool()), (Some(3.0), Some(true)));
        assert!(
            !p.contains_key("email") && !p.contains_key("phone") && !p.contains_key("nan") && !p.contains_key("null")
        );
    }

    #[test]
    fn bay_su_kien_dung_ten_va_thuoc_tinh() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let ev = ProductEvents::from_config(&cfg(Some("phc_k"), Some("s"), "http://127.0.0.1:1"));
        let all = [
            (
                ProductEvent::OnboardingStep {
                    step: "company",
                    confirmed: false,
                },
                "onboarding_step",
            ),
            (
                ProductEvent::FeatureToggled {
                    feature: "pos",
                    enabled: true,
                },
                "feature_toggled",
            ),
            (ProductEvent::PlanChanged { plan: "pro" }, "plan_changed"),
            (ProductEvent::TableCreated { fields: 4 }, "table_created"),
            (ProductEvent::TableUpdated { fields: 5 }, "table_updated"),
            (
                ProductEvent::PostPublished {
                    networks: 2,
                    scheduled: true,
                    source: "mcp",
                },
                "post_published",
            ),
            (
                ProductEvent::CommentRuleSaved {
                    created: true,
                    actions: 3,
                },
                "comment_rule_saved",
            ),
        ];
        for (e, name) in &all {
            let p = ev.payload(e, Some("42")).unwrap();
            assert_eq!(p["event"], *name);
            assert_eq!(p["properties"]["$lib"], "trinity-server");
        }
        let p = ev.payload(&all[0].0, None).unwrap();
        assert_eq!(p["distinct_id"], "anonymous-server");
        assert_eq!(p["properties"]["action"], "skip");
        assert_eq!(p["properties"]["$process_person_profile"], false);
    }

    #[test]
    fn node_env_test_thi_tat() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let c = MonitoringConfig::from_env(|n| match n {
            "POSTHOG_KEY" => Some("k".to_owned()),
            "MONITORING_HASH_SECRET" => Some("s".to_owned()),
            "NODE_ENV" => Some("test".to_owned()),
            _ => None,
        });
        assert!(!ProductEvents::from_config(&c).enabled());
    }

    #[tokio::test]
    async fn thieu_khoa_hoac_khoa_bam_thi_tat_khong_goi_mang() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", l.local_addr().unwrap());
        for c in [
            cfg(None, Some("s"), &host),
            cfg(Some("k"), None, &host),
            cfg(Some("k"), Some(""), &host),
        ] {
            let ev = ProductEvents::from_config(&c);
            assert!(!ev.enabled() && ev.payload(&ProductEvent::PlanChanged { plan: "x" }, None).is_none());
            ev.track(&ProductEvent::PlanChanged { plan: "x" }, Some("1"));
        }
        let accepted = tokio::time::timeout(std::time::Duration::from_millis(300), l.accept()).await;
        assert!(accepted.is_err(), "không được có kết nối nào");
    }

    #[tokio::test]
    async fn bat_thi_gui_dung_duong_dan_va_khong_lo_id_tho() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}/", l.local_addr().unwrap());
        let ev = ProductEvents::from_config(&cfg(Some("phc_k"), Some("secret"), &host));
        ev.track(&ProductEvent::PlanChanged { plan: "pro" }, Some("987654321"));
        let (mut sock, _) = tokio::time::timeout(std::time::Duration::from_secs(5), l.accept())
            .await
            .unwrap()
            .unwrap();
        let mut buf = vec![0u8; 8192];
        let mut got = 0;
        // Đọc tới khi đủ thân JSON.
        let text = loop {
            let n = sock.read(&mut buf[got..]).await.unwrap();
            got += n;
            let t = String::from_utf8_lossy(&buf[..got]).into_owned();
            if t.contains("\r\n\r\n") && t.trim_end().ends_with('}') || n == 0 {
                break t;
            }
        };
        let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await;
        assert!(text.starts_with("POST /i/v0/e/ HTTP/1.1"), "{text}");
        assert!(text.contains("\"event\":\"plan_changed\""));
        assert!(!text.contains("987654321"), "id thô lộ: {text}");
    }
}
