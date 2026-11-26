/// Khoảng byte đóng hai đầu `[start, end]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }

    pub fn is_empty(&self) -> bool {
        false
    }
}

/// Đọc header `Range` dạng đơn (`bytes=a-b`, `bytes=a-`, `bytes=-n`), như `parseRange` của
/// `packages/storage/src/range.ts`. `None` = phục vụ cả file 200 (không có range, cú pháp lạ, nhiều khoảng, hoặc
/// khoảng không khớp kích thước); không bao giờ là lỗi, không có 416.
///
/// Số được đọc như `Number()` của JS (f64): số quá lớn thành vô cực hoặc lớn hơn kích thước nên ra `None` giống TS.
pub fn parse_range(range: Option<&str>, size: u64) -> Option<ByteRange> {
    let range = range?;
    if size == 0 {
        return None;
    }
    let rest = trim_js(range).strip_prefix("bytes=")?;
    let (start_raw, end_raw) = rest.split_once('-')?;
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(start_raw) || !digits(end_raw) {
        return None;
    }
    if start_raw.is_empty() && end_raw.is_empty() {
        return None;
    }
    let num = |s: &str| s.parse::<f64>().unwrap_or(f64::NAN);
    let size_f = size as f64;
    let (start, end) = if start_raw.is_empty() {
        let suffix = num(end_raw);
        if !suffix.is_finite() || suffix <= 0.0 {
            return None;
        }
        ((size_f - suffix).max(0.0), size_f - 1.0)
    } else {
        let start = num(start_raw);
        let end = if end_raw.is_empty() { size_f - 1.0 } else { num(end_raw) };
        (start, end)
    };
    if !start.is_finite() || !end.is_finite() || start < 0.0 || start > end {
        return None;
    }
    let end = end.min(size_f - 1.0);
    if start > end {
        return None;
    }
    Some(ByteRange {
        start: start as u64,
        end: end as u64,
    })
}

/// `String.prototype.trim` của JS: khoảng trắng Unicode, dòng mới và BOM.
fn trim_js(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(start: u64, end: u64) -> Option<ByteRange> {
        Some(ByteRange { start, end })
    }

    // Các ca chép từ packages/storage/src/range.spec.ts (size = 1000).
    #[test]
    fn cac_ca_cua_ban_ts() {
        let size = 1000;
        assert_eq!(parse_range(None, size), None);
        assert_eq!(parse_range(Some("bytes=0-499"), size), r(0, 499));
        assert_eq!(parse_range(Some("bytes=500-"), size), r(500, 999));
        assert_eq!(parse_range(Some("bytes=-200"), size), r(800, 999));
        assert_eq!(parse_range(Some("bytes=900-9999"), size), r(900, 999));
        assert_eq!(parse_range(Some("bytes=500-100"), size), None);
        assert_eq!(parse_range(Some("bytes=-1-100"), size), None);
        assert_eq!(parse_range(Some("bytes=0-99,200-299"), size), None);
        assert_eq!(parse_range(Some("items=0-99"), size), None);
        assert_eq!(parse_range(Some("bytes=-"), size), None);
        assert_eq!(parse_range(Some("bytes=0-10"), 0), None);
    }

    #[test]
    fn bien_them() {
        let size = 1000;
        assert_eq!(parse_range(Some("  bytes=1-2 \n"), size), r(1, 2));
        assert_eq!(parse_range(Some("bytes=-0"), size), None);
        assert_eq!(parse_range(Some("bytes=-5000"), size), r(0, 999));
        assert_eq!(parse_range(Some("bytes=1000-"), size), None);
        assert_eq!(parse_range(Some("bytes=999-999"), size), r(999, 999));
        assert_eq!(parse_range(Some("bytes=+1-2"), size), None);
        assert_eq!(parse_range(Some("Bytes=1-2"), size), None);
        assert_eq!(parse_range(Some(&format!("bytes=0-{}", "9".repeat(400))), size), None);
        assert_eq!(parse_range(Some("bytes=0-99999999999999999999"), size), r(0, 999));
        assert_eq!(parse_range(Some(""), size), None);
    }
}
