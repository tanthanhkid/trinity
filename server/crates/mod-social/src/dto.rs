//! DTO của route tài khoản, kiểm đúng như class-validator (thông điệp của `ValidationPipe`, không phải của serde).

use serde_json::Value;
use trinity_kernel::error::HttpError;

use crate::config::{REMOVED_SOCIAL_NETWORKS, SOCIAL_NETWORKS};

const BAD_NETWORK: &str = "Mạng không hợp lệ";

/// Body `POST /social/accounts/connect-url` (`SocialConnectDto`): `@IsIn([...SOCIAL_NETWORKS, ...removed], { message: 'Mạng không hợp lệ' })`.
/// Nhận cả tên mạng đã gỡ để service trả câu "đã ngừng hỗ trợ". Thiếu, `null`, không phải chuỗi ⇒ cùng câu lỗi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocialConnect {
    pub network: String,
}

impl SocialConnect {
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let network = v
            .as_object()
            .and_then(|o| o.get("network"))
            .and_then(Value::as_str)
            .filter(|s| SOCIAL_NETWORKS.contains(s) || REMOVED_SOCIAL_NETWORKS.iter().any(|(k, _)| k == s));
        match network {
            Some(n) => Ok(Self { network: n.to_owned() }),
            None => Err(HttpError::validation(vec![BAD_NETWORK.to_owned()])),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kiem_mang() {
        assert_eq!(
            SocialConnect::from_json(&json!({"network":"facebook"})).unwrap().network,
            "facebook"
        );
        assert!(SocialConnect::from_json(&json!({"network":"youtube"})).is_ok());
        for bad in [
            json!({}),
            json!({"network":null}),
            json!({"network":1}),
            json!({"network":"x"}),
            json!([]),
            json!(null),
        ] {
            let e = SocialConnect::from_json(&bad).unwrap_err();
            let (s, b) = trinity_kernel::error::AppError::from(e).response(true);
            assert_eq!(s, 400);
            assert_eq!(serde_json::to_value(&b.message).unwrap(), json!(["Mạng không hợp lệ"]), "{bad}");
        }
    }
}
