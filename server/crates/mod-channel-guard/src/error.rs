//! Lỗi chặn gửi ra ngoài (`channel-guard.errors.ts`): khoá kênh (403), tạm dừng tự động và hết hạn mức (429).

use serde_json::Value;
use trinity_kernel::error::{AppError, HttpError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockCode {
    ChannelLocked,
    ChannelPaused,
    ChannelQuota,
}

impl BlockCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChannelLocked => "channel_locked",
            Self::ChannelPaused => "channel_paused",
            Self::ChannelQuota => "channel_quota",
        }
    }

    pub fn status(self) -> u16 {
        if self == Self::ChannelLocked { 403 } else { 429 }
    }
}

/// Sự kiện chờ ghi: hết hạn mức xảy ra TRONG giao dịch thì ghi sau giao dịch bằng [`crate::ChannelGuard::record_blocked`].
#[derive(Debug, Clone, PartialEq)]
pub struct PendingEvent {
    pub kind: &'static str,
    pub message: String,
    pub meta: Value,
    pub dedupe: String,
    pub log: String,
}

/// Gửi ra ngoài bị chặn. Lời báo tiếng Việt cho người dùng thường.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelBlocked {
    pub code: BlockCode,
    pub message: String,
    pub pending_event: Option<PendingEvent>,
}

impl ChannelBlocked {
    pub fn new(code: BlockCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            pending_event: None,
        }
    }

    pub fn status(&self) -> u16 {
        self.code.status()
    }

    /// Body như bản Node: `{ statusCode, message, code }`.
    pub fn body(&self) -> Value {
        serde_json::json!({ "statusCode": self.status(), "message": self.message, "code": self.code.as_str() })
    }
}

impl std::fmt::Display for ChannelBlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ChannelBlocked {}

/// Lỗi của các hàm giữ chỗ/kiểm tra: bị chặn (có mã riêng) hoặc lỗi hệ thống.
#[derive(Debug)]
pub enum GuardError {
    Blocked(ChannelBlocked),
    App(AppError),
}

impl GuardError {
    /// Mã chặn nếu là lỗi chặn.
    pub fn block_code(&self) -> Option<BlockCode> {
        match self {
            Self::Blocked(b) => Some(b.code),
            Self::App(_) => None,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Blocked(b) => b.message.clone(),
            Self::App(e) => e.to_string(),
        }
    }
}

impl From<ChannelBlocked> for GuardError {
    fn from(b: ChannelBlocked) -> Self {
        Self::Blocked(b)
    }
}

impl From<AppError> for GuardError {
    fn from(e: AppError) -> Self {
        Self::App(e)
    }
}

impl From<GuardError> for AppError {
    fn from(e: GuardError) -> Self {
        match e {
            GuardError::Blocked(b) => HttpError::new(b.status(), b.message).into(),
            GuardError::App(a) => a,
        }
    }
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}
