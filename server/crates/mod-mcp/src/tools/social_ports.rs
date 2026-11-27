//! Cổng (port) của tool đăng bài (M44a phần 2): những dịch vụ CHƯA có trên `main` hoặc cần hạ tầng của tầng `serve`.
//!
//! - [`PostInfra`]: bộ chặn kênh + Graph của từng công ty, để dựng `mod_social::posts::PostCtx` (tạo, sửa, đổi giờ, thử lại, xem
//!   trước, kiểm bài). Thiếu ⇒ tool trả "chưa có tính năng".
//! - [`MetricsPort`] (M54b): thống kê và lấy số liệu mới của bài đã đăng.
//! - [`RecurrencePort`] (M55b): lịch đăng lặp lại.
//! - [`ImportPort`] (M55b): nhập nhiều bài một lần (kế hoạch + tạo).
//! - [`DraftPublishPort`]: đăng bài nháp thành bài thật (giữ chỗ nháp + tạo bài trong CÙNG một giao dịch; `posts::create` chưa có
//!   móc trong giao dịch nên không dựng lại ở `mod-mcp`).
//!
//! Dữ liệu qua cổng là JSON đúng dạng của dịch vụ bản Node (`social-recurrence.service.ts`, `social-import.service.ts`…): thời
//! điểm là chuỗi ISO UTC, `mod-mcp` đổi sang giờ Việt Nam khi trả cho AI. Khi M54b/M55b vào `main`, `serve` viết bộ chuyển (adapter)
//! từ module thật sang các cổng này; tool không đổi.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use mod_channel_guard::ChannelGuard;
use mod_facebook::graph::GraphClient;
use serde_json::Value;
use trinity_db::CompanyRef;
use trinity_kernel::error::AppError;

use crate::protocol::BoxFuture;

pub type PortFut<'a, T> = BoxFuture<'a, Result<T, AppError>>;

/// Hạ tầng dựng `PostCtx`: bộ chặn kênh dùng chung và Graph theo công ty (cùng bản với job đăng, `JobDeps::graph_for`).
#[derive(Clone)]
pub struct PostInfra {
    pub guard: ChannelGuard,
    pub graph_for: Arc<dyn Fn(CompanyRef) -> GraphClient + Send + Sync>,
}

/// Kết quả lấy số liệu một bài: id kênh không trả số lần này, id kênh vừa lấy dưới 1 phút (bỏ qua).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefreshReport {
    pub failed: Vec<i32>,
    pub throttled: Vec<i32>,
}

/// Số liệu bài đã đăng (M54b).
pub trait MetricsPort: Send + Sync {
    /// `{ totals, by_account, top: [{ post_id, published_at (ISO), … }], without_metrics, removed, updated_at (ISO) }`; `from`/`to`
    /// là khoảng ngày bài LÊN MẠNG, `to` tính cả mili giây cuối.
    fn stats(&self, company: CompanyRef, from: DateTime<Utc>, to: DateTime<Utc>, top: i64) -> PortFut<'_, Value>;
    /// Lấy ngay số liệu mới của mọi kênh đã đăng của bài (cách quãng ≥ 1 phút mỗi kênh) và lưu lại.
    fn refresh_post(&self, company: CompanyRef, post_id: i32) -> PortFut<'_, RefreshReport>;
}

/// Lịch đăng lặp lại (M55b). Mỗi `Value` là bản xem (`RecurrenceView`):
/// `{ id, title, active, next_run_at, next_times: [ISO], template: { content, media_keys, targets: [{ account_id, caption,
/// options }], utm? }, rule: { freq, interval, weekdays?, month_day?, time }, starts_on, ends_on, max_count, count, last_error,
/// posts: [{ id, status, scheduled_at (ISO) }] }`.
pub trait RecurrencePort: Send + Sync {
    fn list(&self, company: CompanyRef) -> PortFut<'_, Vec<Value>>;
    fn get(&self, company: CompanyRef, id: i32) -> PortFut<'_, Value>;
    /// Kiểm và tính các lần đăng tới, KHÔNG ghi. `id` có ⇒ sửa lịch đó; `input` rỗng `{}` ⇒ giữ nguyên lịch (dùng khi tiếp tục).
    /// Trả `{ title, rule, startsOn, endsOn, maxCount, times: [ISO], validated: { content, targets: [{ account_name, network,
    /// caption, options }], media: [{ type }] } }`.
    fn preview(&self, company: CompanyRef, user_id: i32, input: Value, id: Option<i32>) -> PortFut<'_, Value>;
    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> PortFut<'_, Value>;
    fn update(&self, company: CompanyRef, user_id: i32, id: i32, input: Value) -> PortFut<'_, Value>;
    /// `active = false` ⇒ tạm dừng (huỷ bài hẹn đang chờ, không xoá); `true` ⇒ tiếp tục (tính lại lần kế từ bây giờ).
    fn set_active(&self, company: CompanyRef, id: i32, active: bool) -> PortFut<'_, Value>;
}

/// Nhập nhiều bài (M55b). `rows`: các dòng đã chuẩn hoá `{ content, account_ids, scheduled_at, use_queue, media_keys,
/// first_comment, utm_campaign }`; `mode`: `drafts` | `schedule`.
pub trait ImportPort: Send + Sync {
    /// Kế hoạch từng dòng, KHÔNG tạo gì: `{ mode, plan_hash, total, ok_count, error_count, rows: [{ row, ok, errors, warnings,
    /// preview: { channels: [{ account_id, name, network }], scheduled_at, use_queue, content_excerpt } }] }`.
    fn plan(&self, company: CompanyRef, user_id: i32, rows: Value, mode: &str) -> PortFut<'_, Value>;
    /// Tạo các dòng hợp lệ; `plan_hash` khác lúc xem trước ⇒ 409. Trả `{ mode, created: [{ row, id }], skipped: [{ row, errors }] }`.
    fn import(&self, company: CompanyRef, user_id: i32, rows: Value, mode: &str, plan_hash: &str)
    -> PortFut<'_, Value>;
}

/// Ghi đè giờ lúc đăng nháp: `scheduled_at`: `None` = giữ giờ của nháp; `Some(None)` = đăng ngay; `Some(Some(iso))` = giờ mới.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DraftOverrides {
    pub scheduled_at: Option<Option<String>>,
}

/// Đăng bài nháp (giữ chỗ nháp theo ĐÚNG phiên bản đã xem rồi tạo bài, gắn `post_id` trong cùng giao dịch).
pub trait DraftPublishPort: Send + Sync {
    /// `expect_updated_at`: nháp phải còn đúng bản đã xem, khác ⇒ 409. Trả bài đã tạo `{ id, status, scheduled_at (ISO), targets:
    /// [{ id, account_name, status }] }`.
    fn publish(
        &self,
        company: CompanyRef,
        user_id: i32,
        draft_id: i32,
        overrides: DraftOverrides,
        expect_updated_at: Option<DateTime<Utc>>,
    ) -> PortFut<'_, Value>;
}
