//! Mã hoá secret ký của endpoint: AES-256-GCM, khoá `INTEGRATIONS_SECRET_KEY` = 32 byte base64. Thiếu hoặc sai khoá ⇒ lỗi,
//! KHÔNG tự sinh khoá ngầm. Định dạng `v1.<iv>.<tag>.<ciphertext>` (base64url, AAD `trinity-webhook-secret/v1`) khớp bản Node
//! để hai bên đọc được dữ liệu của nhau. Dùng chung cho webhook vào (M35).

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};

const AAD: &[u8] = b"trinity-webhook-secret/v1";
const KEY_BYTES: usize = 32;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Lỗi khoá/secret. `Display` là câu bản Node trả (503 cho người dùng).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct KeyError(pub String);

pub type Key = [u8; KEY_BYTES];

/// Nguồn khoá (đọc env mỗi lần gọi như bản Node, để đổi `.env` + restart là đủ).
pub type KeySource = std::sync::Arc<dyn Fn() -> Result<Key, KeyError> + Send + Sync>;

/// Base64 của Node `Buffer.from(raw, 'base64')`: nhận cả hai bảng chữ, đệm tuỳ chọn, bit thừa cuối bị bỏ qua.
fn lenient() -> GeneralPurpose {
    GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )
}

pub fn load_secret_key(get: &impl Fn(&str) -> Option<String>) -> Result<Key, KeyError> {
    let raw = get("INTEGRATIONS_SECRET_KEY")
        .map(|s| s.trim().to_owned())
        .unwrap_or_default();
    if raw.is_empty() {
        return Err(KeyError(
            "INTEGRATIONS_SECRET_KEY chưa được cấu hình (cần 32 byte base64)".into(),
        ));
    }
    let body = raw.trim_end_matches('=');
    let valid = !body.is_empty()
        && raw.len() - body.len() <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'_' | b'-'));
    if !valid {
        return Err(KeyError("INTEGRATIONS_SECRET_KEY không phải base64 hợp lệ".into()));
    }
    let std_form: String = body
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    let bytes = lenient().decode(std_form.as_bytes()).unwrap_or_default();
    Key::try_from(bytes.as_slice()).map_err(|_| {
        KeyError(format!(
            "INTEGRATIONS_SECRET_KEY phải giải mã ra đúng {KEY_BYTES} byte (hiện {})",
            bytes.len()
        ))
    })
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("hệ điều hành cấp được byte ngẫu nhiên");
    b
}

pub fn encrypt_secret(plain: &str, key: &Key) -> String {
    let iv = random::<IV_BYTES>();
    let cipher = Aes256Gcm::new_from_slice(key).expect("khoá 32 byte");
    let mut buf = plain.as_bytes().to_vec();
    let tag = cipher
        .encrypt_inout_detached(
            &Nonce::try_from(&iv[..]).expect("iv 12 byte"),
            AAD,
            buf.as_mut_slice().into(),
        )
        .expect("mã hoá GCM");
    let b = |x: &[u8]| URL_SAFE_NO_PAD.encode(x);
    format!("v1.{}.{}.{}", b(&iv), b(&tag), b(&buf))
}

pub fn decrypt_secret(enc: &str, key: &Key) -> Result<String, KeyError> {
    let parts: Vec<&str> = enc.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        return Err(KeyError("secret_enc sai định dạng".into()));
    }
    let bad = || KeyError("Không giải mã được secret (sai INTEGRATIONS_SECRET_KEY hoặc dữ liệu hỏng)".into());
    let dec = |s: &str| URL_SAFE_NO_PAD.decode(s).map_err(|_| bad());
    let (iv, tag, mut ct) = (dec(parts[1])?, dec(parts[2])?, dec(parts[3])?);
    if iv.len() != IV_BYTES || tag.len() != TAG_BYTES {
        return Err(bad());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| bad())?;
    cipher
        .decrypt_inout_detached(
            &Nonce::try_from(&iv[..]).map_err(|_| bad())?,
            AAD,
            ct.as_mut_slice().into(),
            &Tag::try_from(&tag[..]).map_err(|_| bad())?,
        )
        .map_err(|_| bad())?;
    String::from_utf8(ct).map_err(|_| bad())
}

/// Secret ký HMAC của endpoint, hiển thị đúng một lần cho người tạo: `whsec_` + 32 byte base64url.
pub fn generate_webhook_secret() -> String {
    format!("whsec_{}", URL_SAFE_NO_PAD.encode(random::<32>()))
}
