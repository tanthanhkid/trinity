//! Chèn dữ liệu lúc chạy vào HTML đã xuất (bản xuất tĩnh không có máy chủ để render).
//!
//! - Tên miền phụ cửa hàng: `<meta name="store-slug" content="<slug>">` (R004: component đọc thẻ này trong `useEffect`).
//! - `/privacy`, `/terms`: `<script id="trinity-site-config" type="application/json">…</script>` chứa đúng nội dung
//!   `GET /api/v1/site-config` (trong đó có `legal.*` từ `LEGAL_*`), để trình thu thập của Meta thấy tên đơn vị mà không
//!   cần chạy JS. Trang đọc khối này trước, lùi về `GET /site-config` khi không có.

use serde_json::Value;

/// Chèn `snippet` ngay trước `</head>` đầu tiên. Không có `</head>` thì trả nguyên văn.
pub fn insert_before_head_end(html: &str, snippet: &str) -> String {
    match html.find("</head>") {
        Some(i) => {
            let mut out = String::with_capacity(html.len() + snippet.len());
            out.push_str(&html[..i]);
            out.push_str(snippet);
            out.push_str(&html[i..]);
            out
        }
        None => html.to_owned(),
    }
}

/// Thẻ `<meta name="store-slug">`. `slug` đã qua kiểm `[a-z0-9-]` nên không cần escape; vẫn escape để hàm tự an toàn.
pub fn store_slug_meta(slug: &str) -> String {
    format!(r#"<meta name="store-slug" content="{}">"#, escape_attr(slug))
}

/// Khối JSON cấu hình trang. Escape `<`, `>`, `&`, U+2028, U+2029 để chuỗi giá trị không thoát khỏi thẻ `<script>`.
pub fn site_config_script(config: &Value) -> String {
    let json = config.to_string();
    let mut safe = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' => safe.push_str("\\u003c"),
            '>' => safe.push_str("\\u003e"),
            '&' => safe.push_str("\\u0026"),
            '\u{2028}' => safe.push_str("\\u2028"),
            '\u{2029}' => safe.push_str("\\u2029"),
            c => safe.push(c),
        }
    }
    format!(r#"<script id="trinity-site-config" type="application/json">{safe}</script>"#)
}

/// Trần độ dài header `Link` (CDN và proxy hay cắt header lớn; 3 KB đủ cho ~30 tệp).
const LINK_HEADER_MAX: usize = 3072;

/// Header `Link: <…>; rel=preload; as=…` cho JS/CSS/font `/_next/static/` mà HTML nạp ngay (Early Hints).
///
/// Chỉ đọc đường dẫn bên trong thuộc tính `src`/`href` của thẻ `<script>`/`<link>`, theo thứ tự xuất hiện, bỏ trùng,
/// bỏ thẻ `nomodule` (polyfill trình duyệt cũ). Đường dẫn chỉ gồm ký tự an toàn (`[A-Za-z0-9._/-]`) nên không cần escape.
/// HTML tĩnh dùng chung cho mọi người dùng ⇒ header này không chứa dữ liệu riêng. `None` khi không có tệp nào.
pub fn preload_link_header(html: &str) -> Option<String> {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find("\"/_next/static/") {
        let start = i + 1;
        let after = &rest[start..];
        let Some(end) = after.find('"') else { break };
        let path = &after[..end];
        let tag_start = rest[..i].rfind('<').unwrap_or(0);
        let tag_head = &rest[tag_start..i];
        // Cả thẻ (thuộc tính `nomodule` đứng sau `src`): từ `<` tới `>` đầu tiên sau đường dẫn.
        let after_path = &rest[start + end..];
        let tag_end = after_path.find('>').map_or(after_path.len(), |k| k + 1);
        let nomodule = rest[tag_start..start + end + tag_end]
            .to_ascii_lowercase()
            .contains("nomodule");
        rest = after_path;
        let attr_ok = tag_head.ends_with("src=") || tag_head.ends_with("href=");
        let safe = path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'/' | b'-' | b'_'));
        if !attr_ok || !safe || nomodule || seen.contains(&path) {
            continue;
        }
        let (as_attr, extra) = match path.rsplit_once('.').map(|(_, e)| e) {
            Some("js") => ("script", ""),
            Some("css") => ("style", ""),
            Some("woff2") => ("font", "; crossorigin"),
            _ => continue,
        };
        let item = format!("<{path}>; rel=preload; as={as_attr}{extra}");
        let sep = if out.is_empty() { 0 } else { 2 };
        if out.len() + sep + item.len() > LINK_HEADER_MAX {
            break;
        }
        if sep > 0 {
            out.push_str(", ");
        }
        out.push_str(&item);
        seen.push(path);
    }
    (!out.is_empty()).then_some(out)
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chen_truoc_dong_head() {
        let html = "<html><head><title>a</title></head><body></body></html>";
        let out = insert_before_head_end(html, "<meta x>");
        assert_eq!(out, "<html><head><title>a</title><meta x></head><body></body></html>");
        assert_eq!(
            insert_before_head_end("<p>khong head</p>", "<meta x>"),
            "<p>khong head</p>"
        );
    }

    #[test]
    fn link_preload_tu_html() {
        let html = concat!(
            r#"<html><head><link rel="preload" href="/_next/static/chunks/a.js" as="script"/>"#,
            r#"<link rel="stylesheet" href="/_next/static/chunks/s.css"/>"#,
            r#"<link rel="preload" as="font" href="/_next/static/media/f.woff2" crossorigin=""/>"#,
            r#"<script src="/_next/static/chunks/a.js" async></script>"#,
            r#"<script src="/_next/static/chunks/poly.js" nomodule></script>"#,
            r#"<script>self.__next_f.push(["/_next/static/chunks/inline.js"])</script>"#,
            r#"<script src="/_next/static/chunks/b.js"></script></head></html>"#,
        );
        let got = preload_link_header(html).unwrap();
        assert_eq!(
            got,
            "</_next/static/chunks/a.js>; rel=preload; as=script, </_next/static/chunks/s.css>; rel=preload; as=style, \
</_next/static/media/f.woff2>; rel=preload; as=font; crossorigin, </_next/static/chunks/b.js>; rel=preload; as=script"
        );
        assert_eq!(preload_link_header("<html><head></head></html>"), None);
    }

    #[test]
    fn link_preload_co_tran_do_dai() {
        let mut html = String::new();
        for i in 0..400 {
            html.push_str(&format!(r#"<script src="/_next/static/chunks/c{i}.js"></script>"#));
        }
        let got = preload_link_header(&html).unwrap();
        assert!(got.len() <= LINK_HEADER_MAX);
        assert!(got.matches("rel=preload").count() > 20);
    }

    #[test]
    fn meta_slug_va_escape() {
        assert_eq!(
            store_slug_meta("cua-hang-1"),
            r#"<meta name="store-slug" content="cua-hang-1">"#
        );
        assert_eq!(
            store_slug_meta(r#"a"><script>"#),
            r#"<meta name="store-slug" content="a&quot;&gt;&lt;script&gt;">"#
        );
    }

    #[test]
    fn khoi_json_khong_thoat_khoi_the_script() {
        let cfg = json!({"legal": {"company_name": "A </script><b>&\u{2028}", "company_tax_id": null}});
        let out = site_config_script(&cfg);
        assert!(out.starts_with(r#"<script id="trinity-site-config" type="application/json">"#));
        assert!(out.ends_with("</script>"));
        // Chỉ còn đúng một thẻ đóng: cái của chính khối.
        assert_eq!(out.matches("</script>").count(), 1);
        assert_eq!(out.matches('<').count(), 2);
        let inner = out
            .strip_prefix(r#"<script id="trinity-site-config" type="application/json">"#)
            .and_then(|s| s.strip_suffix("</script>"))
            .unwrap();
        // Giải mã lại ra đúng giá trị gốc.
        assert_eq!(serde_json::from_str::<Value>(inner).unwrap(), cfg);
    }
}
