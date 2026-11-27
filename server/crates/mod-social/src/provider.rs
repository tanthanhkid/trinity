//! Provider Facebook Page (`providers/facebook.provider.ts`, phần kết nối). Mọi lời gọi Graph đi qua
//! [`mod_facebook::graph::GraphClient`] (một chỗ duy nhất gọi Meta: URL gốc đổi được bằng `FACEBOOK_GRAPH_BASE_URL`, chống SSRF
//! ở `api_base_url`, kết quả báo ChannelGuard). Đăng bài, số liệu thuộc M54.

use mod_facebook::config::{Env, FACEBOOK_SOCIAL_SCOPES, form_encode, load_facebook_config};
use mod_facebook::graph::{GraphApiError, GraphClient, GraphPage, utf16_prefix};
use serde_json::{Map, Value};

use crate::first_comment::FIRST_COMMENT_MAX;
use crate::media::SocialMedia;
use crate::utm::utf16_len;

/// Tên biến môi trường cần đặt (hiện ở màn Kênh khi chưa cấu hình).
pub const FACEBOOK_ENV_NAMES: [&str; 2] = ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"];

/// Đủ app id/secret để liên kết.
pub fn configured(env: &Env) -> bool {
    let c = load_facebook_config(env);
    !c.app_id.is_empty() && !c.app_secret.is_empty()
}

/// URL hộp thoại đăng nhập (`authorizeUrl`): thứ tự tham số `client_id, redirect_uri, state, scope, response_type`.
pub fn authorize_url(env: &Env, state: &str, redirect_uri: &str) -> String {
    let c = load_facebook_config(env);
    let query = vec![
        ("client_id".to_owned(), c.app_id.clone()),
        ("redirect_uri".to_owned(), redirect_uri.to_owned()),
        ("state".to_owned(), state.to_owned()),
        ("scope".to_owned(), FACEBOOK_SOCIAL_SCOPES.join(",")),
        ("response_type".to_owned(), "code".to_owned()),
    ];
    format!(
        "https://www.facebook.com/{}/dialog/oauth?{}",
        c.graph_version,
        form_encode(&query)
    )
}

/// Tài khoản/trang nhận được sau OAuth; token ở dạng THÔ, tầng lưu mã hoá trước khi ghi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectedAccount {
    pub external_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub access_token: String,
    pub scopes: Vec<String>,
}

/// Page người dùng có quyền tạo nội dung: `tasks` vắng, hoặc có `CREATE_CONTENT`/`MANAGE`; và có `access_token`.
pub fn connected_from_pages(pages: &[GraphPage]) -> Vec<ConnectedAccount> {
    pages
        .iter()
        .filter_map(|p| {
            let token = p.access_token.as_deref().filter(|t| !t.is_empty())?;
            let allowed = p
                .tasks
                .as_ref()
                .is_none_or(|t| t.iter().any(|x| x == "CREATE_CONTENT" || x == "MANAGE"));
            if !allowed {
                return None;
            }
            Some(ConnectedAccount {
                external_id: p.id.clone().filter(|s| !s.is_empty())?,
                name: p.name.clone()?,
                avatar_url: p.picture_url().map(str::to_owned),
                access_token: token.to_owned(),
                scopes: FACEBOOK_SOCIAL_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
            })
        })
        .collect()
}

/// `exchange`: `code` ⇒ user token ngắn ⇒ dài hạn ⇒ `me/accounts`. Token Page từ user token dài hạn không hết hạn.
pub async fn exchange(
    graph: &GraphClient,
    code: &str,
    redirect_uri: &str,
) -> Result<Vec<ConnectedAccount>, GraphApiError> {
    let short = graph.exchange_code(code, redirect_uri).await?;
    let long = graph.to_long_lived(&short).await?;
    let pages = graph.list_pages(&long).await?;
    Ok(connected_from_pages(&pages))
}

/// `validateMedia`: Facebook chỉ một video, không ghép video với ảnh, tối đa 10 ảnh.
pub fn validate_media(media: &[SocialMedia]) -> Option<String> {
    let videos = media.iter().filter(|m| m.r#type == "video").count();
    let images = media.len() - videos;
    if videos > 1 {
        return Some("Facebook: mỗi bài chỉ một video.".to_owned());
    }
    if videos == 1 && images > 0 {
        return Some("Facebook: không ghép video với ảnh trong cùng một bài.".to_owned());
    }
    if images > 10 {
        return Some("Facebook: tối đa 10 ảnh mỗi bài.".to_owned());
    }
    None
}

/// `validateOptions`: `first_comment` (nếu có, kể cả `null`) phải là chữ tối đa 8.000 ký tự.
pub fn validate_options(options: &Map<String, Value>) -> Option<String> {
    match options.get("first_comment") {
        None => None,
        Some(Value::String(s)) if utf16_len(s) <= FIRST_COMMENT_MAX => None,
        Some(_) => Some("Facebook: bình luận đầu tiên phải là chữ, tối đa 8.000 ký tự.".to_owned()),
    }
}

/// Loại lỗi đăng để job quyết định thử lại hay liên kết lại (`classifyGraphError`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishErrorKind {
    /// Bài/video không còn trên Facebook (đã bị xoá).
    Gone,
    Token,
    Rate,
    Permission,
    Temporary,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishError {
    pub kind: PublishErrorKind,
    pub message: String,
}

/// Lỗi Graph ⇒ loại lỗi + câu tiếng Việt. Lỗi kết nối (không có mã HTTP) coi là tạm thời.
pub fn classify_graph_error(e: &GraphApiError) -> PublishError {
    let msg = utf16_prefix(&e.message, 300);
    let code = e.code;
    let status = e.http_status;
    let in_codes = |list: &[i64]| code.is_some_and(|c| list.contains(&c));
    let kind = if code == Some(100) && e.subcode == Some(33) {
        PublishErrorKind::Gone
    } else if in_codes(&[190, 102]) {
        PublishErrorKind::Token
    } else if status == 429 || in_codes(&[4, 17, 32, 613]) {
        PublishErrorKind::Rate
    } else if code == Some(10) || code.is_some_and(|c| (200..300).contains(&c)) {
        PublishErrorKind::Permission
    } else if in_codes(&[1, 2]) || status == 408 || status >= 500 || (status == 0 && !e.config_error) {
        PublishErrorKind::Temporary
    } else {
        PublishErrorKind::Invalid
    };
    let head = match kind {
        PublishErrorKind::Gone => "Facebook: bài không còn trên trang (đã bị xoá).",
        PublishErrorKind::Token => "Facebook: phiên đăng nhập của trang đã hết hạn hoặc bị thu hồi — liên kết lại.",
        PublishErrorKind::Rate => "Facebook giới hạn tần suất.",
        PublishErrorKind::Permission => "Facebook: thiếu quyền đăng lên trang này.",
        PublishErrorKind::Temporary => "Facebook tạm thời lỗi.",
        PublishErrorKind::Invalid => "Facebook từ chối bài:",
    };
    let message = match kind {
        PublishErrorKind::Invalid => format!("{head} {msg}"),
        _ => format!("{head} ({msg})"),
    };
    PublishError { kind, message }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, token: Option<&str>, tasks: Option<&[&str]>) -> GraphPage {
        GraphPage {
            id: Some(id.to_owned()),
            name: Some(format!("Trang {id}")),
            access_token: token.map(str::to_owned),
            tasks: tasks.map(|t| t.iter().map(|s| (*s).to_owned()).collect()),
            picture: None,
        }
    }

    #[test]
    fn loc_trang_dang_duoc() {
        let pages = vec![
            page("1", Some("t1"), None),
            page("2", Some("t2"), Some(&["MESSAGING"])),
            page("3", Some("t3"), Some(&["CREATE_CONTENT"])),
            page("4", None, Some(&["MANAGE"])),
            page("5", Some("t5"), Some(&["MANAGE", "MESSAGING"])),
        ];
        let ids: Vec<String> = connected_from_pages(&pages)
            .into_iter()
            .map(|a| a.external_id)
            .collect();
        assert_eq!(ids, ["1", "3", "5"]);
    }

    #[test]
    fn url_dang_nhap() {
        let env: Env = std::sync::Arc::new(|k| match k {
            "FACEBOOK_APP_ID" => Some("123".into()),
            "FACEBOOK_APP_SECRET" => Some("s".into()),
            _ => None,
        });
        assert!(configured(&env));
        assert_eq!(
            authorize_url(&env, "st", "https://a.example/cb"),
            "https://www.facebook.com/v25.0/dialog/oauth?client_id=123&redirect_uri=https%3A%2F%2Fa.example%2Fcb&state=st&scope=pages_show_list%2Cpages_read_engagement%2Cpages_manage_posts&response_type=code"
        );
        let none: Env = std::sync::Arc::new(|_| None);
        assert!(!configured(&none));
    }

    fn media(kinds: &[&str]) -> Vec<SocialMedia> {
        kinds
            .iter()
            .enumerate()
            .map(|(i, k)| SocialMedia {
                key: format!("k{i}"),
                r#type: (*k).to_owned(),
                content_type: String::new(),
                size: 1,
            })
            .collect()
    }

    #[test]
    fn kiem_tep_va_tuy_chon() {
        assert_eq!(validate_media(&media(&["image", "image"])), None);
        assert_eq!(validate_media(&media(&["video"])), None);
        let two = validate_media(&media(&["video", "video"]));
        assert_eq!(two.as_deref(), Some("Facebook: mỗi bài chỉ một video."));
        let mixed = validate_media(&media(&["video", "image"]));
        assert!(mixed.unwrap().contains("không ghép video với ảnh"));
        let many = ["image"; 11];
        assert_eq!(
            validate_media(&media(&many)).unwrap(),
            "Facebook: tối đa 10 ảnh mỗi bài."
        );

        let opt = |v: Value| v.as_object().cloned().unwrap_or_default();
        assert_eq!(validate_options(&opt(serde_json::json!({}))), None);
        assert_eq!(validate_options(&opt(serde_json::json!({"first_comment": "ok"}))), None);
        assert!(validate_options(&opt(serde_json::json!({"first_comment": null}))).is_some());
        assert!(validate_options(&opt(serde_json::json!({"first_comment": 1}))).is_some());
        let long = "a".repeat(8001);
        assert!(validate_options(&opt(serde_json::json!({ "first_comment": long }))).is_some());
    }

    fn graph_err(status: u16, code: Option<i64>, subcode: Option<i64>) -> GraphApiError {
        GraphApiError {
            http_status: status,
            code,
            subcode,
            message: "x".to_owned(),
            config_error: false,
        }
    }

    #[test]
    fn phan_loai_loi_graph() {
        let kind = |s, c, sc| classify_graph_error(&graph_err(s, c, sc)).kind;
        assert_eq!(kind(400, Some(100), Some(33)), PublishErrorKind::Gone);
        assert_eq!(kind(400, Some(190), None), PublishErrorKind::Token);
        assert_eq!(kind(400, Some(613), None), PublishErrorKind::Rate);
        assert_eq!(kind(429, None, None), PublishErrorKind::Rate);
        assert_eq!(kind(403, Some(200), None), PublishErrorKind::Permission);
        assert_eq!(kind(500, None, None), PublishErrorKind::Temporary);
        assert_eq!(kind(0, None, None), PublishErrorKind::Temporary);
        assert_eq!(kind(400, Some(100), None), PublishErrorKind::Invalid);
        let e = classify_graph_error(&graph_err(400, Some(100), None));
        assert_eq!(e.message, "Facebook từ chối bài: x");
    }
}
