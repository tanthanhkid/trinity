//! Phần dùng chung của tool GHI cấu trúc (M43): lời đồng ý của người dùng (`user-confirmation.ts`), làm sạch văn bản AI gửi
//! (`action-helpers.ts`), đổi lỗi dịch vụ sang lỗi tool, lưu phiên bản cấu trúc trước mỗi lần đổi, chặn khi bật "Yêu cầu duyệt".
//!
//! Khung đề xuất/duyệt (M42: `create_draft`, hạn mức ghi theo người/ứng dụng) CHƯA có trên main. Tới khi có, các tool ở đây chỉ
//! chạy chế độ GHI NGAY; chế độ "Yêu cầu duyệt thay đổi do AI" bật thì từ chối (không ghi lặng lẽ) bằng [`assert_direct`].

use std::future::Future;

use serde_json::{Value, json};
use trinity_kernel::error::{AppError, Message};
use trinity_kernel::json::js_json;
use trinity_kernel::vi::fold_vi;
use unicode_normalization::UnicodeNormalization;

use super::wrapped;
use crate::ai_output::slice16;
use crate::exec::{ToolCtx, ToolError, ToolOutput};

/// Scope của mọi tool ghi.
pub(super) const WRITE_SCOPE: &str = "crm.write";

/// Khoá `settings` của "Yêu cầu duyệt thay đổi do AI" (`REQUIRE_APPROVAL_KEY`).
const REQUIRE_APPROVAL_KEY: &str = "ai_require_approval";

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
    "khong", "ko", "k", "chua", "dung tao", "dung lam", "khoan", "doi", "sua lai", "them", "bot", "bo", "thay", "no", "not",
];
const NO_ASK: &[&str] = &[
    "khong can hoi lai",
    "khong can hoi",
    "ko can hoi lai",
    "ko can hoi",
];
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
    if NO.iter().any(|k| has(k)) {
        return false;
    }
    YES.iter().any(|k| has(k))
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

/// Chế độ "Yêu cầu duyệt thay đổi do AI" bật (hoặc không đọc được) ⇒ từ chối: khung đề xuất thuộc M42 (fail-closed, không ghi).
pub(super) async fn assert_direct(ctx: &ToolCtx<'_>) -> Result<(), ToolError> {
    let v: Option<String> = {
        let mut c = ctx.deps.conn(ctx.principal.company).await?;
        sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(REQUIRE_APPROVAL_KEY)
            .fetch_optional(&mut *c)
            .await
            .map_err(internal)?
    };
    if v.as_deref() == Some("true") {
        return Err(user(
            "Workspace đang bật \"Yêu cầu duyệt thay đổi do AI\", nhưng bản máy chủ này chưa hỗ trợ tạo đề xuất chờ duyệt cho thay đổi cấu trúc. \
             Chưa ghi gì: nhờ quản trị viên tắt tuỳ chọn đó (Cài đặt › Kết nối & AI) hoặc tự thao tác trên giao diện. / \
             Approval mode is on and this server cannot queue structure drafts yet; nothing was changed.",
        ));
    }
    Ok(())
}

/// Kết quả `prepare` của một thao tác: tham số đã chuẩn hoá, câu tóm tắt và các dòng chi tiết (văn bản thuần).
pub(super) struct Prepared {
    pub params: Value,
    pub summary: String,
    pub details: Vec<Detail>,
}

/// Vài dòng lỗi đầu của `result.errors` `[{row, reason}]` (import) để nêu ngay trong `message` (`rowErrorNote`).
fn row_error_note(result: &Value) -> String {
    let Some(errs) = result.get("errors").and_then(Value::as_array).filter(|a| !a.is_empty()) else {
        return String::new();
    };
    let total = result
        .get("error_total")
        .and_then(Value::as_u64)
        .unwrap_or(errs.len() as u64);
    let mut rows: Vec<(i64, String)> = errs
        .iter()
        .map(|e| {
            let obj = e.get("object").and_then(Value::as_str).map(|o| format!("{o} ")).unwrap_or_default();
            let reason = e.get("reason").and_then(Value::as_str).unwrap_or_default();
            let reason = if reason.chars().count() > 80 {
                format!("{}…", reason.chars().take(80).collect::<String>())
            } else {
                reason.to_owned()
            };
            (
                e.get("row").and_then(Value::as_i64).unwrap_or(0),
                format!("{obj}dòng {}: {reason}", e.get("row").and_then(Value::as_i64).unwrap_or(0)),
            )
        })
        .collect();
    rows.sort_by_key(|r| r.0);
    let preview = rows.iter().take(3).map(|r| r.1.as_str()).collect::<Vec<_>>().join("; ");
    format!(
        ". {total} dòng lỗi không ghi: {preview}{}",
        if total > 3 { " … (xem result.errors)" } else { "" }
    )
}

/// Chạy NGAY một thao tác ghi (`executeNow` của `ai-actions.service.ts`, chưa có hạn mức ghi và chế độ duyệt của M42): ghi dòng
/// `ai_action_drafts` trạng thái `approved` (lịch sử "Hoạt động AI"), lưu phiên bản cấu trúc nếu `structure`, chạy `exec`, rồi đặt
/// `executed` + kết quả (hoặc `failed` + lỗi). Lỗi ghi lịch sử SAU khi đã chạy không biến thao tác thành thất bại.
pub(super) async fn run_direct<F>(
    ctx: &ToolCtx<'_>,
    tool: &str,
    structure: bool,
    prepared: Prepared,
    exec: F,
) -> Result<ToolOutput, ToolError>
where
    F: Future<Output = Result<Value, ToolError>>,
{
    let p = ctx.principal;
    let summary = slice16(&prepared.summary, 1000);
    let details = Value::Array(
        prepared
            .details
            .iter()
            .map(|(l, v)| json!({ "label": l, "value": v }))
            .collect(),
    );
    let id: i32 = {
        let mut c = ctx.deps.conn(p.company).await?;
        sqlx::query_scalar(
            "INSERT INTO ai_action_drafts (user_id, client_id, tool, params, summary, details, status, decided_at, expires_at) \
             VALUES ($1, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, 'approved', now(), now() + interval '24 hours') RETURNING id",
        )
        .bind(p.user_id)
        .bind(&p.client_id)
        .bind(tool)
        .bind(js_json(&prepared.params))
        .bind(&summary)
        .bind(js_json(&details))
        .fetch_one(&mut *c)
        .await
        .map_err(internal)?
    };
    if structure {
        // Phiên bản gắn với id đề xuất như bản TS (`versions.save(row.id, …)`).
        let res = async {
            let mut c = ctx.deps.conn(p.company).await.map_err(|e| format!("{e:?}"))?;
            mod_custom::versions::save(&mut c, Some(id), tool, &summary, p.user_id)
                .await
                .map_err(|e| format!("{e:?}"))
        }
        .await;
        if let Err(e) = res {
            tracing::warn!("Không lưu được phiên bản cấu trúc trước {tool}: {e}");
        }
    }
    let result = match exec.await {
        Ok(r) => r,
        Err(e) => {
            let why = match &e {
                ToolError::User(m) | ToolError::Forbidden(m) | ToolError::Plain(m) | ToolError::Internal(m) => m.clone(),
                ToolError::Http { message, .. } => message.clone(),
                ToolError::NotFound => "not_found".to_owned(),
            };
            if let Ok(mut c) = ctx.deps.conn(p.company).await {
                let _ = sqlx::query("UPDATE ai_action_drafts SET status = 'failed', error = $2 WHERE id = $1")
                    .bind(id)
                    .bind(slice16(&why, 1000))
                    .execute(&mut *c)
                    .await;
            }
            return Err(e);
        }
    };
    match ctx.deps.conn(p.company).await {
        Ok(mut c) => {
            if let Err(e) = sqlx::query("UPDATE ai_action_drafts SET status = 'executed', result = $2::text::jsonb WHERE id = $1")
                .bind(id)
                .bind(js_json(&result))
                .execute(&mut *c)
                .await
            {
                tracing::error!("Ghi kết quả thao tác AI #{id} lỗi: {e}");
            }
        }
        Err(e) => tracing::error!("Ghi kết quả thao tác AI #{id} lỗi: {e:?}"),
    }
    let message = format!("Đã thực hiện: {summary}{}", row_error_note(&result));
    wrapped(&json!({
        "action_id": id, "status": "executed", "summary": summary, "result": result, "message": message,
    }))
}

/// Số nguyên có dấu trong `Value` (JSON số nguyên hoặc số thực không phần lẻ).
pub(super) fn as_int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64)),
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
        for no in ["", "tạo cho mình bảng khách", "chưa, thêm cột email", "không", "đừng tạo", "ok nhưng bớt cột"] {
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
