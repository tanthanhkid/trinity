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

/// Tìm entity bắt đầu tại `s[i..]` (`s[i]` là `&`): trả (chuỗi thay, số byte tiêu thụ). Chỉ nhận đúng các dạng của bản TS:
/// `&#123;`, `&#x1F;`, `&nbsp;|lt|gt|quot|apos;` (không phân biệt hoa thường). `&amp;` xử lý ở bước riêng.
fn entity(s: &str, i: usize) -> Option<(String, usize)> {
    let rest = &s[i + 1..];
    let end = rest.find(';')?;
    let name = &rest[..end];
    let used = end + 2;
    if let Some(num) = name.strip_prefix('#') {
        let cp = if let Some(hex) = num.strip_prefix(['x', 'X']) {
            if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            u32::from_str_radix(hex, 16).unwrap_or(u32::MAX)
        } else {
            if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            num.parse::<u32>().unwrap_or(u32::MAX)
        };
        return Some((code_point(cp), used));
    }
    let rep = match name.to_ascii_lowercase().as_str() {
        "nbsp" => " ",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => return None,
    };
    Some((rep.to_owned(), used))
}

fn decode_once(s: &str) -> String {
    // Lượt 1: entity số và tên (trừ amp), chạy một mạch từ trái sang phải như chuỗi `.replace` nối tiếp của JS ở dữ liệu thường.
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let b = s.as_bytes()[i];
        if b == b'&'
            && let Some((rep, used)) = entity(s, i)
        {
            out.push_str(&rep);
            i += used;
            continue;
        }
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    // Lượt 2: `&amp;` (không phân biệt hoa thường) → `&`, chạy sau cùng.
    replace_amp(&out)
}

fn replace_amp(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s.is_char_boundary(i) && s.len() >= i + 5 && s.as_bytes()[i..i + 5].eq_ignore_ascii_case(b"&amp;") {
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
    fn entity_la_va_ky_tu_dac_biet_giu_nguyen() {
        assert_eq!(s("a &unknown; b & c"), "a &unknown; b & c");
        assert_eq!(s("giá 5 < 6"), "giá 5 < 6");
        assert_eq!(s("&#99999999999;x"), "x");
    }
}
