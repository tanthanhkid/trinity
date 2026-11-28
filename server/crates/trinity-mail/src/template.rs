//! Mẫu thư đăng nhập (#675) theo design system «Ánh xanh»: chữ Inter, màu chính #3A75A6, nền #FBFBFA, viền #EBEBE8.
//! HTML chỉ dùng bảng + style nội tuyến (Gmail/Outlook bỏ `<style>` và CSS ngoài), không ảnh, không link rút gọn; link đăng
//! nhập hiện nguyên văn dưới nút để người dùng thấy rõ tên miền.

use crate::OutgoingMail;

/// Mục đích của mã: đăng nhập thường hay xác nhận email khi nhận lời mời.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodePurpose<'a> {
    Login,
    /// Tên công ty mời.
    Invite(&'a str),
}

/// Thoát HTML cho chuỗi do người dùng đặt (tên công ty, link).
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Thư chứa mã 6 số và (tuỳ chọn) link đăng nhập một lần, hạn `minutes` phút.
pub fn login_code_mail(
    to: &str,
    code: &str,
    link: Option<&str>,
    minutes: u32,
    purpose: CodePurpose<'_>,
) -> OutgoingMail {
    let (subject, heading, lead) = match purpose {
        CodePurpose::Login => (
            format!("Mã đăng nhập Trinity: {code}"),
            "Đăng nhập Trinity".to_owned(),
            "Dùng mã dưới đây để đăng nhập vào Trinity.".to_owned(),
        ),
        CodePurpose::Invite(company) => (
            format!("Mã xác nhận Trinity: {code}"),
            "Xác nhận email".to_owned(),
            format!("Dùng mã dưới đây để xác nhận email và tham gia {company} trên Trinity."),
        ),
    };
    let mut text = format!("{heading}\n\n{lead}\n\nMã của bạn: {code}\n\n");
    if let Some(l) = link {
        text.push_str(&format!(
            "Hoặc mở link sau trên máy bạn đang đăng nhập (chỉ dùng được một lần):\n{l}\n\n"
        ));
    }
    text.push_str(&format!(
        "Mã và link hết hạn sau {minutes} phút. Nếu bạn không yêu cầu, hãy bỏ qua thư này — tài khoản của bạn vẫn an toàn.\n\n— Trinity\n"
    ));

    let font = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    let button = link.map_or_else(String::new, |l| {
        let l = escape_html(l);
        format!(
            r#"<tr><td style="padding:8px 32px 0 32px;{font}">
<p style="margin:0 0 16px 0;font-size:15px;line-height:22px;color:#17181c">Hoặc bấm nút để đăng nhập ngay trên máy này:</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:10px;background:#3a75a6">
<a href="{l}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px;{font}">Đăng nhập Trinity</a>
</td></tr></table>
<p style="margin:16px 0 0 0;font-size:13px;line-height:20px;color:#6b6f7b;word-break:break-all">Link chỉ dùng được một lần:<br><a href="{l}" style="color:#3a75a6">{l}</a></p>
</td></tr>"#
        )
    });
    let html = format!(
        r#"<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{subject}</title></head>
<body style="margin:0;padding:0;background:#fbfbfa">
<div style="display:none;max-height:0;overflow:hidden">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbfbfa"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #ebebe8;border-radius:16px">
<tr><td style="padding:32px 32px 0 32px;{font}">
<p style="margin:0 0 24px 0;font-size:17px;font-weight:700;color:#3a75a6;letter-spacing:-0.2px">Trinity</p>
<h1 style="margin:0 0 8px 0;font-size:22px;line-height:28px;font-weight:600;color:#17181c">{heading}</h1>
<p style="margin:0 0 20px 0;font-size:15px;line-height:22px;color:#17181c">{lead}</p>
<div style="margin:0 0 20px 0;padding:16px;background:#f2f6fa;border-radius:12px;text-align:center;font-size:32px;line-height:40px;font-weight:700;letter-spacing:8px;color:#17181c;font-variant-numeric:tabular-nums">{code}</div>
</td></tr>
{button}
<tr><td style="padding:24px 32px 32px 32px;{font}">
<p style="margin:0;font-size:13px;line-height:20px;color:#6b6f7b">Mã và link hết hạn sau {minutes} phút. Nếu bạn không yêu cầu, hãy bỏ qua thư này — tài khoản của bạn vẫn an toàn.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>"#,
        subject = escape_html(&subject),
        preheader = escape_html(&format!("Mã của bạn: {code}")),
        heading = escape_html(&heading),
        lead = escape_html(&lead),
        code = escape_html(code),
    );
    OutgoingMail {
        to: to.to_owned(),
        subject,
        text,
        html,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thu_dang_nhap_co_ma_link_va_tieu_de() {
        let m = login_code_mail(
            "a@example.com",
            "123456",
            Some("https://crm.example.com/auth/email#token=abc"),
            10,
            CodePurpose::Login,
        );
        assert_eq!(m.subject, "Mã đăng nhập Trinity: 123456");
        assert!(m.text.contains("123456") && m.text.contains("https://crm.example.com/auth/email#token=abc"));
        assert!(m.html.contains("#3a75a6") && m.html.contains("Inter"));
        assert!(m.html.contains("href=\"https://crm.example.com/auth/email#token=abc\""));
        assert!(m.text.contains("10 phút"));
    }

    #[test]
    fn thu_loi_moi_thoat_html_ten_cong_ty() {
        let m = login_code_mail("a@example.com", "000111", None, 10, CodePurpose::Invite("A&B <script>"));
        assert_eq!(m.subject, "Mã xác nhận Trinity: 000111");
        assert!(m.html.contains("A&amp;B &lt;script&gt;"));
        assert!(!m.html.contains("<script>"));
        assert!(!m.html.contains("Đăng nhập Trinity</a>"), "không link thì không nút");
        assert!(m.text.contains("A&B <script>"));
    }
}
