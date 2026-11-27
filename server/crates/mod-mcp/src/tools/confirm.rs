//! Lời người dùng có phải là lời đồng ý không (`isUserConfirmation` của `actions/user-confirmation.ts`). Hai bước "xem trước →
//! `confirmed_by_user`" của `reply_to_customer` dựa vào hàm này.
//!
//! Có thể trùng với bản của M42 (nhóm tool ghi qua khung "action"); khi cả hai nhánh đã gộp thì giữ MỘT bản.

use trinity_kernel::vi::fold_vi;

/// Cụm từ (đã bỏ dấu) là lời đồng ý.
const YES: &[&str] = &[
    "ok",
    "oke",
    "okie",
    "okay",
    "dong y",
    "duoc",
    "dc",
    "chot",
    "u",
    "uh",
    "um",
    "uk",
    "yes",
    "y",
    "dung roi",
    "dung vay",
    "chuan",
    "chuan roi",
    "lam di",
    "tao di",
    "lam luon",
    "tao luon",
    "lam vay",
    "nhu vay",
    "xac nhan",
    "duyet",
    "go",
    "on",
    "oki",
    "vang",
    "da",
    "khoi hoi lai",
    "khoi hoi",
    "dung hoi lai",
    "tao ngay",
    "lam ngay",
];

/// Cụm từ phủ định hoặc còn đổi ý: có mặt thì không tính là đồng ý.
const NO: &[&str] = &[
    "khong", "ko", "k", "chua", "dung tao", "dung lam", "khoan", "doi", "sua lai", "them", "bot", "bo", "thay", "no",
    "not",
];

/// "không cần hỏi lại" là bảo làm ngay: đổi về "khỏi hỏi lại" trước khi xét phủ định.
const NO_ASK: &[&str] = &["khong can hoi lai", "khong can hoi", "ko can hoi lai", "ko can hoi"];

/// "không cần thêm gì", "không sao" là đồng ý, không phải phủ định.
const BENIGN: &[&str] = &[
    "khong can them gi",
    "khong can them",
    "khong can sua",
    "khong can",
    "khong sao",
    "khong van de",
    "khong co gi",
];

/// `foldVi` của bản TS: bỏ dấu, chữ thường, mọi ký tự ngoài `[a-z0-9]` thành một dấu cách, gộp và cắt hai đầu.
fn fold_words(s: &str) -> String {
    let folded = fold_vi(s);
    let mut out = String::with_capacity(folded.len());
    let mut gap = false;
    for c in folded.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        } else {
            gap = true;
        }
    }
    out
}

/// Thay mọi lần xuất hiện của ` cụm ` bằng `with` (như `w.split(x).join(y)`; không chồng lấn).
fn swap(w: &str, phrase: &str, with: &str) -> String {
    w.split(&format!(" {phrase} ")).collect::<Vec<_>>().join(with)
}

/// Lời người dùng có phải là lời đồng ý (không kèm phủ định hay yêu cầu đổi) không.
pub fn is_user_confirmation(words: Option<&str>) -> bool {
    let folded = fold_words(words.unwrap_or(""));
    if folded.is_empty() {
        return false;
    }
    let mut w = format!(" {folded} ");
    for a in NO_ASK {
        w = swap(&w, a, " khoi hoi lai ");
    }
    for b in BENIGN {
        w = swap(&w, b, " ");
    }
    if NO.iter().any(|k| w.contains(&format!(" {k} "))) {
        return false;
    }
    YES.iter().any(|k| w.contains(&format!(" {k} ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dong_y() {
        for ok in [
            "ok",
            "OK gửi đi",
            "được, làm vậy",
            "Đồng ý",
            "ok tạo luôn, không cần hỏi lại",
            "ừ không sao",
            "xác nhận!",
            "dạ",
        ] {
            assert!(is_user_confirmation(Some(ok)), "{ok}");
        }
    }

    #[test]
    fn khong_dong_y() {
        for bad in [
            "",
            "   ",
            "không",
            "chưa gửi",
            "ok nhưng sửa lại",
            "khoan đã",
            "thêm câu chào",
            "hmm",
        ] {
            assert!(!is_user_confirmation(Some(bad)), "{bad}");
        }
        assert!(!is_user_confirmation(None));
    }
}
