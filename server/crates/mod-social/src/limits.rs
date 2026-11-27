//! Hằng giới hạn đăng bài mà M55b dùng: lấy từ M55a ([`crate::drafts`], [`crate::queue`]) để một nguồn duy nhất.

pub use crate::drafts::{MAX_DRAFT_TARGETS as MAX_TARGETS, MAX_MEDIA_PER_POST};
pub use crate::queue::MAX_SCHEDULE_AHEAD_MS;
