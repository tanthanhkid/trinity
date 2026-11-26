//! Định dạng số kiểu Việt Nam, thay các chỗ gọi `n.toLocaleString('vi-VN')` của bản TS (tiền trên phiếu, giới hạn
//! xuất file, xem trước liên kết, thông báo phiếu lương).

/// Như `Number.prototype.toLocaleString('vi-VN')` của V8 (ICU): nhóm nghìn bằng `.`, phần thập phân sau `,`, tối đa 3
/// chữ số thập phân làm tròn nửa xa số 0 trên dạng thập phân ngắn nhất của số (`1.0005` → `1,001`), bỏ số 0 cuối;
/// giữ dấu âm khi làm tròn về 0 (`-0.0001` → `-0`); `NaN`, `∞`, `-∞`.
pub fn format_vn_number(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    let sign = if x.is_sign_negative() { "-" } else { "" };
    if x.is_infinite() {
        return format!("{sign}∞");
    }
    // Display của f64: chữ số thập phân ngắn nhất khôi phục đúng số, không dùng dạng mũ (giống ICU dùng cho locale).
    let shortest = format!("{}", x.abs());
    let (int_part, frac_part) = shortest.split_once('.').unwrap_or((&shortest, ""));
    let mut int_digits: Vec<u8> = int_part.bytes().collect();
    let mut frac: Vec<u8> = frac_part.bytes().take(3).collect();
    if frac_part.len() > 3 && frac_part.as_bytes()[3] >= b'5' {
        // Cộng 1 vào chữ số cuối cùng giữ lại, nhớ sang trái (qua cả phần nguyên).
        let mut carry = true;
        for d in frac.iter_mut().rev().chain(int_digits.iter_mut().rev()) {
            if *d == b'9' {
                *d = b'0';
            } else {
                *d += 1;
                carry = false;
                break;
            }
        }
        if carry {
            int_digits.insert(0, b'1');
        }
    }
    while frac.last() == Some(&b'0') {
        frac.pop();
    }
    let mut out = String::with_capacity(sign.len() + int_digits.len() * 4 / 3 + frac.len() + 2);
    out.push_str(sign);
    let n = int_digits.len();
    for (i, d) in int_digits.iter().enumerate() {
        if i > 0 && (n - i).is_multiple_of(3) {
            out.push('.');
        }
        out.push(char::from(*d));
    }
    if !frac.is_empty() {
        out.push(',');
        out.extend(frac.iter().map(|&d| char::from(d)));
    }
    out
}

/// Như `Math.round` của JS: làm tròn nửa về phía +∞ (`-2.5` → `-2`, `2.5` → `3`), giữ `-0` cho khoảng `[-0.5, 0)`,
/// `NaN`/`±∞` và số đã nguyên (|x| ≥ 2^52) giữ nguyên. Khác `f64::round` (nửa xa số 0). PLAN mục 10.3: một hàm duy nhất
/// cho bộ tính lương (M30a) và bộ tính công thức bảng tuỳ biến (M57).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x.abs() >= 4_503_599_627_370_496.0 {
        return x;
    }
    if (-0.5..0.0).contains(&x) {
        return -0.0;
    }
    let floor = x.floor();
    // `x - floor` là phép trừ chính xác với f64 trong khoảng này, nên so với 0,5 không dính sai số cộng 0,5.
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

#[cfg(test)]
mod js_round_tests {
    use super::js_round;

    #[test]
    fn nua_ve_phia_duong_vo_cuc() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert!(js_round(-0.2).is_sign_negative());
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(-1.5), -1.0);
        assert!(js_round(f64::NAN).is_nan());
    }
}
