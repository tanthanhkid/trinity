//! Sentry (PLAN 4.12): TẮT mặc định — không có `SENTRY_DSN` thì không tạo client, không gọi mạng. Chỉ lỗi 5xx; sự
//! kiện qua [`crate::scrub_sentry_event`] trước khi rời tiến trình; id người dùng chỉ ở dạng băm. Tên biến và
//! mặc định giữ như `apps/monolith/src/monitoring.ts`.

use std::path::PathBuf;

use sentry::protocol::{Breadcrumb, Event, User};
use sentry::{ClientInitGuard, ClientOptions, MaxRequestBodySize};

use crate::{scrub_sentry_event, scrub_url};

const DEFAULT_TRACES_SAMPLE_RATE: f32 = 0.1;

/// Cấu hình giám sát đọc từ biến môi trường.
#[derive(Clone, PartialEq)]
pub struct MonitoringConfig {
    pub sentry_dsn: Option<String>,
    pub environment: String,
    pub release: Option<String>,
    pub traces_sample_rate: f32,
    /// `MONITORING_HASH_SECRET`, không có thì `JWT_SECRET`.
    pub hash_secret: Option<String>,
    pub posthog_key: Option<String>,
    pub posthog_host: String,
}

impl std::fmt::Debug for MonitoringConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MonitoringConfig")
            .field("sentry", &self.sentry_dsn.is_some())
            .field("environment", &self.environment)
            .field("release", &self.release)
            .field("posthog", &self.posthog_key.is_some())
            .finish_non_exhaustive()
    }
}

impl MonitoringConfig {
    /// Đọc biến qua `get` (để test không đụng môi trường thật). Giá trị rỗng/khoảng trắng coi như không đặt.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let rate = val("SENTRY_TRACES_SAMPLE_RATE")
            .and_then(|v| v.parse::<f32>().ok())
            .filter(|r| r.is_finite() && (0.0..=1.0).contains(r))
            .unwrap_or(DEFAULT_TRACES_SAMPLE_RATE);
        Self {
            sentry_dsn: val("SENTRY_DSN"),
            environment: val("SENTRY_ENVIRONMENT").unwrap_or_else(|| "production".to_owned()),
            release: resolve_release(&get),
            traces_sample_rate: rate,
            hash_secret: val("MONITORING_HASH_SECRET").or_else(|| val("JWT_SECRET")),
            posthog_key: val("POSTHOG_KEY"),
            posthog_host: val("POSTHOG_HOST").unwrap_or_else(|| "https://us.i.posthog.com".to_owned()),
        }
    }
}

/// `TRINITY_RELEASE`, rồi 7 ký tự đầu của `VERCEL_GIT_COMMIT_SHA`, rồi tệp `.release` trong `APP_ROOT` (hoặc thư mục
/// hiện tại) — như `resolveRelease()` của `packages/logger`.
pub fn resolve_release(get: &impl Fn(&str) -> Option<String>) -> Option<String> {
    let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
    if let Some(r) = val("TRINITY_RELEASE") {
        return Some(r);
    }
    if let Some(sha) = val("VERCEL_GIT_COMMIT_SHA") {
        return Some(sha.chars().take(7).collect());
    }
    let root = val("APP_ROOT")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())?;
    let v = std::fs::read_to_string(root.join(".release")).ok()?;
    Some(v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Tuỳ chọn client Sentry đã gắn bộ lọc. Tách riêng để test chạy được với transport giả.
pub fn client_options(cfg: &MonitoringConfig) -> ClientOptions {
    let mut opts = ClientOptions::new()
        .environment(cfg.environment.clone())
        .send_default_pii(false)
        .max_request_body_size(MaxRequestBodySize::None)
        .auto_session_tracking(false)
        .before_send(|ev: Event<'static>| {
            // Chỉ lỗi 5xx: sự kiện gắn mã trạng thái < 500 bị bỏ.
            let status = ev.tags.get("http.status_code").and_then(|s| s.parse::<u16>().ok());
            if status.is_some_and(|s| s < 500) {
                return None;
            }
            scrub_sentry_event(ev)
        })
        .before_breadcrumb(|mut b: Breadcrumb| {
            if b.category.as_deref() == Some("console") {
                return None;
            }
            if let Some(serde_json::Value::String(u)) = b.data.get_mut("url") {
                *u = scrub_url(u);
            }
            if let Some(m) = b.message.as_mut() {
                *m = crate::scrub_text(m);
            }
            Some(b)
        });
    if let Some(r) = &cfg.release {
        opts = opts.release(r.clone());
    }
    opts.traces_sample_rate(cfg.traces_sample_rate)
}

/// Khởi tạo Sentry. `None` (không tạo client, không có kết nối mạng nào) khi thiếu `SENTRY_DSN` hoặc DSN sai. Giữ
/// guard đến hết tiến trình: thả guard là xả hàng đợi và tắt client.
pub fn init_sentry(cfg: &MonitoringConfig) -> Option<ClientInitGuard> {
    let dsn = cfg.sentry_dsn.as_deref()?;
    let opts = match dsn.parse::<sentry::types::Dsn>() {
        Ok(_) => client_options(cfg).dsn(dsn),
        Err(e) => {
            tracing::warn!(target: "trinity::obs", "SENTRY_DSN không hợp lệ ({e}), Sentry tắt");
            return None;
        }
    };
    let guard = sentry::init(opts);
    guard.is_enabled().then_some(guard)
}

/// Ngữ cảnh một lỗi máy chủ.
#[derive(Debug, Default, Clone)]
pub struct ErrorContext<'a> {
    pub method: Option<&'a str>,
    pub url: Option<&'a str>,
    /// Id người dùng đã băm ([`crate::log::UserIdHasher`]); không bao giờ truyền id thô.
    pub user_hash: Option<&'a str>,
}

/// Báo một lỗi máy chủ lên Sentry; chỉ mã >= 500 được báo, còn lại bỏ ngay. Không có client (Sentry tắt) thì không
/// làm gì. Không bao giờ panic.
pub fn report_server_error(status: u16, err: &(dyn std::error::Error + 'static), ctx: &ErrorContext<'_>) {
    if status < 500 {
        return;
    }
    sentry::with_scope(
        |scope| {
            if let Some(m) = ctx.method {
                scope.set_tag("http.method", m);
            }
            scope.set_tag("http.status_code", status.to_string());
            if let Some(u) = ctx.url {
                scope.set_tag("url", scrub_url(u));
            }
            if let Some(h) = ctx.user_hash {
                scope.set_user(Some(User {
                    id: Some(h.to_owned()),
                    ..Default::default()
                }));
            }
        },
        || {
            sentry::capture_error(err);
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn bien_rong_thi_tat_het_va_khong_tao_client() {
        let cfg = MonitoringConfig::from_env(env(&[("SENTRY_DSN", "  "), ("POSTHOG_KEY", "")]));
        assert!(cfg.sentry_dsn.is_none() && cfg.posthog_key.is_none());
        assert!(init_sentry(&cfg).is_none());
        assert!(sentry::Hub::current().client().is_none());
    }

    #[test]
    fn mac_dinh_va_ty_le_sai() {
        let c = MonitoringConfig::from_env(env(&[("SENTRY_TRACES_SAMPLE_RATE", "2")]));
        assert_eq!((c.traces_sample_rate, c.environment.as_str()), (0.1, "production"));
        assert_eq!(c.posthog_host, "https://us.i.posthog.com");
        let c = MonitoringConfig::from_env(env(&[
            ("SENTRY_TRACES_SAMPLE_RATE", "0.25"),
            ("JWT_SECRET", "j"),
            ("TRINITY_RELEASE", "r1"),
        ]));
        assert_eq!(
            (c.traces_sample_rate, c.hash_secret.as_deref(), c.release.as_deref()),
            (0.25, Some("j"), Some("r1"))
        );
        let c = MonitoringConfig::from_env(env(&[("MONITORING_HASH_SECRET", "m"), ("JWT_SECRET", "j")]));
        assert_eq!(c.hash_secret.as_deref(), Some("m"));
        assert!(format!("{c:?}").find("\"m\"").is_none());
    }

    #[test]
    fn release_tu_sha_vercel() {
        let g = env(&[("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef")]);
        assert_eq!(resolve_release(&g).as_deref(), Some("0123456"));
    }

    #[test]
    fn chi_5xx_len_sentry_va_su_kien_da_loc() {
        let cfg = MonitoringConfig::from_env(env(&[("SENTRY_DSN", "http://k@localhost/1")]));
        let events = sentry::test::with_captured_events_options(
            || {
                let err = std::io::Error::other("hỏng khi gửi cho a@b.co số 0912345678");
                let ctx = ErrorContext {
                    method: Some("POST"),
                    url: Some("/api/v1/x?email=a@b.co&token=t"),
                    user_hash: Some("abc123"),
                };
                report_server_error(404, &err, &ctx);
                report_server_error(499, &err, &ctx);
                report_server_error(500, &err, &ctx);
                sentry::add_breadcrumb(Breadcrumb {
                    category: Some("http".into()),
                    message: Some("gọi 0912345678".into()),
                    ..Default::default()
                });
                report_server_error(503, &err, &ctx);
            },
            client_options(&cfg),
        );
        assert_eq!(events.len(), 2, "chỉ 500 và 503");
        let s = serde_json::to_string(&events).unwrap();
        for leak in ["a@b.co", "0912345678", "token=t", "email="] {
            assert!(!s.contains(leak), "{leak} còn trong {s}");
        }
        assert_eq!(events[0].user.as_ref().and_then(|u| u.id.as_deref()), Some("abc123"));
        assert_eq!(events[0].tags.get("url").map(String::as_str), Some("/api/v1/x"));
    }
}
