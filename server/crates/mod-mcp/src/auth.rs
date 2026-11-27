//! Xác thực MCP (`mcp-auth.service.ts`): danh tính CHỈ từ access token OAuth đã kiểm (băm → tra DB → chưa thu hồi/hết hạn, đúng
//! audience, người dùng còn hoạt động; [`mod_oauth::OauthCtx::verify_access_token`]), rồi quyền `integrations.ai_connect` và scope
//! `crm.read`. Người dùng được GIỚI HẠN cho AI ([`restrict_for_ai`]).

use std::sync::Arc;

use mod_oauth::OauthCtx;
use trinity_db::CompanyRef;
use trinity_rbac::Grants;

use crate::protocol::BoxFuture;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFailure {
    Missing,
    InvalidToken,
    InsufficientScope,
    /// Lỗi hệ thống khi xác thực (DB lỗi): KHÔNG phải lỗi của người gọi ⇒ 500, không challenge, không đếm, không ghi `denied`.
    Internal,
}

impl AuthFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::InvalidToken => "invalid_token",
            Self::InsufficientScope => "insufficient_scope",
            Self::Internal => "internal",
        }
    }
}

/// Người dùng/client đã nhận diện được (để ghi nhật ký `denied`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Who {
    pub company: CompanyRef,
    pub user_id: i32,
    pub client_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthError {
    pub kind: AuthFailure,
    pub description: String,
    pub who: Option<Who>,
}

impl AuthError {
    fn new(kind: AuthFailure, description: &str, who: Option<Who>) -> Self {
        Self {
            kind,
            description: description.to_owned(),
            who,
        }
    }
}

/// Người gọi đã xác thực. `grants` đã bị gỡ `*.phone_full`; không có cờ admin (admin đã có mọi quyền ở `grants`).
#[derive(Debug, Clone)]
pub struct Principal {
    pub company: CompanyRef,
    pub user_id: i32,
    pub email: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub token_id: i64,
    pub grants: Grants,
}

/// Cho AI chỉ thấy tối đa những gì người dùng thấy, và SĐT luôn che: gỡ MỌI quyền `*.phone_full` khỏi grants (nghiệp vụ che qua
/// `owner_ids(…phone_full)` ⇒ `None` ⇒ che hết).
pub fn restrict_for_ai(mut grants: Grants) -> Grants {
    grants.retain(|k, _| !k.ends_with(".phone_full"));
    grants
}

/// Nguồn danh tính (trừu tượng để test không cần DB).
pub trait Identity: Send + Sync {
    /// `authorization` là giá trị header `Authorization` (nếu có).
    fn authenticate<'a>(&'a self, authorization: Option<&'a str>) -> BoxFuture<'a, Result<Principal, AuthError>>;
}

/// `^Bearer\s+(\S+)$` (không phân biệt hoa thường).
pub fn bearer_token(h: Option<&str>) -> Option<&str> {
    let h = h?;
    let (scheme, rest) = h.split_once(char::is_whitespace)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let tok = rest.trim_start();
    (!tok.is_empty() && !tok.contains(char::is_whitespace)).then_some(tok)
}

/// Danh tính từ OAuth của M37.
pub struct OauthIdentity {
    pub oauth: Arc<OauthCtx>,
}

impl Identity for OauthIdentity {
    fn authenticate<'a>(&'a self, authorization: Option<&'a str>) -> BoxFuture<'a, Result<Principal, AuthError>> {
        Box::pin(async move {
            let Some(raw) = bearer_token(authorization) else {
                return Err(AuthError::new(AuthFailure::Missing, "Thiếu Bearer token", None));
            };
            let Some(v) = self.oauth.verify_access_token(raw).await else {
                return Err(AuthError::new(
                    AuthFailure::InvalidToken,
                    "Token không hợp lệ, đã hết hạn hoặc đã bị thu hồi",
                    None,
                ));
            };
            let who = Who {
                company: v.company,
                user_id: v.user_id,
                client_id: v.client_id.clone(),
            };
            let g = self.oauth.perms.grants_for(v.company, v.user_id).await.map_err(|e| {
                tracing::error!("MCP: không đọc được quyền của người dùng {}: {e}", who.user_id);
                AuthError::new(AuthFailure::Internal, "Không kiểm được quyền của tài khoản", None)
            })?;
            if !g.is_admin && !trinity_rbac::can(&g.grants, "integrations.ai_connect", None) {
                return Err(AuthError::new(
                    AuthFailure::InvalidToken,
                    "Tài khoản không còn quyền kết nối AI",
                    Some(who),
                ));
            }
            if !v.scopes.iter().any(|s| s == "crm.read") {
                return Err(AuthError::new(
                    AuthFailure::InsufficientScope,
                    "Token thiếu scope crm.read",
                    Some(who),
                ));
            }
            Ok(Principal {
                company: v.company,
                user_id: v.user_id,
                email: v.email,
                client_id: v.client_id,
                scopes: v.scopes,
                token_id: v.token_id,
                grants: restrict_for_ai(g.grants.clone()),
            })
        })
    }
}

/// Giá trị header HTTP chỉ nhận Latin-1: mô tả tiếng Việt phải bỏ dấu (`asciiHeader`).
pub fn ascii_header(v: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    v.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| match c {
            'đ' => 'd',
            'Đ' => 'D',
            c => c,
        })
        .filter(|c| (' '..='~').contains(c))
        .map(|c| if c == '"' { '\'' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinity_rbac::{Grant, Scope};

    #[test]
    fn bearer_dung_dinh_dang() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("bearer   abc")), Some("abc"));
        for bad in [
            None,
            Some(""),
            Some("Bearer"),
            Some("Bearer a b"),
            Some("Basic abc"),
            Some("Bearer "),
        ] {
            assert_eq!(bearer_token(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn gui_quyen_phone_full_va_header_latin1() {
        let mut g = Grants::new();
        g.insert("contacts.view".into(), Grant::Scope(Scope::All));
        g.insert("contacts.phone_full".into(), Grant::Scope(Scope::All));
        g.insert("custom_records.phone_full".into(), Grant::Scope(Scope::Own));
        let r = restrict_for_ai(g);
        assert_eq!(r.keys().map(String::as_str).collect::<Vec<_>>(), vec!["contacts.view"]);
        assert_eq!(ascii_header("Token không hợp lệ \"x\" đ"), "Token khong hop le 'x' d");
    }
}
