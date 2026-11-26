//! Số điện thoại Việt Nam (thuần, không DB). Chuyển từ `services/crm/src/common/helpers/phone.helper.ts`, bộ chuẩn hoá
//! duy nhất cho danh bạ, nhập file, webhook vào, Fanpage, API công khai, kết nối và tool MCP.

use crate::vi::is_js_whitespace;

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `0` + 9 chữ số.
fn is_local(s: &str) -> bool {
    s.len() == 10 && s.starts_with('0') && all_digits(s)
}

/// Chuẩn hoá SĐT về dạng nội địa `0xxxxxxxxx`. Nhận `0…`, `+84…`, `84…`, `0084…`, `+84 (0) 9…` (số 0 thừa sau mã
/// nước), bỏ khoảng trắng (như `\s` của JS), chấm, gạch, ngoặc. Không mã nước mà chỉ 9 số (Excel/Sheet làm rụng số 0
/// đầu) thì chỉ nhận đầu di động 3/5/7/8/9. Không hợp lệ → `None`.
pub fn normalize_phone(raw: &str) -> Option<String> {
    let d: String = raw
        .chars()
        .filter(|&c| !(is_js_whitespace(c) || matches!(c, '.' | '-' | '(' | ')')))
        .collect();
    let body = d.strip_prefix('+').unwrap_or(&d);
    if !all_digits(body) {
        return None;
    }
    let rest: &str = if let Some(r) = d.strip_prefix("+84") {
        r
    } else if d.starts_with('+') {
        return None;
    } else if let Some(r) = d.strip_prefix("0084") {
        r
    } else if d.starts_with("84") && (d.len() == 11 || (d.len() == 12 && d.as_bytes()[2] == b'0')) {
        &d[2..]
    } else if d.starts_with('0') {
        return is_local(&d).then_some(d);
    } else {
        let mobile = d.len() == 9 && matches!(d.as_bytes()[0], b'3' | b'5' | b'7' | b'8' | b'9');
        return mobile.then(|| format!("0{d}"));
    };
    // Sau mã nước: 9 số, hoặc "(0)" + 9 số.
    let first = rest.as_bytes().first().copied();
    if rest.len() == 10 && first == Some(b'0') && rest.as_bytes()[1] != b'0' && all_digits(rest) {
        return Some(rest.to_owned());
    }
    (rest.len() == 9 && first != Some(b'0') && all_digits(rest)).then(|| format!("0{rest}"))
}

/// Các dạng lưu có thể có của cùng một SĐT nội địa (`0…`, `84…`, `+84…`), dùng khi kiểm trùng.
pub fn phone_variants(local: &str) -> Vec<String> {
    if is_local(local) {
        vec![
            local.to_owned(),
            format!("84{}", &local[1..]),
            format!("+84{}", &local[1..]),
        ]
    } else {
        vec![local.to_owned()]
    }
}
