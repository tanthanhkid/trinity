//! Phần dùng chung của tool GHI cấu trúc (M43): lời đồng ý của người dùng (`user-confirmation.ts`), làm sạch văn bản AI gửi
//! (`action-helpers.ts`), đổi lỗi dịch vụ sang lỗi tool, lưu phiên bản cấu trúc trước mỗi lần đổi, chặn khi bật "Yêu cầu duyệt".
//!
//! Các thao tác cấu trúc là `ActionDef` của khung đề xuất/duyệt M42 (`crate::actions`): `prepare` kiểm và KHÔNG ghi, `execute` ghi
//! qua `mod-custom`/`mod-setup`; chạy ngay hoặc chờ duyệt do khung quyết định theo cài đặt "Yêu cầu duyệt thay đổi do AI".

use serde_json::{Value, json};
use trinity_kernel::error::{AppError, Message};
use trinity_kernel::vi::fold_vi;
use unicode_normalization::UnicodeNormalization;

use crate::ai_output::{mask_phones_in_text, slice16};
use crate::exec::ToolError;

pub(super) type Detail = (String, String);

pub(super) fn internal(e: impl std::fmt::Display) -> ToolError {
    ToolError::Internal(e.to_string())
}

pub(super) fn user(msg: impl Into<String>) -> ToolError {
    ToolError::User(msg.into())
}

/// `AppError` của dịch vụ nghiệp vụ → lỗi tool. 400/404/409 là lỗi AI sửa được (`asUserError`): trả nguyên câu; 403 ⇒ từ chối chung;
/// còn lại ⇒ như `Http` (<500 "Yêu cầu không hợp lệ", ≥500 lỗi hệ thống).
pub(super) fn user_err(e: AppError) -> ToolError {
    let (status, body) = e.response(true);
    let message = match body.message {
        Message::One(s) => s,
        Message::Many(m) => m.join("; "),
    };
    match status {
        400 | 404 | 409 => ToolError::User(message),
        s => ToolError::Http { status: s, message },
    }
}

fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2069}'
            | '\u{34f}'
            | '\u{61c}'
            | '\u{feff}'
    )
}

/// `cleanText`: NFC, bỏ ký tự điều khiển/vô hình, chuẩn hoá xuống dòng, cắt khoảng trắng và độ dài (đơn vị UTF-16).
pub(super) fn clean_text(v: Option<&Value>, max: usize) -> String {
    let s = match v {
        Some(Value::String(s)) => s.as_str(),
        _ => return String::new(),
    };
    let nfc: String = s.nfc().filter(|c| !invisible(*c)).collect();
    let nl = nfc.replace("\r\n", "\n").replace('\r', "\n");
    slice16(nl.trim(), max)
}

/// Chuỗi tuỳ chọn đã làm sạch, `None` khi rỗng.
pub(super) fn opt_clean(v: Option<&Value>, max: usize) -> Option<String> {
    let s = clean_text(v, max);
    (!s.is_empty()).then_some(s)
}

/// `foldVi` của `view-config.ts`: bỏ dấu, chữ thường, mọi dãy ngoài `a-z0-9` thành MỘT dấu cách, cắt hai đầu.
pub(super) fn fold_words(s: &str) -> String {
    let mut out = String::new();
    let mut sep = true;
    for c in fold_vi(s).chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            sep = false;
        } else if !sep {
            out.push(' ');
            sep = true;
        }
    }
    out.trim().to_owned()
}

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
const NO: &[&str] = &[
    "khong", "ko", "k", "chua", "dung tao", "dung lam", "khoan", "doi", "sua lai", "them", "bot", "bo", "thay", "no",
    "not",
];
const NO_ASK: &[&str] = &["khong can hoi lai", "khong can hoi", "ko can hoi lai", "ko can hoi"];
const BENIGN: &[&str] = &[
    "khong can them gi",
    "khong can them",
    "khong can sua",
    "khong can",
    "khong sao",
    "khong van de",
    "khong co gi",
];

/// `isUserConfirmation`: lời người dùng có phải lời đồng ý (không kèm phủ định hay yêu cầu đổi).
pub(super) fn is_user_confirmation(words: Option<&str>) -> bool {
    let folded = fold_words(words.unwrap_or_default());
    if folded.is_empty() {
        return false;
    }
    let mut w = format!(" {folded} ");
    for a in NO_ASK.iter() {
        w = w.replace(&format!(" {a} "), " khoi hoi lai ");
    }
    for b in BENIGN.iter() {
        w = w.replace(&format!(" {b} "), " ");
    }
    let has = |k: &&str| w.contains(&format!(" {k} "));
    if NO.iter().any(&has) {
        return false;
    }
    YES.iter().any(has)
}

/// Không phải lời đồng ý ⇒ lỗi kèm bản xem trước để AI đưa người dùng xác nhận (`assertConfirmed`).
pub(super) fn assert_confirmed(words: Option<&str>, preview: &[Detail]) -> Result<(), ToolError> {
    if is_user_confirmation(words) {
        return Ok(());
    }
    let said = match words.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => format!("“{}”", slice16(w, 80)),
        None => "(trống)".to_owned(),
    };
    let plan = preview
        .iter()
        .map(|(l, v)| format!("{l}: {v}"))
        .collect::<Vec<_>>()
        .join(" | ");
    Err(user(format!(
        "Chưa tạo gì: chưa có lời người dùng đồng ý với cấu trúc này (confirmed_by_user = {said}). Cấu trúc dự kiến — {plan}. \
         Cấu trúc bảng mới do người dùng duyệt: họ xem danh sách trên, sửa nếu cần, rồi đồng ý; confirmed_by_user là câu đồng ý đó. / \
         Nothing created: no user confirmation of this structure (confirmed_by_user = {said}). Planned structure: {plan}"
    )))
}

/// Dòng chi tiết cho bản xem trước: bỏ khi `value` trống, cắt độ dài.
pub(super) fn line(label: &str, value: impl Into<String>, max: usize) -> Option<Detail> {
    let v: String = value.into();
    (!v.is_empty()).then(|| (label.to_owned(), slice16(&v, max)))
}

/// Kết quả `prepare` của khung M42 từ các phần của một thao tác cấu trúc: chi tiết (cặp nhãn/giá trị) đổi sang dòng JSON, SĐT
/// trong văn bản tự do bị che, tóm tắt cắt 300 ký tự như `shown(summary)` của bản TS.
pub(super) fn prepared(
    params: Value,
    summary: &str,
    details: &[Detail],
    impact: Option<Value>,
) -> crate::actions::Prepared {
    crate::actions::Prepared {
        params,
        summary: crate::actions::shown(summary, 300),
        details: details
            .iter()
            .map(|(l, v)| json!({ "label": l, "value": mask_phones_in_text(v) }))
            .collect(),
        impact,
    }
}

/// `makeImpact` của `impact.ts`: có bản ghi bị ảnh hưởng ⇒ `confirm_label` = tên bảng đầu tiên có bản ghi (người duyệt phải gõ đúng).
pub(super) fn impact_json(tables: &[(String, String, i64)], lines: &[String]) -> Value {
    let affected: i64 = tables.iter().map(|t| t.2).sum();
    let confirm = tables
        .iter()
        .find(|t| t.2 > 0)
        .filter(|_| affected > 0)
        .map_or(Value::Null, |t| json!(t.1));
    json!({
        "affected_records": affected,
        "confirm_label": confirm,
        "lines": lines.iter().take(12).collect::<Vec<_>>(),
        "tables": tables
            .iter()
            .take(20)
            .map(|(k, l, n)| json!({ "key": k, "label": l, "records": n }))
            .collect::<Vec<_>>(),
    })
}

/// Số nguyên có dấu trong `Value` (JSON số nguyên hoặc số thực không phần lẻ).
pub(super) fn as_int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
                .map(|f| f as i64)
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn loi_dong_y() {
        for ok in [
            "ok tạo đi",
            "Được, làm vậy",
            "tạo luôn",
            "khỏi hỏi lại",
            "không cần hỏi lại, tạo ngay",
            "ok không cần thêm gì",
            "Đồng ý",
        ] {
            assert!(is_user_confirmation(Some(ok)), "{ok}");
        }
        for no in [
            "",
            "tạo cho mình bảng khách",
            "chưa, thêm cột email",
            "không",
            "đừng tạo",
            "ok nhưng bớt cột",
        ] {
            assert!(!is_user_confirmation(Some(no)), "{no}");
        }
        assert!(!is_user_confirmation(None));
    }

    #[test]
    fn lam_sach_van_ban() {
        assert_eq!(clean_text(Some(&json!("  a\u{200b}b\r\nc  ")), 10), "ab\nc");
        assert_eq!(clean_text(Some(&json!("abcdef")), 3), "abc");
        assert_eq!(clean_text(Some(&json!(5)), 3), "");
        assert_eq!(fold_words("Xem dạng LỊCH!"), "xem dang lich");
    }

    #[test]
    fn chua_dong_y_bao_ban_xem_truoc() {
        let e = assert_confirmed(Some("ừ thêm cột"), &[("Bảng A".into(), "x (text)".into())]).unwrap_err();
        match e {
            ToolError::User(m) => {
                assert!(m.contains("“ừ thêm cột”") && m.contains("Bảng A: x (text)"), "{m}");
            }
            _ => panic!("phải là lỗi người dùng"),
        }
    }
}
