//! JWT HS256 như `@nestjs/jwt`: ký và kiểm bằng cùng `JWT_SECRET`, payload `{ sub, email, sid?, cid?, type?, iat, exp }`.
//! **`leeway = 0`**: mặc định của crate là 60 giây (token hết hạn vẫn dùng thêm một phút), của bản Node là 0.

use std::sync::Once;

use hmac::{Hmac, KeyInit, Mac};
use jsonwebtoken::crypto::{CryptoProvider, JwtSigner, JwtVerifier, KeyUtils};
use jsonwebtoken::errors::{Error, ErrorKind, new_error};
use jsonwebtoken::signature::{self, Signer, Verifier};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

// Chỉ cần HS256. Tính năng `rust_crypto` của jsonwebtoken kéo cả `rsa` (RUSTSEC-2023-0071, `cargo deny` chặn) và
// `aws_lc_rs` cần cmake, nên cài provider riêng chỉ có HMAC-SHA256 từ `hmac`/`sha2` mà workspace đã dùng. Thuật toán
// khác (HS384, RS256, `none`…) bị từ chối ở bước kiểm `alg`, và nếu lọt tới đây thì provider trả lỗi.
type HmacSha256 = Hmac<Sha256>;

struct Hs256Signer(HmacSha256);
struct Hs256Verifier(HmacSha256);

impl Signer<Vec<u8>> for Hs256Signer {
    fn try_sign(&self, msg: &[u8]) -> Result<Vec<u8>, signature::Error> {
        let mut m = self.0.clone();
        m.update(msg);
        Ok(m.finalize().into_bytes().to_vec())
    }
}

impl JwtSigner for Hs256Signer {
    fn algorithm(&self) -> Algorithm {
        Algorithm::HS256
    }
}

impl Verifier<Vec<u8>> for Hs256Verifier {
    fn verify(&self, msg: &[u8], sig: &Vec<u8>) -> Result<(), signature::Error> {
        let mut m = self.0.clone();
        m.update(msg);
        // Hằng thời gian.
        m.verify_slice(sig).map_err(signature::Error::from_source)
    }
}

impl JwtVerifier for Hs256Verifier {
    fn algorithm(&self) -> Algorithm {
        Algorithm::HS256
    }
}

fn signer_factory(alg: &Algorithm, key: &EncodingKey) -> Result<Box<dyn JwtSigner>, Error> {
    if *alg != Algorithm::HS256 {
        return Err(new_error(ErrorKind::UnsupportedAlgorithm));
    }
    let m = HmacSha256::new_from_slice(key.as_bytes()).map_err(|_| new_error(ErrorKind::InvalidKeyFormat))?;
    Ok(Box::new(Hs256Signer(m)))
}

fn verifier_factory(alg: &Algorithm, key: &DecodingKey) -> Result<Box<dyn JwtVerifier>, Error> {
    if *alg != Algorithm::HS256 {
        return Err(new_error(ErrorKind::UnsupportedAlgorithm));
    }
    let m = HmacSha256::new_from_slice(key.try_get_as_bytes()?).map_err(|_| new_error(ErrorKind::InvalidKeyFormat))?;
    Ok(Box::new(Hs256Verifier(m)))
}

static PROVIDER: CryptoProvider = CryptoProvider {
    signer_factory,
    verifier_factory,
    key_utils: KeyUtils::new_unimplemented(),
};

fn install_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Đã có provider khác (tiến trình tự cài) thì giữ nguyên.
        let _ = PROVIDER.install_default();
    });
}

/// Access token 15 phút.
pub const ACCESS_TTL_SECS: u64 = 15 * 60;
/// Refresh token 7 ngày.
pub const REFRESH_TTL_SECS: u64 = 7 * 24 * 3600;

/// Payload. Thứ tự trường là thứ tự Node ghi (để token Rust ký giống từng byte token Node với cùng đầu vào).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    #[serde(default)]
    pub email: String,
    /// Chỉ có khi tính năng một-phiên bật lúc đăng nhập; thiếu ⇒ fail-open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    /// Công ty; thiếu = công ty 1 (token phát trước khi có đa công ty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cid: Option<i64>,
    /// `refresh` cho refresh token: KHÔNG được dùng làm access token.
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iat: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<u64>,
}

impl Claims {
    pub fn access(sub: i64, email: &str, sid: Option<String>, cid: Option<i64>, now: u64) -> Self {
        Self {
            sub,
            email: email.to_owned(),
            sid,
            cid,
            kind: None,
            iat: Some(now),
            exp: Some(now + ACCESS_TTL_SECS),
        }
    }

    pub fn company_id(&self) -> i64 {
        self.cid.unwrap_or(1)
    }

    pub fn is_refresh(&self) -> bool {
        self.kind.as_deref() == Some("refresh")
    }
}

/// Ký HS256. Lỗi chỉ khi serialize hỏng (không xảy ra với `Claims`).
pub fn sign(claims: &Claims, secret: &str) -> Result<String, Error> {
    install_provider();
    encode(
        &Header::new(Algorithm::HS256),
        claims,
        &EncodingKey::from_secret(secret.as_bytes())?,
    )
}

fn validation() -> Validation {
    let mut v = Validation::new(Algorithm::HS256);
    v.leeway = 0;
    v.validate_exp = true;
    v.validate_nbf = true;
    // Như `jsonwebtoken` của Node: không bắt buộc có `exp`, kiểm `exp`/`nbf` khi có; không kiểm `aud`.
    v.required_spec_claims.clear();
    v.validate_aud = false;
    v
}

/// Kiểm chữ ký HS256 và hạn (`leeway = 0`). Mọi lỗi gộp một loại: guard trả cùng một câu 401.
pub fn verify(token: &str, secret: &str) -> Result<Claims, Error> {
    install_provider();
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes())?, &validation()).map(|d| d.claims)
}

#[cfg(test)]
mod tests;
