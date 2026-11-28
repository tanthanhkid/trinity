//! Gửi thật qua `lettre` tới SMTP giả trên máy (không thư nào ra ngoài).

use trinity_mail::fake_smtp::FakeSmtp;
use trinity_mail::template::{CodePurpose, login_code_mail};
use trinity_mail::{MailSender, SmtpConfig, SmtpMailer};

#[tokio::test]
async fn gui_qua_smtp_gia_doc_lai_duoc_ma() {
    let smtp = FakeSmtp::start().await.unwrap();
    let port = smtp.port.to_string();
    let cfg = SmtpConfig::from_lookup(|k| match k {
        "SMTP_HOST" => Some("127.0.0.1".into()),
        "SMTP_PORT" => Some(port.clone()),
        "SMTP_SECURITY" => Some("none".into()),
        "MAIL_FROM" => Some("Trinity <no-reply@example.com>".into()),
        "MAIL_REPLY_TO" => Some("ho-tro@example.com".into()),
        "SES_CONFIGURATION_SET" => Some("cfg-1".into()),
        _ => None,
    })
    .unwrap()
    .unwrap();
    let mailer = SmtpMailer::new(cfg).unwrap();
    let mail = login_code_mail(
        "khach@example.com",
        "654321",
        Some("https://crm.example.com/auth/email#token=t1"),
        10,
        CodePurpose::Login,
    );
    mailer.send(mail).await.unwrap();
    let got = smtp.wait_for(1).await;
    assert_eq!(got.len(), 1);
    let m = &got[0];
    assert_eq!(m.from, "no-reply@example.com");
    assert_eq!(m.to, vec!["khach@example.com".to_owned()]);
    assert_eq!(m.header("Reply-To").as_deref(), Some("ho-tro@example.com"));
    assert_eq!(m.header("X-SES-CONFIGURATION-SET").as_deref(), Some("cfg-1"));
    let body = m.decoded_text();
    assert!(body.contains("654321"), "{body}");
    assert!(body.contains("https://crm.example.com/auth/email#token=t1"), "{body}");
}
