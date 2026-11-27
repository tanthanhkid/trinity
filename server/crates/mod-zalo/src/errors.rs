//! Lỗi Zalo (`zalo-oa.errors.ts`): lỗi trả về từ Zalo (`error` khác 0), lỗi mạng, hoặc cấu hình địa chỉ gốc sai.

/// Mã riêng của Trinity: địa chỉ gốc Zalo (`ZALO_*_BASE_URL`) cấu hình sai, chưa gửi gì tới Zalo.
pub const ZALO_CONFIG_ERROR: i64 = -3;
/// Mã riêng: phản hồi token của Zalo thiếu trường. (Bản Node dùng nhầm `-3` cho trường hợp này nên bị tính là lỗi cấu hình.)
pub const ZALO_BAD_TOKEN_BODY: i64 = -4;

/// Lỗi gọi Zalo. `Display` là thông báo gốc (có thể là tiếng Anh của Zalo): chỉ ghi log, người dùng thấy
/// [`describe_zalo_error`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ZaloApiError {
    pub code: i64,
    pub message: String,
    pub http_status: Option<u16>,
}

impl ZaloApiError {
    pub fn new(code: i64, message: impl Into<String>, http_status: Option<u16>) -> Self {
        Self {
            code,
            message: message.into(),
            http_status,
        }
    }

    /// Cấu hình phía Trinity sai: không phải lỗi tạm thời, cũng không phải token hỏng.
    pub fn is_config_error(&self) -> bool {
        self.code == ZALO_CONFIG_ERROR
    }

    /// Token sai/hết hạn/bị thu hồi ⇒ cần cấp quyền lại hoặc làm mới (`-216` access token invalid, `-124` hết hạn, `-118`).
    pub fn is_auth_error(&self) -> bool {
        matches!(self.code, -216 | -124 | -118)
    }

    /// Lỗi tạm thời: mạng (`-1`), phản hồi không đọc được (`-2`) hoặc Zalo 5xx. KHÔNG nghĩa là refresh token hỏng.
    pub fn is_transient(&self) -> bool {
        self.code == -1 || self.code == -2 || self.http_status.unwrap_or(0) >= 500
    }
}

/// Câu báo khi Zalo đòi OA nâng gói dịch vụ (OA Tier): gói miễn phí không gửi được tin tư vấn, không đọc được hồ sơ người dùng.
pub const ZALO_TIER_MESSAGE: &str =
    "Zalo OA chưa được dùng tính năng này: OA cần nâng gói dịch vụ Zalo OA (Tier). Xem https://zalo.cloud/oa/pricing";

/// Kênh đã gọi: cùng một mã (vd `-224`) mang nghĩa khác nhau giữa tin tư vấn và ZNS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Consult,
    Zns,
}

/// Mã lỗi hay gặp ⇒ câu tiếng Việt cho người dùng (không lộ nguyên văn lỗi của Zalo).
pub fn describe_zalo_error(e: &ZaloApiError, channel: Channel) -> String {
    if e.is_config_error() {
        return format!("Cấu hình kết nối Zalo của máy chủ sai: {}", e.message);
    }
    if e.is_auth_error() {
        return "Kết nối Zalo OA đã hết hạn hoặc bị thu hồi — cần kết nối lại.".to_owned();
    }
    let lower = e.message.to_lowercase();
    if lower.contains("tier package") || lower.contains("upgrade oa") {
        return ZALO_TIER_MESSAGE.to_owned();
    }
    if channel == Channel::Consult && e.code == -224 {
        return ZALO_TIER_MESSAGE.to_owned();
    }
    match e.code {
        -233 => "Người dùng chưa quan tâm OA hoặc đã chặn — không gửi được.".to_owned(),
        -230 => "Đã quá 48 giờ kể từ tin gần nhất của khách — dùng ZNS thay vì tin tư vấn.".to_owned(),
        -224 => "Mẫu ZNS không tồn tại hoặc chưa được duyệt.".to_owned(),
        -225 => "Số điện thoại không hợp lệ hoặc không dùng Zalo.".to_owned(),
        -226 => "Dữ liệu điền vào mẫu ZNS không hợp lệ.".to_owned(),
        -223 => "Đã hết hạn mức gửi trong ngày.".to_owned(),
        c => format!("Zalo từ chối (mã {c})."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(code: i64, msg: &str) -> ZaloApiError {
        ZaloApiError::new(code, msg, None)
    }

    #[test]
    fn phan_loai_va_cau_nguoi_dung() {
        for c in [-216, -124, -118] {
            assert!(e(c, "x").is_auth_error(), "{c}");
            assert!(describe_zalo_error(&e(c, "x"), Channel::Zns).contains("kết nối lại"));
        }
        assert!(!e(-233, "x").is_auth_error() && e(ZALO_CONFIG_ERROR, "sai").is_config_error());
        assert!(
            describe_zalo_error(&e(ZALO_CONFIG_ERROR, "sai"), Channel::Zns)
                .starts_with("Cấu hình kết nối Zalo của máy chủ sai: sai")
        );
        assert_eq!(describe_zalo_error(&e(-224, "x"), Channel::Consult), ZALO_TIER_MESSAGE);
        assert!(describe_zalo_error(&e(-224, "x"), Channel::Zns).contains("Mẫu ZNS"));
        assert_eq!(
            describe_zalo_error(&e(-1, "Please upgrade OA to a tier package"), Channel::Zns),
            ZALO_TIER_MESSAGE
        );
        for (c, frag) in [
            (-233, "chưa quan tâm"),
            (-230, "48 giờ"),
            (-225, "Số điện thoại"),
            (-226, "Dữ liệu"),
            (-223, "hạn mức"),
            (-999, "mã -999"),
        ] {
            assert!(describe_zalo_error(&e(c, "x"), Channel::Zns).contains(frag), "{c}");
        }
        assert!(
            e(-1, "x").is_transient()
                && e(-2, "x").is_transient()
                && ZaloApiError::new(-5, "x", Some(502)).is_transient()
        );
        assert!(!e(-216, "x").is_transient() && !ZaloApiError::new(-5, "x", Some(400)).is_transient());
    }
}
