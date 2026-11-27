//! Tiền tố công ty của bí mật phát hành (`company-token.ts`): `c<id>.` cho công ty ≥ 2, không có tiền tố là công ty 1. Từ
//! tiền tố biết phải tra khoá ở schema nào.

/// `c5.` hoặc rỗng (công ty 1).
pub fn company_token_prefix(company_id: i32) -> String {
    if company_id == 1 {
        String::new()
    } else {
        format!("c{company_id}.")
    }
}

pub fn with_company_prefix(secret: &str, company_id: i32) -> String {
    format!("{}{secret}", company_token_prefix(company_id))
}

/// Công ty mà bí mật tự nhận (`^c([1-9][0-9]{0,9})\.(.+)$`); không có tiền tố là 1. Id quá lớn so với `i32` trả `0` (không
/// công ty nào khớp, nên bị từ chối ở bước tra công ty).
pub fn company_id_of_token(raw: &str) -> i32 {
    let Some(rest) = raw.strip_prefix('c') else { return 1 };
    let Some((digits, tail)) = rest.split_once('.') else {
        return 1;
    };
    let ok = !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0')
        && !tail.is_empty();
    if !ok {
        return 1;
    }
    digits.parse::<i32>().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tien_to_cong_ty() {
        assert_eq!(company_token_prefix(1), "");
        assert_eq!(company_token_prefix(5), "c5.");
        assert_eq!(with_company_prefix("trinity_live_x", 12), "c12.trinity_live_x");
        assert_eq!(company_id_of_token("trinity_live_x"), 1);
        assert_eq!(company_id_of_token("c5.trinity_live_x"), 5);
        assert_eq!(company_id_of_token("c10.x"), 10);
        // Không khớp mẫu ⇒ công ty 1 (giống regex): số 0 đầu, thiếu thân, không phải số.
        assert_eq!(company_id_of_token("c05.x"), 1);
        assert_eq!(company_id_of_token("c5."), 1);
        assert_eq!(company_id_of_token("cx.y"), 1);
        assert_eq!(company_id_of_token("c0.y"), 1);
        // Số vượt i32 ⇒ 0 (không công ty nào).
        assert_eq!(company_id_of_token("c9999999999.y"), 0);
    }
}
