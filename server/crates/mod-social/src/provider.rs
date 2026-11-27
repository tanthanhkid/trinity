//! Provider Facebook Page (`providers/facebook.provider.ts`, phần kết nối). Mọi lời gọi Graph đi qua
//! [`mod_facebook::graph::GraphClient`] (một chỗ duy nhất gọi Meta: URL gốc đổi được bằng `FACEBOOK_GRAPH_BASE_URL`, chống SSRF
//! ở `api_base_url`, kết quả báo ChannelGuard). Đăng bài, số liệu thuộc M54.

use mod_facebook::config::{Env, FACEBOOK_SOCIAL_SCOPES, form_encode, load_facebook_config};
use mod_facebook::graph::{GraphApiError, GraphClient, GraphPage};

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
    format!("https://www.facebook.com/{}/dialog/oauth?{}", c.graph_version, form_encode(&query))
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
pub async fn exchange(graph: &GraphClient, code: &str, redirect_uri: &str) -> Result<Vec<ConnectedAccount>, GraphApiError> {
    let short = graph.exchange_code(code, redirect_uri).await?;
    let long = graph.to_long_lived(&short).await?;
    let pages = graph.list_pages(&long).await?;
    Ok(connected_from_pages(&pages))
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
        let ids: Vec<String> = connected_from_pages(&pages).into_iter().map(|a| a.external_id).collect();
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
}
