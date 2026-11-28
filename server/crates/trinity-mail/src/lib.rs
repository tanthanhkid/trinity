//! Gửi mail qua SMTP (#675). Bản Rust trước đây không gửi mail nào; crate này chỉ lo một việc: dựng thư (text + HTML,
//! `Reply-To`, header `X-SES-CONFIGURATION-SET` tuỳ chọn) và đẩy qua SMTP bằng `lettre` (rustls, provider `ring`).
//!
//! Cấu hình (thiếu `SMTP_HOST` hoặc `MAIL_FROM` ⇒ không có mailer, nơi gọi tự ẩn tính năng cần mail):
//! - `SMTP_HOST`, `SMTP_PORT` (mặc định 587), `SMTP_USER`, `SMTP_PASS`;
//! - `SMTP_SECURITY`: `starttls` (mặc định, cổng 587), `tls` (TLS ngay từ đầu, cổng 465), `none` (chỉ cho SMTP giả chạy
//!   trên máy như mailpit; không bao giờ dùng với máy chủ thật vì mật khẩu đi dạng rõ);
//! - `MAIL_FROM` (vd `Trinity <no-reply@example.com>`), `MAIL_REPLY_TO` (tuỳ chọn);
//! - `SES_CONFIGURATION_SET` (tuỳ chọn) ⇒ header `X-SES-CONFIGURATION-SET` để Amazon SES ghi sự kiện gửi/nảy/khiếu nại.

#![allow(clippy::result_large_err)]

pub mod template;

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use lettre::message::header::{ContentType, Header, HeaderName, HeaderValue};
use lettre::message::{Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

/// Cách nối TLS tới máy chủ SMTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmtpSecurity {
    /// Nối thường rồi nâng cấp bằng `STARTTLS` (bắt buộc, không rơi về dạng rõ). Cổng 587.
    StartTls,
    /// TLS ngay từ đầu (SMTPS). Cổng 465.
    Tls,
    /// Không mã hoá: chỉ cho SMTP giả trên máy (mailpit, test).
    None,
}

/// Cấu hình SMTP đọc từ env.
#[derive(Clone)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub pass: Option<String>,
    pub security: SmtpSecurity,
    pub from: Mailbox,
    pub reply_to: Option<Mailbox>,
    pub ses_configuration_set: Option<String>,
}

impl std::fmt::Debug for SmtpConfig {
    // Không in mật khẩu SMTP vào log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("pass", &self.pass.as_ref().map(|_| "[ẩn]"))
            .field("security", &self.security)
            .field("from", &self.from.to_string())
            .field("reply_to", &self.reply_to.as_ref().map(ToString::to_string))
            .field("ses_configuration_set", &self.ses_configuration_set)
            .finish()
    }
}

impl SmtpConfig {
    /// `Ok(None)`: chưa cấu hình (thiếu `SMTP_HOST` hoặc `MAIL_FROM`). `Err`: có cấu hình nhưng sai (cổng, địa chỉ…).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let val = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let (Some(host), Some(from)) = (val("SMTP_HOST"), val("MAIL_FROM")) else {
            return Ok(None);
        };
        let security = match val("SMTP_SECURITY").map(|s| s.to_ascii_lowercase()).as_deref() {
            None | Some("starttls") => SmtpSecurity::StartTls,
            Some("tls" | "ssl" | "smtps") => SmtpSecurity::Tls,
            Some("none") => SmtpSecurity::None,
            Some(other) => return Err(format!("SMTP_SECURITY không hợp lệ: {other} (starttls | tls | none)")),
        };
        let default_port = if security == SmtpSecurity::Tls { 465 } else { 587 };
        let port = match val("SMTP_PORT") {
            None => default_port,
            Some(p) => p
                .parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or_else(|| format!("SMTP_PORT không hợp lệ: {p}"))?,
        };
        let from: Mailbox = from.parse().map_err(|e| format!("MAIL_FROM không hợp lệ: {e}"))?;
        let reply_to = match val("MAIL_REPLY_TO") {
            None => None,
            Some(r) => Some(
                r.parse::<Mailbox>()
                    .map_err(|e| format!("MAIL_REPLY_TO không hợp lệ: {e}"))?,
            ),
        };
        let ses = val("SES_CONFIGURATION_SET");
        if let Some(s) = &ses
            && !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(format!("SES_CONFIGURATION_SET không hợp lệ: {s}"));
        }
        Ok(Some(Self {
            host,
            port,
            user: val("SMTP_USER"),
            pass: val("SMTP_PASS"),
            security,
            from,
            reply_to,
            ses_configuration_set: ses,
        }))
    }
}

/// Một thư cần gửi: một người nhận, tiêu đề, bản chữ và bản HTML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingMail {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// Lỗi gửi mail (nội dung chỉ để ghi log, không trả ra ngoài).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailError(pub String);

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MailError {}

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), MailError>> + Send + 'a>>;

/// Nơi gửi thư: SMTP thật ([`SmtpMailer`]) hoặc hộp thư giả trong test ([`MemoryMailer`]).
pub trait MailSender: Send + Sync {
    fn send(&self, mail: OutgoingMail) -> SendFuture<'_>;
}

/// Header `X-SES-CONFIGURATION-SET` của Amazon SES.
#[derive(Debug, Clone)]
struct SesConfigurationSet(String);

impl Header for SesConfigurationSet {
    fn name() -> HeaderName {
        HeaderName::new_from_ascii_str("X-SES-CONFIGURATION-SET")
    }

    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(s.to_owned()))
    }

    fn display(&self) -> HeaderValue {
        HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// Dựng thư MIME `multipart/alternative` (text trước, HTML sau) theo cấu hình.
pub fn build_message(cfg: &SmtpConfig, mail: &OutgoingMail) -> Result<Message, MailError> {
    let to: Mailbox = mail
        .to
        .parse()
        .map_err(|e| MailError(format!("địa chỉ nhận không hợp lệ: {e}")))?;
    // Message-ID theo tên máy (thiếu header này thì bộ lọc thư rác trừ điểm).
    let mut b = Message::builder()
        .from(cfg.from.clone())
        .to(to)
        .subject(mail.subject.clone())
        .message_id(None);
    if let Some(r) = &cfg.reply_to {
        b = b.reply_to(r.clone());
    }
    if let Some(set) = &cfg.ses_configuration_set {
        b = b.header(SesConfigurationSet(set.clone()));
    }
    b.multipart(
        MultiPart::alternative()
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(mail.text.clone()),
            )
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_HTML)
                    .body(mail.html.clone()),
            ),
    )
    .map_err(|e| MailError(format!("dựng thư: {e}")))
}

/// Gửi qua SMTP thật (kết nối dùng lại trong pool của lettre).
pub struct SmtpMailer {
    cfg: SmtpConfig,
    transport: AsyncSmtpTransport<Tokio1Executor>,
}

impl SmtpMailer {
    pub fn new(cfg: SmtpConfig) -> Result<Self, MailError> {
        let builder = match cfg.security {
            SmtpSecurity::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
                .map_err(|e| MailError(format!("SMTP STARTTLS: {e}")))?,
            SmtpSecurity::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
                .map_err(|e| MailError(format!("SMTP TLS: {e}")))?,
            SmtpSecurity::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
        };
        let mut builder = builder.port(cfg.port).timeout(Some(std::time::Duration::from_secs(20)));
        if let (Some(u), Some(p)) = (&cfg.user, &cfg.pass) {
            builder = builder.credentials(Credentials::new(u.clone(), p.clone()));
        }
        Ok(Self {
            transport: builder.build(),
            cfg,
        })
    }

    pub fn config(&self) -> &SmtpConfig {
        &self.cfg
    }
}

impl MailSender for SmtpMailer {
    fn send(&self, mail: OutgoingMail) -> SendFuture<'_> {
        Box::pin(async move {
            let msg = build_message(&self.cfg, &mail)?;
            self.transport
                .send(msg)
                .await
                .map(|_| ())
                .map_err(|e| MailError(format!("SMTP gửi lỗi: {e}")))
        })
    }
}

/// Hộp thư trong RAM cho test: giữ mọi thư đã "gửi".
#[derive(Debug, Default, Clone)]
pub struct MemoryMailer {
    pub sent: Arc<Mutex<Vec<OutgoingMail>>>,
}

impl MemoryMailer {
    pub fn take(&self) -> Vec<OutgoingMail> {
        std::mem::take(&mut *self.sent.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

impl MailSender for MemoryMailer {
    fn send(&self, mail: OutgoingMail) -> SendFuture<'_> {
        self.sent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(mail);
        Box::pin(async { Ok(()) })
    }
}

/// Mailer từ env: `Ok(None)` khi chưa cấu hình SMTP.
pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Arc<dyn MailSender>>, String> {
    match SmtpConfig::from_lookup(get)? {
        None => Ok(None),
        Some(cfg) => Ok(Some(Arc::new(SmtpMailer::new(cfg).map_err(|e| e.0)?))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let v: Vec<(String, String)> = pairs.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
        move |k| v.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone())
    }

    #[test]
    fn cau_hinh_thieu_thi_khong_co_mailer() {
        assert!(SmtpConfig::from_lookup(env(&[])).unwrap().is_none());
        assert!(
            SmtpConfig::from_lookup(env(&[("SMTP_HOST", "smtp.example.com")]))
                .unwrap()
                .is_none()
        );
        assert!(
            SmtpConfig::from_lookup(env(&[("MAIL_FROM", "a@example.com")]))
                .unwrap()
                .is_none()
        );
        assert!(
            SmtpConfig::from_lookup(env(&[("SMTP_HOST", " "), ("MAIL_FROM", "a@example.com")]))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn cau_hinh_day_du() {
        let c = SmtpConfig::from_lookup(env(&[
            ("SMTP_HOST", "smtp.example.com"),
            ("SMTP_USER", "u"),
            ("SMTP_PASS", "p"),
            ("MAIL_FROM", "Trinity <no-reply@example.com>"),
            ("MAIL_REPLY_TO", "ho-tro@example.com"),
            ("SES_CONFIGURATION_SET", "trinity-login"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(c.port, 587);
        assert_eq!(c.security, SmtpSecurity::StartTls);
        assert_eq!(c.from.email.to_string(), "no-reply@example.com");
        assert!(!format!("{c:?}").contains("\"p\""), "không in mật khẩu");
        let tls = SmtpConfig::from_lookup(env(&[
            ("SMTP_HOST", "h"),
            ("MAIL_FROM", "a@example.com"),
            ("SMTP_SECURITY", "tls"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!((tls.port, tls.security), (465, SmtpSecurity::Tls));
    }

    #[test]
    fn cau_hinh_sai_bao_loi() {
        let base = [("SMTP_HOST", "h"), ("MAIL_FROM", "a@example.com")];
        let with = |k: &'static str, v: &'static str| {
            let mut p = base.to_vec();
            p.push((k, v));
            SmtpConfig::from_lookup(env(&p))
        };
        assert!(with("SMTP_PORT", "0").is_err());
        assert!(with("SMTP_PORT", "abc").is_err());
        assert!(with("SMTP_SECURITY", "plain").is_err());
        assert!(with("MAIL_REPLY_TO", "khong-phai-email").is_err());
        assert!(with("SES_CONFIGURATION_SET", "a b\r\nBcc: x@y").is_err());
        assert!(SmtpConfig::from_lookup(env(&[("SMTP_HOST", "h"), ("MAIL_FROM", "xx")])).is_err());
    }

    #[test]
    fn thu_co_text_html_reply_to_va_header_ses() {
        let c = SmtpConfig::from_lookup(env(&[
            ("SMTP_HOST", "h"),
            ("MAIL_FROM", "Trinity <no-reply@example.com>"),
            ("MAIL_REPLY_TO", "ho-tro@example.com"),
            ("SES_CONFIGURATION_SET", "trinity-login"),
        ]))
        .unwrap()
        .unwrap();
        let m = build_message(
            &c,
            &OutgoingMail {
                to: "khach@example.com".into(),
                subject: "Mã đăng nhập Trinity: 123456".into(),
                text: "Mã: 123456".into(),
                html: "<p>Mã: <b>123456</b></p>".into(),
            },
        )
        .unwrap();
        let raw = String::from_utf8(m.formatted()).unwrap();
        assert!(raw.contains("Reply-To: ho-tro@example.com"), "{raw}");
        assert!(raw.contains("X-SES-CONFIGURATION-SET: trinity-login"), "{raw}");
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("text/plain") && raw.contains("text/html"), "{raw}");
        assert!(raw.contains("Message-ID:") && raw.contains("Date:"), "{raw}");
        // Tiêu đề có dấu được mã hoá theo RFC 2047.
        assert!(raw.contains("Subject: =?utf-8?"), "{raw}");
        assert!(
            build_message(
                &c,
                &OutgoingMail {
                    to: "khong hop le".into(),
                    subject: "s".into(),
                    text: "t".into(),
                    html: "h".into(),
                }
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn hop_thu_gia_giu_thu() {
        let m = MemoryMailer::default();
        let mail = OutgoingMail {
            to: "a@example.com".into(),
            subject: "s".into(),
            text: "t".into(),
            html: "h".into(),
        };
        m.send(mail.clone()).await.unwrap();
        assert_eq!(m.take(), vec![mail]);
        assert!(m.take().is_empty());
    }
}

#[cfg(feature = "testing")]
pub mod fake_smtp;
