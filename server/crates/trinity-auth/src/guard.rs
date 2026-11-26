//! Guard xác thực: cùng thứ tự kiểm và cùng câu 401 với `packages/rbac-nest/src/jwt-auth.guard.ts`:
//! thiếu token → chữ ký/hạn/refresh → công ty còn hoạt động → blacklist → phiên hiện hành → trạng thái tài khoản.
//! Cộng guard `@Internal` (`x-service-secret`).

use std::sync::Arc;

use chrono::{DateTime, Utc};
use subtle::ConstantTimeEq;
use trinity_db::CompanyRef;
use trinity_kernel::error::HttpError;

use crate::jwt;
use crate::security::Security;

/// 9 câu 401, nguyên văn bản Node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    MissingToken,
    InvalidToken,
    CompanyInactive,
    Blacklisted,
    SessionReplaced,
    AccountMissing,
    AccountDeleted,
    AccountLocked,
    ServiceSecret,
}

impl AuthError {
    pub const fn message(self) -> &'static str {
        match self {
            Self::MissingToken => "Token không được cung cấp",
            Self::InvalidToken => "Token không hợp lệ hoặc đã hết hạn",
            Self::CompanyInactive => "Công ty của tài khoản này không còn hoạt động",
            Self::Blacklisted => "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
            Self::SessionReplaced => "Tài khoản vừa đăng nhập ở nơi khác, phiên này đã bị đăng xuất",
            Self::AccountMissing => "Tài khoản không tồn tại",
            Self::AccountDeleted => "Tài khoản đã bị xoá, vui lòng liên hệ quản trị viên",
            Self::AccountLocked => "Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên",
            Self::ServiceSecret => "Thiếu hoặc sai x-service-secret",
        }
    }
}

impl From<AuthError> for HttpError {
    fn from(e: AuthError) -> Self {
        HttpError::unauthorized(e.message())
    }
}

/// Người dùng đã xác thực (`req.user` của bản Node).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthUser {
    pub user_id: i32,
    pub email: String,
    pub company_id: i32,
}

/// `Authorization: Bearer <token>` như `extractTokenFromHeader` (tách theo dấu cách, loại phải đúng `Bearer`); token
/// rỗng coi như không có.
pub fn bearer_token(header: Option<&str>) -> Option<&str> {
    let mut it = header?.split(' ');
    let (kind, token) = (it.next()?, it.next()?);
    (kind == "Bearer" && !token.is_empty()).then_some(token)
}

fn safe_equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

pub struct Authenticator {
    security: Arc<Security>,
    jwt_secret: String,
    /// `INTERNAL_SERVICE_SECRET`, `SERVICE_SECRET` (bỏ giá trị rỗng): giá trị nào đang đặt đều được.
    service_secrets: Vec<String>,
}

type AccountRow = (Option<DateTime<Utc>>, String);

impl Authenticator {
    pub fn new(security: Arc<Security>, jwt_secret: &str, service_secrets: &[&str]) -> Self {
        Self {
            security,
            jwt_secret: jwt_secret.to_owned(),
            service_secrets: service_secrets
                .iter()
                .filter(|s| !s.is_empty())
                .map(|s| (*s).to_owned())
                .collect(),
        }
    }

    pub fn security(&self) -> &Arc<Security> {
        &self.security
    }

    /// `@Internal`: so `x-service-secret` (hằng thời gian).
    pub fn check_service_secret(&self, provided: Option<&str>) -> Result<(), AuthError> {
        match provided {
            Some(p) if !p.is_empty() && self.service_secrets.iter().any(|e| safe_equal(p, e)) => Ok(()),
            _ => Err(AuthError::ServiceSecret),
        }
    }

    /// Xác thực một request từ giá trị header `Authorization`. Lỗi ngoài ý muốn (DB hỏng…) cũng thành `InvalidToken`,
    /// như `catch` của bản Node.
    pub async fn authenticate(&self, authorization: Option<&str>) -> Result<AuthUser, AuthError> {
        let token = bearer_token(authorization).ok_or(AuthError::MissingToken)?;
        let claims = jwt::verify(token, &self.jwt_secret).map_err(|_| AuthError::InvalidToken)?;
        if claims.is_refresh() {
            return Err(AuthError::InvalidToken);
        }
        let platform = self.security.platform();
        let cid = claims.company_id();
        let company = if platform.multi_tenant() {
            match platform.active_company(cid).await {
                Ok(Some(c)) => c,
                Ok(None) => return Err(AuthError::CompanyInactive),
                Err(_) => return Err(AuthError::InvalidToken),
            }
        } else if cid != 1 {
            // Tắt đa công ty: token công ty khác không được đóng vai user cùng id của công ty 1.
            return Err(AuthError::InvalidToken);
        } else {
            CompanyRef::DEFAULT
        };
        let user = i32::try_from(claims.sub).map_err(|_| AuthError::InvalidToken)?;
        let cid = company.id();
        if self.security.is_blacklisted(cid, user) {
            return Err(AuthError::Blacklisted);
        }
        if !self.security.is_current_session(cid, user, claims.sid.as_deref()) {
            return Err(AuthError::SessionReplaced);
        }
        // Mỗi request thêm một truy vấn: thu hồi tức thì khi xoá mềm hoặc khoá user.
        match self
            .account_status(company, user)
            .await
            .map_err(|_| AuthError::InvalidToken)?
        {
            None => Err(AuthError::AccountMissing),
            Some((Some(_), _)) => Err(AuthError::AccountDeleted),
            Some((None, status)) if status != "active" => Err(AuthError::AccountLocked),
            Some(_) => Ok(AuthUser {
                user_id: user,
                email: claims.email,
                company_id: cid,
            }),
        }
    }

    async fn account_status(&self, company: CompanyRef, user: i32) -> Result<Option<AccountRow>, trinity_db::DbError> {
        let tenant = self.security.db().tenant(company).await?;
        let mut conn = tenant.acquire().await?;
        Ok(sqlx::query_as("SELECT deleted_at, status FROM users WHERE id = $1")
            .bind(user)
            .fetch_optional(&mut *conn)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_nhu_extract_token_from_header() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("Bearer abc def")), Some("abc"));
        assert_eq!(bearer_token(Some("Bearer ")), None);
        assert_eq!(bearer_token(Some("Bearer")), None);
        assert_eq!(bearer_token(Some("bearer abc")), None);
        assert_eq!(bearer_token(Some("Basic abc")), None);
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn chin_cau_401_nguyen_van() {
        let all = [
            (AuthError::MissingToken, "Token không được cung cấp"),
            (AuthError::InvalidToken, "Token không hợp lệ hoặc đã hết hạn"),
            (
                AuthError::CompanyInactive,
                "Công ty của tài khoản này không còn hoạt động",
            ),
            (
                AuthError::Blacklisted,
                "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại",
            ),
            (
                AuthError::SessionReplaced,
                "Tài khoản vừa đăng nhập ở nơi khác, phiên này đã bị đăng xuất",
            ),
            (AuthError::AccountMissing, "Tài khoản không tồn tại"),
            (
                AuthError::AccountDeleted,
                "Tài khoản đã bị xoá, vui lòng liên hệ quản trị viên",
            ),
            (
                AuthError::AccountLocked,
                "Tài khoản đã bị khoá, vui lòng liên hệ quản trị viên",
            ),
            (AuthError::ServiceSecret, "Thiếu hoặc sai x-service-secret"),
        ];
        for (e, msg) in all {
            let b = HttpError::from(e).body();
            assert_eq!(b.status_code, 401);
            assert_eq!(serde_json::to_value(&b.message).unwrap(), serde_json::json!(msg));
            assert_eq!(b.error, "Unauthorized");
        }
    }

    #[test]
    fn safe_equal_khac_do_dai_la_false() {
        assert!(safe_equal("abc", "abc"));
        assert!(!safe_equal("abc", "abcd"));
        assert!(!safe_equal("abc", "abd"));
    }
}
