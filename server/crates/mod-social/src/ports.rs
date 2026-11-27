//! Cổng sang dịch vụ bài đăng (`SocialPostsService`, M54a — chưa có trên nhánh này), nháp và khung giờ hàng đợi (M55a).
//! Bài lặp và nhập CSV chỉ cần vài thao tác của chúng, nên khai ở đây dưới dạng trait. Nháp và hàng đợi đã có bản cài thật
//! ở [`crate::adapters`]; `PostsPort` do M54a cài (bọc `posts.rs`) khi gộp, không đổi mã M55b.
//!
//! Quy ước chung của mọi cổng: mỗi lời gọi tự xin kết nối DB của mình (không nhận kết nối từ người gọi) nên người gọi
//! KHÔNG được giữ kết nối khi gọi cổng (pool một kết nối sẽ treo; quy tắc "không giữ hai conn").

use std::future::Future;

use chrono::{DateTime, Utc};
use trinity_kernel::error::AppError;

use crate::recur::{TemplateTarget, TemplateUtm};

pub use crate::queue::NO_QUEUE_SLOTS;

/// Dữ liệu một bài hoặc một nháp (`CreatePostInput` / `DraftInput`).
#[derive(Debug, Clone, PartialEq)]
pub struct PostInput {
    pub content: String,
    pub media_keys: Vec<String>,
    pub targets: Vec<TemplateTarget>,
    pub utm: Option<TemplateUtm>,
    /// Giờ hẹn; `None` = đăng ngay (bài) hoặc chưa đặt (nháp).
    pub scheduled_at: Option<DateTime<Utc>>,
    /// Nháp: đăng vào khung trống gần nhất của hàng đợi.
    pub use_queue: bool,
    /// `csv` | `mcp` | `web`… (cột `social_posts.source`).
    pub source: Option<String>,
}

/// Kết quả [`PostsPort::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedPost {
    /// Giờ hẹn đã chuẩn hoá; `None` khi giờ đã qua (bài sẽ đăng ngay).
    pub scheduled_at: Option<DateTime<Utc>>,
}

/// Điều kiện "lịch lặp còn nguyên" kiểm NGAY TRONG giao dịch tạo bài (thay cho `inTx` của bản Node).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecurrenceGuard {
    pub recurrence_id: i32,
    /// `next_run_at` mà lượt chạy này đang tạo bài cho.
    pub at: DateTime<Utc>,
}

/// Lỗi của [`PostsPort::create`].
#[derive(Debug)]
pub enum CreateFailure {
    /// `RecurrenceGuard` không còn đúng (lịch vừa bị tạm dừng, sửa, xoá): giao dịch đã huỷ, không tạo bài.
    Changed,
    /// Lỗi thường: 409 = khoá chống lặp đã có bài; 4xx khác = kênh/tệp hỏng; còn lại là lỗi hạ tầng.
    Failed(AppError),
}

/// `SocialPostsService` phần M55b cần.
pub trait PostsPort: Send + Sync {
    /// Kiểm như lúc tạo bài (kênh, tệp, giờ hẹn, UTM, giới hạn) mà không ghi gì; lỗi 4xx tiếng Việt.
    fn validate(&self, user_id: i32, input: &PostInput) -> impl Future<Output = Result<ValidatedPost, AppError>> + Send;

    /// Tạo bài (hẹn giờ) cho `user_id`; trả id bài. `dedupe_source` ghi vào `social_posts.source`, trùng với bài đang có
    /// ⇒ `Failed(409)`. `guard` có thì cài đặt PHẢI gọi [`crate::recurrences::guard_holds`] trên chính kết nối của giao
    /// dịch tạo bài (sau khi khoá dòng lịch) và trả `Changed` nếu `false`.
    fn create(
        &self,
        user_id: i32,
        input: &PostInput,
        dedupe_source: &str,
        guard: Option<RecurrenceGuard>,
    ) -> impl Future<Output = Result<i32, CreateFailure>> + Send;

    /// Huỷ bài đang chờ; lỗi 4xx khi bài đã bắt đầu đăng hoặc đã huỷ.
    fn cancel(&self, post_id: i32) -> impl Future<Output = Result<(), AppError>> + Send;
}

/// `SocialDraftsService` phần nhập CSV cần.
pub trait DraftsPort: Send + Sync {
    /// Kiểm nháp như lúc lưu (không ghi).
    fn check(&self, user_id: i32, input: &PostInput) -> impl Future<Output = Result<(), AppError>> + Send;

    /// Tạo nháp; `dedupe` là khoá chống lặp của lượt nhập. Trả id nháp.
    fn create(
        &self,
        user_id: i32,
        input: &PostInput,
        source: &str,
        dedupe: &str,
    ) -> impl Future<Output = Result<i32, AppError>> + Send;
}

/// `SocialQueueService.nextFree`.
pub trait QueuePort: Send + Sync {
    /// `n` khung trống kế tiếp của hàng đợi (có thể ít hơn `n`, rỗng khi chưa đặt khung nào); KHÔNG giữ chỗ.
    fn next_free(&self, n: usize) -> impl Future<Output = Result<Vec<DateTime<Utc>>, AppError>> + Send;
}

/// Mã HTTP của lỗi nếu đó là lỗi HTTP chủ động.
pub fn status_of(e: &AppError) -> Option<u16> {
    match e {
        AppError::Http(h) => Some(h.status()),
        _ => None,
    }
}
