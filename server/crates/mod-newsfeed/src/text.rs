//! Chuyển HTML rich-text thành văn bản thuần cho đoạn trích thông báo (`newsfeed-text.util.ts`).
//!
//! Giải mã entity hai lượt, `&amp;` cuối cùng trong mỗi lượt, để dữ liệu cũ bị escape hai lần (`&amp;nbsp;`) ra
//! khoảng trắng chứ không lộ chữ "&nbsp;".

fn code_point(cp: u32) -> String {
    if cp == 160 {
        return " ".to_owned();
    }
    char::from_u32(cp).map_or_else(|| " ".to_owned(), String::from)
}

/// Thay mọi entity có dạng `&<tiền tố><thân>;` bằng `f(thân)` (một lượt `String.replace` toàn chuỗi của JS).
fn replace_entities(s: &str, accept: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s.as_bytes()[i] == b'&'
            && let Some(end) = s[i + 1..].find(';')
            && let Some(rep) = accept(&s[i + 1..i + 1 + end])
        {
            out.push_str(&rep);
            i += end + 2;
            continue;
        }
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `decodeOnce` của bản TS: bốn phép thay NỐI TIẾP trên cả chuỗi (số thập phân, số hex, tên, rồi `&amp;` cuối cùng), nên đầu
/// ra của phép trước là đầu vào của phép sau (`&#38;lt;` → `&lt;` → `<` trong cùng một lượt).
fn decode_once(s: &str) -> String {
    let dec = replace_entities(s, |b| {
        let n = b.strip_prefix('#')?;
        (!n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
            .then(|| code_point(n.parse::<u32>().unwrap_or(u32::MAX)))
    });
    let hex = replace_entities(&dec, |b| {
        let h = b.strip_prefix("#x").or_else(|| b.strip_prefix("#X"))?;
        (!h.is_empty() && h.bytes().all(|c| c.is_ascii_hexdigit()))
            .then(|| code_point(u32::from_str_radix(h, 16).unwrap_or(u32::MAX)))
    });
    let named = replace_entities(&hex, |b| {
        Some(
            match b.to_ascii_lowercase().as_str() {
                "nbsp" => " ",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" => "'",
                _ => return None,
            }
            .to_owned(),
        )
    });
    replace_amp(&named)
}

fn replace_amp(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s.len() >= i + 5 && s.is_char_boundary(i + 5) && s[i..i + 5].eq_ignore_ascii_case("&amp;") {
            out.push('&');
            i += 5;
            continue;
        }
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn strip_tags(html: &str) -> String {
    // `/<[^>]*>/g`: từ `<` tới `>` đầu tiên sau nó; `<` không có `>` phía sau thì giữ nguyên.
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        if html.as_bytes()[i] == b'<'
            && let Some(rel) = html[i + 1..].find('>')
        {
            out.push(' ');
            i += rel + 2;
            continue;
        }
        let ch = html[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `stripHtmlToText`: bỏ thẻ (thay bằng một khoảng trắng), giải mã entity hai lượt, gộp khoảng trắng, cắt hai đầu.
pub fn strip_html_to_text(html: &str) -> String {
    let no_tags = strip_tags(html);
    let decoded = decode_once(&decode_once(&no_tags));
    decoded
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::strip_html_to_text as s;

    #[test]
    fn bo_the_va_gop_khoang_trang() {
        assert_eq!(s("<p>Xin   chào</p><p>các bạn</p>"), "Xin chào các bạn");
        assert_eq!(s(""), "");
        assert_eq!(s("<br>"), "");
    }

    #[test]
    fn giai_ma_entity_hai_luot() {
        assert_eq!(s("a&nbsp;b"), "a b");
        assert_eq!(s("a&amp;nbsp;b"), "a b");
        assert_eq!(s("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(s("&lt;b&gt; &quot;x&quot; &apos;y&apos;"), "<b> \"x\" 'y'");
        assert_eq!(s("&#65;&#x42;&#160;C"), "AB C");
        assert_eq!(s("&NBSP;x"), "x");
    }

    #[test]
    fn cac_phep_thay_noi_tiep_trong_mot_luot() {
        // `&#38;lt;` → `&lt;` (phép số) → `<` (phép tên) trong cùng một lượt; lượt hai không còn gì để đổi.
        assert_eq!(s("a&#38;lt;b"), "a<b");
        assert_eq!(s("&#x26;amp;nbsp;x"), "x");
    }

    #[test]
    fn entity_la_va_ky_tu_dac_biet_giu_nguyen() {
        assert_eq!(s("a &unknown; b & c"), "a &unknown; b & c");
        assert_eq!(s("giá 5 < 6"), "giá 5 < 6");
        assert_eq!(s("&#99999999999;x"), "x");
    }
}
