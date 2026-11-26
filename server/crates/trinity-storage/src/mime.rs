use crate::mime_db::TYPES;

/// `Content-Type` mà `/uploads` của bản Node trả cho một đường dẫn: `mime.lookup` của mime 1.6 (phần sau dấu `.`,
/// `/` hoặc `\` cuối cùng, chữ thường; không có trong bảng ⇒ `application/octet-stream`) cộng `; charset=UTF-8`
/// cho `text/*`, `application/javascript`, `application/json` (`mime.charsets.lookup`), đúng như gói `send` 0.19 ghép.
pub fn content_type_for_path(path: &str) -> String {
    // Regex `^.*[\.\/\\]` của JS không có cờ `s`: `.` không qua ký tự xuống dòng, nên chỉ tìm dấu ngăn cuối cùng
    // trong dòng đầu; không có thì cả chuỗi là phần mở rộng.
    let first_line = path
        .find(['\n', '\r', '\u{2028}', '\u{2029}'])
        .map_or(path, |i| &path[..i]);
    let ext = first_line
        .rfind(['.', '/', '\\'])
        .map_or(path, |i| &path[i + 1..])
        .to_lowercase();
    let ty = TYPES
        .binary_search_by(|(e, _)| (*e).cmp(ext.as_str()))
        .map_or("application/octet-stream", |i| TYPES[i].1);
    if ty.starts_with("text/") || ty.starts_with("application/javascript") || ty.starts_with("application/json") {
        format!("{ty}; charset=UTF-8")
    } else {
        ty.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Giá trị lấy bằng mime 1.6 + send 0.19 của monolith (lệnh trong scripts/gen-mime.cjs).
    #[test]
    fn khop_ban_node() {
        for (p, t) in [
            ("products/1_a.jpg", "image/jpeg"),
            ("avatars/X.JPG", "image/jpeg"),
            ("c2/products/a.png", "image/png"),
            ("a.webp", "image/webp"),
            ("a.gif", "image/gif"),
            ("a.svg", "image/svg+xml"),
            ("a.avif", "application/octet-stream"),
            ("a.heic", "application/octet-stream"),
            ("a.txt", "text/plain; charset=UTF-8"),
            ("a.json", "application/json; charset=UTF-8"),
            ("a.js", "application/javascript; charset=UTF-8"),
            ("a.html", "text/html; charset=UTF-8"),
            ("a.xml", "application/xml"),
            ("a.pdf", "application/pdf"),
            ("a.mp4", "video/mp4"),
            ("a.mp3", "audio/mpeg"),
            (
                "a.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            ("a.", "application/octet-stream"),
            ("abc", "application/octet-stream"),
            // mime 1.6 coi cả tên không có dấu chấm là phần mở rộng.
            ("products/png", "image/png"),
            // Ký tự xuống dòng: như regex JS chỉ xét dòng đầu.
            ("a.png\nb", "application/octet-stream"),
            ("a\nb.png", "application/octet-stream"),
            ("x/y.a\u{2028}png", "application/octet-stream"),
        ] {
            assert_eq!(content_type_for_path(p), t, "{p}");
        }
    }
}
