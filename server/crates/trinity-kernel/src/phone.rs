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

/// Số điện thoại Việt Nam nằm trong một đoạn văn (tin nhắn của khách), dạng nội địa `0xxxxxxxxx`, theo thứ tự xuất hiện, không
/// trùng. Nhận `0912 345 678`, `0912.345.678`, `0912-345-678`, `+84 912 345 678`, `84912345678`. Chỉ nhận số có đầu `0`/`84`/`+84`
/// (KHÔNG nhận 9 số trần như `normalize_phone`, vì "18.500.000" hay "912345678 đồng" là tiền) và đầu số di động hợp lệ
/// 03/05/07/08/09. Dãy chữ số dính liền chữ cái hoặc dài hơn một SĐT (số tài khoản, mã đơn) thì bỏ qua.
pub fn detect_phones(text: &str) -> Vec<String> {
    // Tách thành các "cụm" chữ số nối nhau bằng đúng một dấu cách/chấm/gạch; `+` đứng ngay trước cụm đầu thì giữ lại.
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let starts_plus = c == '+' && chars.get(i + 1).is_some_and(char::is_ascii_digit);
        if !(c.is_ascii_digit() || starts_plus) {
            i += 1;
            continue;
        }
        // Chữ số dính ngay sau chữ cái (vd "ABC0912345678") không phải SĐT.
        let glued = i > 0 && chars[i - 1].is_alphanumeric();
        // Mỗi cụm kèm vị trí kết thúc, để khớp được số ngắn hơn cả dãy thì đi tiếp từ ngay sau nó.
        let mut groups: Vec<(String, usize)> = Vec::new();
        let mut total = 0usize;
        let mut j = i;
        let mut prefix = String::new();
        if starts_plus {
            prefix.push('+');
            j += 1;
        }
        loop {
            let start = j;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            groups.push((chars[start..j].iter().collect(), j));
            total += j - start;
            // Nối tiếp cụm sau nếu ngăn bởi đúng một dấu ` `, `.`, `-` rồi tới chữ số. Đã quá dài một SĐT (kể cả `0084`) thì
            // thôi nối: chuỗi "1 1 1 1 …" dài không làm việc dò thành bậc ba.
            if total <= MAX_PHONE_DIGITS
                && j + 1 < chars.len()
                && matches!(chars[j], ' ' | '.' | '-')
                && chars[j + 1].is_ascii_digit()
            {
                j += 1;
            } else {
                break;
            }
        }
        // Chữ cái dính ngay sau cụm cuối (vd "0912345678abc") cũng loại.
        let glued_after = chars.get(j).is_some_and(|c| c.is_alphabetic());
        // Không khớp gì thì bỏ qua cụm đầu rồi thử lại từ cụm sau ("SL 2 0912345678", "0912345678 0987654321").
        let mut next = groups[0].1;
        if !glued {
            // Thử từ dãy dài nhất xuống ngắn nhất: "0912 345 678 2 cái" vẫn lấy được "0912 345 678".
            let max = if glued_after { groups.len() - 1 } else { groups.len() };
            for n in (1..=max).rev() {
                let digits: String = groups[..n].iter().map(|(g, _)| g.as_str()).collect();
                if let Some(p) = detected_local(&prefix, groups[0].0.len(), &digits) {
                    if !out.contains(&p) {
                        out.push(p);
                    }
                    next = groups[n - 1].1;
                    break;
                }
            }
        }
        i = next.max(i + 1);
    }
    out
}

/// Dài nhất của một SĐT viết có mã nước: `0084` + `0` + 9 số.
const MAX_PHONE_DIGITS: usize = 14;

fn detected_local(plus: &str, first_group: usize, digits: &str) -> Option<String> {
    // Không `+` thì chỉ nhận đầu `0` (gồm `0084`) hoặc `84` viết liền như số có mã nước ("84912345678", cụm đầu ≥ 4 số, đủ
    // 11–12 số): "849.000.000" hay "84.900.000.000" là tiền, không phải SĐT.
    let ok = !plus.is_empty()
        || digits.starts_with('0')
        || (digits.starts_with("84") && first_group >= 4 && digits.len() >= 11);
    if !ok {
        return None;
    }
    let local = normalize_phone(&format!("{plus}{digits}"))?;
    // Đầu số di động 03/05/07/08/09 (số bàn 11 chữ số không qua được `normalize_phone`).
    matches!(local.as_bytes().get(1), Some(b'3' | b'5' | b'7' | b'8' | b'9')).then_some(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Vec<String> {
        detect_phones(s)
    }

    #[test]
    fn nhan_cac_dang_viet_thuong_gap() {
        for raw in [
            "SĐT chị 0912 345 678 nhé",
            "gọi 0912.345.678.",
            "0912-345-678",
            "số +84 912 345 678",
            "zalo 84912345678",
            "(0912345678)",
            "0912345678,",
        ] {
            assert_eq!(d(raw), vec!["0912345678".to_owned()], "{raw}");
        }
    }

    #[test]
    fn khong_nham_tien_ma_don_va_so_dai() {
        for raw in [
            "báo giá 18.500.000 ₫",
            "báo giá 849.000.000 đ",
            "849000000 đồng",
            "giá 84.900.000.000 đ",
            "912345678 đồng",
            "mã đơn 0912345678901",
            "ABC0912345678",
            "0912345678abc",
            "ngày 28/11/2026 lúc 09:12",
            "0112345678",
            "liên hệ 02838123456",
            "",
        ] {
            assert!(d(raw).is_empty(), "{raw} => {:?}", d(raw));
        }
    }

    #[test]
    fn nhieu_so_khong_trung_theo_thu_tu() {
        assert_eq!(
            d("0912 345 678 hoặc 0987.654.321, lặp lại +84912345678"),
            vec!["0912345678".to_owned(), "0987654321".to_owned()]
        );
        assert_eq!(d("0912 345 678 2 cái"), vec!["0912345678".to_owned()]);
        assert_eq!(
            d("0912345678 0987654321"),
            vec!["0912345678".to_owned(), "0987654321".to_owned()]
        );
        assert_eq!(d("SL 2 0912345678"), vec!["0912345678".to_owned()]);
        assert_eq!(d("0912345678 2abc"), vec!["0912345678".to_owned()]);
        let noise = "1 ".repeat(5000) + "0912345678";
        assert_eq!(d(&noise), vec!["0912345678".to_owned()]);
    }
}
