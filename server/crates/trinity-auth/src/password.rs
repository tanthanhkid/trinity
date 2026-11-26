//! Mật khẩu: `bcryptjs` cost 10 của bản Node. `bcrypt::verify` đọc hash `$2a$`/`$2b$`; hash mới vẫn cost 10 và tiền tố
//! `$2b$` mà bcryptjs đọc được. Chạy trong `spawn_blocking` (cost 10 chiếm CPU trên máy dùng chung lõi).

/// Cost của bản Node.
pub const COST: u32 = 10;

/// `bcrypt.compare`. Hash hỏng ⇒ `false` (Node trả false, không ném).
pub async fn verify(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false))
        .await
        .unwrap_or(false)
}

/// `bcrypt.hash(password, 10)`.
pub async fn hash(password: String) -> Result<String, bcrypt::BcryptError> {
    tokio::task::spawn_blocking(move || bcrypt::hash(password, COST))
        .await
        .map_err(|_| bcrypt::BcryptError::InvalidHash("tác vụ băm bị huỷ"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // `bcryptjs.hashSync('Matkhau#123', 10)` sinh bằng Node.
    const NODE_HASH: &str = "$2a$10$BPI7emvLog5vYEj4/loD7u3jVisbLV/9NW9a.bg0WQXAJoqtlCG5e";

    #[tokio::test]
    async fn hash_bcryptjs_kiem_duoc() {
        assert!(verify("Matkhau#123".into(), NODE_HASH.into()).await);
        assert!(!verify("matkhau#123".into(), NODE_HASH.into()).await);
        assert!(!verify("x".into(), "khong-phai-hash".into()).await);
    }

    #[tokio::test]
    async fn hash_moi_cost_10_va_kiem_lai_duoc() {
        let h = hash("Mật khẩu mới".into()).await.unwrap();
        assert!(h.starts_with("$2b$10$"), "{h}");
        assert!(verify("Mật khẩu mới".into(), h).await);
    }
}
