//! Hướng dẫn nối lại Fanpage để nhân viên gửi cho quản trị viên của Page (thiết kế «Ánh xanh», ketnoi-mobile2).
//!
//! Chỉ SOẠN nội dung, không gửi gì ra ngoài và không ghi DB: người bấm nhận lại văn bản (và các bước, quyền ở dạng cấu trúc) rồi tự
//! chuyển cho quản trị viên bằng Zalo, Messenger, mail… của mình. Việc nối vẫn do người dùng Trinity bấm ở màn Fanpage; hộp thoại
//! Facebook chỉ cho quản trị viên của Page chọn Page đó.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use serde::Serialize;
use sqlx::PgConnection;
use trinity_kernel::error::{AppError, HttpError};

use crate::config::{Env, load_facebook_config};
use crate::dto;
use crate::graph::utf16_prefix;
use crate::ingest::db;

/// Độ dài tối đa của tên người nhận và lời nhắn thêm (đơn vị UTF-16 như `@MaxLength`).
pub const RECIPIENT_MAX: usize = 120;
pub const NOTE_MAX: usize = 500;

/// Ba bước (tiêu đề, mô tả), cùng chữ với màn hướng dẫn trên điện thoại.
pub const STEPS: [(&str, &str); 3] = [
    (
        "Mở Facebook",
        "Bấm nút kết nối trong Trinity. Trinity chuyển sang hộp thoại đăng nhập của Facebook.",
    ),
    (
        "Chọn đúng Page",
        "Tick đúng Page cần nối. Các Page khác bỏ trống nếu không dùng.",
    ),
    (
        "Cho phép đủ quyền",
        "Giữ nguyên các quyền được tick sẵn, rồi bấm Xong. Trinity tự quay lại màn Fanpage.",
    ),
];

/// Quyền cần cấp (nhãn, bắt buộc).
pub const PERMISSIONS: [(&str, bool); 4] = [
    ("Đọc và trả lời tin nhắn Messenger", true),
    ("Nhận khách từ Lead Ads", true),
    ("Đọc bình luận trên bài viết", true),
    ("Đăng bài lên Page", false),
];

/// Body `POST /facebook/pages/:id/admin-guide`. Cả hai trường tuỳ chọn; rỗng hoặc `null` coi như không nhập.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GuideInput {
    pub recipient: Option<String>,
    pub note: Option<String>,
}

impl GuideInput {
    pub fn from_json(v: &serde_json::Value) -> Result<Self, HttpError> {
        let o = dto::object(v)?;
        let mut e = Vec::new();
        dto::unknown(o, &["recipient", "note"], &mut e);
        let recipient = dto::opt_string(o, "recipient", RECIPIENT_MAX, &mut e);
        let note = dto::opt_string(o, "note", NOTE_MAX, &mut e);
        dto::finish(e)?;
        Ok(Self {
            recipient: clean(recipient),
            note: clean(note),
        })
    }
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|t| trinity_kernel::vi::trim_js(&t).to_owned())
        .filter(|t| !t.is_empty())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GuideStep {
    pub title: &'static str,
    pub text: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GuidePermission {
    pub label: &'static str,
    pub required: bool,
}

/// Kết quả: `sent` luôn `false` (Trinity không gửi), `text` là lời nhắn đủ ý để dán vào bất kỳ kênh nào.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Guide {
    pub page_id: String,
    pub page_name: String,
    pub recipient: Option<String>,
    pub steps: Vec<GuideStep>,
    pub permissions: Vec<GuidePermission>,
    /// Trang Fanpage của Trinity; `None` khi máy chủ chưa đặt địa chỉ công khai.
    pub manage_url: Option<String>,
    pub text: String,
    pub sent: bool,
}

/// Soạn hướng dẫn cho Page tên `page_name`. Thuần hàm, dùng cho cả route và tool.
pub fn compose(page_id: &str, page_name: &str, input: &GuideInput, env: &Env) -> Guide {
    let manage_url = load_facebook_config(env)
        .base_url
        .map(|b| format!("{}/connections?muc=facebook", b.trim_end_matches('/')));
    let steps: Vec<GuideStep> = STEPS.iter().map(|&(title, text)| GuideStep { title, text }).collect();
    let permissions: Vec<GuidePermission> = PERMISSIONS
        .iter()
        .map(|&(label, required)| GuidePermission { label, required })
        .collect();

    let mut t = String::new();
    t.push_str(&match &input.recipient {
        Some(r) => format!("Chào {r},\n\n"),
        None => "Chào anh/chị,\n\n".to_owned(),
    });
    t.push_str(&format!(
        "Nhờ anh/chị nối lại Fanpage \"{page_name}\" với Trinity. Người thực hiện phải là quản trị viên của Page này trên Facebook.\n\nLàm ba bước:\n"
    ));
    for (i, s) in steps.iter().enumerate() {
        t.push_str(&format!("{}. {}: {}\n", i + 1, s.title, s.text));
    }
    t.push_str("\nQuyền cần cấp:\n");
    for p in &permissions {
        t.push_str(&format!(
            "- {}{}\n",
            p.label,
            if p.required { "" } else { " (không bắt buộc)" }
        ));
    }
    t.push_str("\nThiếu một quyền thì Page vẫn nối được nhưng sẽ không nhận đủ tin.\n");
    if let Some(u) = &manage_url {
        t.push_str(&format!("\nMở Trinity tại: {u}\n"));
    }
    if let Some(n) = &input.note {
        t.push_str(&format!("\n{n}\n"));
    }
    Guide {
        page_id: page_id.to_owned(),
        page_name: utf16_prefix(page_name, 200),
        recipient: input.recipient.clone(),
        steps,
        permissions,
        manage_url,
        text: t,
        sent: false,
    }
}

/// Cách chọn Page: theo id nội bộ (route) hoặc theo `page_id` của Facebook (tool).
pub enum PageKey<'a> {
    Id(i32),
    FacebookId(&'a str),
}

/// Đọc tên Page (kể cả Page đã ngắt kết nối: nối lại chính là lúc cần hướng dẫn) rồi soạn hướng dẫn.
pub async fn build(
    conn: &mut PgConnection,
    key: PageKey<'_>,
    input: &GuideInput,
    env: &Env,
) -> Result<Guide, AppError> {
    let row: Option<(String, String)> = match key {
        PageKey::Id(id) => {
            sqlx::query_as("SELECT page_id, name FROM facebook_pages WHERE id = $1")
                .bind(id)
                .fetch_optional(conn)
                .await
        }
        PageKey::FacebookId(pid) => {
            sqlx::query_as("SELECT page_id, name FROM facebook_pages WHERE page_id = $1")
                .bind(pid)
                .fetch_optional(conn)
                .await
        }
    }
    .map_err(db)?;
    let (page_id, name) = row.ok_or_else(|| HttpError::not_found("Không tìm thấy Fanpage"))?;
    Ok(compose(&page_id, &name, input, env))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    fn env(base: Option<&'static str>) -> Env {
        Arc::new(move |k| match (k, base) {
            ("INTEGRATIONS_PUBLIC_BASE_URL", Some(b)) => Some(b.to_owned()),
            _ => None,
        })
    }

    #[test]
    fn body_kiem_kieu_va_truong_la() {
        assert_eq!(GuideInput::from_json(&json!({})).unwrap(), GuideInput::default());
        let ok = GuideInput::from_json(&json!({ "recipient": "  Chị Lan ", "note": "", "x": null }));
        assert!(ok.is_err(), "trường lạ phải 400");
        let ok = GuideInput::from_json(&json!({ "recipient": "  Chị Lan ", "note": null })).unwrap();
        assert_eq!(ok.recipient.as_deref(), Some("Chị Lan"));
        assert_eq!(ok.note, None);
        assert!(GuideInput::from_json(&json!({ "recipient": 5 })).is_err());
        assert!(GuideInput::from_json(&json!({ "note": "a".repeat(NOTE_MAX + 1) })).is_err());
        assert!(GuideInput::from_json(&json!([1])).is_err());
    }

    #[test]
    fn van_ban_du_y_va_khong_gui() {
        let input = GuideInput {
            recipient: Some("Chị Lan".into()),
            note: Some("Cảm ơn chị.".into()),
        };
        let g = compose("111", "Hoa Mai Đà Nẵng", &input, &env(None));
        assert!(!g.sent);
        assert_eq!(g.manage_url, None);
        assert!(g.text.starts_with("Chào Chị Lan,"));
        assert!(g.text.contains("\"Hoa Mai Đà Nẵng\""));
        assert!(g.text.contains("3. Cho phép đủ quyền"));
        assert!(g.text.contains("- Đăng bài lên Page (không bắt buộc)"));
        assert!(g.text.trim_end().ends_with("Cảm ơn chị."));
        assert!(!g.text.contains("http"));
        assert_eq!(g.steps.len(), 3);
        assert_eq!(g.permissions.iter().filter(|p| !p.required).count(), 1);
    }

    #[test]
    fn co_dia_chi_cong_khai_thi_kem_link() {
        let g = compose(
            "111",
            "P",
            &GuideInput::default(),
            &env(Some("https://crm.example.test/")),
        );
        assert_eq!(
            g.manage_url.as_deref(),
            Some("https://crm.example.test/connections?muc=facebook")
        );
        assert!(g.text.starts_with("Chào anh/chị,"));
        assert!(
            g.text
                .contains("Mở Trinity tại: https://crm.example.test/connections?muc=facebook")
        );
    }
}
