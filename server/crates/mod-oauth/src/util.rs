//! Chuỗi theo luật JavaScript mà bản TS dựa vào.

/// Ký tự `\s` của JS: khoảng trắng Unicode, `﻿` và ngắt dòng (khác `char::is_whitespace`: có `﻿`, không có `\u0085`).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.split(/\s+/).filter(Boolean)`.
pub fn split_js_space(s: &str) -> Vec<&str> {
    s.split(is_js_space).filter(|p| !p.is_empty()).collect()
}

/// `s.length` của JS (đơn vị UTF-16).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}
