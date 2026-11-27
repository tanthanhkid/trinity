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
