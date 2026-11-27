//! Lỗi OAuth theo RFC 6749 §5.2 / 4.1.2.1 (`oauth-error.ts`).

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthError {
    pub code: String,
    pub description: String,
    /// HTTP status khi trả ở endpoint token/register/revoke/consent.
    pub status: u16,
    /// Đã biết `redirect_uri` hợp lệ: trả về cho client qua redirect (kèm `state`, `iss`) thay vì hiện trên trang.
    pub redirectable: bool,
}

impl OAuthError {
    pub fn new(code: &str, description: &str) -> Self {
        Self::with_status(code, description, 400)
    }

    pub fn with_status(code: &str, description: &str, status: u16) -> Self {
        Self {
            code: code.to_owned(),
            description: description.to_owned(),
            status,
            redirectable: false,
        }
    }

    pub fn redirectable(code: &str, description: &str) -> Self {
        Self {
            redirectable: true,
            ..Self::new(code, description)
        }
    }

    pub fn body(&self) -> Value {
        json!({ "error": self.code, "error_description": self.description })
    }

    /// Lỗi nội bộ: không lộ chi tiết cho client, chỉ ghi log máy chủ.
    pub fn internal(what: &str, e: impl std::fmt::Display) -> Self {
        tracing::error!("[oauth] {what}: {e}");
        Self::with_status("server_error", "Lỗi máy chủ", 500)
    }
}

pub type R<T> = Result<T, OAuthError>;

pub fn invalid_grant(desc: &str) -> OAuthError {
    OAuthError::new("invalid_grant", desc)
}
